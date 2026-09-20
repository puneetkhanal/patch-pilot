import {
  IssueAiUpgradeAnalysis,
  IssueAnalysisHistory,
  IssueCursorUpgradeAnalysis,
  IssueFinalUpgradeVerification,
  IssueUpgradeAnalysis,
  TrackerIssue
} from '../domain/types.js';

const historyLimit = 20;

function historyFor(issue: TrackerIssue): IssueAnalysisHistory {
  return issue.analysisHistory ||= { dependencyEngine: [], ai: [], cursor: [], finalVerification: [] };
}

function append<T>(items: T[], value: T) {
  items.push(value);
  if (items.length > historyLimit) items.splice(0, items.length - historyLimit);
}

export function recordDependencyAnalysis(issue: TrackerIssue, analysis: IssueUpgradeAnalysis) {
  issue.lastUpgradeAnalysis = analysis;
  append(historyFor(issue).dependencyEngine, analysis);
}

export function recordAiAnalysis(issue: TrackerIssue, analysis: IssueAiUpgradeAnalysis) {
  issue.lastAiAnalysis = analysis;
  append(historyFor(issue).ai, analysis);
}

export function recordCursorAnalysis(issue: TrackerIssue, analysis: IssueCursorUpgradeAnalysis) {
  issue.lastCursorAnalysis = analysis;
  append(historyFor(issue).cursor, analysis);
}

export function recordFinalVerification(issue: TrackerIssue, analysis: IssueFinalUpgradeVerification) {
  issue.lastFinalVerification = analysis;
  append(historyFor(issue).finalVerification, analysis);
}
