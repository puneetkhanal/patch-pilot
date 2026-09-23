import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { GitHubClient } from '../src/integrations/github.js';
import { JobManager } from '../src/remediation/jobManager.js';
import { JsonRepository } from '../src/repository/jsonRepository.js';
import { AnalysisJobManager } from '../src/services/analysisJobs.js';
import { BatchService } from '../src/services/batches.js';
import { FixAgentSkillService } from '../src/services/fixAgentSkills.js';
import { GroupingJobManager } from '../src/services/groupingJobs.js';
import { LocalRepositoryService } from '../src/services/localRepositories.js';
import { Scanner } from '../src/services/scanner.js';
import { SettingsService } from '../src/services/settings.js';
import { WorktreeService } from '../src/services/worktrees.js';

const exec = promisify(execFile);
const enabled = process.env.RUN_GITHUB_E2E === '1';
if (enabled) {
  try { loadEnvFile(path.resolve('.env')); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}
const liveDescribe = enabled ? describe : describe.skip;

type ApiResult = { status: number; body: any };
type FixJobResponse = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; log: string; error?: string; agent?: { provider: string; skill: string }; result?: { branch?: string; commitSha?: string; worktreePath?: string; prUrl?: string } };
type GroupingJobResponse = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; provider: string; error?: string; steps: Array<{ id: string; status: string }>; workItems?: Array<{ id: string; issueIds: string[]; branch: string; state: string; grouping?: { source?: string; model?: string } }>; artifacts?: { llmRequest?: { model?: string } } };

