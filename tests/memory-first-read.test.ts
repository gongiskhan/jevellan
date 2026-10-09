import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getEventListeners } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { Homes, MemorySearchSchema, ProjectSchema, runOwnedCommand, type Project } from '@jevellan/core';
import { BasicMemory, OwnedMemoryTransport } from '@jevellan/memory';
import { Application, createDaemon } from '@jevellan/daemon';

// Simulated provider timing, with real BasicMemory state and MCP client timeout/cancellation behavior.
vi.mock('@jevellan/core', async importOriginal => ({
  ...await importOriginal<typeof import('@jevellan/core')>(), runOwnedCommand: vi.fn(),
}));

function gate<T>() {
  let resolve!: (value: T) => void;
  const pending = new Promise<T>(done => { resolve = done; });
  return { pending, resolve };
}
const inputSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) });
const syncSchema = z.object({ schema: z.literal('memory-sync-request-v1'), project: z.string(), path: z.string() });
const commandResult = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });
let root: string; let homes: Homes; let memory: BasicMemory; let definition: Project;
let app: Application | undefined; let server: Server | undefined;
let sync: (project: string, path: string) => Promise<void>;
let holdRead: boolean;
const tools: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-memory-first-read-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); memory = new BasicMemory(homes);
  const checkout = join(root, 'project'); mkdirSync(checkout); execFileSync('git', ['init', '--initial-branch=main', checkout], { stdio: 'ignore' });
  definition = ProjectSchema.parse({ schema: 'project-v1', id: 'cold_memory', name: 'Cold memory fixture', paths: { here: checkout }, branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } });
  const folder = join(checkout, '.jevellan/memory'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'Base.md'), '---\ntitle: Base rule\n---\nPreserve the existing rule.\n');
  sync = async () => {}; holdRead = false; tools.length = 0;
  vi.mocked(runOwnedCommand).mockReset().mockImplementation(async (_command, args, options) => {
    if (args.includes('--version')) return commandResult('basic-memory 0.22.1');
    const input = syncSchema.parse(JSON.parse(options.input!)); await sync(input.project, input.path);
    return commandResult(JSON.stringify({ schema: 'memory-sync-v1', project: input.project, total: 1 }));
  });
  vi.spyOn(OwnedMemoryTransport.prototype, 'start').mockImplementation(async () => {});
  vi.spyOn(OwnedMemoryTransport.prototype, 'close').mockImplementation(async function (this: OwnedMemoryTransport) { this.onclose?.(); });
  vi.spyOn(OwnedMemoryTransport.prototype, 'send').mockImplementation(async function (this: OwnedMemoryTransport, message) {
    if (!('id' in message) || !('method' in message)) return;
    const reply = (result: Record<string, unknown>) => queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') { reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture-memory', version: '0.22.1' } }); return; }
    if (message.method !== 'tools/call') throw new Error('The fixture received an unexpected request.');
    const input = inputSchema.parse(message.params); tools.push(input.name);
    if (input.name === 'read_note' && holdRead) return;
    const result = input.name === 'create_memory_project' ? { name: input.arguments.project_name, path: input.arguments.project_path }
      : input.name === 'search_notes' ? { results: [{ title: 'Base rule', file_path: 'Base.md' }] }
      : { title: 'Base rule', file_path: 'Base.md', content: readFileSync(join(folder, 'Base.md'), 'utf8') };
    reply({ content: [], structuredContent: { result } });
  });
});
afterEach(async () => {
  vi.useRealTimers();
  if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  if (app) { await app.close(); app = undefined; }
  await memory.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
});
const projectMemory = () => memory.project(definition, 'here', () => { throw new Error('This reader cannot write.'); });
async function cancelledWhileHeld<T>(pending: Promise<T>): Promise<void> {
  const result = await Promise.race([pending.then(() => 'resolved', error => error instanceof Error ? error.name : 'rejected'), new Promise<string>(resolve => setTimeout(() => resolve('still waiting for setup'), 100))]);
  expect(result).toBe('AbortError');
}

test('cancelling one cold reader stops its wait while another uses the same bounded initialization', async () => {
  const started = gate<void>(); const release = gate<void>();
  sync = async () => { started.resolve(); await release.pending; };
  const cancelled = new AbortController(); const live = new AbortController(); const reader = projectMemory();
  const first = reader.read('Base.md', cancelled.signal); const second = reader.read('Base.md', live.signal);
  try {
    await started.pending; cancelled.abort(); await cancelledWhileHeld(first);
    expect(tools.filter(name => name === 'read_note')).toHaveLength(0);
    release.resolve(); expect((await second).content).toContain('existing rule');
    expect(tools.filter(name => name === 'create_memory_project')).toHaveLength(1);
    expect(tools.filter(name => name === 'read_note')).toHaveLength(1);
    expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0);
    const prepared = new AbortController(); await memory.project(definition, 'here', () => {}).prepare(prepared.signal); expect(getEventListeners(prepared.signal, 'abort')).toHaveLength(0);
  } finally { release.resolve(); await Promise.allSettled([first, second]); }
});

test('cancelling search during foreground sync returns before sync and performs no later provider search', async () => {
  const reader = projectMemory(); expect((await reader.search('base', new AbortController().signal)).notes).toHaveLength(1);
  writeFileSync(join(reader.path, 'Base.md'), '---\ntitle: Base rule\n---\nPreserve the changed rule.\n');
  const started = gate<void>(); const release = gate<void>(); sync = async () => { started.resolve(); await release.pending; };
  const controller = new AbortController(); const before = tools.length; const pending = reader.search('changed', controller.signal);
  try {
    await started.pending; controller.abort(); await cancelledWhileHeld(pending);
    expect(tools.slice(before)).toEqual([]); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect((await reader.read('Base.md', new AbortController().signal)).content).toContain('changed rule');
  } finally { release.resolve(); await Promise.allSettled([pending]); }
});

