import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@cursor/sdk';
import { Config } from '../src/config/env.js';
import { TrackerIssue } from '../src/domain/types.js';
import { JsonRepository } from '../src/repository/jsonRepository.js';
import { BatchService } from '../src/services/batches.js';

vi.mock('@cursor/sdk', () => ({ Agent: { prompt: vi.fn() } }));

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
function issue(id: string, name: string): TrackerIssue { const now = new Date().toISOString(); return { id, repo: 'owner/repo', title: name, state: 'TRIAGED', alerts: [Number(id.slice(-1))], packageName: name, ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: '2.0.0', vulnerableVersionRange: '<2', severity: 'high', severityScore: 8, complexity: 'medium', pr: { branch: `security/${name}` }, remediation: {}, history: [{ at: now, to: 'TRIAGED', actor: 'test' }], notes: [], labels: [], updatedAt: now, createdAt: now }; }
function analyzed(value: TrackerIssue, riskLevel: 'safe' | 'likely_safe' | 'risky' = 'safe') { value.lastUpgradeAnalysis = { riskLevel, safetyScore: riskLevel === 'safe' ? 100 : 75, confidence: 'high', recommendation: 'Test it.', needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: new Date().toISOString() }; return value; }

describe('BatchService', () => {
  it('creates a 2-issue npm batch and transitions members', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-batch-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const first = issue('issue-1', 'one'), second = issue('issue-2', 'two');
    await repository.upsertIssues('owner/repo', [first, second]);
    const batch = await new BatchService(repository).create('owner/repo', [first.id, second.id]);
    expect(batch.issueIds).toHaveLength(2);
    expect((await repository.getIssue(first.id, first.repo))?.state).toBe('PLANNED_BATCH');
  });

  it('creates a single-issue work item so risky dependencies can be isolated', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-batch-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const first = issue('issue-1', 'one'), second = issue('issue-2', 'two');
    first.lastUpgradeAnalysis = { riskLevel: 'unsafe', needsAdditionalBumps: true, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: new Date().toISOString() };
    await repository.upsertIssues('owner/repo', [first, second]);
    const workItem = await new BatchService(repository).create('owner/repo', [first.id]);
    expect(workItem.issueIds).toEqual([first.id]);
    expect(workItem.grouping?.source).toBe('manual');
  });

  it('auto-groups analyzed safe issues using the requested maximum without orphan groups', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-batch-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const issues = Array.from({ length: 7 }, (_, index) => analyzed(issue(`issue-${index + 1}`, `package-${index + 1}`), index === 0 ? 'likely_safe' : 'safe'));
    await repository.upsertIssues('owner/repo', issues);
    const batches = await new BatchService(repository).compose('owner/repo', 3);
    expect(batches.map(batch => batch.issueIds.length)).toEqual([3, 3, 1]);
    expect(batches.every(batch => batch.grouping?.source === 'dependency_engine' && batch.grouping.maxGroupSize === 3)).toBe(true);
    expect(batches.flatMap(batch => batch.issueIds)).toHaveLength(7);
  });

  it('recomputes dependency-engine draft groups when the maximum changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-batch-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const issues = Array.from({ length: 6 }, (_, index) => analyzed(issue(`issue-${index + 1}`, `package-${index + 1}`)));
    await repository.upsertIssues('owner/repo', issues);
    const service = new BatchService(repository);
    expect((await service.compose('owner/repo', 2))).toHaveLength(3);
    const recomputed = await service.compose('owner/repo', 3);
    expect(recomputed.map(batch => batch.issueIds.length)).toEqual([3, 3]);
    expect(await repository.listBatches('owner/repo')).toHaveLength(2);
  });

  it('moves issues between draft work items and deletes an empty source', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-batch-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const first = issue('issue-1', 'one'), second = issue('issue-2', 'two');
    await repository.upsertIssues('owner/repo', [first, second]);
    const service = new BatchService(repository);
    const source = await service.create('owner/repo', [first.id]);
    const target = await service.create('owner/repo', [second.id]);
    await service.moveIssue('owner/repo', first.id, target.id);
    expect(await repository.getBatch(source.id)).toBeUndefined();
    expect((await repository.getBatch(target.id))?.issueIds).toEqual([second.id, first.id]);
    expect((await repository.getBatch(target.id))?.grouping?.source).toBe('manual');
  });

  it('moves an issue back to the unassigned pool', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-batch-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const first = issue('issue-1', 'one');
    await repository.upsertIssues('owner/repo', [first]);
    const service = new BatchService(repository);
    await service.create('owner/repo', [first.id]);
    await service.moveIssue('owner/repo', first.id);
    expect(await repository.listBatches('owner/repo')).toEqual([]);
    expect((await repository.getIssue(first.id, first.repo))?.state).toBe('TRIAGED');
  });

  it('resets every work item and releases active member issues', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-batch-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const first = issue('issue-1', 'one'), second = issue('issue-2', 'two');
    await repository.upsertIssues('owner/repo', [first, second]);
    const service = new BatchService(repository);
    const draft = await service.create('owner/repo', [first.id]);
    const active = await service.create('owner/repo', [second.id]);
    active.state = 'ready_for_pr';
    await repository.saveBatch(active);

    expect(await service.reset('owner/repo')).toEqual({ removed: 2, releasedIssues: 2 });
    expect(await repository.listBatches('owner/repo')).toEqual([]);
    expect((await repository.getIssue(first.id, first.repo))?.state).toBe('TRIAGED');
    expect((await repository.getIssue(second.id, second.repo))?.state).toBe('TRIAGED');
    expect(await repository.getBatch(draft.id)).toBeUndefined();
  });

  it('allows overlapping tracked alerts beyond ten when fix targets stay within the limit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-batch-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const axiosVersions = ['1.15.2', '1.16.0', '1.17.0', '1.18.0', '1.19.0', '1.20.0', '1.21.0', '1.22.0', '1.23.0', '1.24.0', '1.25.0'];
    const axiosIssues = axiosVersions.map((version, index) => analyzed({ ...issue(`issue-${index + 1}`, 'axios'), patchedVersion: version, alerts: [index + 1] }));
    const lodash = analyzed(issue('issue-lodash', 'lodash'));
    await repository.upsertIssues('owner/repo', [...axiosIssues, lodash]);
    const workItem = await new BatchService(repository).create('owner/repo', [...axiosIssues.map(value => value.id), lodash.id]);
    expect(workItem.issueIds).toHaveLength(12);
    expect(workItem.issueIds).toContain('issue-lodash');
  });

  it('persists AI safety ranking on generated work items', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-batch-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const issues = [analyzed(issue('issue-1', 'one')), analyzed(issue('issue-2', 'two')), analyzed(issue('issue-3', 'three'))];
    await repository.upsertIssues('owner/repo', issues);
    vi.mocked(Agent.prompt).mockResolvedValue({ status: 'finished', result: JSON.stringify({ groups: [{ issueIds: issues.map(value => value.id), safetyScore: 91, safetyLevel: 'safe', summary: 'Low conflict risk', rationale: ['package.json has no graph conflicts'], requiresHumanReview: true, humanReviewIssueIds: ['issue-1'], humanReviewReasons: ['Operator must verify the package-specific migration'] }] }), id: 'cursor-grouping-run', model: { id: 'composer-2.5' } } as any);
    const config = { cursorApiKey: 'cursor-key', cursorModel: 'composer-2.5' } as Config;
    const workItems = await new BatchService(repository).composeWithAi('owner/repo', config, dir, 3);
    expect(workItems).toHaveLength(1);
    expect(workItems[0].grouping).toMatchObject({ source: 'ai', safetyRank: 1, safetyScore: 91, safetyLevel: 'safe', safetySummary: 'Low conflict risk', model: 'composer-2.5' });
    expect(workItems[0].grouping?.humanReviewIssueIds).toContain('issue-1');
    expect(workItems[0].grouping?.humanReviewReasons).toContain('Operator must verify the package-specific migration');
  });
});
