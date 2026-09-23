import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRepositoryService } from '../src/services/localRepositories.js';

const directories: string[] = [];
const exec = promisify(execFile);
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

async function repository(root: string, relative: string, remote: string) {
  const directory = path.join(root, relative);
  await fs.mkdir(directory, { recursive: true });
  await exec('git', ['init', '-q', directory]);
  await exec('git', ['-C', directory, 'remote', 'add', 'origin', remote]);
  return fs.realpath(directory);
}

describe('LocalRepositoryService', () => {
  it('loads only the GitHub clones explicitly selected by the user', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-repositories-')); directories.push(root);
    const first = await repository(root, 'team/first', 'git@github.com:example-org/first.git');
    const second = await repository(root, 'second', 'https://github.com/example-org/second.git');
    await repository(root, 'not-github', 'git@example.invalid:team/hidden.git');
    const found = await new LocalRepositoryService().selected([second, first]);
    expect(found).toEqual([
      expect.objectContaining({ repo: 'example-org/first', path: first, relativePath: '.' }),
      expect.objectContaining({ repo: 'example-org/second', path: second, relativePath: '.' })
    ]);
  });

  it('rejects a selected project whose origin is not on GitHub', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-repositories-')); directories.push(root);
    const selected = await repository(root, 'not-github', 'git@example.invalid:team/hidden.git');
    await expect(new LocalRepositoryService().inspect(selected)).rejects.toThrow('origin must point to GitHub');
  });
});
