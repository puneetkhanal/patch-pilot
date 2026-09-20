import crypto from 'node:crypto';
import { Config } from '../config/env.js';
import { AiAnalysisProvider, IssueUpgradeAnalysis, SecurityBatch } from '../domain/types.js';
import { Repository } from '../repository/repository.js';
import { recordDependencyAnalysis } from './analysisTracking.js';
import { BatchService } from './batches.js';
import { analyzeUpgrade } from './analysis.js';
import { collectIssueRepoContext } from './repoContext.js';
import { classifyPackageTargetOverlaps } from './packageTargetDedup.js';
import { AiWorkItemProposal, buildGroupingPayload, GroupingNormalizationCorrection, IssueGroupingEvidence, proposeWorkItemsWithAi } from './workItemGrouping.js';
export interface GroupingJobDependencyAnalysisEntry {
  issueId: string;
  packageName: string;
  manifestPath: string;
  targetVersion: string;
  analysis: IssueUpgradeAnalysis;
}

export interface GroupingJobLlmRequest {
  prompt: string;
  input: unknown;
  model: string;
  groups?: AiWorkItemProposal[];
  corrections?: GroupingNormalizationCorrection[];
  responseAttempts?: Array<{ kind: 'initial' | 'repair'; response: string; error?: string }>;
}

export interface GroupingJobArtifacts {
  dependencyAnalysis?: GroupingJobDependencyAnalysisEntry[];
  collectedEvidence?: ReturnType<typeof buildGroupingPayload>;
  llmRequest?: GroupingJobLlmRequest;
}

export type GroupingStepId = 'collect_issues' | 'dependency_analysis' | 'import_context' | 'ai_grouping' | 'create_work_items';

export interface GroupingJobStep {
  id: GroupingStepId;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  detail?: string;
  completedAt?: string;
}

export interface GroupingJob {
  id: string;
  repo: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  steps: GroupingJobStep[];
  totalIssues: number;
  analyzedIssues: number;
  currentIssueId?: string;
  currentPackageName?: string;
  workItems?: SecurityBatch[];
  artifacts?: GroupingJobArtifacts;
  error?: string;
  provider: AiAnalysisProvider;
  createdAt: string;
  updatedAt: string;
}

const STEP_DEFINITIONS: Array<{ id: GroupingStepId; label: string }> = [
  { id: 'collect_issues', label: 'Collect eligible issues' },
  { id: 'dependency_analysis', label: 'Run dependency analysis' },
  { id: 'import_context', label: 'Collect manifests and import usage' },
  { id: 'ai_grouping', label: 'AI grouping proposal' },
  { id: 'create_work_items', label: 'Create work items' }
];

function initialSteps(): GroupingJobStep[] {
  return STEP_DEFINITIONS.map(step => ({ ...step, status: 'pending' }));
}

export class GroupingJobManager {
  private jobs = new Map<string, GroupingJob>();

  constructor(private repository: Repository, private batches: BatchService, private config: Config) {}

  get(id: string) { return this.jobs.get(id); }

