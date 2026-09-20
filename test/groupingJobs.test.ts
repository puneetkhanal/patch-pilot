import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@cursor/sdk';
import { loadConfig } from '../src/config/env.js';
import { JsonRepository } from '../src/repository/jsonRepository.js';
import { BatchService } from '../src/services/batches.js';
import { GroupingJobManager } from '../src/services/groupingJobs.js';
import { TrackerIssue } from '../src/domain/types.js';

vi.mock('@cursor/sdk', () => ({ Agent: { prompt: vi.fn() } }));

const dirs: string[] = [];
const now = '2026-09-18T12:00:00.000Z';

function issue(id: string, packageName = id): TrackerIssue {
  return { id, repo: 'owner/repo', title: id, state: 'TRIAGED', alerts: [1], packageName, ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: '1.1.0', vulnerableVersionRange: '<1.1.0', severity: 'high', severityScore: 8, complexity: 'low', pr: { branch: `security/${id}` }, remediation: {}, history: [], notes: [], labels: [], createdAt: now, updatedAt: now };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function waitForJob(manager: GroupingJobManager, id: string) {
  let job = manager.get(id);
  while (job && ['queued', 'running'].includes(job.status)) {
    await new Promise(resolve => setTimeout(resolve, 20));
    job = manager.get(id);
  }
  return job!;
}

describe('GroupingJobManager', () => {
  it('runs dependency analysis, import context, AI grouping, and work-item creation with visible steps', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-grouping-job-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', dependencies: { one: '^1.0.0', two: '^1.0.0' } }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/one': { version: '1.0.0' }, 'node_modules/two': { version: '1.0.0' } } }));
    await fs.writeFile(path.join(dir, 'index.js'), "import one from 'one';\nconst two = require('two');\n");
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const issues = [issue('issue-1', 'one'), issue('issue-2', 'two')];
    await repository.upsertIssues('owner/repo', issues);
    vi.mocked(Agent.prompt).mockResolvedValue({
      status: 'finished',
      result: JSON.stringify({ groups: [{ issueIds: issues.map(value => value.id), safetyScore: 90, safetyLevel: 'safe', summary: 'Compatible', rationale: ['Shared manifest'], requiresHumanReview: false, humanReviewIssueIds: [], humanReviewReasons: [] }] }),
      id: 'cursor-grouping-run',
      model: { id: 'composer-2.5' }
    } as any);
    const config = loadConfig({ GH_TOKEN: 'test', CURSOR_API_KEY: 'cursor-key', CURSOR_MODEL: 'composer-2.5', ORCHESTRATOR_DEFAULT_PROJECT_PATH: dir });
    const batches = new BatchService(repository);
    const manager = new GroupingJobManager(repository, batches, config);
    const started = manager.start({ repo: 'owner/repo', projectPath: dir, maxGroupSize: 3, provider: 'cursor' });
    const job = await waitForJob(manager, started.id);
    expect(job.status).toBe('succeeded');
    expect(job.steps.map(step => step.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
    expect(job.workItems).toHaveLength(1);
    expect(job.workItems![0].grouping).toMatchObject({ source: 'ai', safetyScore: 90 });
    const saved = await repository.getIssue('issue-1', 'owner/repo');
    expect(saved?.lastUpgradeAnalysis?.dependencyGraph.nodes.length).toBeGreaterThan(0);
    expect(job.artifacts?.dependencyAnalysis).toHaveLength(2);
    expect(job.artifacts?.collectedEvidence?.manifests).toBeTruthy();
    expect(job.artifacts?.llmRequest?.prompt).toContain('packageTargetOverlaps');
    expect(job.artifacts?.llmRequest?.prompt).toContain('dependencyGraph');
    expect(job.artifacts?.llmRequest?.prompt).toContain('breakingChanges');
    expect(job.artifacts?.llmRequest?.input).toBeTruthy();
    expect(job.artifacts?.llmRequest?.groups).toHaveLength(1);
    expect(job.artifacts?.llmRequest?.corrections?.map(correction => correction.code)).toContain('rationale_replaced');
  });

  it('marks the active step failed when AI grouping throws', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-grouping-job-fail-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', dependencies: { one: '^1.0.0' } }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/one': { version: '1.0.0' } } }));
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    await repository.upsertIssues('owner/repo', [issue('issue-1', 'one')]);
    vi.mocked(Agent.prompt).mockResolvedValue({ status: 'failed', error: { message: 'model unavailable' } } as any);
    const config = loadConfig({ GH_TOKEN: 'test', CURSOR_API_KEY: 'cursor-key', CURSOR_MODEL: 'composer-2.5', ORCHESTRATOR_DEFAULT_PROJECT_PATH: dir });
    const batches = new BatchService(repository);
    const existing = await batches.create('owner/repo', ['issue-1']);
    existing.grouping = { source: 'ai', rationale: ['Existing AI group'] };
    await repository.saveBatch(existing);
    const manager = new GroupingJobManager(repository, batches, config);
    const started = manager.start({ repo: 'owner/repo', projectPath: dir, maxGroupSize: 3, provider: 'cursor' });
    const job = await waitForJob(manager, started.id);
    expect(job.status).toBe('failed');
    expect(job.steps.find(step => step.id === 'ai_grouping')).toMatchObject({ status: 'failed' });
    expect(job.error).toContain('model unavailable');
    expect(await repository.getBatch(existing.id)).toBeTruthy();
  });

  it('completes an empty grouping job without calling a provider', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-grouping-empty-'));
    dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const manager = new GroupingJobManager(repository, new BatchService(repository), loadConfig({ GH_TOKEN: 'test', CURSOR_API_KEY: 'cursor-key', CURSOR_MODEL: 'composer-2.5', ORCHESTRATOR_DEFAULT_PROJECT_PATH: dir }));
    const job = await waitForJob(manager, manager.start({ repo: 'owner/repo', projectPath: dir, maxGroupSize: 3, provider: 'cursor' }).id);
    expect(job).toMatchObject({ status: 'succeeded', totalIssues: 0, workItems: [] });
    expect(job.steps.every(step => step.status === 'completed')).toBe(true);
    expect(job.steps.filter(step => step.id !== 'collect_issues').every(step => step.detail === 'No eligible issues')).toBe(true);
    expect(Agent.prompt).not.toHaveBeenCalled();
  });
});
