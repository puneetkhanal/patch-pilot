import { describe, expect, it } from 'vitest';
import { buildAnalysisMemberProgress, dependencyNeighborhood, installRepoControls, issueRisk, matchesRisk, settings, workflowLogTail, withBusy } from '../public/common.js';

describe('withBusy', () => {
  it('restores a button after an asynchronous operation succeeds', async () => {
    const button = { dataset: {}, textContent: 'List worktrees', disabled: false } as any;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });

    const operation = withBusy(button, 'Loading…', () => pending);
    expect(button).toMatchObject({ textContent: 'Loading…', disabled: true });

    release();
    await operation;
    expect(button).toMatchObject({ textContent: 'List worktrees', disabled: false });
  });

  it('restores a button after an asynchronous operation fails', async () => {
    const button = { dataset: {}, textContent: 'Refresh', disabled: false } as any;

    await expect(withBusy(button, 'Refreshing…', async () => {
      throw new Error('request failed');
    })).rejects.toThrow('request failed');

    expect(button).toMatchObject({ textContent: 'Refresh', disabled: false });
  });
});

describe('risk helpers', () => {
  const issue = (risk?: string) => risk ? { lastAiAnalysis: { riskLevel: risk } } : {};

  it('matches analyzed and unanalyzed issues by risk', () => {
    expect(issueRisk(issue('likely_safe'))).toBe('likely_safe');
    expect(issueRisk(issue())).toBe('not_analyzed');
    expect(matchesRisk(issue('safe'), 'safe')).toBe(true);
    expect(matchesRisk(issue('unsafe'), 'safe')).toBe(false);
    expect(matchesRisk(issue(), 'not_analyzed')).toBe(true);
    expect(matchesRisk(issue('risky'), '')).toBe(true);
  });
});

describe('dependency graph helpers', () => {
  it('finds the packages that consume and are consumed by a selected package', () => {
    const graph = {
      nodes: [{ id: 'project', direct: true }, { id: 'alpha', version: '1.0.0', direct: true }, { id: 'beta', version: '2.0.0' }],
      edges: [{ from: 'project', to: 'alpha', kind: 'dependencies' }, { from: 'alpha', to: 'beta', kind: 'runtime' }]
    };
    expect(dependencyNeighborhood(graph, 'alpha')).toEqual({
      target: { id: 'alpha', version: '1.0.0', direct: true },
      dependents: [{ id: 'project', direct: true, relationship: 'dependencies' }],
      dependencies: [{ id: 'beta', version: '2.0.0', relationship: 'runtime' }]
    });
  });

  it('handles a transitive leaf and removes duplicate relationships', () => {
    const edge = { from: 'alpha', to: 'beta', kind: 'runtime' };
    const result = dependencyNeighborhood({ nodes: [{ id: 'alpha' }, { id: 'beta' }], edges: [edge, edge] }, 'beta');
    expect(result.dependents).toEqual([{ id: 'alpha', relationship: 'runtime' }]);
    expect(result.dependencies).toEqual([]);
  });
});

describe('workflow progress helpers', () => {
  it('builds per-member analysis progress rows', () => {
    const members = [
      { id: 'one', packageName: 'axios', patchedVersion: '1.0.0' },
      { id: 'two', packageName: 'lodash', patchedVersion: '4.0.0' },
      { id: 'three', packageName: 'express', patchedVersion: '5.0.0' }
    ];
    const job = {
      total: 3,
      completed: 1,
      failed: 0,
      currentIssueId: 'two',
      results: [{ issueId: 'one', ok: true }]
    };
    expect(buildAnalysisMemberProgress(job, members)).toEqual([
      { issue: members[0], status: 'completed' },
      { issue: members[1], status: 'running' },
      { issue: members[2], status: 'pending' }
    ]);
  });

  it('keeps only the latest log lines for workflow output', () => {
    const log = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join('\n');
    expect(workflowLogTail(log, 3)).toBe('line-48\nline-49\nline-50');
  });
});

describe('repository controls', () => {
  it('persists configured defaults for a fresh browser session', () => {
    const originalDocument = globalThis.document;
    const originalLocalStorage = globalThis.localStorage;
    const controls: Record<string, any> = { '#repo': { value: '', addEventListener() {} }, '#project-path': { value: '', addEventListener() {} } };
    Object.assign(globalThis, { document: { querySelector: (selector: string) => controls[selector] || null }, localStorage: {} });
    try {
      installRepoControls({ defaultRepo: 'owner/repo', defaultProjectPath: '/tmp/repo' });
      expect(settings.repo).toBe('owner/repo');
      expect(settings.projectPath).toBe('/tmp/repo');
      expect(controls['#repo'].value).toBe('owner/repo');
    } finally {
      Object.assign(globalThis, { document: originalDocument, localStorage: originalLocalStorage });
    }
  });
});
