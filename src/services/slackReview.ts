import { PullRequestStatus, TrackerIssue, WorkItem } from '../domain/types.js';

function pullRequestNumber(url?: string) {
  return Number(url?.match(/\/pull\/(\d+)(?:$|[/?#])/)?.[1]) || undefined;
}

function issuesForPullRequest(pr: PullRequestStatus, issues: TrackerIssue[], workItems: WorkItem[]) {
  const issueIds = new Set(
    issues
      .filter(issue => issue.pr.number === pr.number || issue.pr.branch === pr.branch)
      .map(issue => issue.id)
  );
  for (const workItem of workItems) {
    if (workItem.branch === pr.branch || pullRequestNumber(workItem.remediation.result?.prUrl) === pr.number) {
      for (const issueId of workItem.issueIds) issueIds.add(issueId);
    }
  }
  return issues.filter(issue => issueIds.has(issue.id));
}

function issueSummary(issue: TrackerIssue) {
  const manifests = [...new Set(issue.manifestPaths?.length ? issue.manifestPaths : [issue.manifestPath])];
  const alerts = [...new Set(issue.alerts)].sort((left, right) => left - right).map(number => `#${number}`).join(', ');
  const context = [manifests.join(', '), alerts ? `alerts ${alerts}` : ''].filter(Boolean).join('; ');
  return `- ${issue.packageName} → ${issue.patchedVersion}${context ? ` (${context})` : ''}`;
}

export function buildSlackReviewMessage(
  repo: string,
  prs: PullRequestStatus[],
  issues: TrackerIssue[],
  workItems: WorkItem[],
  introduction?: string
) {
  const noun = prs.length === 1 ? 'pull request' : 'pull requests';
  const linked = prs.map(pr => ({ pr, issues: issuesForPullRequest(pr, issues, workItems) }));
  const linkedIssueCount = linked.reduce((total, entry) => total + entry.issues.length, 0);
  const issueNoun = linkedIssueCount === 1 ? 'issue' : 'issues';
  const defaultIntroduction = `Hi Team,\n\nPlease review ${prs.length === 1 ? 'this' : 'these'} ${noun}, which ${prs.length === 1 ? 'fixes' : 'fix'} the following Dependabot ${issueNoun} in ${repo}:`;
  const sections = linked.map(({ pr, issues: linkedIssues }) => {
    const details = linkedIssues.length
      ? linkedIssues.map(issueSummary)
      : [`- ${pr.title} (tracked dependency details are available in the pull request)`];
    return [`PR #${pr.number} — ${pr.title}`, ...details].join('\n');
  });
  return [introduction?.trim() || defaultIntroduction, ...sections].join('\n\n');
}
