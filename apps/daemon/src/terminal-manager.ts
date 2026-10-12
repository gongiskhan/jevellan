import { readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { z } from 'zod';
import { Homes, IdSchema, TerminalCommandSourceSchema, TerminalSessionSchema, TimestampSchema, newId, readDocument, resolvedPath, writeDocument,
  type SecretRedactor, type TerminalCommand, type TerminalSession, type TerminalSnapshot } from '@jevellan/core';
import { TerminalBuffer } from './terminal-buffer.js';
import { terminalShell } from './terminal-shell.js';

const LocalSchema = z.strictObject({ schema: z.literal('terminal-local-v1'), session: TerminalSessionSchema, requestId: IdSchema, fingerprint: z.string(),
  source: TerminalCommandSourceSchema.optional(), command: z.string().max(4000).optional(),
  ownerCommandKey: z.string().length(64).optional(),
  commandSent: z.boolean().default(false),
  completion: z.strictObject({ messageId: IdSchema, text: z.string().max(14000), deliveredAt: TimestampSchema.nullable() }).optional(), takeover: z.boolean().default(false) });
type Local = z.infer<typeof LocalSchema>;
type Live = { local: Local; process: pty.IPty; buffer: TerminalBuffer; ready: Promise<void>; lastOutput: number; listeners: Set<(data: string) => void>; closed: Set<(reason: string) => void>; sent: boolean; expectedCommand: string | undefined };
export type TerminalManagerOptions = { homes: Homes; deviceId: string; deviceName: string; redactor: SecretRedactor; env?: NodeJS.ProcessEnv; now?: () => number;
  publish(snapshot: TerminalSnapshot): Promise<void>; deliver(local: { projectId: string; source: z.infer<typeof TerminalCommandSourceSchema>; messageId: string; text: string }): Promise<void>;
  detached?(threadId: string): Promise<void>; idleMs?: number; unknownMs?: number; timers?: boolean };
const refuse = (text: string, status = 409) => Object.assign(new Error(text), { status });

/** Real device PTYs. Browser connections are subscribers, never the lifetime of a shell. */
export class TerminalManager {
  readonly #o: TerminalManagerOptions; readonly #now: () => number; readonly #live = new Map<string, Live>(); readonly #saved = new Map<string, Local>();
  readonly #dirty = new Set<string>(); #timer: ReturnType<typeof setInterval> | undefined; #flushing: Promise<void> | undefined; #closing = false;
  readonly #deliveries = new Map<string, Promise<void>>(); readonly #buffers = new Map<string, TerminalBuffer>();
  constructor(options: TerminalManagerOptions) {
    this.#o = options; this.#now = options.now ?? Date.now;
    const root = options.homes.ensure('terminals');
    for (const id of readdirSync(root)) {
      const file = join(root, id, 'session.json'); if (!IdSchema.safeParse(id).success || !existsSync(file)) continue;
      const local = readDocument(file, LocalSchema);
      if (local.session.status === 'open') { local.session.status = 'closed'; local.session.closedReason = 'The device daemon restarted.';
        if (local.commandSent && local.source && local.session.projectId && !local.completion) local.completion = { messageId: `terminal_${local.requestId}`.slice(0, 120), deliveredAt: null,
          text: `The owner ran your command on ${options.deviceName} in ${local.session.cwd}:\n$ ${options.redactor.text(local.command ?? '')}\nExit code: unknown\nOutput (last 0 characters):\nThe device daemon restarted before the result was recorded.` };
        this.#save(local); this.#dirty.add(id); }
      this.#saved.set(id, local);
    }
    if (options.timers !== false) { this.#timer = setInterval(() => { void this.sweep().catch(() => {}); }, 500); this.#timer.unref(); }
  }
  #save(local: Local) { writeDocument(this.#o.homes.at('terminals', local.session.id, 'session.json'), LocalSchema, local); this.#saved.set(local.session.id, local); }
  session(id: string): TerminalSession { const local = this.#saved.get(IdSchema.parse(id)); if (!local) throw refuse('Terminal not found on this device.', 404); return structuredClone(local.session); }
  list() { return [...this.#saved.values()].map(row => structuredClone(row.session)); }
  async create(input: { requestId: string; fingerprint: string; cwd: string; title: string; projectId?: string; threadId?: string; source?: z.infer<typeof TerminalCommandSourceSchema>; command?: string; takeover?: boolean; ownerCommandKey?: string }) {
    if (this.#closing) throw refuse('Jevellan is stopping.', 503);
    const repeated = [...this.#saved.values()].find(row => row.requestId === input.requestId);
    if (repeated) { if (repeated.fingerprint !== input.fingerprint) throw refuse('This terminal request was already used for another command.'); return this.session(repeated.session.id); }
    if (this.#live.size >= 8) throw refuse('Eight terminals are already open on this device. Close one first.');
    const cwd = resolvedPath(input.cwd); if (!statSync(cwd).isDirectory()) throw refuse('Choose an existing folder.', 400);
    const at = new Date(this.#now()).toISOString(), id = newId('term', this.#now());
    const session = TerminalSessionSchema.parse({ schema: 'terminal-session-v1', id, deviceId: this.#o.deviceId, cwd, title: input.title,
      createdAt: at, lastActivityAt: at, status: 'open', ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.threadId ? { threadId: input.threadId } : {}) });
    const local = LocalSchema.parse({ schema: 'terminal-local-v1', session, requestId: input.requestId, fingerprint: input.fingerprint, takeover: input.takeover ?? false,
      ...(input.source ? { source: input.source } : {}), ...(input.command ? { command: input.command } : {}), ...(input.ownerCommandKey ? { ownerCommandKey: input.ownerCommandKey } : {}) });
    const shell = terminalShell(this.#o.homes, id, this.#o.env);
    let process: pty.IPty;
    try { process = pty.spawn(shell.shell, shell.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: shell.env }); }
    catch (error) { rmSync(shell.directory, { recursive: true, force: true }); throw error; }
    const buffer = new TerminalBuffer(id, cwd, this.#now); let ready: () => void = () => {};
    const live: Live = { local, process, buffer, ready: new Promise(resolve => { ready = resolve; }), lastOutput: this.#now(), listeners: new Set(), closed: new Set(), sent: false, expectedCommand: undefined };
    buffer.onPrompt = ready;
    buffer.onCommand = command => { if (local.source && !local.completion && live.sent && (command.approximate || command.command.trim() === live.expectedCommand)) { command.fromOwnerCommand = local.source; this.#complete(live, command); } this.#dirty.add(id); };
    this.#live.set(id, live); this.#buffers.set(id, buffer); this.#save(local); this.#dirty.add(id);
    process.onData(data => {
      live.lastOutput = this.#now(); local.session.lastActivityAt = new Date(live.lastOutput).toISOString(); buffer.feed(data); local.session.cwd = buffer.cwd; this.#dirty.add(id);
      for (const listener of live.listeners) listener(data);
    });
    process.onExit(event => { buffer.finish(event.exitCode); this.#ended(live, `Shell exited (${event.exitCode}).`); });
    if (!shell.integrated) { const timer = setTimeout(ready, 250); timer.unref(); }
    await this.flush();
    if (input.command) {
      const timeout = setTimeout(ready, 30_000); timeout.unref(); await live.ready; clearTimeout(timeout);
      if (local.session.status !== 'open') throw refuse('The terminal shell ended before the command could run.');
      live.sent = true;
      local.commandSent = true; this.#save(local);
      // Old Readline has no bracketed paste. A compound command keeps a multiline owner action and its final status together.
      const text = !buffer.bracketedPaste && buffer.integrated && input.command.includes('\n') ? `{\n${input.command}\n}` : input.command;
      live.expectedCommand = text.trim();
      if (!buffer.integrated) buffer.begin(input.command, true);
      this.input(id, buffer.bracketedPaste ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`);
    }
    return this.session(id);
  }
  #complete(live: Live, command: TerminalCommand) {
    const local = live.local; if (!local.source || local.completion || !local.session.projectId) return;
    const output = this.#o.redactor.text(command.output).slice(-8000), commandText = this.#o.redactor.text(local.command ?? command.command);
    local.completion = { messageId: `terminal_${local.requestId}`.slice(0, 120), deliveredAt: null,
      text: `The owner ran your command on ${this.#o.deviceName} in ${command.cwd}:\n$ ${commandText}\nExit code: ${command.exitCode ?? 'unknown'}\nOutput (last ${output.length} characters):\n${output}` };
    this.#save(local); void this.#deliver(local).catch(() => {});
  }
  async #deliver(local: Local) {
    if (!local.completion || local.completion.deliveredAt || !local.source || !local.session.projectId) return;
    const previous = this.#deliveries.get(local.session.id); if (previous) return previous;
    const { projectId } = local.session, { source, completion } = local;
    const pending = this.#o.deliver({ projectId, source, messageId: completion.messageId, text: completion.text }).then(() => {
      completion.deliveredAt = new Date(this.#now()).toISOString(); this.#save(local);
    }).finally(() => this.#deliveries.delete(local.session.id));
    this.#deliveries.set(local.session.id, pending); return pending;
  }
  #ended(live: Live, reason: string) {
    const local = live.local; if (local.session.status === 'closed') return;
    if (local.source && live.sent && !local.completion) this.#complete(live, { schema: 'terminal-command-v1', sessionId: local.session.id, index: 0,
      command: local.command ?? '', cwd: local.session.cwd, exitCode: null, startedAt: local.session.createdAt, endedAt: new Date(this.#now()).toISOString(), output: live.buffer.plain(), approximate: true });
    local.session.status = 'closed'; local.session.closedReason = reason; this.#save(local); this.#dirty.add(local.session.id); this.#live.delete(local.session.id);
    const closed = [...this.#buffers.keys()].filter(id => !this.#live.has(id)); for (const id of closed.slice(0, -32)) this.#buffers.delete(id);
    for (const listener of live.closed) listener(reason); live.listeners.clear(); live.closed.clear();
    if (local.takeover && local.session.threadId) void this.#o.detached?.(local.session.threadId).catch(() => {});
  }
  input(id: string, data: string) {
    const live = this.#live.get(IdSchema.parse(id)); if (!live) throw refuse('This terminal is closed.');
    if (Buffer.byteLength(data) > 48 * 1024) throw refuse('Terminal input is too large.', 400);
    live.local.session.lastActivityAt = new Date(this.#now()).toISOString(); live.buffer.input(data); live.process.write(data);
  }
  resize(id: string, cols: number, rows: number) { const live = this.#live.get(IdSchema.parse(id)); if (live) live.process.resize(cols, rows); }
  subscribe(id: string, output: (data: string) => void, closed: (reason: string) => void) {
    const live = this.#live.get(IdSchema.parse(id)); if (!live) return { raw: this.#buffers.get(id)?.raw ?? '', approximate: this.approximate(id), unsubscribe: () => {} };
    live.listeners.add(output); live.closed.add(closed);
    return { raw: live.buffer.raw, approximate: live.buffer.approximate, unsubscribe: () => { live.listeners.delete(output); live.closed.delete(closed); } };
  }
  approximate(id: string) { return this.#buffers.get(id)?.approximate ?? true; }
  snapshot(id: string) { const local = this.#saved.get(IdSchema.parse(id)); if (!local) throw refuse('Terminal not found.', 404);
    const snapshot = this.#buffers.get(id)?.snapshot(local.session, text => this.#o.redactor.text(text)) ?? { schema: 'terminal-snapshot-v1' as const, session: this.session(id), at: new Date(this.#now()).toISOString(), tail: '', commands: [], approximate: true };
    return { ...snapshot, ...(local.ownerCommandKey ? { ownerCommand: { key: local.ownerCommandKey, receipt: { schema: 'owner-command-run-receipt-v1' as const, terminalId: id,
      deviceId: local.session.deviceId, deviceName: this.#o.deviceName, at: local.session.createdAt } } } : {}) }; }
  async stop(id: string, reason = 'Closed by the owner.') {
    const live = this.#live.get(IdSchema.parse(id)); if (!live) { this.session(id); return; }
    live.buffer.finish(null); this.#ended(live, reason);
    try { live.process.kill('SIGHUP'); } catch { /* Shell already ended. */ }
    await this.flush();
  }
  flush(): Promise<void> {
    return this.#flushing ??= (async () => {
      for (const id of [...this.#dirty]) {
        this.#dirty.delete(id);
        try { const local = this.#saved.get(id)!; this.#save(local); await this.#o.publish(this.snapshot(id)); }
        catch (error) { this.#dirty.add(id); throw error; }
      }
    })().finally(() => { this.#flushing = undefined; });
  }
  async sweep() {
    const now = this.#now();
    for (const [id, live] of this.#live) {
      if (now - Date.parse(live.local.session.lastActivityAt) >= (this.#o.idleMs ?? 12 * 60 * 60_000)) await this.stop(id, 'Closed after twelve hours without activity.');
      else if (live.local.source && live.sent && !live.local.completion && live.buffer.current?.approximate && now - live.lastOutput >= (this.#o.unknownMs ?? 10_000)) live.buffer.finish(null);
    }
    for (const local of this.#saved.values()) if (local.completion && !local.completion.deliveredAt) await this.#deliver(local);
    await this.flush();
  }
  async close() { this.#closing = true; if (this.#timer) clearInterval(this.#timer); for (const id of [...this.#live.keys()]) await this.stop(id, 'The device daemon stopped.'); await this.flush(); await Promise.allSettled([...this.#deliveries.values()]); }
}
