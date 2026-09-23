import { describe, expect, it } from 'vitest';
import { PullRequestStatus, TrackerIssue, WorkItem } from '../src/domain/types.js';
import { buildSlackReviewMessage } from '../src/services/slackReview.js';

const pr = (overrides: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  number: 7,
  title: 'Security: update dependencies',
  url: 'https://example.com/pull/7',
  branch: 'security-fix/dependabot/work-item-1',
  draft: false,
  reviewState: 'review_required',
  checks: { total: 1, successful: 1, failed: 0, pending: 0, conclusion: 'successful' },
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

const issue = (overrides: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id: 'issue-lodash',
  repo: 'owner/repo',
  title: 'lodash → 4.17.21',
  state: 'READY_FOR_REVIEW',
  alerts: [10, 11],
  packageName: 'lodash',
  ecosystem: 'npm',
  manifestPath: 'package.json',
  manifestPaths: ['package.json', 'apps/web/package.json'],
  patchedVersion: '4.17.21',
  vulnerableVersionRange: '<4.17.21',
  severity: 'high',
  severityScore: 8,
  complexity: 'medium',
  pr: { branch: 'security-fix/dependabot/lodash' },
  remediation: {},
  history: [],
  notes: [],
  labels: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

const workItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: 'work-item-1',
  repo: 'owner/repo',
  issueIds: ['issue-lodash'],
  state: 'pr_open',
  branch: 'security-fix/dependabot/work-item-1',
  remediation: { result: { prUrl: 'https://example.com/pull/7' } },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

describe('buildSlackReviewMessage', () => {
  it('describes every Dependabot issue linked through a work item', () => {
    const message = buildSlackReviewMessage('owner/repo', [pr()], [issue()], [workItem()]);

    expect(message).toContain('Hi Team,\n\nPlease review this pull request, which fixes the following Dependabot issue in owner/repo:');
    expect(message).toContain('PR #7 — Security: update dependencies');
    expect(message).toContain('- lodash → 4.17.21 (package.json, apps/web/package.json; alerts #10, #11)');
  });

  it('retains a custom introduction and falls back to the PR title when no issue is linked', () => {
    const message = buildSlackReviewMessage('owner/repo', [pr()], [], [], 'Hello reviewers, please take a look.');

    expect(message).toContain('Hello reviewers, please take a look.');
    expect(message).toContain('- Security: update dependencies (tracked dependency details are available in the pull request)');
  });
});
