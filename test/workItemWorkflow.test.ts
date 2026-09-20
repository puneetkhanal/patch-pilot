import { describe, expect, it } from 'vitest';
import { FixJob, TrackerIssue, WorkItem } from '../src/domain/types.js';
import { buildWorkItemWorkflow } from '../src/services/workItemWorkflow.js';

const now = '2026-09-18T12:00:00.000Z';
const workItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({ id: 'work-1', repo: 'owner/repo', issueIds: ['issue-1', 'issue-2'], state: 'draft', branch: 'security/work-1', remediation: {}, createdAt: now, updatedAt: now, ...overrides });
const issue = (id: string, packageName: string): TrackerIssue => ({ id, repo: 'owner/repo', title: packageName, state: 'PLANNED_BATCH', alerts: [1], packageName, ecosystem: 'npm', manifestPath: 'package.json', patchedVersion: '2.0.0', vulnerableVersionRange: '<2', severity: 'high', severityScore: 8, complexity: 'low', pr: { branch: `security/${packageName}` }, remediation: {}, history: [], notes: [], labels: [], createdAt: now, updatedAt: now });
const analyzed = (value: TrackerIssue) => {
  value.lastUpgradeAnalysis = { riskLevel: 'safe', safetyScore: 100, confidence: 'high', recommendation: 'Proceed', needsAdditionalBumps: false, findings: [], dependencyGraph: { nodes: [], edges: [] }, analyzedAt: now };
  return value;
};
const job = (overrides: Partial<FixJob> = {}): FixJob => ({ id: 'job-1', kind: 'batch-fix', status: 'succeeded', repo: 'owner/repo', batchId: 'work-1', log: '', result: { commitSha: 'abc123' }, createdAt: now, updatedAt: now, ...overrides });

describe('work-item workflow state', () => {
  it('requires every member to have dependency engine analysis before fixing', () => {
    const workflow = buildWorkItemWorkflow(workItem(), [analyzed(issue('issue-1', 'alpha')), issue('issue-2', 'beta')], []);
    expect(workflow.progress).toBe(25);
    expect(workflow.steps.find(step => step.id === 'fix')).toMatchObject({ status: 'current', detail: '1 of 2 analyzed by dependency engine' });
    expect(workflow.nextActionKind).toBe('fix');
    expect(workflow.nextAction).toContain('missing');
  });

  it('blocks fixing when a member is risky or needs additional bumps', () => {
    const risky = analyzed(issue('issue-1', 'axios'));
    risky.lastUpgradeAnalysis!.riskLevel = 'risky';
    const workflow = buildWorkItemWorkflow(workItem(), [risky, analyzed(issue('issue-2', 'lodash'))], []);
    expect(workflow.steps.find(step => step.id === 'fix')).toMatchObject({ status: 'current', detail: expect.stringContaining('flagged by dependency engine') });
    expect(workflow.nextActionKind).toBe('fix');
    expect(workflow.nextAction).toContain('axios');
  });

  it('advances to pull request after a successful fix even when a member was flagged risky', () => {
    const risky = analyzed(issue('issue-1', 'axios'));
    risky.lastUpgradeAnalysis!.riskLevel = 'risky';
    const workflow = buildWorkItemWorkflow(workItem(), [risky, analyzed(issue('issue-2', 'lodash'))], [job()]);
    expect(workflow.steps.find(step => step.id === 'fix')?.status).toBe('completed');
    expect(workflow.steps.find(step => step.id === 'pull-request')?.status).toBe('current');
    expect(workflow.nextActionKind).toBe('create-pr');
    expect(workflow.nextAction).toContain('axios');
    expect(workflow.nextAction).not.toContain('before fixing');
  });

  it('shows fix and pull-request completion for the whole work item', () => {
    const issues = [analyzed(issue('issue-1', 'alpha')), analyzed(issue('issue-2', 'beta'))];
    const prJob = job({ id: 'job-pr', kind: 'batch-create-pr', result: { prUrl: 'https://example.com/pull/9' } });
    const workflow = buildWorkItemWorkflow(workItem({ state: 'pr_open', remediation: { result: prJob.result } }), issues, [job(), prJob]);
    expect(workflow.steps.find(step => step.id === 'fix')?.status).toBe('completed');
    expect(workflow.steps.find(step => step.id === 'pull-request')?.status).toBe('completed');
    expect(workflow.nextActionKind).toBe('review');
    expect(workflow.canRefix).toBe(true);
  });
});
