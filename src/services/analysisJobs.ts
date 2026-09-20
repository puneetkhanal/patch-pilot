import crypto from 'node:crypto';
import { Config } from '../config/env.js';
import { AiAnalysisProvider } from '../domain/types.js';
import { Repository } from '../repository/repository.js';
import { analyzeUpgrade, analyzeUpgradeWithAi, vetUpgradeWithCursor, verifyUpgradeWithLlm } from './analysis.js';
import { recordAiAnalysis, recordCursorAnalysis, recordDependencyAnalysis, recordFinalVerification } from './analysisTracking.js';

export interface AnalysisJob {
  id: string;
  repo: string;
  status: 'queued' | 'running' | 'succeeded' | 'completed_with_errors' | 'failed';
  total: number;
  completed: number;
  failed: number;
  currentIssueId?: string;
  currentPackageName?: string;
  results: Array<{ issueId: string; ok: boolean; error?: string }>;
  stages: Array<'graph' | 'ai' | 'cursor' | 'final_verification'>;
  createdAt: string;
  updatedAt: string;
}

export class AnalysisJobManager {
  private jobs = new Map<string, AnalysisJob>();
  constructor(private repository: Repository, private config: Config) {}

  get(id: string) { return this.jobs.get(id); }

  start(input: { repo: string; projectPath: string; promptTemplate?: string; useAi: boolean; useCursor?: boolean; useFinalVerification?: boolean; issueIds?: string[]; provider?: AiAnalysisProvider }) {
    const now = new Date().toISOString();
    const stages: AnalysisJob['stages'] = [];
    if (input.useAi) stages.push('ai');
    else stages.push('graph');
    if (input.useCursor || input.useFinalVerification) stages.push('cursor');
    if (input.useFinalVerification) stages.push('final_verification');
    const job: AnalysisJob = { id: crypto.randomUUID(), repo: input.repo, status: 'queued', total: 0, completed: 0, failed: 0, results: [], stages, createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    queueMicrotask(() => void this.run(job, input));
    return job;
  }

  private async run(job: AnalysisJob, input: { repo: string; projectPath: string; promptTemplate?: string; useAi: boolean; useCursor?: boolean; useFinalVerification?: boolean; issueIds?: string[]; provider?: AiAnalysisProvider }) {
    try {
      const issues = (await this.repository.listIssues(input.repo)).filter(issue => !input.issueIds || input.issueIds.includes(issue.id));
      job.total = issues.length;
      job.status = 'running';
      job.updatedAt = new Date().toISOString();
      for (const issue of issues) {
        job.currentIssueId = issue.id;
        job.currentPackageName = issue.packageName;
        try {
          let dependencyAnalysis: Awaited<ReturnType<typeof analyzeUpgrade>> | undefined;
          if (input.useAi) recordAiAnalysis(issue, await analyzeUpgradeWithAi(issue, input.projectPath, this.config, input.promptTemplate, input.provider));
          if (!input.useAi || input.useCursor || input.useFinalVerification) {
            dependencyAnalysis = await analyzeUpgrade(issue, input.projectPath);
            recordDependencyAnalysis(issue, dependencyAnalysis);
          }
          let cursorAnalysis = undefined;
          if (input.useCursor || input.useFinalVerification) {
            if (!dependencyAnalysis) throw new Error('Dependency analysis is required for codebase verification');
            cursorAnalysis = await vetUpgradeWithCursor(issue, dependencyAnalysis, input.projectPath, this.config, input.provider);
            recordCursorAnalysis(issue, cursorAnalysis);
          }
          if (input.useFinalVerification) recordFinalVerification(issue, await verifyUpgradeWithLlm(issue, dependencyAnalysis!, cursorAnalysis, this.config, input.provider));
          await this.repository.saveIssue(issue);
          job.results.push({ issueId: issue.id, ok: true });
          job.completed++;
        } catch (error: any) {
          job.results.push({ issueId: issue.id, ok: false, error: error.message });
          job.failed++;
        }
        job.updatedAt = new Date().toISOString();
      }
      job.currentIssueId = undefined;
      job.currentPackageName = undefined;
      job.status = job.failed ? (job.completed ? 'completed_with_errors' : 'failed') : 'succeeded';
      job.updatedAt = new Date().toISOString();
    } catch (error: any) {
      job.status = 'failed';
      job.failed++;
      job.results.push({ issueId: '', ok: false, error: error.message });
      job.updatedAt = new Date().toISOString();
    }
  }
}
