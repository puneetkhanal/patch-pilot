import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonRepository } from '../src/repository/jsonRepository.js';
import { Scanner } from '../src/services/scanner.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const alert = (number: number, ecosystem = 'npm') => ({ number, state: 'open', dependency: { package: { ecosystem, name: ecosystem === 'npm' ? 'lodash' : 'requests' }, manifest_path: 'package.json' }, security_advisory: { severity: 'high', cvss: { score: 8 } }, security_vulnerability: { vulnerable_version_range: '<4.17.21', first_patched_version: { identifier: '4.17.21' } } });

describe('Scanner', () => {
  it('ingests only npm alerts and closes issues that disappear', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-scanner-')); dirs.push(dir);
    const repository = new JsonRepository(path.join(dir, 'state.json'));
    let alerts = [alert(1), alert(2, 'pip')];
    const github = { dependabotAlerts: async () => alerts, openPullRequests: async () => [] } as any;
    const scanner = new Scanner(repository, github);
    const first = await scanner.scan('owner', 'repo');
    expect(first.alertCount).toBe(1);
    const issue = (await repository.listIssues('owner/repo'))[0];
    expect(issue.ecosystem).toBe('npm');
    issue.remediation = { jobId: 'kept' };
    issue.pr.url = 'https://example.com/pull/1';
    await repository.saveIssue(issue);
    alerts = [];
    await scanner.scan('owner', 'repo');
    const closed = await repository.getIssue(issue.id, 'owner/repo');
    expect(closed?.state).toBe('CLOSED');
    expect(closed?.remediation.jobId).toBe('kept');
    expect(closed?.pr.url).toContain('/pull/1');
  });
});
