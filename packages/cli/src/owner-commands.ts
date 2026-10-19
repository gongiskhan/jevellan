import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { DoctorControlSchema, Homes, OWNER_TOOLS, OwnerEventSchema, StatusLineViewSchema, applicationRoot, doctorControlPath, ownerTool, readDocument, type OwnerEvent } from '@jevellan/core';
import { callOwnerTool } from './owner-mcp.js';

const PluginSourceSchema = z.strictObject({ schema: z.literal('jevellan-plugin-source-v1'), name: z.string(), description: z.string(), marketplace: z.string(),
  targets: z.record(z.string(), z.strictObject({ server: z.string(), channel: z.boolean() })) });

/** Values on the command line: JSON where it parses (numbers, booleans, arrays, objects), text otherwise. */
function value(raw: string): unknown { try { return JSON.parse(raw); } catch { return raw; } }

/** `jevellan call <tool> [action] [--key value ...]`: every tool from a terminal (bridge specification, "Live watch"). */
export async function callCommand(args: string[], homes = new Homes()): Promise<number> {
  const [name, ...rest] = args; const tool = name ? ownerTool(name) : undefined;
  if (!tool) { console.error(`Usage: jevellan call <tool> [action] [--key value ...]. Tools: ${OWNER_TOOLS.map(entry => entry.name).join(', ')}.`); return 1; }
  const input: Record<string, unknown> = {}; let index = 0;
  if (rest[0] && !rest[0].startsWith('--')) { if (tool.name === 'ask_coordinator') input.mode = rest[0]; else input.action = rest[0]; index = 1; }
  const positional: string[] = [];
  for (; index < rest.length; index++) {
    const item = rest[index]!;
    if (!item.startsWith('--')) { positional.push(item); continue; }
    const key = item.slice(2); const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) { input[key] = true; continue; }
    input[key] = value(next); index++;
  }
  // A bare id after the action names its subject: `call thread open T31`, `call respond W12 deploy`, `call work inspect T31`.
  const subject: Record<string, string> = { thread: 'thread', work: 'task', goals: 'goal', jobs: 'job', respond: 'item', override: 'decision', login: 'account' };
  if (positional.length && subject[tool.name] && input[subject[tool.name]!] === undefined) input[subject[tool.name]!] = positional.shift()!;
  if (positional.length && tool.name === 'respond' && input.answer === undefined) input.answer = positional.join(' ');
  else if (positional.length && ['ask_coordinator', 'thread'].includes(tool.name) && input.text === undefined) input.text = positional.join(' ');
  else if (positional.length) { console.error(`Unexpected ${positional.join(' ')}. Pass values as --key value.`); return 1; }
  const result = await callOwnerTool(tool.name, input, { homes, caller: 'cli' });
  if (result.ok) { console.log(result.text); return 0; }
  console.error(result.error.text); return result.error.code === 'not_running' ? 3 : 1;
}

