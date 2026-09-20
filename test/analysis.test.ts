import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@cursor/sdk';
import { Config } from '../src/config/env.js';
import { TrackerIssue } from '../src/domain/types.js';
import { analyzeUpgrade, analyzeUpgradeWithAi, buildRepositoryAnalysis } from '../src/services/analysis.js';

vi.mock('@cursor/sdk', () => ({ Agent: { prompt: vi.fn() } }));

const dirs: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe('upgrade analysis', () => {
  it('builds meaningful edges from package-lock metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-analysis-')); dirs.push(dir);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0', dependencies: { alpha: '^1.0.0' } }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { alpha: '^1.0.0' } }, 'node_modules/alpha': { version: '1.0.0', dependencies: { beta: '^1.0.0' } }, 'node_modules/beta': { version: '1.0.0' } } }));
    const now = new Date().toISOString();
    const issue: TrackerIssue = { id: 'issue-npm-alpha-2-0-0', repo: 'owner/repo', title: 'alpha', state: 'NEW', alerts: [1], packageName: 'alpha', ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: '2.0.0', vulnerableVersionRange: '<2', severity: 'high', severityScore: 8, complexity: 'medium', pr: { branch: 'security/alpha' }, remediation: {}, history: [{ at: now, to: 'NEW', actor: 'test' }], notes: [], labels: [], updatedAt: now, createdAt: now };
    const result = await analyzeUpgrade(issue, dir);
    expect(result.dependencyGraph.edges).toContainEqual({ from: 'alpha', to: 'beta', kind: 'runtime' });
    expect(result.riskLevel).toBe('risky');
    expect(result.safetyScore).toBe(55);
    expect(result.confidence).toBe('high');
  });

  it('rates a locked patch upgrade safe and aggregates a ranked repository report', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-analysis-')); dirs.push(dir);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0', dependencies: { alpha: '^1.0.0' } }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { alpha: '^1.0.0' } }, 'node_modules/alpha': { version: '1.0.0' } } }));
    const now = new Date().toISOString();
    const issue: TrackerIssue = { id: 'issue-npm-alpha-1-0-1', repo: 'owner/repo', title: 'alpha', state: 'NEW', alerts: [1], packageName: 'alpha', ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: '1.0.1', vulnerableVersionRange: '<1.0.1', severity: 'high', severityScore: 8, complexity: 'low', pr: { branch: 'security/alpha' }, remediation: {}, history: [{ at: now, to: 'NEW', actor: 'test' }], notes: [], labels: [], updatedAt: now, createdAt: now };
    issue.lastUpgradeAnalysis = await analyzeUpgrade(issue, dir);

    expect(issue.lastUpgradeAnalysis).toMatchObject({ riskLevel: 'safe', safetyScore: 100, confidence: 'high', needsAdditionalBumps: false });
    expect(issue.lastUpgradeAnalysis.dependencyGraph.nodes).toContainEqual(expect.objectContaining({ id: 'alpha', version: '1.0.0', requestedVersion: '^1.0.0', direct: true }));
    const report = buildRepositoryAnalysis(issue.repo, dir, [issue]);
    expect(report.summary).toMatchObject({ safe: 1, risky: 0, not_analyzed: 0 });
    expect(report.dependencies[0]).toMatchObject({ packageName: 'alpha', safetyScore: 100, currentVersion: '1.0.0' });
  });

  it('maps legacy risk labels to nonzero display scores', () => {
    const now = new Date().toISOString();
    const issue = { id: 'legacy', repo: 'owner/repo', packageName: 'alpha', patchedVersion: '2.0.0', manifestPath: 'package.json', lastUpgradeAnalysis: { riskLevel: 'likely_safe', needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: now } } as TrackerIssue;
    expect(buildRepositoryAnalysis(issue.repo, '/tmp/project', [issue]).dependencies[0].safetyScore).toBe(75);
  });

  it('uses a parent workspace lockfile for a nested manifest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-analysis-')); dirs.push(dir);
    await fs.mkdir(path.join(dir, 'apps/web'), { recursive: true });
    await fs.writeFile(path.join(dir, 'apps/web/package.json'), JSON.stringify({ name: 'web', dependencies: { alpha: '^1.0.0' } }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/alpha': { version: '1.0.0' } } }));
    const now = new Date().toISOString();
    const issue: TrackerIssue = { id: 'issue-npm-alpha-1-0-1', repo: 'owner/repo', title: 'alpha', state: 'NEW', alerts: [1], packageName: 'alpha', ecosystem: 'npm', manifestPath: 'apps/web/package.json', patchedVersion: '1.0.1', vulnerableVersionRange: '<1.0.1', severity: 'high', severityScore: 8, complexity: 'low', pr: { branch: 'security/alpha' }, remediation: {}, history: [{ at: now, to: 'NEW', actor: 'test' }], notes: [], labels: [], updatedAt: now, createdAt: now };
    const result = await analyzeUpgrade(issue, dir);
    expect(result.findings).not.toContainEqual(expect.objectContaining({ code: 'LOCKFILE_UNREADABLE' }));
    expect(result.confidence).toBe('high');
  });

  it('runs the primary AI analysis through the Cursor SDK with Composer 2.5 and read-only tools', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-cursor-analysis-')); dirs.push(dir);
    const now = new Date().toISOString();
    const issue = { id: 'issue-npm-alpha-1-0-1', repo: 'owner/repo', title: 'alpha', state: 'NEW', alerts: [1], packageName: 'alpha', ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: '1.0.1', vulnerableVersionRange: '<1.0.1', severity: 'high', severityScore: 8, complexity: 'low', pr: { branch: 'security/alpha' }, remediation: {}, history: [{ at: now, to: 'NEW', actor: 'test' }], notes: [], labels: [], updatedAt: now, createdAt: now } as TrackerIssue;
    vi.mocked(Agent.prompt).mockResolvedValue({ status: 'finished', result: JSON.stringify({ riskLevel: 'safe', safetyScore: 96, confidence: 'high', needsAdditionalBumps: false, summary: 'Compatible usage', steps: ['Upgrade alpha'], breakingChanges: [], verificationChecks: ['Run tests'] }), id: 'cursor-run-1', durationMs: 42, model: { id: 'composer-2.5' } } as any);

    const result = await analyzeUpgradeWithAi(issue, dir, { cursorApiKey: 'cursor-key', cursorModel: 'composer-2.5' } as Config);

    expect(Agent.prompt).toHaveBeenCalledWith(expect.stringContaining('Inspect the repository'), expect.objectContaining({
      apiKey: 'cursor-key',
      model: { id: 'composer-2.5' },
      tools: ['read', 'grep', 'glob', 'ls', 'readLints', 'semSearch'],
      local: { cwd: path.resolve(dir), sandboxOptions: { enabled: true } }
    }));
    expect(result).toMatchObject({ provider: 'cursor', model: 'composer-2.5', runId: 'cursor-run-1', durationMs: 42, riskLevel: 'safe', safetyScore: 96, summary: 'Compatible usage' });
  });

  it('runs primary AI analysis through Gemini with pre-collected repository context', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-gemini-analysis-')); dirs.push(dir);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0', dependencies: { alpha: '^1.0.0' } }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/alpha': { version: '1.0.0' } } }));
    await fs.writeFile(path.join(dir, 'index.js'), "import alpha from 'alpha';\nconsole.log(alpha);\n");
    const now = new Date().toISOString();
    const issue = { id: 'issue-npm-alpha-1-0-1', repo: 'owner/repo', title: 'alpha', state: 'NEW', alerts: [1], packageName: 'alpha', ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: '1.0.1', vulnerableVersionRange: '<1.0.1', severity: 'high', severityScore: 8, complexity: 'low', pr: { branch: 'security/alpha' }, remediation: {}, history: [{ at: now, to: 'NEW', actor: 'test' }], notes: [], labels: [], updatedAt: now, createdAt: now } as TrackerIssue;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ riskLevel: 'safe', safetyScore: 91, confidence: 'high', needsAdditionalBumps: false, summary: 'Gemini compatible', steps: ['Upgrade alpha'], breakingChanges: [], verificationChecks: ['Run tests'] }) }] } }] })
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await analyzeUpgradeWithAi(issue, dir, { geminiApiKey: 'gemini-key', geminiModel: 'gemini-3.6-flash', cursorModel: 'composer-2.5' } as Config, undefined, 'gemini');

    expect(fetchMock).toHaveBeenCalled();
    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-3.6-flash', riskLevel: 'safe', safetyScore: 91, summary: 'Gemini compatible' });
    vi.unstubAllGlobals();
  });
});
