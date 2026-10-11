import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inside } from '@jevellan/core';

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

/** Select once by presence, so an invalid AGENTS.md cannot silently enable the fallback. */
export function projectInstructionFile(cwd: string): { filename: 'AGENTS.md' | 'CLAUDE.md'; text: string } | null {
  const root = realpathSync(cwd);
  for (const filename of ['AGENTS.md', 'CLAUDE.md'] as const) {
    const path = join(root, filename);
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const target = realpathSync(path);
    if (!inside(root, target)) throw new Error(`Project ${filename} must resolve inside the project.`);
    const info = statSync(target);
    if (!info.isFile() || info.size > 32_768) throw new Error(`Project ${filename} must be a file of at most 32768 bytes.`);
    const bytes = readFileSync(target);
    if (bytes.length > 32_768) throw new Error(`Project ${filename} must be a file of at most 32768 bytes.`);
    return { filename, text: bytes.toString('utf8') };
  }
  return null;
}
export function projectInstructions(cwd: string): string { return projectInstructionFile(cwd)?.text ?? ''; }
/** Read afresh on every run, including native session resumes. */
export function projectInstructionPrompt(cwd: string): string {
  const file = projectInstructionFile(cwd);
  return file ? `# Project instructions: ${file.filename}\n${file.text}\n\n` : '';
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
