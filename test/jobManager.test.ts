import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobManager } from '../src/remediation/jobManager.js';
import { JsonRepository } from '../src/repository/jsonRepository.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe('JobManager', () => {
  it('streams output, parses results, persists completion, and calls the completion hook', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-job-')); dirs.push(directory);
    const repository = new JsonRepository(path.join(directory, 'state.json'));
    const completed = vi.fn();
    const manager = new JobManager(repository);
    const job = manager.start({
      kind: 'fix', repo: 'owner/repo', issueId: 'issue-1', command: process.execPath,
      agent: { provider: 'codex', skill: 'dependency-security-fix' },
      args: ['-e', 'console.log("branch: security/test"); console.log("commit: abc123"); console.log("worktree_path: /tmp/worktree")'],
      onComplete: completed
    });
    let current = job;
    for (let attempt = 0; attempt < 100 && (!['succeeded', 'failed'].includes(current.status) || completed.mock.calls.length === 0); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      current = (await manager.get(job.id))!;
    }
    expect(current.status).toBe('succeeded');
    expect(current.result).toMatchObject({ branch: 'security/test', commitSha: 'abc123', worktreePath: '/tmp/worktree' });
    expect(current.agent).toEqual({ provider: 'codex', skill: 'dependency-security-fix' });
    expect((await repository.getJob(job.id))?.status).toBe('succeeded');
    expect(completed).toHaveBeenCalledOnce();
  });

  it('records a failed child process', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-job-')); dirs.push(directory);
    const repository = new JsonRepository(path.join(directory, 'state.json'));
    const manager = new JobManager(repository);
    const completed = vi.fn();
    const job = manager.start({ kind: 'fix', repo: 'owner/repo', command: process.execPath, args: ['-e', 'console.error("No new commit (fix already applied)"); process.exit(4)'], onComplete: completed });
    let current = job;
    for (let attempt = 0; attempt < 100 && (!['succeeded', 'failed'].includes(current.status) || completed.mock.calls.length === 0); attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); current = (await manager.get(job.id))!; }
    expect(current.status).toBe('failed');
    expect(current.error).toBe('Process exited 4');
    expect(current.log).toContain('No new commit');
    expect(completed).toHaveBeenCalledOnce();
  });
});
