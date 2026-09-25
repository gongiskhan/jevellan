import { readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inside, ProjectFoldersSchema } from '@jevellan/core';

/** Folder names only, for the signed-in user's project picker. */
export async function projectFolders(userHome: string, requested?: string) {
  const home = await realpath(userHome); const path = await realpath(requested ?? home);
  if (!inside(home, path)) throw Object.assign(new Error('Browse folders inside your home, or enter the project path directly.'), { status: 400 });
  const entries = await readdir(path, { withFileTypes: true });
  const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => ({ name: entry.name, path: join(path, entry.name) })).sort((a, b) => a.name.localeCompare(b.name));
  return ProjectFoldersSchema.parse({ schema: 'project-folders-v1', path, parent: path === home ? null : dirname(path), folders });
}
