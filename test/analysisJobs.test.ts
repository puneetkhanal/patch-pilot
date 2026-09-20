import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { TrackerIssue } from '../src/domain/types.js';
import { JsonRepository } from '../src/repository/jsonRepository.js';
import { AnalysisJobManager } from '../src/services/analysisJobs.js';

vi.mock('../src/services/analysis.js', () => ({
  analyzeUpgradeWithAi: vi.fn(async issue => {
    await new Promise(resolve => setTimeout(resolve, 25));
    return {
    riskLevel: 'safe',
    safetyScore: 100,
    confidence: 'high',
    recommendation: 'Proceed',
    needsAdditionalBumps: false,
    breakingChanges: [],
    verificationChecks: [],
    summary: `Analyzed ${issue.packageName}`,
    analyzedAt: new Date().toISOString(),
    provider: 'gemini',
    model: 'gemini-3.6-flash'
    };
  }),
  analyzeUpgrade: vi.fn(),
  vetUpgradeWithCursor: vi.fn(),
  verifyUpgradeWithLlm: vi.fn()
}));

const dirs: string[] = [];
const now = '2026-09-18T12:00:00.000Z';

function issue(id: string, packageName: string): TrackerIssue {
  return {
    id,
    repo: 'owner/repo',
    title: id,
    state: 'TRIAGED',
    alerts: [1],
    packageName,
    ecosystem: 'npm',
    manifestPath: 'package.json',
    patchedVersion: '2.0.0',
    vulnerableVersionRange: '<2',
    severity: 'high',
    severityScore: 8,
    complexity: 'low',
    pr: { branch: `security/${id}` },
    remediation: {},
    history: [],
    notes: [],
    labels: [],
    createdAt: now,
    updatedAt: now
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function waitForAnalysisJob(manager: AnalysisJobManager, id: string) {
  let job = manager.get(id);
  while (job && ['queued', 'running'].includes(job.status)) {
    await new Promise(resolve => setTimeout(resolve, 20));
    job = manager.get(id);
  }
  return job!;
}

describe('AnalysisJobManager', () => {
  it('tracks currentPackageName while analyzing each issue', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-analysis-job-'));
    dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    const issues = [issue('issue-1', 'axios'), issue('issue-2', 'lodash')];
    await repository.upsertIssues('owner/repo', issues);
    const config = loadConfig({ GH_TOKEN: 'test', GEMINI_API_KEY: 'gemini-key', ORCHESTRATOR_DEFAULT_PROJECT_PATH: dir });
    const manager = new AnalysisJobManager(repository, config);
    const started = manager.start({ repo: 'owner/repo', projectPath: dir, useAi: true, issueIds: issues.map(value => value.id), provider: 'gemini' });

    let sawPackageName = false;
    while (true) {
      const current = manager.get(started.id);
      if (!current) break;
      if (current.currentPackageName) sawPackageName = true;
      if (!['queued', 'running'].includes(current.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const job = await waitForAnalysisJob(manager, started.id);
    expect(sawPackageName).toBe(true);
    expect(job.status).toBe('succeeded');
    expect(job.currentPackageName).toBeUndefined();
    expect(job.completed).toBe(2);
  });
});
