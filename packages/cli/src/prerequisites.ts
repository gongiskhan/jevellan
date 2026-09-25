import { z } from 'zod';
import { Homes, runOwnedCommand } from '@jevellan/core';
import { toolEnvironment, type ToolCommand } from './toolchain.js';

export const InstallerPrerequisitesSchema = z.strictObject({ schema: z.literal('installer-prerequisites-v1'), node: z.string(), git: z.string().min(1), mergeTree: z.literal(true) });
export function checkNodeVersion(): string {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 13 || major === 23 && minor < 4) throw new Error('Jevellan requires Node 22.13+ or 23.4+ for SQLite.');
  return process.versions.node;
}
export async function checkGit(homes: Homes, run: ToolCommand = runOwnedCommand, path?: string): Promise<string> {
  const options = { cwd: homes.ensure(), env: toolEnvironment(homes, path), timeoutMs: 30_000 };
  const git = await run('git', ['--version'], options); if (git.code !== 0) throw new Error('Install Git before installing Jevellan.');
  const merge = await run('git', ['merge-tree', '-h'], options), help = (merge.stdout + merge.stderr).replaceAll('--[no-]', '--');
  if (![0, 129].includes(merge.code) || !help.includes('--write-tree') || !help.includes('--merge-base')) throw new Error('Jevellan requires Git with merge-tree --write-tree and --merge-base support. Upgrade Git before installing.');
  return git.stdout.trim();
}
export async function installerPrerequisites(homes: Homes, run: ToolCommand = runOwnedCommand) {
  return InstallerPrerequisitesSchema.parse({ schema: 'installer-prerequisites-v1', node: checkNodeVersion(), git: await checkGit(homes, run), mergeTree: true });
}
