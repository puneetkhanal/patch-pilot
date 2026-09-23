import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type DirectoryPurpose = 'project' | 'cursor-skills';
export interface DirectoryPicker { pick(purpose: DirectoryPurpose): Promise<string | undefined> }

type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>;
const exec = promisify(execFile);
const runCommand: CommandRunner = async (file, args) => {
  const result = await exec(file, args, { encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr };
};

function wasCancelled(error: unknown, platform: NodeJS.Platform) {
  const detail = error as { code?: string | number; message?: string; stderr?: string };
  return detail.code === 1 && (platform !== 'darwin' || /cancel|canceled|cancelled/i.test(`${detail.message || ''} ${detail.stderr || ''}`));
}

export class NativeDirectoryPicker implements DirectoryPicker {
  constructor(private platform: NodeJS.Platform = process.platform, private run: CommandRunner = runCommand) {}

  async pick(purpose: DirectoryPurpose) {
    const title = purpose === 'project'
      ? 'Choose a GitHub project folder'
      : 'Choose your Cursor skills folder';
    try {
      let stdout = '';
      if (this.platform === 'darwin') {
        ({ stdout } = await this.run('osascript', ['-e', `POSIX path of (choose folder with prompt "${title}")`]));
      } else if (this.platform === 'win32') {
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$picker = New-Object System.Windows.Forms.FolderBrowserDialog',
          `$picker.Description = '${title.replaceAll("'", "''")}'`,
          'if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picker.SelectedPath }'
        ].join('; ');
        ({ stdout } = await this.run('powershell.exe', ['-NoProfile', '-STA', '-Command', script]));
      } else {
        try {
          ({ stdout } = await this.run('zenity', ['--file-selection', '--directory', `--title=${title}`]));
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
          ({ stdout } = await this.run('kdialog', ['--getexistingdirectory', '.', '--title', title]));
        }
      }
      const selected = stdout.trim();
      return selected ? path.resolve(selected) : undefined;
    } catch (error) {
      if (wasCancelled(error, this.platform)) return undefined;
      throw Object.assign(new Error('Could not open the system folder chooser. Enter the path manually instead.'), { cause: error, status: 501 });
    }
  }
}
