import { describe, expect, it } from 'vitest';
import { TrackerIssue } from '../src/domain/types.js';
import { assessGroupHumanReview, assessIssueHumanReview } from '../src/services/humanReview.js';
import { normalizeAiWorkItemGroups } from '../src/services/workItemGrouping.js';

const now = '2026-09-18T12:00:00.000Z';
function issue(id: string, overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id,
    repo: 'owner/repo',
    title: id,
    state: 'TRIAGED',
    alerts: [1],
    packageName: id,
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
    updatedAt: now,
    ...overrides
  };
}

describe('human review assessment', () => {
  it('flags unanalyzed, risky, and breaking-change issues', () => {
    const safe = issue('safe', {
      lastUpgradeAnalysis: { riskLevel: 'safe', safetyScore: 100, confidence: 'high', recommendation: 'Proceed', needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: now },
      lastAiAnalysis: { riskLevel: 'safe', safetyScore: 100, confidence: 'high', recommendation: 'Proceed', needsAdditionalBumps: false, breakingChanges: [], verificationChecks: [], summary: 'ok', analyzedAt: now, provider: 'gemini', model: 'gemini-3.6-flash' }
    });
    const risky = issue('risky', {
      lastUpgradeAnalysis: { riskLevel: 'risky', safetyScore: 40, confidence: 'medium', recommendation: 'Review', needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: now },
      lastAiAnalysis: { riskLevel: 'risky', safetyScore: 40, confidence: 'medium', recommendation: 'Review', needsAdditionalBumps: false, breakingChanges: ['Major API change'], verificationChecks: [], summary: 'risky', analyzedAt: now, provider: 'gemini', model: 'gemini-3.6-flash' }
    });
    const unanalyzed = issue('unanalyzed');

    expect(assessIssueHumanReview(safe).requiresHumanReview).toBe(false);
    expect(assessIssueHumanReview(risky).reasons).toEqual(expect.arrayContaining([
      'AI rated this upgrade risky',
      'Dependency engine rated this upgrade risky',
      'AI reported 1 potential breaking change'
    ]));
    expect(assessIssueHumanReview(unanalyzed).reasons).toEqual(expect.arrayContaining([
      'Dependency analysis has not been completed',
      'AI upgrade analysis has not been completed'
    ]));

    const group = assessGroupHumanReview(['safe', 'risky', 'unanalyzed'], new Map([safe, risky, unanalyzed].map(entry => [entry.id, entry])));
    expect(group.requiresHumanReview).toBe(true);
    expect(group.humanReviewIssueIds).toEqual(['risky', 'unanalyzed']);
  });

  it('merges AI human-review flags into normalized groups', () => {
    const first = issue('one', {
      lastUpgradeAnalysis: { riskLevel: 'safe', safetyScore: 100, confidence: 'high', recommendation: 'Proceed', needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: now }
    });
    const second = issue('two', {
      lastUpgradeAnalysis: { riskLevel: 'safe', safetyScore: 100, confidence: 'high', recommendation: 'Proceed', needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: now }
    });
    const groups = normalizeAiWorkItemGroups({
      groups: [{
        issueIds: ['one', 'two'],
        safetyScore: 70,
        safetyLevel: 'likely_safe',
        summary: 'Mixed evidence',
        rationale: ['Shared manifest'],
        requiresHumanReview: true,
        humanReviewIssueIds: ['one'],
        humanReviewReasons: ['Missing AI analysis on axios']
      }]
    }, [first, second], 3);
    expect(groups[0]).toMatchObject({
      issueIds: ['one', 'two'],
      requiresHumanReview: true,
      humanReviewIssueIds: expect.arrayContaining(['one', 'two'])
    });
  });
});
