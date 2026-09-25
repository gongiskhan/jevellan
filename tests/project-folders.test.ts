import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectFolders } from '../apps/daemon/dist/project-folders.js';

test('project picker lists directories, navigates parents, and excludes private files and aliases outside home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevellan-folders-'));
  try {
    const home = join(root, 'home'); await mkdir(home); await mkdir(join(home, 'Projects')); await mkdir(join(home, '.claude')); await mkdir(join(home, 'node_modules')); await writeFile(join(home, 'private.txt'), 'fixture'); await symlink(root, join(home, 'outside'));
    const result = await projectFolders(home);
    expect(result.parent).toBeNull(); expect(result.folders.map(row => row.name)).toEqual(['Projects']);
    expect((await projectFolders(home, join(home, 'Projects'))).parent).toBe(result.path);
    await expect(projectFolders(home, join(home, 'outside'))).rejects.toThrow('Browse folders inside your home');
  } finally { await rm(root, { recursive: true, force: true }); }
});
