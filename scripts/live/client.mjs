import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { z } from 'zod';
import { ProjectEventFrameSchema, ProjectWorkViewSchema, TaskListViewSchema, ThreadViewSchema, ProjectMemoryViewSchema, ProjectDailyListViewSchema } from '../../packages/core/dist/index.js';
import { newId, shellQuote } from './contracts.mjs';
import { SANDBOX_REPOSITORY } from './sandbox.mjs';

export const empty = { schema: 'empty-request-v1' };
export const blocked = message => Object.assign(new Error(message), { blocked: true });
export async function until(assertion, predicate, milliseconds, interval = 2000) {
  const deadline = Date.now() + milliseconds;
  do { const result = await predicate(); if (result) return result; await sleep(Math.min(interval, Math.max(1, deadline - Date.now()))); } while (Date.now() < deadline);
  throw new Error(`Timed out after ${Math.round(milliseconds / 60000 * 10) / 10} minutes: ${assertion}`);
}
export function command(executable, args, options = {}) {
  return execFileSync(executable, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
}
export function github(path, { method = 'GET', input } = {}) {
  // The owner's authorized CLI supplies its saved login; no token is extracted or written by the harness.
  const args = ['api', `repos/${SANDBOX_REPOSITORY}/${path}`, '--method', method];
  if (input !== undefined) args.push('--input', '-');
  return JSON.parse(command('gh', args, input === undefined ? {} : { input: JSON.stringify(input) }) || 'null');
}
export function git(checkout, args, options) { return command('git', args, { cwd: checkout, ...options }); }
export function remote(config, source, payload) {
  const script = `const payload = ${JSON.stringify(payload)};\n${source}`;
  return command('ssh', ['-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', config.madridHost,
    `${shellQuote(config.madridNode)} --input-type=module`], { input: script, timeout: 120000 });
}
export class OwnerClient {
  constructor(config, browser, context, page, secrets) { Object.assign(this, { config, browser, context, page, secrets }); this.events = new Map(); this.readers = new Map(); this.stops = new Map(); }
  static async connect(config, layout = 'desktop-light') {
    if (!existsSync(config.storageState)) throw blocked('Owner browser sign-in state is missing. Sign in through the hub UI; never put the passphrase in chat or arguments.');
    if (statSync(config.storageState).mode & 0o077) throw blocked('The private owner browser state must have mode 600.');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ storageState: config.storageState, baseURL: config.hub, viewport: layout.startsWith('phone') ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: layout.endsWith('dark') ? 'dark' : 'light', permissions: ['clipboard-read', 'clipboard-write'] });
      const page = await context.newPage(), secrets = (await context.cookies()).map(row => row.value), client = new OwnerClient(config, browser, context, page, secrets);
      const auth = await client.call('GET', '/api/auth'); if (!auth.authenticated) throw blocked('Sign in to the Pro hub through its owner UI.'); return client;
    } catch (error) { await browser.close(); throw error; }
  }
  async call(method, path, data, schema) {
    const response = await this.context.request.fetch(path, { method, headers: { Origin: new URL(this.config.hub).origin }, ...(data === undefined ? {} : { data }), timeout: 60000 });
    if (response.status() === 401) throw blocked('The owner UI sign-in expired.');
    if (!response.ok()) { const error = await response.json().catch(() => ({})); throw new Error(`${method} ${path}: ${response.status()} ${error.message ?? 'request failed'}`); }
    const value = await response.json(); return schema ? schema.parse(value) : value;
  }
  work(projectId) { return this.call('GET', `/api/projects/${projectId}/work`, undefined, ProjectWorkViewSchema); }
  tasks(projectId) { return this.call('GET', `/api/projects/${projectId}/tasks`, undefined, TaskListViewSchema).then(value => value.tasks); }
  thread(projectId, threadId) { return this.call('GET', `/api/projects/${projectId}/threads/${threadId}`, undefined, ThreadViewSchema); }
  memory(projectId) { return this.call('GET', `/api/projects/${projectId}/memory/shared`, undefined, ProjectMemoryViewSchema); }
  nightly(projectId) { return this.call('GET', `/api/projects/${projectId}/dailies`, undefined, ProjectDailyListViewSchema); }
  async settings(projectId, patch) {
    const view = await this.call('GET', `/api/projects/${projectId}/work-settings`), { schema: _schema, projectId: _id, revision, ...settings } = view.settings;
    void _schema; void _id;
    return this.call('PUT', `/api/projects/${projectId}/work-settings`, { schema: 'project-work-settings-request-v1', revision, clientRequestId: newId('settings'), settings: { ...settings, ...patch } });
  }
  async watch(projectId, threadId) {
    const key = `${projectId}:${threadId ?? 'coordinator'}`; if (this.readers.has(key)) return this.events.get(key);
    const cookies = await this.context.cookies(this.config.hub), cookie = cookies.map(row => `${row.name}=${row.value}`).join('; '), controller = new AbortController();
    this.stops.set(key, controller); const rows = []; this.events.set(key, rows);
    const url = `${this.config.hub}/api/projects/${projectId}/${threadId ? `threads/${threadId}` : 'coordinator'}/events`;
    let connected = false, head = 0;
    const task = (async () => {
      const response = await fetch(url, { headers: { Cookie: cookie }, signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`The owner ledger stream returned ${response.status}.`);
      head = z.coerce.number().int().nonnegative().parse(response.headers.get('x-jevellan-ledger-head') ?? 0);
      connected = true;
      let pending = ''; const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true }); assert(pending.length <= 2_000_000, 'An owner ledger frame exceeded its limit.');
        let end; while ((end = pending.indexOf('\n\n')) >= 0) {
          const packet = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'); if (!data) continue;
          const frame = ProjectEventFrameSchema.safeParse(JSON.parse(data)); if (frame.success && !rows.some(row => row.id === frame.data.event.id)) rows.push(frame.data.event);
        }
      }
    })(); this.readers.set(key, task); task.catch(error => { if (!controller.signal.aborted) this.streamError = error; });
    await until('the owner ledger stream to replay its initial history', () => this.streamError ? Promise.reject(this.streamError) : connected && (!head || rows.some(row => row.id >= head)), 30000, 100);
    return rows;
  }
  ledger(projectId, threadId) { if (this.streamError) throw this.streamError; return this.events.get(`${projectId}:${threadId ?? 'coordinator'}`) ?? []; }
  async owner(projectId, text, recorder, timeout = 15 * 60000) {
    await this.watch(projectId); const before = Date.now();
    await this.call('POST', `/api/projects/${projectId}/coordinator/messages`, { schema: 'coordinator-message-request-v1', clientMessageId: newId('owner'), text });
    const ended = await until('the coordinator to complete this owner turn', async () => {
      const rows = this.ledger(projectId), owner = rows.findLast(row => row.type === 'coordinator-event' && row.data.kind === 'user-message' && row.data.text === text && Date.parse(row.t) >= before - 2000);
      const turns = rows.filter(row => row.type === 'coordinator-turn-start' && row.data.eventIds.includes(owner?.data.id));
      return turns.map(turn => rows.find(row => row.type === 'coordinator-turn-end' && row.turn === turn.turn && row.data.status === 'completed')).find(Boolean);
    }, timeout);
    const reply = this.ledger(projectId).filter(row => row.turn === ended.turn && row.type === 'coordinator-text').map(row => row.data.text).join('\n');
    const tools = this.ledger(projectId).filter(row => row.turn === ended.turn && row.type === 'coordinator-tool').map(row => row.data);
    recorder.receipt.messages.push({ owner: text, reply, turn: ended.turn }); recorder.receipt.toolCalls.push(...tools); return { reply, tools, turn: ended.turn };
  }
  async task(projectId, title, brief, fixed = {}) { return this.call('POST', `/api/projects/${projectId}/tasks`, { schema: 'task-create-request-v1', clientRequestId: newId('task'), title, brief, fixed }); }
  async action(projectId, task, action, reason) { return this.call('POST', `/api/projects/${projectId}/tasks/${task.id}/action`, { schema: 'task-action-request-v1', expectedRevision: task.revision, action, ...(reason ? { reason } : {}) }); }
  async terminal(projectId, { deviceId, threadId, cwd = 'checkout', takeover = false } = {}) {
    const value = await this.call('POST', '/api/terminals', { schema: 'terminal-create-request-v1', clientRequestId: newId('terminal'), projectId, deviceId: deviceId ?? this.config.proDeviceId, ...(threadId ? { threadId } : {}), cwd, takeover });
    await this.page.goto(`${this.config.hub}/terminals/${value.session.id}`); return value.session;
  }
  async run(commandText) {
    await this.page.getByRole('textbox', { name: 'Type or dictate a command' }).fill(commandText);
    await this.page.locator('.terminal-commandline').getByRole('button', { name: 'Run', exact: true }).click();
  }
  terminalSnapshot(id) { return this.call('GET', `/api/terminals/${id}`); }
  async close() { for (const stop of this.stops.values()) stop.abort(); await Promise.allSettled([...this.readers.values()]); await this.browser.close(); }
}
export const GithubObjectSchema = z.record(z.string(), z.unknown());
export function publicTranscript(view) { return (view.transcript?.turns ?? []).map(turn => ({ role: turn.role, text: turn.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n'), tools: turn.blocks.filter(block => block.type === 'tool') })); }
export const userPrompts = view => publicTranscript(view).filter(row => row.role === 'user').map(row => row.text);
export function changedSource(number) { const files = github(`pulls/${number}/files?per_page=100`); return { files, patch: files.filter(row => /\.(?:ts|tsx|js)$/u.test(row.filename)).map(row => `${row.filename}\n${row.patch ?? ''}`).join('\n') }; }
export function startChild(executable, args, options) { return spawn(executable, args, { stdio: 'inherit', ...options }); }