  start(input: {
    repo: string;
    projectPath: string;
    maxGroupSize: number;
    promptTemplate?: string;
    provider?: AiAnalysisProvider;
  }) {
    const now = new Date().toISOString();
    const provider = input.provider || 'cursor';
    const job: GroupingJob = {
      id: crypto.randomUUID(),
      repo: input.repo,
      status: 'queued',
      steps: initialSteps(),
      totalIssues: 0,
      analyzedIssues: 0,
      provider,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    queueMicrotask(() => void this.run(job, input));
    return job;
  }

  private touch(job: GroupingJob) {
    job.updatedAt = new Date().toISOString();
  }

  private setStep(job: GroupingJob, id: GroupingStepId, status: GroupingJobStep['status'], detail?: string) {
    const step = job.steps.find(candidate => candidate.id === id);
    if (!step) return;
    step.status = status;
    if (detail !== undefined) step.detail = detail;
    if (status === 'completed' || status === 'failed') step.completedAt = new Date().toISOString();
    this.touch(job);
  }

  private async run(job: GroupingJob, input: {
    repo: string;
    projectPath: string;
    maxGroupSize: number;
    promptTemplate?: string;
    provider?: AiAnalysisProvider;
  }) {
    try {
      job.status = 'running';
      this.touch(job);

      this.setStep(job, 'collect_issues', 'running');
      const { issues, replaceable } = await this.batches.getEligibleGroupingIssues(input.repo);
      job.totalIssues = issues.length;
      this.setStep(job, 'collect_issues', 'completed', `${issues.length} issue${issues.length === 1 ? '' : 's'} ready`);

      if (!issues.length) {
        for (const step of job.steps.filter(step => step.status === 'pending')) this.setStep(job, step.id, 'completed', 'No eligible issues');
        job.workItems = [];
        job.status = 'succeeded';
        this.touch(job);
        return;
      }

      const evidenceById = new Map<string, IssueGroupingEvidence>();
      const analyses = new Map<string, Awaited<ReturnType<typeof analyzeUpgrade>>>();

      this.setStep(job, 'dependency_analysis', 'running', issues.length ? `0/${issues.length}` : 'No issues');
      for (let index = 0; index < issues.length; index++) {
        const issue = issues[index];
        job.currentIssueId = issue.id;
        job.currentPackageName = issue.packageName;
        job.analyzedIssues = index;
        this.setStep(job, 'dependency_analysis', 'running', `${issue.packageName} · ${index + 1}/${issues.length}`);
        const dependencyAnalysis = await analyzeUpgrade(issue, input.projectPath);
        recordDependencyAnalysis(issue, dependencyAnalysis);
        analyses.set(issue.id, dependencyAnalysis);
        job.analyzedIssues = index + 1;
        this.touch(job);
      }
      job.artifacts = {
        ...(job.artifacts || {}),
        dependencyAnalysis: issues.map(issue => ({
          issueId: issue.id,
          packageName: issue.packageName,
          manifestPath: issue.manifestPath,
          targetVersion: issue.patchedVersion,
          analysis: analyses.get(issue.id)!
        }))
      };
      this.setStep(job, 'dependency_analysis', 'completed', `Analyzed ${issues.length} package${issues.length === 1 ? '' : 's'}`);

      this.setStep(job, 'import_context', 'running', issues.length ? `0/${issues.length}` : 'No issues');
      for (let index = 0; index < issues.length; index++) {
        const issue = issues[index];
        job.currentIssueId = issue.id;
        job.currentPackageName = issue.packageName;
        this.setStep(job, 'import_context', 'running', `${issue.packageName} · ${index + 1}/${issues.length}`);
        const dependencyAnalysis = analyses.get(issue.id)!;
        const repoContext = await collectIssueRepoContext(issue, input.projectPath, dependencyAnalysis);
        evidenceById.set(issue.id, { issueId: issue.id, dependencyAnalysis, repoContext });
        await this.repository.saveIssue(issue);
        this.touch(job);
      }
      job.currentIssueId = undefined;
      job.currentPackageName = undefined;
      const targetClassification = classifyPackageTargetOverlaps(issues);
      const collectedEvidence = buildGroupingPayload(issues, input.maxGroupSize, evidenceById, targetClassification.overlaps);
      job.artifacts = { ...(job.artifacts || {}), collectedEvidence };
      this.setStep(job, 'import_context', 'completed', `Collected manifests and imports for ${issues.length} package${issues.length === 1 ? '' : 's'}`);

      this.setStep(job, 'ai_grouping', 'running', 'Sending evidence to AI');
      const proposal = await proposeWorkItemsWithAi(
        issues,
        input.maxGroupSize,
        this.config,
        input.projectPath,
        input.promptTemplate,
        input.provider,
        evidenceById,
        collectedEvidence
      );
      job.artifacts = {
        ...(job.artifacts || {}),
        llmRequest: {
          prompt: proposal.prompt,
          input: proposal.payload,
          model: proposal.model,
          groups: proposal.groups,
          corrections: proposal.corrections,
          responseAttempts: proposal.responseAttempts
        }
      };
      this.setStep(job, 'ai_grouping', 'completed', `${proposal.groups.length} proposed group${proposal.groups.length === 1 ? '' : 's'} · ${proposal.model}`);

      this.setStep(job, 'create_work_items', 'running');
      const workItems = await this.batches.applyGroupingProposal(input.repo, issues, proposal, input.maxGroupSize, replaceable);
      job.workItems = workItems;
      this.setStep(job, 'create_work_items', 'completed', `Created ${workItems.length} work item${workItems.length === 1 ? '' : 's'}`);

      job.status = 'succeeded';
      this.touch(job);
    } catch (error: any) {
      const failedStep = job.steps.find(step => step.status === 'running') || job.steps.find(step => step.status === 'pending');
      if (failedStep) this.setStep(job, failedStep.id, 'failed', error.message);
      job.status = 'failed';
      job.error = error.message;
      job.currentIssueId = undefined;
      job.currentPackageName = undefined;
      this.touch(job);
    }
  }
}
