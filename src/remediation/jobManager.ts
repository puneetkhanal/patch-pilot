import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { FixAgentSelection, FixJob, FixJobKind, RemediationResult } from '../domain/types.js';
import { Repository } from '../repository/repository.js';

export interface RunSpec {
  kind: FixJobKind;
  repo: string;
  issueId?: string;
  batchId?: string;
  alertNumber?: number;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  agent?: FixAgentSelection;
  onComplete?: (job: FixJob) => Promise<void> | void;
}

export class JobManager {
  private jobs = new Map<string, FixJob>();
  constructor(private repository: Repository) {}

  async get(id: string) { return this.jobs.get(id) || this.repository.getJob(id); }
  async list(repo?: string) {
    const persisted = await this.repository.listJobs(repo);
    const merged = new Map(persisted.map(job => [job.id, job]));
    for (const job of this.jobs.values()) if (!repo || job.repo === repo) merged.set(job.id, job);
    return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  start(spec: RunSpec) {
    const now = new Date().toISOString();
    const job: FixJob = {
      id: crypto.randomUUID(), kind: spec.kind, status: 'queued', repo: spec.repo,
      issueId: spec.issueId, batchId: spec.batchId, alertNumber: spec.alertNumber,
      agent: spec.agent,
      log: '', createdAt: now, updatedAt: now
    };
    this.jobs.set(job.id, job);
    void this.repository.saveJob(job);
    queueMicrotask(() => this.run(job, spec));
    return job;
  }

  private parse(log: string): RemediationResult {
    const result: RemediationResult = {};
    for (const line of log.split(/\r?\n/)) {
      const match = line.match(/^(branch|commit|worktree_path|pr_url):\s*(.+)$/);
      if (!match) continue;
      if (match[1] === 'branch') result.branch = match[2];
      if (match[1] === 'commit') result.commitSha = match[2];
      if (match[1] === 'worktree_path') result.worktreePath = match[2];
      if (match[1] === 'pr_url') result.prUrl = match[2];
    }
    return result;
  }

  private persist(job: FixJob) { void this.repository.saveJob(job); }

  private run(job: FixJob, spec: RunSpec) {
    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    this.persist(job);
    const process = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...globalThis.process.env, ...spec.env },
      shell: false
    });
    let finalized = false;
    const output = (chunk: Buffer) => {
      job.log += chunk.toString();
      job.updatedAt = new Date().toISOString();
      this.persist(job);
    };
    const finish = async (code: number | null, spawnError?: Error) => {
      if (finalized) return;
      finalized = true;
      job.result = this.parse(job.log);
      job.status = !spawnError && code === 0 ? 'succeeded' : 'failed';
      job.error = spawnError?.message || (job.status === 'failed' ? `Process exited ${code}` : undefined);
      job.updatedAt = new Date().toISOString();
      await this.repository.saveJob(job);
      await spec.onComplete?.(job);
    };
    process.stdout.on('data', output);
    process.stderr.on('data', output);
    process.on('error', error => void finish(null, error));
    process.on('close', code => void finish(code));
  }
}
