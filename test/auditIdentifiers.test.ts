import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const script = path.resolve('scripts/audit-identifiers.mjs');
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(contents: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'identifier-audit-'));
  directories.push(directory);
  await fs.writeFile(path.join(directory, 'fixture.txt'), contents);
  return directory;
}

describe('identifier audit', () => {
  it('accepts documented service URLs and checksum names', async () => {
    const cwd = await fixture([
      'https://generativelanguage.googleapis.com/v1beta/models/example',
      'https://api.github.com/repos/owner/repo',
      'https://cursor.com/agents',
      'https://mcp.slack.com/mcp',
      'SHA-256'
    ].join('\n'));
    await expect(exec(process.execPath, [script], { cwd })).resolves.toMatchObject({ stdout: 'identifier audit passed\n' });
  });

  it('rejects machine-specific paths, unknown hosts, and ticket identifiers', async () => {
    const cwd = await fixture([
      ['/', 'Users', '/someone/private/project'].join(''),
      ['https:', '//internal.example.net/resource'].join(''),
      ['SECRET', '-', '123'].join('')
    ].join('\n'));
    await expect(exec(process.execPath, [script], { cwd })).rejects.toMatchObject({ code: 1 });
  });
});
