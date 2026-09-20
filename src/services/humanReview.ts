import { IssueUpgradeAnalysis, TrackerIssue } from '../domain/types.js';

export interface IssueHumanReviewAssessment {
  issueId: string;
  requiresHumanReview: boolean;
  reasons: string[];
}

export interface GroupHumanReviewAssessment {
  requiresHumanReview: boolean;
  humanReviewIssueIds: string[];
  humanReviewReasons: string[];
  issueAssessments: IssueHumanReviewAssessment[];
}

export interface AiHumanReviewFlags {
  requiresHumanReview?: boolean;
  humanReviewIssueIds?: string[];
  humanReviewReasons?: string[];
}

function pushReason(reasons: string[], reason: string) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function assessIssueHumanReview(issue: TrackerIssue, dependencyAnalysis?: IssueUpgradeAnalysis): IssueHumanReviewAssessment {
  const reasons: string[] = [];
  const engine = dependencyAnalysis || issue.lastUpgradeAnalysis;
  const ai = issue.lastAiAnalysis;

  if (!engine) pushReason(reasons, 'Dependency analysis has not been completed');
  if (!ai) pushReason(reasons, 'AI upgrade analysis has not been completed');
  if (ai && ['risky', 'unsafe'].includes(ai.riskLevel)) pushReason(reasons, `AI rated this upgrade ${ai.riskLevel.replaceAll('_', ' ')}`);
  if (engine && ['risky', 'unsafe'].includes(engine.riskLevel)) pushReason(reasons, `Dependency engine rated this upgrade ${engine.riskLevel.replaceAll('_', ' ')}`);
  if (ai?.needsAdditionalBumps) pushReason(reasons, 'AI analysis indicates additional coordinated bumps may be required');
  if (engine?.needsAdditionalBumps) pushReason(reasons, 'Dependency engine indicates additional coordinated bumps may be required');
  if (ai?.breakingChanges?.length) pushReason(reasons, `AI reported ${ai.breakingChanges.length} potential breaking change${ai.breakingChanges.length === 1 ? '' : 's'}`);
  for (const finding of engine?.findings || []) {
    const signal = `${finding.code} ${finding.message}`;
    if (finding.severity === 'error' || /breaking|incompatible|high[ -]?blast|major.version.gap|peer.range|peer.conflict/i.test(signal)) {
      pushReason(reasons, `Dependency finding requires review: ${finding.code}`);
    }
  }

  return { issueId: issue.id, requiresHumanReview: reasons.length > 0, reasons };
}

export function assessGroupHumanReview(
  issueIds: string[],
  issuesById: Map<string, TrackerIssue>,
  evidenceById?: Map<string, { dependencyAnalysis?: IssueUpgradeAnalysis }>,
  aiFlags?: AiHumanReviewFlags
): GroupHumanReviewAssessment {
  const issueAssessments = issueIds.map(id => {
    const issue = issuesById.get(id);
    if (!issue) return { issueId: id, requiresHumanReview: true, reasons: ['Issue not found in tracker'] };
    const evidence = evidenceById?.get(id);
    return assessIssueHumanReview(issue, evidence?.dependencyAnalysis);
  });

  const humanReviewIssueIds = [...new Set([
    ...issueAssessments.filter(assessment => assessment.requiresHumanReview).map(assessment => assessment.issueId),
    ...(aiFlags?.humanReviewIssueIds || []).filter(id => issueIds.includes(id))
  ])];

  const humanReviewReasons = [...new Set([
    ...issueAssessments.flatMap(assessment => assessment.reasons),
    ...(aiFlags?.humanReviewReasons || [])
  ])];

  const requiresHumanReview = humanReviewIssueIds.length > 0 || Boolean(aiFlags?.requiresHumanReview);

  return { requiresHumanReview, humanReviewIssueIds, humanReviewReasons, issueAssessments };
}
