import { describe, expect, it } from 'vitest';
import { TrackerIssue } from '../src/domain/types.js';
import { recordAiAnalysis, recordDependencyAnalysis } from '../src/services/analysisTracking.js';

function issue(): TrackerIssue {
  const now = new Date().toISOString();
  return { id: 'issue', repo: 'owner/repo', title: 'alpha', state: 'NEW', alerts: [1], packageName: 'alpha', ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: '1.0.1', vulnerableVersionRange: '<1.0.1', severity: 'high', severityScore: 8, complexity: 'low', pr: { branch: 'security/alpha' }, remediation: {}, history: [{ at: now, to: 'NEW', actor: 'test' }], notes: [], labels: [], updatedAt: now, createdAt: now };
}

describe('analysis tracking', () => {
  it('keeps dependency-engine and AI runs in separate histories', () => {
    const target = issue();
    const dependency = { riskLevel: 'safe' as const, safetyScore: 100, confidence: 'high' as const, needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: '2026-01-01T00:00:00.000Z' };
    const ai = { riskLevel: 'safe' as const, safetyScore: 95, confidence: 'high' as const, needsAdditionalBumps: false, summary: 'Compatible', steps: [], breakingChanges: [], verificationChecks: [], model: 'composer-2.5', analyzedAt: '2026-01-01T00:01:00.000Z' };

    recordDependencyAnalysis(target, dependency);
    recordAiAnalysis(target, ai);

    expect(target.lastUpgradeAnalysis).toBe(dependency);
    expect(target.lastAiAnalysis).toBe(ai);
    expect(target.analysisHistory?.dependencyEngine).toEqual([dependency]);
    expect(target.analysisHistory?.ai).toEqual([ai]);
  });

  it('retains only the latest twenty runs per track', () => {
    const target = issue();
    for (let index = 0; index < 22; index++) recordDependencyAnalysis(target, { riskLevel: 'safe', needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: String(index) });
    expect(target.analysisHistory?.dependencyEngine).toHaveLength(20);
    expect(target.analysisHistory?.dependencyEngine[0].analyzedAt).toBe('2');
    expect(target.lastUpgradeAnalysis?.analyzedAt).toBe('21');
  });
});
