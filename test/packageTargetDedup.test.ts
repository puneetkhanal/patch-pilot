import { describe, expect, it } from 'vitest';
import { TrackerIssue } from '../src/domain/types.js';
import { attachSupersededIssueIds, classifyPackageTargetOverlaps, collectPrimaryBatchAlerts, countFixTargets, uniquePackageTargetIssueIds } from '../src/services/packageTargetDedup.js';
import { normalizeAiWorkItemGroups } from '../src/services/workItemGrouping.js';

const now = '2026-09-18T12:00:00.000Z';

function issue(id: string, packageName: string, version: string): TrackerIssue {
  return { id, repo: 'owner/repo', title: `${packageName} → ${version}`, state: 'TRIAGED', alerts: [Number(id.replace(/\D/g, '') || 1)], packageName, ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: version, vulnerableVersionRange: `<${version}`, severity: 'high', severityScore: 8, complexity: 'low', pr: { branch: `security/${id}` }, remediation: {}, history: [], notes: [], labels: [], createdAt: now, updatedAt: now };
}

describe('package target deduplication', () => {
  it('classifies overlapping axios targets and keeps the highest version primary', () => {
    const issues = [issue('a1', 'axios', '1.15.2'), issue('a2', 'axios', '1.16.0'), issue('a3', 'axios', '1.18.0'), issue('l1', 'lodash', '4.17.21')];
    const classification = classifyPackageTargetOverlaps(issues);
    expect(classification.primaryIssues.map(value => value.id).sort()).toEqual(['a3', 'l1']);
    expect(classification.supersededBy.get('a1')).toBe('a3');
    expect(classification.supersededBy.get('a2')).toBe('a3');
    expect(classification.overlaps).toHaveLength(1);
    expect(classification.overlaps[0]).toMatchObject({ primaryIssueId: 'a3', primaryTargetVersion: '1.18.0', supersededIssueIds: ['a2', 'a1'] });
  });

  it('collapses duplicate package targets in AI groups and re-attaches superseded alerts', () => {
    const issues = [issue('a1', 'axios', '1.15.2'), issue('a2', 'axios', '1.16.0'), issue('a3', 'axios', '1.18.0'), issue('l1', 'lodash', '4.17.21')];
    for (const value of issues) value.lastUpgradeAnalysis = { riskLevel: 'safe', safetyScore: 100, confidence: 'high', needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: now };
    const groups = normalizeAiWorkItemGroups({ groups: [{ issueIds: ['a1', 'a2', 'a3', 'l1'], safetyScore: 90, safetyLevel: 'safe', summary: 'Compatible', rationale: ['Shared manifest'] }] }, issues, 3);
    expect(groups[0].issueIds.sort()).toEqual(['a1', 'a2', 'a3', 'l1']);
    expect(uniquePackageTargetIssueIds(groups[0].issueIds, new Map(issues.map(value => [value.id, value]))).sort()).toEqual(['a3', 'l1']);
  });

  it('collects alerts only from primary fix targets for batch remediation', () => {
    const issues = [issue('a1', 'axios', '1.15.2'), issue('a2', 'axios', '1.16.0'), issue('a3', 'axios', '1.18.0')];
    expect(collectPrimaryBatchAlerts(issues)).toBe('3');
  });

  it('counts fix targets separately from overlapping tracked alerts', () => {
    const issues = [issue('a1', 'axios', '1.15.2'), issue('a2', 'axios', '1.16.0'), issue('a3', 'axios', '1.18.0'), issue('l1', 'lodash', '4.17.21')];
    expect(countFixTargets(issues)).toBe(2);
  });

  it('expands grouped primary ids with superseded tracker issues', () => {
    const classification = classifyPackageTargetOverlaps([issue('a1', 'axios', '1.15.2'), issue('a3', 'axios', '1.18.0')]);
    const expanded = attachSupersededIssueIds([{ issueIds: ['a3'] }], classification.supersededBy);
    expect(expanded[0].issueIds.sort()).toEqual(['a1', 'a3']);
  });
});
