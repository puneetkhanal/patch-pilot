import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalGitHubRepository } from '../domain/types.js';

const exec = promisify(execFile);
const ignored = new Set(['.git', 'node_modules', '.dependabot-worktrees', 'dist', 'build', 'coverage', '.cache']);

function githubRepo(remote: string) {
  const normalized = remote.trim().replace(/\.git$/, '');
  const match = normalized.match(/(?:github\.com[/:])([^/\s:]+)\/([^/\s]+)$/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export class LocalRepositoryService {
  constructor(private maxDepth = 4, private maxDirectories = 2000) {}

  async discover(root: string): Promise<LocalGitHubRepository[]> {
    const absoluteRoot = await fs.realpath(path.resolve(root));
    if (!(await fs.stat(absoluteRoot)).isDirectory()) throw new Error('Repositories root must be a directory');
    const found: LocalGitHubRepository[] = [];
    const queue: Array<{ directory: string; depth: number }> = [{ directory: absoluteRoot, depth: 0 }];
    let visited = 0;
    while (queue.length) {
      const current = queue.shift()!;
      if (++visited > this.maxDirectories) throw new Error(`Repository scan stopped after ${this.maxDirectories} directories; choose a narrower root path`);
      let entries;
      try { entries = await fs.readdir(current.directory, { withFileTypes: true }); } catch { continue; }
      const gitEntry = entries.find(entry => entry.name === '.git' && (entry.isDirectory() || entry.isFile()));
      if (gitEntry) {
        try {
          const { stdout } = await exec('git', ['-C', current.directory, 'config', '--get', 'remote.origin.url']);
          const remoteUrl = stdout.trim();
          const repo = githubRepo(remoteUrl);
          if (repo) found.push({ repo, name: path.basename(current.directory), path: current.directory, relativePath: path.relative(absoluteRoot, current.directory) || '.', remoteUrl });
        } catch { /* A local repository without an origin is not a selectable GitHub repository. */ }
        continue;
      }
      if (current.depth >= this.maxDepth) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name) || entry.name.startsWith('.')) continue;
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
    return found.sort((a, b) => a.repo.localeCompare(b.repo));
  }
}
