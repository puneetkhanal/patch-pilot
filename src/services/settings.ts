import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export interface AppSettings {
  repositoriesRoot?: string;
  cursorSkillsDirectory?: string;
  defaultCursorSkill?: string;
}
const settingsSchema = z.object({
  repositoriesRoot: z.string().min(1).optional(),
  cursorSkillsDirectory: z.string().min(1).optional(),
  defaultCursorSkill: z.string().min(1).optional()
});

export class SettingsService {
  private settings: AppSettings = {};
  private ready: Promise<void>;

  constructor(private file = path.resolve('.orchestrator-settings.json'), defaults: AppSettings = {}) {
    this.settings = defaults;
    this.ready = this.load();
  }

  private async load() {
    try { this.settings = { ...this.settings, ...settingsSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8'))) }; }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }

  async get() { await this.ready; return structuredClone(this.settings); }

  async update(next: AppSettings) {
    await this.ready;
    this.settings = settingsSchema.parse({ ...this.settings, ...next });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.settings, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, this.file);
    return this.get();
  }
}
