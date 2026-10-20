import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { IdSchema, TimestampSchema, atomicWrite, buildPlugin, pluginDist, type Project } from '@jevellan/core';
import type { Application } from './application.js';
import { hasInteractiveClaudeLogin } from '@jevellan/core';
import { OwnerRefusal } from './owner-tools.js';

const NAMESPACE = 'owner-bridges';
// state point hub namespace owner-bridges, key projectId: the running bridge as Jevellan started it
const BridgeStateSchema = z.strictObject({ schema: z.literal('owner-bridge-state-v1'), projectId: IdSchema, project: z.string().min(1).max(200), tmuxSession: z.string().min(1).max(120),
  folder: z.string().min(1).max(4096), configDir: z.string().min(1).max(4096), transport: z.enum(['channel', 'inject', 'none']), startedAt: TimestampSchema,
  wanted: z.boolean(), restarts: z.number().int().nonnegative(), lastCheckAt: TimestampSchema.optional() });
type BridgeState = z.infer<typeof BridgeStateSchema>;
export const BRIDGE_TOOL_PREFIX = 'mcp__plugin_jevellan_jevellan__';
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60) || 'project';
const shell = (part: string) => `'${part.replace(/'/gu, `'\\''`)}'`;
/** Start-up dialogs a fresh bridge shows, and the keys that answer them (run log, spikes S2 and S3). */
const DIALOGS: Array<{ text: RegExp; keys: string[] }> = [
  { text: /Yes, I trust this folder/u, keys: ['Down', 'Enter'] },
  { text: /I am using this for local development/u, keys: ['Enter'] },
  { text: /keep browser tools off/iu, keys: ['Enter'] },
  { text: /Do you want to use this API key\?/u, keys: ['Down', 'Enter'] },
];

/** Trust for the bridge folder, accepted in the account's own preferences before the start: the trust dialog defaults to "No, exit",
 * and a key sent before it takes input is lost (run log, Journey B). A preferences file that does not parse is left alone. */
function trustFolder(configDir: string, folder: string): void {
  const file = join(configDir, '.claude.json'); let value: Record<string, unknown> = {};
  if (existsSync(file)) { try { value = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, 'utf8'))); } catch { return; } }
  const projects = z.record(z.string(), z.record(z.string(), z.unknown())).safeParse(value.projects ?? {}); if (!projects.success) return;
  const path = realpathSync(folder); if (projects.data[path]?.hasTrustDialogAccepted === true) return;
  atomicWrite(file, `${JSON.stringify({ ...value, projects: { ...projects.data, [path]: { ...projects.data[path], hasTrustDialogAccepted: true } } }, null, 2)}\n`);
}

export type TmuxRunner = (args: string[]) => { status: number | null; stdout: string };
export const realTmux: TmuxRunner = (args) => { const result = spawnSync('tmux', args, { encoding: 'utf8' }); return { status: result.status, stdout: result.stdout ?? '' }; };

/**
 * One Claude Code session per project on the state point (bridge specification, "Bridge session and push"): Sonnet at medium effort,
 * under remote control so it shows in the Claude app, with the plugin loaded from the installation's data folder and only the Jevellan
 * tools allowed. Jevellan keeps it wanted and starts it again with `--continue` when its tmux session is gone. The `inject` transport
 * types pushes into its pane while it is idle.
 */
export class OwnerBridges {
  #timer: ReturnType<typeof setInterval> | undefined;
  #injectTimer: ReturnType<typeof setInterval> | undefined;
  /** Projects whose bridge is starting, and when each became ready: a channel push sent before then is dropped by Claude (Journey B). */
  readonly #starting = new Set<string>(); readonly #readyAt = new Map<string, number>();
  constructor(private readonly app: Application, readonly tmux: TmuxRunner = realTmux, readonly claude = process.env.JEVELLAN_CLAUDE_BIN || 'claude') {}
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.check().catch(() => undefined); }, 60_000); this.#timer.unref();
    this.#injectTimer = setInterval(() => { void this.injectPending().catch(() => undefined); }, 2000); this.#injectTimer.unref();
  }
  close(): void { clearInterval(this.#timer); clearInterval(this.#injectTimer); this.#timer = undefined; this.#injectTimer = undefined; }
  state(projectId: string): BridgeState | null { return this.app.hub.get(NAMESPACE, projectId, BridgeStateSchema)?.document ?? null; }
  #save(state: BridgeState): void { const stored = this.app.hub.get(NAMESPACE, state.projectId, BridgeStateSchema); this.app.hub.put(NAMESPACE, state.projectId, BridgeStateSchema, state, stored?.revision ?? 0); }
  /** Whether pushes may go to the project's bridge now: not while it starts, and three seconds after its prompt showed. */
  accepting(projectId: string, now = Date.now()): boolean { return !this.#starting.has(projectId) && now - (this.#readyAt.get(projectId) ?? 0) >= 3000; }
  sessionName(project: Pick<Project, 'name'>): string { return `jv-bridge-${slug(project.name)}`; }
  running(session: string): boolean {
    if (this.tmux(['has-session', '-t', `=${session}`]).status !== 0) return false;
    const command = this.tmux(['list-panes', '-t', `=${session}`, '-F', '#{pane_current_command}']).stdout;
    // Claude's native build runs as its version file (~/.local/share/claude/versions/2.1.304), so the pane shows the version number.
    return /claude|node|^\d+\.\d+\.\d+/mu.test(command);
  }
  /** The account folder the bridge runs under: the `bridge.account` account's managed folder, or an explicit Claude config folder. */
  async #configDir(project: Project, override?: string): Promise<{ dir: string; label: string }> {
    if (override) return { dir: override, label: override };
    const label = this.app.ownerTools.projectSettings(project.id).bridge.account;
    const account = (await this.app.accounts.list()).find(row => row.account.label === label && row.account.runtime === 'claude');
    if (!account) throw new OwnerRefusal(`There is no Claude account ${label} for the bridge. Change it with config set bridge account <label>.`, 'no_account', 409);
    return { dir: this.app.homes.account('claude', account.account.id), label };
  }

  async startBridge(project: Project, options: { restart?: boolean; claudeConfigDir?: string; continue?: boolean; remoteName?: string } = {}): Promise<string> {
    const session = this.sessionName(project); const settings = this.app.ownerTools.projectSettings(project.id);
    if (this.running(session) && !options.restart) return `The bridge for ${project.name} is already running (tmux ${session}).`;
    const { dir, label } = await this.#configDir(project, options.claudeConfigDir ?? this.state(project.id)?.configDir);
    // Remote control needs an interactive claude.ai login in the folder; a long-lived token cannot start it (run log, phase 0).
    if (!hasInteractiveClaudeLogin(dir)) throw new OwnerRefusal(`Account ${label} has no interactive Claude login, which remote control needs. Run: jevellan login ${label} --interactive`, 'no_interactive_login', 409);
    if (options.restart && this.tmux(['has-session', '-t', `=${session}`]).status === 0) this.tmux(['kill-session', '-t', `=${session}`]);
    const folder = this.app.homes.at('bridges', slug(project.name)); mkdirSync(folder, { recursive: true, mode: 0o700 });
    buildPlugin(this.app.homes);
    const plugin = join(pluginDist(this.app.homes), 'jevellan');
    const prompt = readFileSync(join(plugin, 'bridge', 'system-prompt.md'), 'utf8').replaceAll('{project}', project.name);
    writeFileSync(join(folder, 'system-prompt.md'), prompt, { mode: 0o600 });
    const transport = settings.push.transport; const files = this.#sessionFiles(dir, folder); const previous = files.length > 0;
    const before = this.state(project.id);
    if (before && transport !== 'none') this.app.ownerPushes.requeueUndelivered(project.id, Date.parse(before.startedAt), files.map(file => readFileSync(file, 'utf8')).join('\n'));
    const name = options.remoteName ?? process.env.JEVELLAN_BRIDGE_REMOTE_NAME ?? `Jevellan · ${project.name}`;
    const args = ['--model', 'sonnet', '--effort', 'medium', '--remote-control', name, '--plugin-dir', plugin,
      ...(transport === 'channel' ? ['--dangerously-load-development-channels', 'plugin:jevellan@inline'] : []),
      '--append-system-prompt-file', join(folder, 'system-prompt.md'), '--allowedTools', `${BRIDGE_TOOL_PREFIX}*`, '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit',
      ...(previous && options.continue !== false ? ['--continue'] : [])];
    // The account's claude.ai connectors stay out of the bridge: their task and calendar tools would compete with Jevellan's (run log, Journey A).
    const env: Record<string, string> = { JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: project.name, JEVELLAN_HOME: this.app.homes.root, CLAUDE_CONFIG_DIR: dir, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
    // tmux starts the session through the owner's login shell, whose profile can reorder PATH and find an older claude first: the script
    // restores the service's PATH and runs the claude that PATH finds, by its full path.
    const path = process.env.PATH ?? '/usr/bin:/bin';
    const script = ['#!/bin/sh', 'unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY JEVELLAN_ROLE', `export PATH=${shell(path)}`, ...Object.entries(env).map(([key, value]) => `export ${key}=${shell(value)}`),
      `exec ${shell(executableOnPath(this.claude, path))} ${args.map(shell).join(' ')}`].join('\n');
    writeFileSync(join(folder, 'start.sh'), `${script}\n`, { mode: 0o700 });
    trustFolder(dir, folder);
    const startedAt = new Date().toISOString(); let ready = false;
    this.#starting.add(project.id);
    try {
      const started = this.tmux(['new-session', '-d', '-s', session, '-x', '200', '-y', '50', '-c', folder, join(folder, 'start.sh')]);
      if (started.status !== 0) throw new OwnerRefusal(`tmux could not start the bridge session ${session}.`, 'tmux_failed', 500);
      ready = await this.#answerDialogs(session);
    } finally { this.#starting.delete(project.id); this.#readyAt.set(project.id, Date.now()); }
    this.#save({ schema: 'owner-bridge-state-v1', projectId: project.id, project: project.name, tmuxSession: session, folder, configDir: dir, transport, startedAt, wanted: true,
      restarts: (before?.restarts ?? 0) + (before ? 1 : 0) });
    this.app.ownerTools.updateProjectSettings(project.id, current => ({ ...current, bridge: { ...current.bridge, wanted: true } }));
    this.app.ownerEvents.publish({ projectId: project.id, source: 'jevellan', kind: 'state', text: `bridge started in tmux ${session}${ready ? '' : ' (start-up dialogs did not finish in time)'}` });
    return `Started the bridge for ${project.name} in tmux ${session}. Open the session "${name}" in the Claude app (account ${label}).${ready ? '' : ' It is still starting; check it with tmux attach -t ' + session + '.'}`;
  }

  stopBridge(project: Project): string {
    const session = this.sessionName(project); const state = this.state(project.id);
    if (state) this.#save({ ...state, wanted: false });
    this.app.ownerTools.updateProjectSettings(project.id, current => ({ ...current, bridge: { ...current.bridge, wanted: false } }));
    if (this.tmux(['has-session', '-t', `=${session}`]).status !== 0) return `The bridge for ${project.name} is not running.`;
    this.tmux(['send-keys', '-t', `=${session}:`, '/exit', 'Enter']);
    return `Stopping the bridge for ${project.name}. It stays off until you start it again.`;
  }

  /** Answers the known start-up dialogs until the prompt shows, for at most 90 seconds. */
  async #answerDialogs(session: string, timeoutMs = 90_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs; let quiet = 0; const answered = new Map<RegExp, number>(); let seen: RegExp | undefined;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const pane = this.tmux(['capture-pane', '-p', '-t', `=${session}:`]).stdout;
      // A dialog just answered can stay on screen until Claude redraws; answering it again would send its keys to the next dialog
      // (Down then Enter on the channel confirmation picks Exit), so each one waits five seconds before it is answered again.
      const dialog = DIALOGS.find(entry => entry.text.test(pane) && Date.now() - (answered.get(entry.text) ?? 0) >= 5000);
      // A dialog is answered on its second sighting, once it takes input; keys sent while it is still drawing are lost.
      if (dialog && seen !== dialog.text) { seen = dialog.text; quiet = 0; continue; }
      if (dialog) { seen = undefined; answered.set(dialog.text, Date.now()); for (const key of dialog.keys) { this.tmux(['send-keys', '-t', `=${session}:`, key]); await new Promise(resolve => setTimeout(resolve, 300)); } quiet = 0; continue; }
      if (DIALOGS.some(entry => entry.text.test(pane))) { quiet = 0; continue; }
      if (/Claude Code v\d/u.test(pane) && /❯/u.test(pane)) { quiet++; if (quiet >= 4) return true; }
    }
    return false;
  }

  #sessionFiles(configDir: string, folder: string): string[] {
    const directory = join(configDir, 'projects', folder.replace(/[^A-Za-z0-9]/gu, '-'));
    try { return readdirSync(directory).filter(name => name.endsWith('.jsonl')).map(name => join(directory, name)); } catch { return []; }
  }
  /** Idle: the bridge's newest session file has not changed for five seconds (bridge specification, `inject`). */
  idle(projectId: string, now = Date.now()): boolean {
    const state = this.state(projectId); if (!state) return false;
    const files = this.#sessionFiles(state.configDir, state.folder).map(path => statSync(path).mtimeMs);
    return files.length === 0 || now - Math.max(...files) >= 5000;
  }

  /** The minute check: a wanted bridge whose tmux session is gone starts again with `--continue`. */
  async check(): Promise<void> {
    for (const { document: state } of this.app.hub.list(NAMESPACE, BridgeStateSchema)) {
      if (!state.wanted || this.running(state.tmuxSession)) continue;
      const project = (await this.app.ownerTools.projects()).find(row => row.id === state.projectId); if (!project) continue;
      try { await this.startBridge(project, { claudeConfigDir: state.configDir }); this.app.ownerEvents.publish({ projectId: project.id, source: 'jevellan', kind: 'state', text: `bridge was gone; started it again with --continue` }); }
      catch (error) { this.app.ownerEvents.publish({ projectId: project.id, source: 'jevellan', kind: 'state', text: `bridge could not start again: ${error instanceof Error ? error.message : String(error)}` }); }
    }
  }

  /** The `inject` transport: types pushes into an idle bridge's pane as a message and acks them. */
  async injectPending(): Promise<void> {
    for (const { document: state } of this.app.hub.list(NAMESPACE, BridgeStateSchema)) {
      if (!state.wanted || state.transport !== 'inject' || !this.accepting(state.projectId) || !this.running(state.tmuxSession) || !this.idle(state.projectId)) continue;
      const [message] = this.app.ownerPushes.messages(state.projectId); if (!message) continue;
      const text = ` [Jevellan push]  ${message.text.replace(/^\[Jevellan\] /u, '').replace(/\n/gu, ' | ')}`;
      this.tmux(['send-keys', '-t', `=${state.tmuxSession}:`, '-l', text]); this.tmux(['send-keys', '-t', `=${state.tmuxSession}:`, 'Enter']);
      this.app.ownerPushes.ack(state.projectId, message.pushIds);
    }
  }
}

/** The full path of a command on PATH (the first executable file), or the name itself when it already has a slash or is not found. */
export function executableOnPath(name: string, path: string): string {
  if (name.includes('/')) return name;
  for (const directory of path.split(':').filter(entry => entry.startsWith('/'))) {
    const file = join(directory, name);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* the next directory */ }
  }
  return name;
}
