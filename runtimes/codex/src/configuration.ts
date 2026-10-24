import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
export { PROJECT_INSTRUCTION_MAX_BYTES, projectInstructionFile, projectInstructions, projectInstructionPrompt } from '@jevellan/core';

/** Pass secret references through Codex's stdio allow list, never their values. */
export function codexMcpServers(servers: Record<string, { command: string; args: string[] }>) {
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, {
    command: server.command, args: server.args,
    env_vars: ['JEVELLAN_STRETCH_TOKEN', 'JEVELLAN_DAEMON_URL', ...server.args.filter(arg => /^JEVELLAN_NATIVE_MCP_[a-f0-9]{16}$/u.test(arg))],
    default_tools_approval_mode: 'approve',
  }]));
}

/** Preserve the project path as one TOML key, including dots and symlinks. */
export function projectTrustOverride(cwd: string): string {
  return `projects={${JSON.stringify(realpathSync(cwd))}={trust_level="untrusted"}}`;
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
