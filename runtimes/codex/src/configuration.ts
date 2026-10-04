import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inside } from '@jevellan/core';

/** Preserve the project path as one TOML key, including dots and symlinks. */
export function projectTrustOverride(cwd: string): string {
  return `projects={${JSON.stringify(realpathSync(cwd))}={trust_level="untrusted"}}`;
}

/** Supply project instructions without enabling project configuration or hooks. */
export function projectInstructions(cwd: string): string {
  const root = realpathSync(cwd); const path = join(root, 'AGENTS.md');
  if (!existsSync(path)) return '';
  if (!inside(root, realpathSync(path))) throw new Error('Project AGENTS.md must resolve inside the project.');
  if (!statSync(path).isFile() || statSync(path).size > 32_768) throw new Error('Project AGENTS.md must be a file of at most 32768 bytes.');
  return readFileSync(path, 'utf8');
}

/** What a commit in a linked worktree writes: the common directory's objects, refs and logs and the worktree's own git directory,
 * never the common directory root, so the owner checkout's index, HEAD and config stay outside the sandbox (D17). */
export function worktreeGitDirs(cwd: string): string[] | undefined {
  try {
    if (!statSync(join(cwd, '.git')).isFile()) return undefined;
    const git = (flag: string) => execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', flag], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const common = git('--git-common-dir'); const own = git('--git-dir');
    if (!common || !own) return undefined;
    const directories = [join(common, 'objects'), join(common, 'refs'), join(common, 'logs'), own];
    for (const directory of directories) mkdirSync(directory, { recursive: true });
    return directories;
  } catch { return undefined; }
}
