import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalGitHubRepository } from '../domain/types.js';

const exec = promisify(execFile);
function githubRepo(remote: string) {
  const normalized = remote.trim().replace(/\.git$/, '');
  const match = normalized.match(/(?:github\.com[/:])([^/\s:]+)\/([^/\s]+)$/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export class LocalRepositoryService {
  async inspect(directory: string): Promise<LocalGitHubRepository> {
    const absolutePath = await fs.realpath(path.resolve(directory));
    if (!(await fs.stat(absolutePath)).isDirectory()) throw new Error('Selected project must be a directory');
    try {
      await fs.stat(path.join(absolutePath, '.git'));
    } catch {
      throw new Error('Selected folder is not a Git repository');
    }
    let remoteUrl = '';
    try {
      ({ stdout: remoteUrl } = await exec('git', ['-C', absolutePath, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }));
    } catch {
      throw new Error('Selected repository does not have an origin remote');
    }
    remoteUrl = remoteUrl.trim();
    const repo = githubRepo(remoteUrl);
    if (!repo) throw new Error('Selected repository origin must point to GitHub');
    return { repo, name: path.basename(absolutePath), path: absolutePath, relativePath: '.', remoteUrl };
  }

  async selected(projectPaths: string[]) {
    const repositories = await Promise.all([...new Set(projectPaths)].map(projectPath => this.inspect(projectPath)));
    return repositories.sort((a, b) => a.repo.localeCompare(b.repo));
  }
}
