import fs from 'node:fs/promises';
import path from 'node:path';
import { Config } from '../config/env.js';
import { FixAgentProvider, FixAgentSelection } from '../domain/types.js';

export interface FixAgentSkillDescriptor extends FixAgentSelection {
  name: string;
  description: string;
  configured: boolean;
  reason?: string;
}

const providerDirectory: Record<FixAgentProvider, string> = { codex: '.agents', claude: '.claude', cursor: '.cursor' };

export class FixAgentSkillService {
  private root: string;
  constructor(private config: Config, root = config.fixAgentSkillsRoot || path.resolve('.')) { this.root = path.resolve(root); }

  private providerStatus(provider: FixAgentProvider) {
    if (provider === 'codex') return this.config.codexFixEnabled ? {} : { reason: 'Codex fix agent is disabled' };
    if (provider === 'cursor') return this.config.cursorApiKey ? {} : { reason: 'CURSOR_API_KEY is not configured' };
    return this.config.claudeFixEnabled ? {} : { reason: 'Claude fix agent is disabled' };
  }

  private skillsDirectory(provider: FixAgentProvider, cursorSkillsDirectory?: string) {
    return provider === 'cursor' && cursorSkillsDirectory
      ? path.resolve(cursorSkillsDirectory)
      : path.join(this.root, providerDirectory[provider], 'skills');
  }

  async list(cursorSkillsDirectory?: string): Promise<FixAgentSkillDescriptor[]> {
    const result: FixAgentSkillDescriptor[] = [];
    for (const provider of Object.keys(providerDirectory) as FixAgentProvider[]) {
      const directory = this.skillsDirectory(provider, cursorSkillsDirectory);
      let entries: string[];
      try { entries = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { continue; }
      for (const skill of entries.sort()) {
        const file = path.join(directory, skill, 'SKILL.md');
        try {
          const content = await fs.readFile(file, 'utf8');
          const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim() || skill;
          const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() || 'Configured fix skill';
          const status = this.providerStatus(provider);
          result.push({ provider, skill, name, description, configured: !status.reason, reason: status.reason });
        } catch { /* ignore invalid skill directories */ }
      }
    }
    return result;
  }

  async resolve(selection: FixAgentSelection, cursorSkillsDirectory?: string) {
    const descriptor = (await this.list(cursorSkillsDirectory)).find(item => item.provider === selection.provider && item.skill === selection.skill);
    if (!descriptor) throw Object.assign(new Error(`Unknown ${selection.provider} fix skill: ${selection.skill}`), { status: 400 });
    if (!descriptor.configured) throw Object.assign(new Error(descriptor.reason || `${selection.provider} is not configured`), { status: 412 });
    const providerRoot = this.skillsDirectory(selection.provider, cursorSkillsDirectory);
    const file = path.resolve(providerRoot, selection.skill, 'SKILL.md');
    if (!file.startsWith(`${providerRoot}${path.sep}`)) throw Object.assign(new Error('Invalid fix skill path'), { status: 400 });
    return { descriptor, file };
  }
}
