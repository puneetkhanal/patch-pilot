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
  it('discovers nested GitHub clones and ignores non-GitHub origins', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-repositories-')); directories.push(root);
    const first = await repository(root, 'team/first', 'git@github.com:example-org/first.git');
    const second = await repository(root, 'second', 'https://github.com/example-org/second.git');
    await repository(root, 'not-github', 'git@example.invalid:team/hidden.git');
    const found = await new LocalRepositoryService().discover(root);
    expect(found).toEqual([
      expect.objectContaining({ repo: 'example-org/first', path: first, relativePath: 'team/first' }),
      expect.objectContaining({ repo: 'example-org/second', path: second, relativePath: 'second' })
    ]);
  });

  it('rejects a missing root path', async () => {
    await expect(new LocalRepositoryService().discover('/definitely/not/a/real/repository/root')).rejects.toThrow();
  });
});