/** Bridge specification, "Status line": prints within 300 ms, `--wrap` puts another status line in front. */
export async function statuslineCommand(args: string[], homes = new Homes(), stdin: () => Promise<string> = readStdin): Promise<number> {
  if (args[0] === 'install') return statuslineInstall(args.slice(1), homes);
  const wrapIndex = args.indexOf('--wrap'); const wrap = wrapIndex >= 0 ? args[wrapIndex + 1] : undefined;
  const input = await stdin(); let cwd: string | undefined;
  try { const parsed = JSON.parse(input) as { workspace?: { current_dir?: unknown }; cwd?: unknown }; cwd = typeof parsed.workspace?.current_dir === 'string' ? parsed.workspace.current_dir : typeof parsed.cwd === 'string' ? parsed.cwd : undefined; } catch { /* no JSON: no folder */ }
  const wrapped = wrap ? runWrapped(wrap, input) : Promise.resolve('');
  const line = await jevellanLine(homes, cwd);
  const before = (await wrapped).trim();
  console.log(before ? `${before}  |  ${line}` : line);
  return 0;
}
async function jevellanLine(homes: Homes, cwd: string | undefined): Promise<string> {
  let control; try { control = readDocument(doctorControlPath(homes), DoctorControlSchema); } catch { return 'Jevellan · not running'; }
  try {
    const response = await fetch(`${control.origin}/api/local/statusline`, { method: 'POST', signal: AbortSignal.timeout(280), headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema: 'status-line-request-v1', ...(cwd ? { cwd } : {}) }) });
    if (!response.ok) return 'Jevellan · not running';
    return StatusLineViewSchema.parse(await response.json()).text;
  } catch (error) { return error instanceof Error && error.name === 'TimeoutError' ? 'Jevellan · no answer' : 'Jevellan · not running'; }
}
function runWrapped(command: string, input: string): Promise<string> {
  return new Promise(resolvePromise => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] }); let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolvePromise(output); }, 2000);
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.on('close', () => { clearTimeout(timer); resolvePromise(output); }); child.on('error', () => { clearTimeout(timer); resolvePromise(''); });
    child.stdin.end(input);
  });
}
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString('utf8');
}
function configDir(args: string[]): string {
  const index = args.indexOf('--claude-config-dir');
  return index >= 0 && args[index + 1] ? resolve(args[index + 1]!) : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}
/** The command that runs this installation (the installed wrapper when there is one). */
export function installedCommand(homes: Homes): string[] {
  try {
    const record = JSON.parse(readFileSync(join(homes.root, 'install.json'), 'utf8')) as { command?: { definition?: { path?: unknown } } };
    const path = record.command?.definition?.path; if (typeof path === 'string' && existsSync(path)) return [path];
  } catch { /* not installed: run this copy */ }
  return [process.execPath, join(applicationRoot(), 'bin', 'jevellan.mjs')];
}
const quote = (part: string) => /^[A-Za-z0-9_./:=@-]+$/u.test(part) ? part : `'${part.replace(/'/gu, `'\\''`)}'`;
function statuslineInstall(args: string[], homes: Homes): number {
  const dir = configDir(args); const path = join(dir, 'settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  const command = installedCommand(homes).map(quote).join(' ');
  const existing = (settings.statusLine as { command?: unknown } | undefined)?.command;
  const mine = typeof existing === 'string' && existing.includes(' statusline');
  const statusLine = { type: 'command', command: `${command} statusline${typeof existing === 'string' && !mine ? ` --wrap ${quote(existing)}` : ''}` };
  mkdirSync(dir, { recursive: true }); writeFileSync(path, `${JSON.stringify({ ...settings, statusLine }, null, 2)}\n`);
  console.log(`Installed the Jevellan status line for Claude Code (${dir})${typeof existing === 'string' && !mine ? ', after your existing status line' : ''}.`);
  return 0;
}

/** `jevellan watch [target] [--project p] [--all] [--no-thinking]`: the live event stream in the terminal, resuming from the last seq. */
export async function watchCommand(args: string[], homes = new Homes(), out: (line: string) => void = line => console.log(line), once = false): Promise<number> {
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const project = option('--project') ?? process.env.JEVELLAN_PROJECT; const all = args.includes('--all'); const noThinking = args.includes('--no-thinking');
  const target = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--project')?.toUpperCase() ?? 'C';
  const colors = [36, 33, 35, 32, 34, 31]; const colorOf = new Map<string, number>(); const tty = process.stdout.isTTY;
  const show = (event: OwnerEvent) => {
    if (!all && event.source !== target) return; if (noThinking && event.kind === 'think') return;
    const clock = new Date(event.at).toLocaleTimeString('en-GB', { hour12: false }); const kind = event.kind.padEnd(6);
    let source = event.source.padEnd(6);
    if (tty) { if (!colorOf.has(event.source)) colorOf.set(event.source, colors[colorOf.size % colors.length]!); source = `\u001b[${colorOf.get(event.source)}m${source}\u001b[0m`; }
    out(`${clock} ${source} ${kind} ${event.text}`);
  };
  let after = 0;
  for (;;) {
    let control; try { control = readDocument(doctorControlPath(homes), DoctorControlSchema); } catch { console.error('Jevellan is not running on this device.'); if (once) return 3; await new Promise(r => setTimeout(r, 3000)); continue; }
    try {
      const url = new URL(`${control.origin}/api/local/events`); url.searchParams.set('after', String(after)); if (project) url.searchParams.set('project', project);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${control.token}`, Accept: 'text/event-stream' } });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let split; while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue; const event = OwnerEventSchema.safeParse(JSON.parse(data.slice(6))); if (!event.success) continue;
          after = event.data.seq; show(event.data);
        }
        if (once) { await reader.cancel(); return 0; }
      }
    } catch { /* reconnect below */ }
    if (once) return 0;
    await new Promise(r => setTimeout(r, 2000));
  }
}

