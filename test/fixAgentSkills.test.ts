import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { FixAgentSkillService } from '../src/services/fixAgentSkills.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe('FixAgentSkillService', () => {
  it('discovers skills separately by provider and reports configuration readiness', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fix-skills-')); directories.push(root);
    await fs.mkdir(path.join(root, '.agents/skills/security-fix'), { recursive: true });
    await fs.mkdir(path.join(root, '.cursor/skills/security-fix'), { recursive: true });
    const skill = '---\nname: Security fix\ndescription: Safely update a vulnerable dependency.\n---\n';
    await fs.writeFile(path.join(root, '.agents/skills/security-fix/SKILL.md'), skill);
    await fs.writeFile(path.join(root, '.cursor/skills/security-fix/SKILL.md'), skill);
    const service = new FixAgentSkillService(loadConfig({}), root);

    expect(await service.list()).toEqual([
      expect.objectContaining({ provider: 'codex', skill: 'security-fix', configured: true }),
      expect.objectContaining({ provider: 'cursor', skill: 'security-fix', configured: false, reason: 'CURSOR_API_KEY is not configured' })
    ]);
    await expect(service.resolve({ provider: 'codex', skill: 'security-fix' })).resolves.toMatchObject({ descriptor: { configured: true } });
    await expect(service.resolve({ provider: 'codex', skill: '../escape' })).rejects.toMatchObject({ status: 400 });
    await expect(service.resolve({ provider: 'cursor', skill: 'security-fix' })).rejects.toMatchObject({ status: 412 });
  });
});
