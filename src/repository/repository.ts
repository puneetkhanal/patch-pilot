import { FixJob, IssueState, SecurityBatch, TrackerIssue } from '../domain/types.js';

export interface Repository {
  listIssues(repo: string): Promise<TrackerIssue[]>;
  getIssue(id: string, repo?: string): Promise<TrackerIssue | undefined>;
  upsertIssues(repo: string, issues: TrackerIssue[]): Promise<void>;
  transitionIssue(id: string, to: IssueState, actor: string, note?: string, force?: boolean, repo?: string): Promise<TrackerIssue>;
  addNote(id: string, actor: string, body: string, repo?: string): Promise<TrackerIssue>;
  saveIssue(issue: TrackerIssue): Promise<void>;
  listSummary(repo: string): Promise<Record<IssueState, number>>;
  listBatches(repo: string): Promise<SecurityBatch[]>;
  getBatch(id: string): Promise<SecurityBatch | undefined>;
  saveBatch(batch: SecurityBatch): Promise<void>;
  deleteBatch(id: string): Promise<void>;
  replaceBatches(repo: string, removeIds: string[], batches: SecurityBatch[], issues: TrackerIssue[]): Promise<void>;
  saveJob(job: FixJob): Promise<void>;
  getJob(id: string): Promise<FixJob | undefined>;
  listJobs(repo?: string): Promise<FixJob[]>;
  exportState(): Promise<unknown>;
  importState(state: unknown): Promise<void>;
}
