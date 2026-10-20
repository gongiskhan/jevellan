import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DoctorControlSchema, Homes, OWNER_TOOLS, OwnerEventSchema, StatusLineViewSchema, buildPlugin, doctorControlPath, installedCommand, ownerTool, pluginDist, quote, readDocument, type OwnerEvent } from '@jevellan/core';
export { buildPlugin, installedCommand, pluginDist } from '@jevellan/core';
import { callOwnerTool } from './owner-mcp.js';

/** Values on the command line: JSON where it parses (numbers, booleans, arrays, objects), text otherwise. */
function value(raw: string): unknown { try { return JSON.parse(raw); } catch { return raw; } }

/** `jevellan call <tool> [action] [--key value ...]`: every tool from a terminal (bridge specification, "Live watch"). */
export async function callCommand(args: string[], homes = new Homes()): Promise<number> {
  const [name, ...rest] = args; const tool = name ? ownerTool(name) : undefined;
  if (!tool) { console.error(`Usage: jevellan call <tool> [action] [--key value ...]. Tools: ${OWNER_TOOLS.map(entry => entry.name).join(', ')}.`); return 1; }
  const input: Record<string, unknown> = {}; let index = 0;
  if (rest[0] && !rest[0].startsWith('--') && (!tool.single || tool.name === 'ask_coordinator')) { if (tool.name === 'ask_coordinator') input.mode = rest[0]; else input.action = rest[0]; index = 1; }
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
function statuslineInstall(args: string[], homes: Homes): number {
  const dir = configDir(args); const path = join(dir, 'settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  const command = installedCommand(homes).map(quote).join(' ');
  const existing = (settings.statusLine as { command?: unknown } | undefined)?.command;
  const mine = typeof existing === 'string' && existing.includes(' statusline');
  const statusLine = mine ? settings.statusLine : { type: 'command', command: `${command} statusline${typeof existing === 'string' ? ` --wrap ${quote(existing)}` : ''}` };
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

/** The plugin line `jevellan doctor` prints after its ten checks (bridge specification, "Installing the plugin"); it never changes the exit code. */
export async function pluginDoctorLine(homes = new Homes(), env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const built = existsSync(join(pluginDist(homes), 'jevellan', '.claude-plugin', 'plugin.json'));
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let installed = false; try { installed = readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8').includes('jevellan@jevellan-local'); } catch { /* not installed */ }
  // Reachable means the service answered, even when it answered that no project exists yet.
  const probe = await callOwnerTool('status', {}, { homes, caller: 'cli', timeoutMs: 5000 });
  const reachable = probe.ok || !['not_running', 'unauthenticated'].includes(probe.error.code);
  return `INFO Plugin: ${built ? 'built' : 'not built (jevellan plugin build)'} · ${installed ? `installed for Claude Code (${dir})` : 'not installed (jevellan plugin install)'} · forwarder ${reachable ? 'reachable' : 'not reachable'}`;
}

/** `jevellan bridge [--project p] [--restart] [--stop] [--claude-config-dir dir]` on the state point (bridge specification, "Starting the bridge"). */
export async function bridgeCommand(args: string[], homes = new Homes()): Promise<number> {
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const operation = args.includes('--stop') ? 'stop' : args.includes('--restart') ? 'restart' : 'start';
  const project = option('--project') ?? process.env.JEVELLAN_PROJECT; const dir = option('--claude-config-dir'); const remoteName = option('--remote-name');
  let control; try { control = readDocument(doctorControlPath(homes), DoctorControlSchema); } catch { console.error('Jevellan is not running on this device.'); return 3; }
  const response = await fetch(`${control.origin}/api/local/bridge`, { method: 'POST', signal: AbortSignal.timeout(180_000), headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'owner-bridge-request-v1', operation, ...(project ? { project } : {}), cwd: process.cwd(), ...(dir ? { claudeConfigDir: resolve(dir) } : {}), ...(remoteName ? { remoteName } : {}) }) });
  const body = await response.json().catch(() => null) as { ok?: boolean; text?: string; message?: string } | null;
  if (body?.ok) { console.log(body.text); return 0; }
  console.error(body?.text ?? body?.message ?? `The bridge could not start (HTTP ${response.status}).`); return 1;
}

/** `jevellan account in-place <label> --runtime claude|codex --folder <dir>`: use a folder you already logged in, in place (no copy). */
export async function accountCommand(args: string[], homes = new Homes()): Promise<number> {
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const label = args[1]; const runtime = option('--runtime'); const folder = option('--folder');
  if (args[0] !== 'in-place' || !label || label.startsWith('--') || (runtime !== 'claude' && runtime !== 'codex') || !folder) { console.error('Usage: jevellan account in-place <label> --runtime claude|codex --folder <dir>'); return 1; }
  let control; try { control = readDocument(doctorControlPath(homes), DoctorControlSchema); } catch { console.error('Jevellan is not running on this device.'); return 3; }
  const response = await fetch(`${control.origin}/api/local/accounts/in-place`, { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'owner-in-place-account-request-v1', label, runtime, folder: resolve(folder) }) });
  const body = await response.json().catch(() => null) as { ok?: boolean; text?: string; message?: string } | null;
  if (body?.ok) { console.log(body.text); return 0; }
  console.error(body?.text ?? body?.message ?? `The account could not be added (HTTP ${response.status}).`); return 1;
}