liveDescribe('real GitHub automatic vulnerability remediation', () => {
  let temporaryRoot = '';
  let projectPath = '';
  let baseUrl = '';
  let server: Server | undefined;
  let github: GitHubClient;
  let owner = '';
  let repositoryName = '';
  let generatedBranch = '';
  let ownsGeneratedBranch = false;
  let createdPullRequest: number | undefined;

  async function request(endpoint: string, init?: RequestInit): Promise<ApiResult> {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text) : undefined
    };
  }

  async function waitForJob(jobId: string, timeoutMs = 540_000): Promise<FixJobResponse> {
    const deadline = Date.now() + timeoutMs;
    let job = (await request(`/api/fix-jobs/${jobId}`)).body as FixJobResponse;
    while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      job = (await request(`/api/fix-jobs/${jobId}`)).body as FixJobResponse;
    }
    if (['queued', 'running'].includes(job.status)) throw new Error(`Timed out waiting for remediation job ${jobId}\n${job.log}`);
    return job;
  }

  async function waitForGroupingJob(jobId: string, timeoutMs = 540_000): Promise<GroupingJobResponse> {
    const deadline = Date.now() + timeoutMs;
    let job = (await request(`/api/grouping-jobs/${jobId}`)).body as GroupingJobResponse;
    while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      job = (await request(`/api/grouping-jobs/${jobId}`)).body as GroupingJobResponse;
    }
    if (['queued', 'running'].includes(job.status)) throw new Error(`Timed out waiting for Gemini grouping job ${jobId}`);
    return job;
  }

  async function waitForWorkItemState(workItemId: string, expected: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let workItem = (await request(`/api/batches/${workItemId}`)).body;
    while (workItem.state !== expected && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      workItem = (await request(`/api/batches/${workItemId}`)).body;
    }
    expect(workItem.state).toBe(expected);
    return workItem;
  }

  beforeAll(async () => {
    const repository = process.env.E2E_GITHUB_REPO || '';
    const parts = repository.split('/');
    if (parts.length !== 2 || parts.some(part => !part)) throw new Error('E2E_GITHUB_REPO must use owner/repo format');
    if (!/^\d+$/.test(process.env.E2E_GITHUB_ALERT || '')) throw new Error('E2E_GITHUB_ALERT must be an open npm Dependabot alert number');
    if (process.env.E2E_GITHUB_CLEANUP !== '1') throw new Error('E2E_GITHUB_CLEANUP=1 is required because the test creates and then removes a branch and pull request');
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for live work-item auto-grouping');
    if (!process.env.CURSOR_API_KEY) throw new Error('CURSOR_API_KEY is required for the live Cursor skill fix');
    [owner, repositoryName] = parts;

    await exec('gh', ['auth', 'status']);
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'patchpilot-github-e2e-'));
    projectPath = path.join(temporaryRoot, 'testbed');
    await exec('gh', ['repo', 'clone', repository, projectPath, '--', '--depth=1']);
    await exec('git', ['-C', projectPath, 'config', 'user.name', 'PatchPilot E2E']);
    await exec('git', ['-C', projectPath, 'config', 'user.email', 'patchpilot-e2e@users.noreply.github.com']);

    const config = loadConfig({
      ...process.env,
      PORT: '0',
      ORCHESTRATOR_DEFAULT_REPO: repository,
      ORCHESTRATOR_DEFAULT_PROJECT_PATH: projectPath,
      REMEDIATION_REQUIRE_AWS_SSO: 'false',
      CODEX_FIX_ENABLED: 'false'
    });
    const state = new JsonRepository(path.join(temporaryRoot, 'state.json'));
    github = new GitHubClient(config.ghToken, config.githubApiBase);
    const batches = new BatchService(state);
    const app = createApp({
      config,
      repo: state,
      github,
      scanner: new Scanner(state, github),
      batches,
      jobs: new JobManager(state),
      worktrees: new WorktreeService(),
      slack: { status: () => ({ configured: false }), sendReviewRequest: async () => ({ ok: true }) },
      analysisJobs: new AnalysisJobManager(state, config),
      groupingJobs: new GroupingJobManager(state, batches, config),
      settings: new SettingsService(path.join(temporaryRoot, 'settings.json')),
      localRepositories: new LocalRepositoryService(),
      fixAgentSkills: new FixAgentSkillService(config, path.resolve('.'))
    }, path.resolve('public'));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('E2E server did not bind to a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    const cleanupErrors: Error[] = [];
    if (createdPullRequest) {
      try { await github.closePullRequest(owner, repositoryName, createdPullRequest); }
      catch (error) { cleanupErrors.push(error as Error); }
    }
    if (ownsGeneratedBranch && generatedBranch.startsWith('security-fix/dependabot/')) {
      try { await exec('git', ['-C', projectPath, 'push', 'origin', '--delete', generatedBranch]); }
      catch (error: any) {
        if (!String(error?.stderr || error?.message).includes('remote ref does not exist')) cleanupErrors.push(error as Error);
      }
    }
    if (server?.listening) {
      try { await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
      catch (error) { cleanupErrors.push(error as Error); }
    }
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Real GitHub E2E cleanup failed');
  });

  it('scans, auto-groups with Gemini, fixes a work item with a Cursor skill, and opens a PR', async () => {
    const repository = `${owner}/${repositoryName}`;
    const alertNumber = Number(process.env.E2E_GITHUB_ALERT);
    const scan = await request(`/api/repos/${owner}/${repositoryName}/scan`, { method: 'POST' });
    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.alertCount).toBeGreaterThan(0);

    const issues = await request(`/api/repos/${owner}/${repositoryName}/issues`);
    expect(issues.status).toBe(200);
    const issue = issues.body.find((candidate: any) => candidate.alerts.includes(alertNumber));
    expect(issue, `Alert #${alertNumber} was not returned as an open npm Dependabot issue`).toBeTruthy();
    expect(issue.alerts[0], 'Choose the first alert number on a grouped PatchPilot issue').toBe(alertNumber);
    if (process.env.E2E_GITHUB_PACKAGE) expect(issue.packageName).toBe(process.env.E2E_GITHUB_PACKAGE);

    const groupingStarted = await request(`/api/repos/${owner}/${repositoryName}/work-items/auto-group`, {
      method: 'POST',
      body: JSON.stringify({ projectPath, maxGroupSize: 2, provider: 'gemini' })
    });
    expect(groupingStarted.status, JSON.stringify(groupingStarted.body)).toBe(202);
    const groupingJob = await waitForGroupingJob(groupingStarted.body.id);
    expect(groupingJob.status, groupingJob.error).toBe('succeeded');
    expect(groupingJob.provider).toBe('gemini');
    expect(groupingJob.steps.every(step => step.status === 'completed')).toBe(true);
    expect(groupingJob.artifacts?.llmRequest?.model).toBeTruthy();
    const workItem = groupingJob.workItems?.find(candidate => candidate.issueIds.includes(issue.id));
    expect(workItem, `Gemini did not place ${issue.id} into a work item`).toBeTruthy();
    expect(workItem!.grouping).toMatchObject({ source: 'ai', model: groupingJob.artifacts!.llmRequest!.model });

    generatedBranch = workItem!.branch;
    expect(generatedBranch).toMatch(/^security-fix\/dependabot\//);
    expect(await github.findPullRequestByBranch(owner, repositoryName, generatedBranch), `An open PR already uses ${generatedBranch}`).toBeUndefined();
    const remoteBranch = await exec('git', ['-C', projectPath, 'ls-remote', '--heads', 'origin', `refs/heads/${generatedBranch}`]);
    expect(remoteBranch.stdout.trim(), `Remote branch already exists: ${generatedBranch}`).toBe('');
    ownsGeneratedBranch = true;

    const fixStarted = await request(`/api/work-items/${workItem!.id}/actions/fix`, {
      method: 'POST',
      body: JSON.stringify({
        projectPath,
        force: true,
        agent: { provider: 'cursor', skill: 'dependency-security-fix' }
      })
    });
    expect(fixStarted.status, JSON.stringify(fixStarted.body)).toBe(202);
    const fixJob = await waitForJob(fixStarted.body.id);
    expect(fixJob.status, `${fixJob.error || ''}\n${fixJob.log}`).toBe('succeeded');
    expect(fixJob.agent).toEqual({ provider: 'cursor', skill: 'dependency-security-fix' });
    expect(fixJob.log).toContain('agent_provider: cursor');
    expect(fixJob.log).toContain('agent_skill: dependency-security-fix');
    expect(fixJob.result).toMatchObject({ branch: generatedBranch, commitSha: expect.any(String), worktreePath: expect.any(String) });
    await waitForWorkItemState(workItem!.id, 'ready_for_pr');

    const published = await request(`/api/work-items/${workItem!.id}/actions/create-pr`, {
      method: 'POST',
      body: JSON.stringify({ projectPath })
    });
    expect(published.status, JSON.stringify(published.body)).toBe(202);
    const publishJob = await waitForJob(published.body.id);
    const pullRequestNumber = Number(publishJob.result?.prUrl?.match(/\/pull\/(\d+)/)?.[1]);
    if (pullRequestNumber) createdPullRequest = pullRequestNumber;
    expect(publishJob.status, `${publishJob.error || ''}\n${publishJob.log}`).toBe('succeeded');
    expect(publishJob.result).toMatchObject({ branch: generatedBranch, commitSha: fixJob.result!.commitSha, prUrl: expect.stringContaining(`github.com/${repository}/pull/`) });

    const pullRequest = await github.findPullRequestByBranch(owner, repositoryName, generatedBranch);
    expect(pullRequest).toMatchObject({ head: { ref: generatedBranch, sha: fixJob.result!.commitSha } });
    createdPullRequest = pullRequest!.number;
  });
});