/** `jevellan attach T31`: the terminal joins a held thread's tmux session (bridge specification, "Live watch"). */
export function attachCommand(args: string[]): number {
  const id = (args[0] ?? '').toUpperCase();
  if (!/^T[1-9][0-9]*$/u.test(id)) { console.error('Usage: jevellan attach T31'); return 1; }
  const session = `jv-${id}`;
  if (spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status !== 0) {
    console.error(`${id} is not held. Take it over first: thread open, from the bridge or with jevellan call thread open ${id}.`); return 1;
  }
  return spawnSync('tmux', ['attach', '-t', session], { stdio: 'inherit' }).status ?? 1;
}

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

/** `jevellan plugin build|install [--claude-config-dir <dir>]`. */
export function pluginCommand(args: string[], homes = new Homes(), claude = 'claude'): number {
  if (args[0] === 'build') { console.log(`Built the Jevellan plugin at ${buildPlugin(homes)}.`); return 0; }
  if (args[0] !== 'install') { console.error('Usage: jevellan plugin build, or jevellan plugin install [--claude-config-dir <dir>]'); return 1; }
  const root = buildPlugin(homes); const dir = configDir(args); const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  const run = (argv: string[]) => spawnSync(claude, argv, { env, encoding: 'utf8' });
  const marketplace = run(['plugin', 'marketplace', 'add', root]);
  if (marketplace.status !== 0 && !/already/iu.test(`${marketplace.stdout}${marketplace.stderr}`)) { console.error(`Claude Code refused the Jevellan marketplace: ${(marketplace.stderr || marketplace.stdout).trim()}`); return 1; }
  run(['plugin', 'marketplace', 'update', 'jevellan-local']);
  const install = run(['plugin', 'install', 'jevellan@jevellan-local', '--scope', 'user']);
  if (install.status !== 0) { console.error(`Claude Code refused the Jevellan plugin: ${(install.stderr || install.stdout).trim()}`); return 1; }
  console.log(`Installed the Jevellan plugin for Claude Code (${dir}). Ask any Claude Code session in a project folder "what's running?".`);
  return 0;
}

/** The plugin's session-start hook (bridge specification, "Session-start hook"): context only in the bridge. */
export async function hookCommand(args: string[], homes = new Homes(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args[0] !== 'session-start') { console.error('Usage: jevellan hook session-start'); return 1; }
  if (env.JEVELLAN_ROLE || env.JEVELLAN_BRIDGE !== '1' || !env.JEVELLAN_PROJECT) return 0;
  const result = await callOwnerTool('status', {}, { homes, caller: 'cli', project: env.JEVELLAN_PROJECT, timeoutMs: 8000 });
  if (!result.ok) return 0;
  const view = result.data as { waiting?: unknown[]; running?: unknown[] } | undefined;
  console.log(`Jevellan bridge for ${env.JEVELLAN_PROJECT}. Waiting on you: ${view?.waiting?.length ?? 0}. Running: ${view?.running?.length ?? 0}.`);
  return 0;
}
