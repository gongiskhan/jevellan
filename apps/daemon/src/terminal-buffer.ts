/* eslint-disable no-control-regex -- OSC and ANSI framing use these literal protocol control bytes. */
import { stripVTControlCharacters } from 'node:util';
import { TerminalCommandSchema, TerminalSnapshotSchema, type TerminalCommand, type TerminalSession, type TerminalSnapshot } from '@jevellan/core';

export const TERMINAL_BUFFER_BYTES = 2 * 1024 * 1024;
export function terminalPlain(text: string): string {
  const withoutOsc = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/gu, '').replace(/\x1b\][^\x07]*$/gu, '');
  return stripVTControlCharacters(withoutOsc).replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/[^\n]\x08/gu, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '');
}
export function terminalExcerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const note = '\n[output trimmed]\n', half = Math.floor((limit - note.length) / 2);
  return text.slice(0, half) + note + text.slice(-(limit - note.length - half));
}
const byteTail = (text: string, bytes: number) => { const buffer = Buffer.from(text); return buffer.length <= bytes ? text : buffer.subarray(buffer.length - bytes).toString('utf8').replace(/^\uFFFD/u, ''); };

/** OSC records are parsed across arbitrary PTY chunks; raw replay is bounded separately from plain command output. */
export class TerminalBuffer {
  raw = '';
  readonly commands: TerminalCommand[] = [];
  #pending = ''; #candidate = ''; #index = 0; #current: TerminalCommand | undefined; #cwd: string; #prompt = false;
  #integrated = false; #echo = ''; #remote = false; #paste = false;
  onPrompt: (() => void) | undefined;
  onCommand: ((command: TerminalCommand) => void) | undefined;
  constructor(readonly sessionId: string, cwd: string, readonly now: () => number = Date.now) { this.#cwd = cwd; }
  get integrated() { return this.#integrated; }
  get current() { return this.#current; }
  get cwd() { return this.#cwd; }
  get atPrompt() { return this.#prompt; }
  get bracketedPaste() { return this.#paste; }
  input(text: string) {
    // Readline handles the keys; the candidate is used only for unsupported shells, and only if it was visibly echoed.
    if (text.includes('\x1b[200~')) text = text.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
    if (text.includes('\x03')) { this.#candidate = ''; this.#echo = ''; }
    for (const char of stripVTControlCharacters(text)) {
      if (char === '\r' || char === '\n') { if (this.#candidate.trim()) this.#candidate += '\n'; }
      else if (char === '\x7f' || char === '\b') this.#candidate = this.#candidate.slice(0, -1);
      else if (char >= ' ') { if (this.#candidate.endsWith('\n')) { this.#candidate = ''; this.#echo = ''; } this.#candidate = (this.#candidate + char).slice(-8000); }
    }
  }
  feed(data: string) {
    this.raw = byteTail(this.raw + data, TERMINAL_BUFFER_BYTES);
    this.#pending += data;
    for (;;) {
      const start = this.#pending.indexOf('\x1b]');
      if (start < 0) { const carry = this.#pending.endsWith('\x1b') ? '\x1b' : ''; this.#text(carry ? this.#pending.slice(0, -1) : this.#pending); this.#pending = carry; break; }
      this.#text(this.#pending.slice(0, start)); this.#pending = this.#pending.slice(start);
      const end = /\x07|\x1b\\/u.exec(this.#pending);
      if (!end) { if (this.#pending.length > 65536) this.#pending = ''; break; }
      const token = this.#pending.slice(2, end.index); this.#pending = this.#pending.slice(end.index + end[0].length); this.#osc(token);
    }
  }
  #text(text: string) {
    if (!text) return;
    this.#echo = (this.#echo + terminalPlain(text)).slice(-16000);
    if ((!this.#integrated || this.#remote) && this.#candidate.endsWith('\n') && this.#echo.includes(this.#candidate.trim())) {
      this.begin(this.#candidate.trim(), true); this.#candidate = '';
    }
    if (this.#current) { this.#current.output = byteTail(this.#current.output + text, TERMINAL_BUFFER_BYTES); this.#trim(); }
  }
  #trim() {
    let excess = this.commands.reduce((sum, row) => sum + Buffer.byteLength(row.output), 0) - TERMINAL_BUFFER_BYTES;
    for (const row of this.commands) { if (excess <= 0) break; const bytes = Buffer.byteLength(row.output), remove = Math.min(excess, bytes); row.output = byteTail(row.output, bytes - remove); excess -= remove; }
  }
  #osc(token: string) {
    if (token.startsWith('7;file://')) { try { const cwd = decodeURIComponent(new URL(token.slice(2)).pathname); if (cwd.startsWith('/') && !/[\0\r\n]/u.test(cwd)) this.#cwd = cwd; } catch { /* Unsupported OSC folder. */ } return; }
    const [kind, phase, value] = token.split(';');
    if (kind !== '133') return;
    if (phase === 'P') { this.#paste = value === '1'; return; }
    this.#integrated = true;
    if (phase === 'C') { this.#prompt = false; this.#candidate = ''; this.#echo = ''; const command = value ? Buffer.from(value, 'base64').toString('utf8').slice(0, 8000) : ''; this.#remote = /(?:^|\s|;|\|)ssh(?:\s|$)/u.test(command); this.begin(command, !value); }
    if (phase === 'D') this.finish(this.#remote && this.#current?.approximate ? null : value && /^-?\d+$/u.test(value) ? Number(value) : null);
    if (phase === 'A') { this.#prompt = true; this.#remote = false; this.onPrompt?.(); }
  }
  begin(command: string, approximate: boolean) {
    if (this.#current) this.finish(null);
    const record = TerminalCommandSchema.parse({ schema: 'terminal-command-v1', sessionId: this.sessionId, index: this.#index++, command, cwd: this.#cwd,
      exitCode: null, startedAt: new Date(this.now()).toISOString(), endedAt: null, output: '', approximate });
    this.#current = record; this.commands.push(record);
    if (this.commands.length > 200) this.commands.shift();
  }
  finish(exitCode: number | null) {
    if (!this.#current) return;
    const record = this.#current; record.exitCode = exitCode; record.endedAt = new Date(this.now()).toISOString(); record.output = terminalPlain(record.output);
    this.#current = undefined; this.onCommand?.(record);
  }
  plain() { return terminalPlain(this.raw); }
  records(last: number, redact: (text: string) => string = text => text): TerminalCommand[] {
    const rows = this.commands.slice(-last); let remaining = 30000;
    return rows.map((row, index) => { const allowance = Math.min(8000, Math.floor(remaining / (rows.length - index))); const output = terminalExcerpt(redact(terminalPlain(row.output)), allowance); remaining -= output.length;
      return { ...row, command: redact(row.command).slice(0, 8000), output }; });
  }
  get approximate() { return !this.#integrated || this.#remote; }
  snapshot(session: TerminalSession, redact: (text: string) => string): TerminalSnapshot {
    return TerminalSnapshotSchema.parse({ schema: 'terminal-snapshot-v1', session, at: new Date(this.now()).toISOString(),
      tail: redact(this.plain()).slice(-30000), commands: this.records(20, redact), approximate: this.approximate });
  }
}
