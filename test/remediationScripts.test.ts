import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe('remediation shell helpers', () => {
  it('maps a reported npm lockfile to its sibling package.json', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fix-common-')); directories.push(directory);
    await fs.mkdir(path.join(directory, 'examples'));
    await fs.writeFile(path.join(directory, 'examples/package.json'), '{}');
    await fs.writeFile(path.join(directory, 'examples/package-lock.json'), '{}');
    const helper = path.resolve('scripts/remediation/fix-common.sh');
    const { stdout } = await exec('bash', ['-c', 'source "$1"; cd "$2"; resolve_npm_manifest examples/package-lock.json', 'bash', helper, directory]);
    expect(stdout.trim()).toBe('examples/package.json');
  });

  it('keeps an ordinary npm manifest unchanged', async () => {
    const helper = path.resolve('scripts/remediation/fix-common.sh');
    const { stdout } = await exec('bash', ['-c', 'source "$1"; resolve_npm_manifest packages/app/package.json', 'bash', helper]);
    expect(stdout.trim()).toBe('packages/app/package.json');
  });
});
