import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TrackerIssue } from '../src/domain/types.js';
import { collectIssueRepoContext } from '../src/services/repoContext.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe('repo context collection', () => {
  it('collects manifest, lockfile excerpt, and import usage for Gemini analysis', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-repo-context-')); dirs.push(dir);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', dependencies: { alpha: '^1.0.0' } }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/alpha': { version: '1.0.0', dependencies: { beta: '^1.0.0' } } } }));
    await fs.writeFile(path.join(dir, 'index.js'), "const alpha = require('alpha');\n");
    const now = new Date().toISOString();
    const issue: TrackerIssue = {
      id: 'issue-npm-alpha-1-0-1', repo: 'owner/repo', title: 'alpha', state: 'NEW', alerts: [1], packageName: 'alpha', ecosystem: 'npm',
      manifestPath: 'package.json', patchedVersion: '1.0.1', vulnerableVersionRange: '<1.0.1', severity: 'high', severityScore: 8, complexity: 'low',
      pr: { branch: 'security/alpha' }, remediation: {}, history: [{ at: now, to: 'NEW', actor: 'test' }], notes: [], labels: [], updatedAt: now, createdAt: now
    };

    const context = await collectIssueRepoContext(issue, dir);
    expect(context.manifest).toMatchObject({ dependencies: { alpha: '^1.0.0' } });
    expect(context.lockfileExcerpt).toHaveProperty('node_modules/alpha');
    expect(context.importUsage).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'index.js', text: expect.stringContaining('alpha') })]));
  });
});