/** Reads one line from the terminal without echoing it, so codes and secrets never appear on screen or in a transcript. */
async function hidden(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as unknown as { question(q: string, cb: (a: string) => void): void; close(): void; _writeToOutput?: (s: string) => void };
  let muted = false; terminal._writeToOutput = (text: string) => { if (!muted) process.stdout.write(text); };
  return new Promise(resolvePromise => { terminal.question(question, answer => { terminal.close(); process.stdout.write('\n'); resolvePromise(answer); }); muted = true; });
}
/** `jevellan login <account> [--interactive]`: the same flow as the login tool, with the code typed in the terminal. */
export async function loginCommand(args: string[], homes = new Homes()): Promise<number> {
  const account = args.find(arg => !arg.startsWith('--')); if (!account) { console.error('Usage: jevellan login <account> [--interactive]'); return 1; }
  const started = await callOwnerTool('login', { action: 'start', account, ...(args.includes('--interactive') ? { interactive: true } : {}) }, { homes, caller: 'cli' });
  if (!started.ok) { console.error(started.error.text); return 1; }
  console.log(started.text.replace(' Then tell me the code it shows.', ''));
  if (/A push confirms when it is done\./u.test(started.text)) { console.log('Waiting for the login to finish here as well...'); }
  else {
    const code = await hidden('Paste the code it shows: ');
    const done = await callOwnerTool('login', { action: 'complete', account, code }, { homes, caller: 'cli' });
    console.log(done.ok ? done.text : done.error.text); return done.ok && /is logged in\./u.test(done.text) ? 0 : 1;
  }
  for (let attempt = 0; attempt < 180; attempt++) {
    const status = await callOwnerTool('login', { action: 'status', account }, { homes, caller: 'cli' });
    if (status.ok && /: logged in/u.test(status.text)) { console.log(`Account ${account} is logged in.`); return 0; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  console.error(`Account ${account} still is not logged in.`); return 1;
}
/** `jevellan secret set NAME [--project p]`: a project secret typed at a hidden prompt, saved in the vault. */
export async function secretCommand(args: string[], homes = new Homes()): Promise<number> {
  if (args[0] !== 'set' || !args[1]) { console.error('Usage: jevellan secret set NAME [--project p]'); return 1; }
  const index = args.indexOf('--project'); const project = index >= 0 ? args[index + 1] : undefined;
  const value = process.stdin.isTTY ? await hidden(`Value for ${args[1]}: `) : (await readStdin()).replace(/\n$/u, '');
  if (!value) { console.error('No value given; nothing was saved.'); return 1; }
  const result = await callOwnerTool('config', { action: 'set_secret', name: args[1], value, ...(project ? { project } : {}) }, { homes, caller: 'cli' });
  if (result.ok) { console.log(result.text); return 0; }
  console.error(result.error.text); return 1;
}

/** `jevellan remote setup [--client-id <id>] | revoke` (bridge specification, "Remote MCP"). */
export async function remoteCommand(args: string[], homes = new Homes()): Promise<number> {
  if (!['setup', 'revoke'].includes(args[0] ?? '')) { console.error('Usage: jevellan remote setup [--client-id <id>], or jevellan remote revoke'); return 1; }
  let control; try { control = readDocument(doctorControlPath(homes), DoctorControlSchema); } catch { console.error('Jevellan is not running on this device.'); return 3; }
  const index = args.indexOf('--client-id'); const clientId = index >= 0 ? args[index + 1] : undefined;
  const clientSecret = clientId ? await hidden('OAuth app client secret: ') : undefined;
  const response = await fetch(`${control.origin}/api/local/remote`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'owner-remote-request-v1', operation: args[0], port: Number(new URL(control.origin).port), ...(clientId && clientSecret ? { clientId, clientSecret } : {}) }) });
  const body = await response.json().catch(() => null) as { text?: string; message?: string } | null;
  if (response.ok && body?.text) { console.log(body.text); return 0; }
  console.error(body?.message ?? `Remote ${args[0]} failed (HTTP ${response.status}).`); return 1;
}