test('an abort racing with initialization completion cannot invoke a provider tool', async () => {
  const started = gate<void>(); const release = gate<void>(); sync = async () => { started.resolve(); await release.pending; };
  const controller = new AbortController(); const pending = projectMemory().read('Base.md', controller.signal);
  try { await started.pending; release.resolve(); controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(tools).not.toContain('read_note'); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0); }
  finally { release.resolve(); await Promise.allSettled([pending]); }
});

test('a cancelled reader cannot start setup or a provider tool', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(projectMemory().read('Base.md', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(tools).toEqual([]); expect(runOwnedCommand).not.toHaveBeenCalled();
});

test('failed initialization releases the reader listener and a later request can retry', async () => {
  const controller = new AbortController(); sync = async () => { throw new Error('Fixture sync failed.'); };
  await expect(projectMemory().read('Base.md', controller.signal)).rejects.toThrow('Fixture sync failed.');
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0); expect(tools).not.toContain('read_note');
  sync = async () => {}; expect((await projectMemory().read('Base.md', new AbortController().signal)).content).toContain('existing rule');
});

test('a warm native memory tool still stops after its own execution deadline', async () => {
  const reader = projectMemory(); await reader.read('Base.md', new AbortController().signal);
  holdRead = true; vi.useFakeTimers();
  const controller = new AbortController(); const pending = reader.read('Base.md', controller.signal); const refused = expect(pending).rejects.toMatchObject({ code: -32001 });
  await vi.advanceTimersByTimeAsync(30_001); await refused;
  expect(controller.signal.aborted).toBe(false);
});

async function apiFixture() {
  await memory.close(); app = new Application({ homes, timers: false }); memory = app.memory;
  await app.conversations.ready;
  definition = ProjectSchema.parse({ ...definition, paths: { [app.device.deviceId]: definition.paths.here } });
  app.hub.put('projects', definition.id, ProjectSchema, definition, 0);
  server = createDaemon({ application: app });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolve(); }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'fixture-memory-first-read' }) });
  expect(setup.status).toBe(200); const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  return { base, headers: { Cookie: cookie, Origin: base }, url: `${base}/api/projects/${definition.id}/memory?query=existing` };
}

test('the UI allows successful cold setup beyond a native tool budget and keeps its overall ceiling', async () => {
  const fixture = await apiFixture(); const started = gate<void>(); const release = gate<void>();
  sync = async () => { started.resolve(); await release.pending; };
  // Scale only the route's AbortSignal timeout so the former 30-second rejection is reproduced quickly.
  const realTimeout = AbortSignal.timeout.bind(AbortSignal); vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => realTimeout(Math.ceil(ms / 500)));
  const pending = fetch(fixture.url, { headers: fixture.headers });
  try {
    await started.pending; await new Promise(resolve => setTimeout(resolve, 90)); release.resolve();
    const response = await pending; expect(response.status).toBe(200); expect(MemorySearchSchema.parse(await response.json()).notes).toHaveLength(1);
  } finally { release.resolve(); await Promise.allSettled([pending]); }
});

test('the UI memory ceiling ends a held startup and never invokes a later provider search', async () => {
  const fixture = await apiFixture(); const started = gate<void>(); const release = gate<void>();
  sync = async () => { started.resolve(); await release.pending; };
  const realTimeout = AbortSignal.timeout.bind(AbortSignal); vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => realTimeout(Math.ceil(ms / 500)));
  const pending = fetch(fixture.url, { headers: fixture.headers });
  try {
    await started.pending; const response = await Promise.race([pending, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 500))]); expect(response).toBeDefined(); expect(response!.status).toBe(400); expect(await response!.json()).toMatchObject({ schema: 'error-v1', message: 'The operation was aborted due to timeout' });
    expect(tools).not.toContain('search_notes'); release.resolve(); await memory.connection(`jv-${definition.id}`, memory.project(definition, app!.device.deviceId, () => {}).path); expect(tools).not.toContain('search_notes');
  } finally { release.resolve(); await Promise.allSettled([pending]); }
});

test('leaving the UI cancels its held memory wait without interrupting shared initialization', async () => {
  const fixture = await apiFixture(); const started = gate<void>(); const release = gate<void>();
  sync = async () => { started.resolve(); await release.pending; };
  const controller = new AbortController(); const original = app!.conversations.memory.bind(app!.conversations);
  const finished = gate<unknown>();
  vi.spyOn(app!.conversations, 'memory').mockImplementation(async id => {
    const reader = await original(id); const search = reader.search.bind(reader);
    reader.search = async (query, signal) => { try { return await search(query, signal); } catch (error) { finished.resolve(error); throw error; } };
    return reader;
  });
  const pending = fetch(fixture.url, { headers: fixture.headers, signal: controller.signal });
  try {
    await started.pending; controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const state = await Promise.race([finished.pending, new Promise(resolve => setTimeout(() => resolve('still waiting for setup'), 100))]); expect(state).toMatchObject({ name: 'AbortError' });
    expect(tools).not.toContain('search_notes'); release.resolve(); await memory.connection(`jv-${definition.id}`, memory.project(definition, app!.device.deviceId, () => {}).path); expect(tools.filter(name => name === 'create_memory_project')).toHaveLength(1);
  } finally { release.resolve(); await Promise.allSettled([pending]); }
});
