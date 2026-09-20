import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { WorktreeInfo } from '../domain/types.js';

const exec = promisify(execFile);
const idFor = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

export class WorktreeService {
  async list(projectPath: string): Promise<WorktreeInfo[]> {
    const { stdout } = await exec('git', ['-C', projectPath, 'worktree', 'list', '--porcelain']);
    return stdout.trim().split(/\n\n+/).filter(Boolean).map(block => {
      const fields = Object.fromEntries(block.split('\n').map(line => { const [key, ...rest] = line.split(' '); return [key, rest.join(' ') || true]; }));
      const worktreePath = String(fields.worktree);
      return { id: idFor(worktreePath), path: worktreePath, branch: typeof fields.branch === 'string' ? fields.branch.replace('refs/heads/', '') : undefined, head: typeof fields.HEAD === 'string' ? fields.HEAD : undefined, locked: Boolean(fields.locked) };
    }).filter(item => item.path.includes(`${path.sep}.dependabot-worktrees${path.sep}`));
  }

  async remove(projectPath: string, id: string, force = false) {
    const item = (await this.list(projectPath)).find(candidate => candidate.id === id);
    if (!item) throw new Error('Managed worktree not found');
    await exec('git', ['-C', projectPath, 'worktree', 'remove', ...(force ? ['--force'] : []), item.path]);
    return item;
  }
}
