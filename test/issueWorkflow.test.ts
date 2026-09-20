import { describe, expect, it } from 'vitest';
import { FixJob, TrackerIssue } from '../src/domain/types.js';
import { buildIssueWorkflow } from '../src/services/issueWorkflow.js';

const now = '2026-09-17T12:00:00.000Z';
function issue(): TrackerIssue {
  return { id: 'issue-1', repo: 'owner/repo', title: 'alpha → 2.0.0', state: 'NEW', alerts: [1], packageName: 'alpha', ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: '2.0.0', vulnerableVersionRange: '<2', severity: 'high', severityScore: 8, complexity: 'medium', pr: { branch: 'security/alpha' }, remediation: {}, history: [{ at: now, to: 'NEW', actor: 'test' }], notes: [], labels: [], createdAt: now, updatedAt: now };
}
function job(overrides: Partial<FixJob> = {}): FixJob {
  return { id: 'fix-123', kind: 'fix', status: 'succeeded', repo: 'owner/repo', issueId: 'issue-1', log: '', result: { commitSha: 'abc123', branch: 'security/alpha' }, agent: { provider: 'codex', skill: 'dependency-security-fix' }, createdAt: now, updatedAt: now, ...overrides };
}
function analyzed(target: TrackerIssue) {
  target.lastAiAnalysis = { riskLevel: 'safe', safetyScore: 95, confidence: 'high', needsAdditionalBumps: false, summary: 'Safe', steps: [], breakingChanges: [], verificationChecks: [], provider: 'cursor', model: 'composer-2.5', analyzedAt: now };
  return target;
}

describe('issue workflow state', () => {
  it('shows analysis as the next required step for a new issue', () => {
    const workflow = buildIssueWorkflow(issue(), []);
    expect(workflow.progress).toBe(20);
    expect(workflow.steps.find(step => step.id === 'dependency-analysis')).toBeUndefined();
    expect(workflow.steps.find(step => step.id === 'ai-analysis')?.status).toBe('current');
    expect(workflow.nextAction).toContain('Run AI analysis');
  });

  it('retains the successful fix identity even when a later PR job exists', () => {
    const target = issue();
    target.state = 'READY_FOR_REVIEW';
    analyzed(target);
    target.pr = { branch: 'security/alpha', url: 'https://example.com/pull/7', number: 7 };
    const workflow = buildIssueWorkflow(target, [job(), job({ id: 'pr-456', kind: 'create-pr', agent: undefined, result: { prUrl: target.pr.url }, updatedAt: '2026-09-17T13:00:00.000Z' })]);
    expect(workflow.latestFix).toMatchObject({ id: 'fix-123', agent: { provider: 'codex', skill: 'dependency-security-fix' }, commitSha: 'abc123' });
    expect(workflow.steps.find(step => step.id === 'fix')?.status).toBe('completed');
    expect(workflow.steps.find(step => step.id === 'pull-request')?.status).toBe('completed');
    expect(workflow.steps.find(step => step.id === 'review')?.status).toBe('current');
    expect(workflow.nextAction).toContain('Review CI');
    expect(workflow.canRefix).toBe(true);
  });

  it('invalidates a historical false-positive fix when PR preflight proves there is no branch commit', () => {
    const target = issue();
    target.state = 'BLOCKED';
    analyzed(target);
    const failedPr = job({ id: 'pr-failed', kind: 'create-pr', status: 'failed', agent: undefined, result: {}, log: 'GraphQL: No commits between master and security-fix/alpha', error: 'Process exited 1', updatedAt: '2026-09-17T13:00:00.000Z' });
    const workflow = buildIssueWorkflow(target, [job(), failedPr]);
    expect(workflow.progress).toBe(40);
    expect(workflow.steps.find(step => step.id === 'fix')).toMatchObject({ status: 'failed', label: 'Fix produced no branch commit' });
    expect(workflow.steps.find(step => step.id === 'pull-request')?.status).toBe('failed');
    expect(workflow.latestFix).toMatchObject({ id: 'fix-123', valid: false });
    expect(workflow.nextActionKind).toBe('fix');
  });
});
