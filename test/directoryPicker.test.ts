import { describe, expect, it, vi } from 'vitest';
import { NativeDirectoryPicker } from '../src/services/directoryPicker.js';

describe('NativeDirectoryPicker', () => {
  it('opens the macOS folder chooser and normalizes the selected path', async () => {
    const run = vi.fn(async () => ({ stdout: '/Users/example/projects/\n', stderr: '' }));
    const picker = new NativeDirectoryPicker('darwin', run);

    await expect(picker.pick('project')).resolves.toBe('/Users/example/projects');
    expect(run).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('GitHub project folder')]);
  });

  it('returns no path when the user cancels the chooser', async () => {
    const error = Object.assign(new Error('User canceled.'), { code: 1 });
    const picker = new NativeDirectoryPicker('darwin', async () => { throw error; });

    await expect(picker.pick('cursor-skills')).resolves.toBeUndefined();
  });

  it('falls back from zenity to kdialog on Linux', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ stdout: '/home/example/.cursor/skills\n' });
    const picker = new NativeDirectoryPicker('linux', run);

    await expect(picker.pick('cursor-skills')).resolves.toBe('/home/example/.cursor/skills');
    expect(run.mock.calls.map(call => call[0])).toEqual(['zenity', 'kdialog']);
  });
});
