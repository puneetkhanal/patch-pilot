import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FixJob, issueStates, IssueState, SecurityBatch, TrackerIssue } from '../domain/types.js';
import { canTransition } from '../domain/workflow.js';
import { Repository } from './repository.js';

type State = {
  issues: Record<string, Record<string, TrackerIssue>>;
  batches: Record<string, SecurityBatch>;
  jobs: Record<string, FixJob>;
};
const empty = (): State => ({ issues: {}, batches: {}, jobs: {} });
const stateShape = z.object({
  issues: z.record(z.record(z.any())),
  batches: z.record(z.any()),
  jobs: z.record(z.any()).optional()
});

export class JsonRepository implements Repository {
  private state: State = empty();
  private ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private file = path.resolve('.tracker-state.json')) { this.ready = this.load(); }

  private async load() {
    try {
      const parsed = stateShape.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      this.state = { issues: parsed.issues as State['issues'], batches: parsed.batches as State['batches'], jobs: (parsed.jobs || {}) as State['jobs'] };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  private async flush() {
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    this.writes = this.writes.then(async () => {
      const temp = `${this.file}.tmp`;
      await fs.writeFile(temp, snapshot, { mode: 0o600 });
      await fs.rename(temp, this.file);
    });
    await this.writes;
  }

  async listIssues(repo: string) { await this.ready; return Object.values(this.state.issues[repo] || {}); }

  async getIssue(id: string, repo?: string) {
    await this.ready;
    if (repo) return this.state.issues[repo]?.[id];
    const matches = Object.values(this.state.issues).map(bucket => bucket[id]).filter(Boolean);
    if (matches.length > 1) throw new Error(`Issue ${id} exists in multiple repositories; provide repo`);
    return matches[0];
  }

  async upsertIssues(repo: string, issues: TrackerIssue[]) {
    await this.ready;
    const bucket = this.state.issues[repo] ??= {};
    const incoming = new Set(issues.map(issue => issue.id));
    for (const issue of issues) {
      const old = bucket[issue.id];
      bucket[issue.id] = old ? {
        ...issue,
        state: old.state,
        pr: { ...old.pr, branch: issue.pr.branch },
        remediation: old.remediation,
        history: old.history,
        notes: old.notes,
        labels: old.labels,
        jira: old.jira,
        lastUpgradeAnalysis: old.lastUpgradeAnalysis,
        lastAiAnalysis: old.lastAiAnalysis,
        lastCursorAnalysis: old.lastCursorAnalysis,
        lastFinalVerification: old.lastFinalVerification,
        analysisHistory: old.analysisHistory,
        createdAt: old.createdAt
      } : issue;
    }
    const now = new Date().toISOString();
    for (const existing of Object.values(bucket)) {
      if (existing.ecosystem === 'npm' && !incoming.has(existing.id) && existing.state !== 'CLOSED') {
        existing.history.push({ at: now, from: existing.state, to: 'CLOSED', actor: 'scan', note: 'No tracked alerts remain open' });
        existing.state = 'CLOSED';
        existing.updatedAt = now;
      }
    }
    await this.flush();
  }

  async transitionIssue(id: string, to: IssueState, actor: string, note?: string, force = false, repo?: string) {
    const issue = await this.getIssue(id, repo);
    if (!issue) throw new Error('Issue not found');
    if (!force && !canTransition(issue.state, to)) throw new Error(`Invalid transition ${issue.state} -> ${to}`);
    if (issue.state !== to) {
      issue.history.push({ at: new Date().toISOString(), from: issue.state, to, actor, note });
      issue.state = to;
      issue.updatedAt = new Date().toISOString();
      await this.saveIssue(issue);
    }
    return issue;
  }

  async addNote(id: string, actor: string, body: string, repo?: string) {
    const issue = await this.getIssue(id, repo);
    if (!issue) throw new Error('Issue not found');
    issue.notes.push({ at: new Date().toISOString(), actor, body });
    issue.updatedAt = new Date().toISOString();
    await this.saveIssue(issue);
    return issue;
  }

  async saveIssue(issue: TrackerIssue) { await this.ready; (this.state.issues[issue.repo] ??= {})[issue.id] = issue; await this.flush(); }
  async listSummary(repo: string) { const out = Object.fromEntries(issueStates.map(state => [state, 0])) as Record<IssueState, number>; for (const issue of await this.listIssues(repo)) out[issue.state]++; return out; }
  async listBatches(repo: string) { await this.ready; return Object.values(this.state.batches).filter(batch => batch.repo === repo); }
  async getBatch(id: string) { await this.ready; return this.state.batches[id]; }
  async saveBatch(batch: SecurityBatch) { await this.ready; this.state.batches[batch.id] = batch; await this.flush(); }
  async deleteBatch(id: string) { await this.ready; delete this.state.batches[id]; await this.flush(); }
  async replaceBatches(repo: string, removeIds: string[], batches: SecurityBatch[], issues: TrackerIssue[]) {
    await this.ready;
    if (batches.some(batch => batch.repo !== repo) || issues.some(issue => issue.repo !== repo)) throw new Error('Atomic work-item replacement cannot cross repositories');
    const previous = this.state;
    const nextBatches = { ...this.state.batches };
    for (const id of removeIds) {
      if (nextBatches[id]?.repo === repo) delete nextBatches[id];
    }
    for (const batch of batches) nextBatches[batch.id] = structuredClone(batch);
    const nextBucket = { ...(this.state.issues[repo] || {}) };
    for (const issue of issues) nextBucket[issue.id] = structuredClone(issue);
    this.state = { ...this.state, batches: nextBatches, issues: { ...this.state.issues, [repo]: nextBucket } };
    try { await this.flush(); }
    catch (error) { this.state = previous; throw error; }
  }
  async saveJob(job: FixJob) { await this.ready; this.state.jobs[job.id] = structuredClone(job); await this.flush(); }
  async getJob(id: string) { await this.ready; return this.state.jobs[id]; }
  async listJobs(repo?: string) { await this.ready; const jobs = Object.values(this.state.jobs); return repo ? jobs.filter(job => job.repo === repo) : jobs; }
  async exportState() { await this.ready; return structuredClone(this.state); }
  async importState(state: unknown) { await this.ready; const parsed = stateShape.parse(state); this.state = { issues: parsed.issues as State['issues'], batches: parsed.batches as State['batches'], jobs: (parsed.jobs || {}) as State['jobs'] }; await this.flush(); }
}
