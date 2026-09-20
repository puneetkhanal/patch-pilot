import { FixJob, TrackerIssue, WorkItem } from '../domain/types.js';
import { WorkflowStepStatus } from './issueWorkflow.js';

export interface WorkItemWorkflowStep {
  id: 'created' | 'fix' | 'pull-request' | 'review';
  label: string;
  status: WorkflowStepStatus;
  detail: string;
  completedAt?: string;
}

const newest = (jobs: FixJob[]) => [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export function isUpgradeFixBlocked(issue: TrackerIssue) {
  const analysis = issue.lastUpgradeAnalysis;
  return !analysis || ['risky', 'unsafe'].includes(analysis.riskLevel) || analysis.needsAdditionalBumps;
}

export function buildWorkItemWorkflow(workItem: WorkItem, issues: TrackerIssue[], allJobs: FixJob[]) {
  const jobs = newest(allJobs.filter(job => job.batchId === workItem.id));
  const fixJobs = jobs.filter(job => job.kind === 'batch-fix');
  const activeFix = fixJobs.find(job => ['queued', 'running'].includes(job.status));
  const successfulFix = fixJobs.find(job => job.status === 'succeeded');
  const failedFix = !activeFix && fixJobs[0]?.status === 'failed' ? fixJobs[0] : undefined;
  const prJobs = jobs.filter(job => job.kind === 'batch-create-pr');
  const activePr = prJobs.find(job => ['queued', 'running'].includes(job.status));
  const failedPr = !activePr && prJobs[0]?.status === 'failed' ? prJobs[0] : undefined;
  const prUrl = workItem.remediation.result?.prUrl || prJobs.find(job => job.result?.prUrl)?.result?.prUrl;
  const engineAnalyzed = issues.filter(issue => issue.lastUpgradeAnalysis);
  const engineComplete = issues.length > 0 && engineAnalyzed.length === issues.length;
  const blocked = issues.filter(issue => isUpgradeFixBlocked(issue));
  const reviewComplete = workItem.state === 'merged';

  const fixBlocked = blocked.length > 0 && !successfulFix;
  let current: WorkItemWorkflowStep['id'] | undefined;
  if (activeFix || failedFix || !successfulFix) current = 'fix';
  else if (!prUrl) current = 'pull-request';
  else if (!reviewComplete) current = 'review';

  const steps: WorkItemWorkflowStep[] = [
    { id: 'created', label: 'Work item created', status: 'completed', detail: `${issues.length} Dependabot issue${issues.length === 1 ? '' : 's'} assigned`, completedAt: workItem.createdAt },
    activeFix
      ? { id: 'fix', label: 'Work-item fix in progress', status: 'running', detail: `Job ${activeFix.id} is ${activeFix.status}` }
      : failedFix
        ? { id: 'fix', label: 'Work-item fix failed', status: 'failed', detail: failedFix.error || 'Review the job log and retry' }
        : successfulFix
          ? { id: 'fix', label: 'All dependency fixes applied', status: 'completed', detail: successfulFix.result?.commitSha ? `Commit ${successfulFix.result.commitSha}` : 'Batch fix completed', completedAt: successfulFix.updatedAt }
          : {
            id: 'fix',
            label: 'Apply all fixes',
            status: current === 'fix' ? 'current' : 'remaining',
            detail: !engineComplete
              ? `${engineAnalyzed.length} of ${issues.length} analyzed by dependency engine`
              : fixBlocked
                ? `${blocked.length} member${blocked.length === 1 ? '' : 's'} flagged by dependency engine before fixing`
                : 'Ready for one coordinated fix'
          },
    prUrl
      ? { id: 'pull-request', label: 'One pull request created', status: 'completed', detail: prUrl, completedAt: prJobs.find(job => job.result?.prUrl)?.updatedAt }
      : activePr
        ? { id: 'pull-request', label: 'Pull request in progress', status: 'running', detail: `Job ${activePr.id} is ${activePr.status}` }
        : failedPr
          ? { id: 'pull-request', label: 'Pull request failed', status: 'failed', detail: failedPr.error || 'Review the job log and retry' }
          : { id: 'pull-request', label: 'Create one pull request', status: current === 'pull-request' ? 'current' : 'remaining', detail: successfulFix ? 'The coordinated fix is ready to publish' : 'Waiting for a successful fix' },
    reviewComplete
      ? { id: 'review', label: 'Review and merge', status: 'completed', detail: 'Work item merged', completedAt: workItem.updatedAt }
      : { id: 'review', label: 'Review and merge', status: current === 'review' ? 'current' : 'remaining', detail: prUrl ? 'Check CI, approvals, and merge status' : 'Waiting for a pull request' }
  ];
  const completed = steps.filter(step => step.status === 'completed').length;

  let nextAction = 'Workflow complete.';
  let nextActionKind: 'fix' | 'create-pr' | 'review' | 'wait' | 'complete' = 'complete';
  if (activeFix || activePr) { nextAction = 'Wait for the running work-item job to finish.'; nextActionKind = 'wait'; }
  else if (failedFix || !successfulFix) {
    if (!engineComplete) nextAction = `Dependency analysis is missing for ${issues.length - engineAnalyzed.length} member${issues.length - engineAnalyzed.length === 1 ? '' : 's'}. Re-scan the repository.`;
    else if (fixBlocked) nextAction = `Resolve dependency engine risk for ${blocked.map(issue => issue.packageName).join(', ')} before fixing.`;
    else nextAction = failedFix ? 'Review the failed fix log and retry Fix All.' : 'Apply all fixes.';
    nextActionKind = 'fix';
  }
  else if (!prUrl) {
    const riskyNames = blocked.map(issue => issue.packageName).join(', ');
    nextAction = failedPr
      ? 'Review the failed PR log and retry.'
      : blocked.length
        ? `Create one pull request for the completed work item. Review flagged members carefully: ${riskyNames}.`
        : 'Create one pull request for the completed work item.';
    nextActionKind = 'create-pr';
  }
  else if (!reviewComplete) {
    nextAction = prUrl
      ? 'Review CI and approvals, or run Fix all again to apply further changes and push them to the open pull request.'
      : 'Review CI and approvals, then merge the pull request.';
    nextActionKind = 'review';
  }

  const canRefix = Boolean(prUrl) && !reviewComplete && !activeFix && !activePr;

  return {
    workItemId: workItem.id,
    workItemState: workItem.state,
    progress: Math.round((completed / steps.length) * 100),
    steps,
    nextAction,
    nextActionKind,
    canRefix,
    prUrl,
    blockedIssueIds: blocked.map(issue => issue.id),
    members: issues.map(issue => ({
      id: issue.id,
      packageName: issue.packageName,
      targetVersion: issue.patchedVersion,
      state: issue.state,
      riskLevel: issue.lastUpgradeAnalysis?.riskLevel,
      safetyScore: issue.lastUpgradeAnalysis?.safetyScore,
      analyzedAt: issue.lastUpgradeAnalysis?.analyzedAt
    })),
    latestRun: jobs[0],
    remediationRuns: jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status, result: job.result, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt }))
  };
}
