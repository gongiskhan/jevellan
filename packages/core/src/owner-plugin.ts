import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Homes } from './homes.js';
import { applicationRoot } from './app-paths.js';

const PluginSourceSchema = z.strictObject({ schema: z.literal('jevellan-plugin-source-v1'), name: z.string(), description: z.string(), marketplace: z.string(),
  targets: z.record(z.string(), z.strictObject({ server: z.string(), channel: z.boolean() })) });

/** The command that runs this installation (the installed wrapper when there is one). */
export function installedCommand(homes: Homes): string[] {
  try {
    const record = JSON.parse(readFileSync(join(homes.root, 'install.json'), 'utf8')) as { command?: { definition?: { path?: unknown } } };
    const path = record.command?.definition?.path; if (typeof path === 'string' && existsSync(path)) return [path];
  } catch { /* not installed: run this copy */ }
  return [process.execPath, join(applicationRoot(), 'bin', 'jevellan.mjs')];
}
export const quote = (part: string) => /^[A-Za-z0-9_./:=@-]+$/u.test(part) ? part : `'${part.replace(/'/gu, `'\\''`)}'`;
/** Where the generated plugin lives: the installation's data folder, never the repository. */
export const pluginDist = (homes: Homes) => join(homes.root, 'plugin-dist', 'claude');
export function pluginSource(): string { return join(applicationRoot(), 'plugin'); }

/**
 * `jevellan plugin build`: the installable Claude Code plugin and its local marketplace, generated from the neutral `plugin/` source
 * (bridge specification, "Plugin source and generation"). A `targets` map leaves room for a Codex target later.
 */
export function buildPlugin(homes = new Homes(), source = pluginSource()): string {
  const manifest = PluginSourceSchema.parse(JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')));
  const root = pluginDist(homes); const plugin = join(root, manifest.name);
  rmSync(root, { recursive: true, force: true }); mkdirSync(join(plugin, '.claude-plugin'), { recursive: true }); mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  const [command = process.execPath, ...prefix] = installedCommand(homes); const target = manifest.targets.claude!;
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: manifest.name, version: JSON.parse(readFileSync(join(applicationRoot(), 'package.json'), 'utf8')).version as string, description: manifest.description,
    ...(target.channel ? { channels: [{ server: target.server, displayName: 'Jevellan' }] } : {}) }, null, 2)}\n`);
  writeFileSync(join(plugin, '.mcp.json'), `${JSON.stringify({ mcpServers: { [target.server]: { command, args: [...prefix, 'mcp'], env: { JEVELLAN_HOME: homes.root } } } }, null, 2)}\n`);
  cpSync(join(source, 'commands'), join(plugin, 'commands'), { recursive: true });
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(join(plugin, 'hooks', 'hooks.json'), `${JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: [command, ...prefix, 'hook', 'session-start'].map(quote).join(' '), timeout: 10 }] }] } }, null, 2)}\n`);
  mkdirSync(join(plugin, 'bridge'), { recursive: true }); cpSync(join(source, 'bridge', 'system-prompt.md'), join(plugin, 'bridge', 'system-prompt.md'));
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({ name: manifest.marketplace, owner: { name: 'Jevellan' }, plugins: [{ name: manifest.name, source: `./${manifest.name}`, description: manifest.description }] }, null, 2)}\n`);
  return root;
}

