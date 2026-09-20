import { FixJob, TrackerIssue } from '../domain/types.js';

export type WorkflowStepStatus = 'completed' | 'current' | 'running' | 'remaining' | 'optional' | 'failed';

export interface IssueWorkflowStep {
  id: 'detected' | 'ai-analysis' | 'fix' | 'pull-request' | 'review';
  label: string;
  status: WorkflowStepStatus;
  detail: string;
  completedAt?: string;
}

const isFix = (job: FixJob) => job.kind === 'fix' || job.kind === 'reset-pr-and-fix';
const newest = (jobs: FixJob[]) => [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export function buildIssueWorkflow(issue: TrackerIssue, allJobs: FixJob[]) {
  const jobs = newest(allJobs.filter(job => job.issueId === issue.id));
  const fixJobs = jobs.filter(isFix);
  const activeFix = fixJobs.find(job => job.status === 'queued' || job.status === 'running');
  const latestAttempt = fixJobs[0];
  const successfulFix = fixJobs.find(job => job.status === 'succeeded');
  const failedFix = !activeFix && latestAttempt?.status === 'failed' ? latestAttempt : undefined;
  const appliedFix = successfulFix || latestAttempt;
  const latestPrJob = jobs.find(job => ['create-pr', 'update-pr'].includes(job.kind));
  const failedPr = !issue.pr.url && latestPrJob?.status === 'failed' ? latestPrJob : undefined;
  const noCommitPrFailure = Boolean(failedPr && /No commits between|no commits beyond/i.test(failedPr.log));
  const prComplete = Boolean(issue.pr.url);
  const reviewComplete = ['MERGED', 'RESOLVED', 'CLOSED'].includes(issue.state);

  let current: IssueWorkflowStep['id'] | undefined;
  if (!issue.lastAiAnalysis) current = 'ai-analysis';
  else if (activeFix || failedFix || !successfulFix) current = 'fix';
  else if (!prComplete) current = 'pull-request';
  else if (!reviewComplete) current = 'review';

  const steps: IssueWorkflowStep[] = [
    { id: 'detected', label: 'Issue detected', status: 'completed', detail: `${issue.alerts.length} alert${issue.alerts.length === 1 ? '' : 's'} imported`, completedAt: issue.createdAt },
    issue.lastAiAnalysis
      ? { id: 'ai-analysis', label: 'AI analysis', status: 'completed', detail: `${issue.lastAiAnalysis.riskLevel.replaceAll('_', ' ')} · score ${issue.lastAiAnalysis.safetyScore} · ${issue.lastAiAnalysis.model || 'Composer 2.5'}`, completedAt: issue.lastAiAnalysis.analyzedAt }
      : { id: 'ai-analysis', label: 'AI analysis', status: current === 'ai-analysis' ? 'current' : 'remaining', detail: 'Not analyzed' },
    activeFix
      ? { id: 'fix', label: 'Fix in progress', status: 'running', detail: `${activeFix.kind} job ${activeFix.status}` }
      : noCommitPrFailure
        ? { id: 'fix', label: 'Fix produced no branch commit', status: 'failed', detail: `Recorded fix job ${successfulFix?.id || latestAttempt?.id || 'unknown'} must be rerun` }
      : failedFix
        ? { id: 'fix', label: 'Fix failed', status: 'failed', detail: failedFix.error || 'Review the job log and retry' }
        : successfulFix
          ? { id: 'fix', label: 'Fix applied', status: 'completed', detail: successfulFix.agent ? `${successfulFix.agent.provider} · ${successfulFix.agent.skill}` : 'Built-in dependency update', completedAt: successfulFix.updatedAt }
          : { id: 'fix', label: 'Apply fix', status: current === 'fix' ? 'current' : 'remaining', detail: 'No successful fix job' },
    prComplete
      ? { id: 'pull-request', label: 'Pull request created', status: 'completed', detail: `PR #${issue.pr.number || ''}`.trim(), completedAt: jobs.find(job => job.result?.prUrl)?.updatedAt }
      : failedPr
        ? { id: 'pull-request', label: 'Pull request failed', status: 'failed', detail: failedPr.log.match(/Cannot publish remediation:[^\n]+/)?.[0] || failedPr.log.match(/No commits between[^\n]+/)?.[0] || failedPr.error || 'Review the job log before retrying' }
      : { id: 'pull-request', label: 'Create pull request', status: current === 'pull-request' ? 'current' : 'remaining', detail: successfulFix ? 'Fix is ready for a pull request' : 'Waiting for a successful fix' },
    reviewComplete
      ? { id: 'review', label: 'Review and merge', status: 'completed', detail: issue.state.replaceAll('_', ' '), completedAt: issue.updatedAt }
      : { id: 'review', label: 'Review and merge', status: current === 'review' ? 'current' : 'remaining', detail: prComplete ? 'Check CI, approvals, and merge status' : 'Waiting for a pull request' }
  ];

  const completed = steps.filter(step => step.status === 'completed').length;
  let nextAction = 'Workflow complete.';
  let nextActionKind: 'analyze' | 'fix' | 'create-pr' | 'review' | 'wait' | 'complete' = 'complete';
  if (!issue.lastAiAnalysis) { nextAction = 'Run AI analysis to assess upgrade safety and compatibility.'; nextActionKind = 'analyze'; }
  else if (activeFix) { nextAction = `Wait for fix job ${activeFix.id} to finish, then review its validation output.`; nextActionKind = 'wait'; }
  else if (failedFix) { nextAction = `Review failed fix job ${failedFix.id}, correct the failure, and run the fix again.`; nextActionKind = 'fix'; }
  else if (!successfulFix) { nextAction = 'Choose a configured fix skill and run the fix.'; nextActionKind = 'fix'; }
  else if (noCommitPrFailure) { nextAction = 'The published branch has no remediation commit. Run Fix again, then create the pull request.'; nextActionKind = 'fix'; }
  else if (!prComplete) { nextAction = failedPr ? 'Review the failed PR job, then retry creating the pull request.' : 'Create a pull request from the successful fix.'; nextActionKind = 'create-pr'; }
  else if (!reviewComplete) {
    nextAction = prComplete
      ? 'Review CI and approvals, or run the fix again to apply further changes and push them to the open pull request.'
      : 'Review CI and approvals, then merge the pull request.';
    nextActionKind = 'review';
  }

  const canRefix = prComplete && !reviewComplete && !activeFix;

  return {
    issueId: issue.id,
    issueState: issue.state,
    progress: Math.round((completed / steps.length) * 100),
    steps,
    nextAction,
    nextActionKind,
    canRefix,
    latestFix: appliedFix ? {
      id: appliedFix.id,
      status: appliedFix.status,
      kind: appliedFix.kind,
      agent: appliedFix.agent,
      commitSha: appliedFix.result?.commitSha,
      branch: appliedFix.result?.branch,
      error: appliedFix.error,
      valid: !noCommitPrFailure,
      validationMessage: noCommitPrFailure ? 'A later PR preflight confirmed this job did not create a commit beyond the base branch.' : undefined,
      updatedAt: appliedFix.updatedAt
    } : undefined,
    remediationRuns: jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status, agent: job.agent, result: job.result, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt }))
  };
}
