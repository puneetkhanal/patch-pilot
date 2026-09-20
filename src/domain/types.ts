export const issueStates = [
  'NEW', 'TRIAGED', 'PLANNED_BATCH', 'IN_PROGRESS', 'READY_FOR_REVIEW',
  'MERGED', 'RESOLVED', 'BLOCKED', 'CLOSED'
] as const;
export type IssueState = typeof issueStates[number];

export interface HistoryEntry { at: string; from?: IssueState; to: IssueState; actor: string; note?: string }
export interface Note { at: string; actor: string; body: string }
export interface RemediationResult {
  branch?: string;
  commitSha?: string;
  worktreePath?: string;
  prUrl?: string;
  packageVersions?: Record<string, string>;
}
export type AiAnalysisProvider = 'cursor' | 'gemini';
export type FixAgentProvider = 'codex' | 'claude' | 'cursor';
export interface FixAgentSelection { provider: FixAgentProvider; skill: string }
export interface RemediationState { jobId?: string; log?: string; error?: string; result?: RemediationResult; agent?: FixAgentSelection }
export interface UpgradeFinding { code: string; message: string; severity: 'info' | 'warning' | 'error' }
export interface DependencyGraph {
  nodes: Array<{ id: string; version?: string; requestedVersion?: string; direct?: boolean; dependencyType?: string }>;
  edges: Array<{ from: string; to: string; kind?: string }>;
}
export type UpgradeRiskLevel = 'safe' | 'likely_safe' | 'risky' | 'unsafe';
export interface IssueUpgradeAnalysis {
  riskLevel: UpgradeRiskLevel;
  safetyScore?: number;
  confidence?: 'high' | 'medium' | 'low';
  recommendation?: string;
  needsAdditionalBumps: boolean;
  findings: UpgradeFinding[];
  dependencyGraph: DependencyGraph;
  analyzedAt: string;
}
export interface IssueAiUpgradeAnalysis {
  riskLevel: UpgradeRiskLevel;
  safetyScore: number;
  confidence: 'high' | 'medium' | 'low';
  needsAdditionalBumps: boolean;
  summary: string;
  steps: string[];
  breakingChanges: string[];
  verificationChecks: string[];
  provider?: AiAnalysisProvider;
  model?: string;
  prompt?: string;
  runId?: string;
  durationMs?: number;
  basedOnAnalysisAt?: string;
  analyzedAt: string;
}
export interface UpgradeVerdict {
  verdict: UpgradeRiskLevel;
  confidence: number;
  summary: string;
  reasons: string[];
  verificationChecks: string[];
  model?: string;
  analyzedAt: string;
}
export interface IssueCursorUpgradeAnalysis extends UpgradeVerdict {
  provider?: AiAnalysisProvider;
  runId?: string;
  durationMs?: number;
  basedOnAnalysisAt?: string;
}
export interface IssueFinalUpgradeVerification extends UpgradeVerdict {
  agreesWithHeuristic: boolean;
  agreesWithCursor?: boolean;
}
export interface IssueAnalysisHistory {
  dependencyEngine: IssueUpgradeAnalysis[];
  ai: IssueAiUpgradeAnalysis[];
  cursor: IssueCursorUpgradeAnalysis[];
  finalVerification: IssueFinalUpgradeVerification[];
}
export interface RepositoryUpgradeAnalysis {
  repo: string;
  projectPath: string;
  summary: Record<UpgradeRiskLevel | 'not_analyzed', number>;
  dependencies: Array<{
    issueId: string;
    packageName: string;
    currentVersion?: string;
    targetVersion: string;
    manifestPath: string;
    riskLevel: UpgradeRiskLevel;
    safetyScore: number;
    confidence: 'high' | 'medium' | 'low';
    recommendation: string;
    needsAdditionalBumps: boolean;
  }>;
  graph: DependencyGraph;
  analyzedAt: string;
}
export interface TrackerIssue {
  id: string;
  repo: string;
  title: string;
  state: IssueState;
  alerts: number[];
  packageName: string;
  ecosystem: string;
  manifestPath: string;
  manifestPaths?: string[];
  patchedVersion: string;
  vulnerableVersionRange: string;
  severity: string;
  severityScore: number;
  complexity: 'low' | 'medium' | 'high';
  pr: { branch: string; url?: string; number?: number };
  remediation: RemediationState;
  lastUpgradeAnalysis?: IssueUpgradeAnalysis;
  lastAiAnalysis?: IssueAiUpgradeAnalysis;
  lastCursorAnalysis?: IssueCursorUpgradeAnalysis;
  lastFinalVerification?: IssueFinalUpgradeVerification;
  analysisHistory?: IssueAnalysisHistory;
  jira?: { key: string; url?: string };
  history: HistoryEntry[];
  notes: Note[];
  labels: string[];
  updatedAt: string;
  createdAt: string;
}
export type BatchState = 'draft' | 'fixing' | 'ready_for_pr' | 'pr_open' | 'merged' | 'failed';
export interface BatchGrouping {
  source: 'manual' | 'dependency_engine' | 'ai';
  maxGroupSize?: number;
  rationale: string[];
  analyzedAt?: string;
  safetyRank?: number;
  safetyScore?: number;
  safetyLevel?: UpgradeRiskLevel;
  safetySummary?: string;
  model?: string;
  requiresHumanReview?: boolean;
  humanReviewIssueIds?: string[];
  humanReviewReasons?: string[];
}
export interface WorkItem {
  id: string;
  repo: string;
  issueIds: string[];
  state: BatchState;
  branch: string;
  remediation: RemediationState;
  grouping?: BatchGrouping;
  createdAt: string;
  updatedAt: string;
}
/** @deprecated Use WorkItem. Kept for persisted-state and API compatibility. */
export type SecurityBatch = WorkItem;
export type FixJobKind = 'fix' | 'create-pr' | 'update-pr' | 'reset-pr-and-fix' | 'batch-fix' | 'batch-create-pr' | 'package-update';
export type FixJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export interface FixJob {
  id: string;
  kind: FixJobKind;
  status: FixJobStatus;
  issueId?: string;
  batchId?: string;
  repo: string;
  alertNumber?: number;
  log: string;
  result?: RemediationResult;
  error?: string;
  agent?: FixAgentSelection;
  createdAt: string;
  updatedAt: string;
}
export interface ScanSummary { alertCount: number; issueCount: number; openPrCount: number; scannedAt: string }
export interface PullRequestStatus {
  number: number;
  title: string;
  url: string;
  branch: string;
  author?: string;
  draft: boolean;
  reviewState: 'approved' | 'changes_requested' | 'review_required' | 'unknown';
  checks: { total: number; successful: number; failed: number; pending: number; conclusion: string };
  updatedAt: string;
  issueId?: string;
}
export interface GitHubRepository { fullName: string; private: boolean; defaultBranch: string; updatedAt: string }
export interface WorktreeInfo { id: string; path: string; branch?: string; head?: string; locked?: boolean }
export interface LocalGitHubRepository { repo: string; name: string; path: string; relativePath: string; remoteUrl: string }
