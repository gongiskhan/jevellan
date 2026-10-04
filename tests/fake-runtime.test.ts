import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountSchema, BridgeRequestSchema, Homes } from '../packages/core/dist/index.js';
import { FakeRuntime, collectEvents, groupAlive, checkEventsAndContinuation, checkTurnResume, fakeNativeSessionFile, forCoordinator, forThread, nativeFormat, type StretchInput, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import { nativeTranscriptAt } from '../packages/mesh/dist/native-sessions.js';
let root: string; let homes: Homes; const runtime = new FakeRuntime();
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-scripted-'))); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'jevellan'), join(root, 'user')); });
afterEach(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
function input(): StretchInput { return { schema: 'stretch-input-v1', conversationId: 'fixture', stretch: 1, action: 'implement', cwd: root, permissions: 'write', memoryWrite: true, systemAppend: '', brief: 'Remember the fixture.', model: 'scripted-model', effort: 'high', timeoutMs: 5000, account: { account: AccountSchema.parse({ schema: 'account-v1', id: 'acc_fixture', runtime: 'fake', label: 'Fixture', kind: 'subscription', credential: 'per-device', enabled: true }), home: homes.account('fake', 'acc_fixture'), env: {} }, launch: { env: {}, mcpServers: {} } }; }
test('scripted adapter emits validated events, continues one session and owns a real process group', async () => {
  runtime.enqueue(({ emit }) => { emit({ type: 'text', delta: 'A scripted response.' }); emit({ type: 'tool-start', id: 'read', name: 'Read', input: {} }); emit({ type: 'tool-end', id: 'read', ok: true }); emit({ type: 'usage', inputTokens: 10, outputTokens: 4 }); return { status: 'completed' }; }, ({ message, emit }) => { emit({ type: 'text', delta: message }); return { status: 'completed' }; });
  await checkEventsAndContinuation(runtime, input(), { message: 'Same session fixture.', expectedText: 'Same session fixture.' });
  expect(groupAlive(runtime.runs.at(-1)!.native.pgid)).toBe(false);
});
test('interruption suppresses late events and cancellation confirms the process group is gone', async () => {
  let release!: () => void;
  runtime.enqueue(async ({ emit }) => { emit({ type: 'text', delta: 'Started.' }); await new Promise<void>((resolve) => { release = resolve; }); emit({ type: 'text', delta: 'Late.' }); return { status: 'completed' }; });
  const run = runtime.startStretch(input()); const iterator = run.events[Symbol.asyncIterator](); expect((await iterator.next()).value).toMatchObject({ type: 'text', delta: 'Started.' });
  await run.interrupt('steer'); release(); expect((await run.done).status).toBe('interrupted'); expect(await collectEvents(run)).toEqual([]);
  await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false);
});

function turn(runtime = 'fake', overrides: Partial<TurnInput> = {}): TurnInput {
  return { schema: 'turn-input-v1', owner: { kind: 'thread', projectId: 'proj_fixture', id: 'thread_fixture' }, turn: 1, cwd: root, permissions: 'write', model: 'scripted-model', effort: 'high', systemAppend: 'Fixture append.', prompt: 'Change the fixture.', safetyProfile: 'thread', timeoutMs: 5000,
    account: { account: AccountSchema.parse({ schema: 'account-v1', id: 'acc_fixture', runtime, label: 'Fixture', kind: 'subscription', credential: 'per-device', enabled: true }), home: homes.account(runtime, 'acc_fixture'), env: {} }, launch: { env: {}, mcpServers: {} }, ...overrides };
}
const coordinatorTurn = (prompt: string) => turn('fake', { owner: { kind: 'coordinator', projectId: 'proj_fixture', id: 'proj_fixture' }, permissions: 'read-only', safetyProfile: 'coordinator', prompt });
const transcript = (format: 'claude' | 'codex', home: string, id: string) => nativeTranscriptAt({ runtime: format, root: home, sessionId: id, deviceId: 'fixture-device', deviceName: 'Fixture', title: 'Fixture', project: 'Fixture' }).turns;

test('a scripted turn emits validated events, records its input and writes a Claude-format native session', async () => {
  runtime.enqueueTurn(({ say, emit, session, message }) => { expect(session.resumed).toBe(false); emit({ type: 'tool-start', id: 'read', name: 'Read', input: {} }); emit({ type: 'tool-end', id: 'read', ok: true }); say(`Done: ${message}`); return { status: 'completed' }; });
  const input = turn(); const run = runtime.startTurn(input);
  const events = await collectEvents(run); expect(await run.done).toEqual({ status: 'completed' });
  expect(events.map((event) => event.type)).toEqual(['tool-start', 'tool-end', 'text']);
  expect(runtime.turnStarts.at(-1)).toEqual(input); expect(runtime.turnStarts.at(-1)).not.toBe(input);
  const sessionId = run.native.sessionId!; expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(fakeNativeSessionFile('claude', input.account.home, sessionId)).toBe(join(input.account.home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`));
  expect(transcript('claude', input.account.home, sessionId).map((entry) => ({ role: entry.role, blocks: entry.blocks.map((block) => block.type === 'text' ? block.text : block.type) })))
    .toEqual([{ role: 'user', blocks: ['Change the fixture.'] }, { role: 'assistant', blocks: ['Done: Change the fixture.'] }]);
  await expect(run.continue('More.', 1000)).rejects.toThrow('Turns do not continue; start a new turn.');
  await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false);
});

test('a resumed turn keeps its native session and Codex accounts get one appended rollout', async () => {
  const codex = new FakeRuntime();
  try {
    codex.enqueueTurn(({ say, session }) => { say(session.resumed ? 'remembered' : 'first'); return { status: 'completed' }; }, forThread());
    codex.enqueueTurn(({ say, session }) => { say(session.resumed ? 'remembered' : 'first'); return { status: 'completed' }; }, forThread());
    expect(nativeFormat('codex')).toBe('codex'); expect(nativeFormat('fake')).toBe('claude');
    const first = turn('codex');
    await checkTurnResume(codex, first, { resumedText: 'remembered' });
    const [opened, resumed] = codex.turnStarts; const sessionId = resumed!.resume!.sessionId;
    expect(opened!.resume).toBeUndefined(); expect(resumed!.turn).toBe(2);
    const file = fakeNativeSessionFile('codex', first.account.home, sessionId)!;
    expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!)).toMatchObject({ type: 'session_meta', payload: { id: sessionId, cwd: root } });
    const days = join(first.account.home, 'sessions'); const files = readdirSync(days, { recursive: true }).filter((name) => String(name).endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    expect(transcript('codex', first.account.home, sessionId).map((entry) => `${entry.role}:${entry.blocks.map((block) => block.type === 'text' ? block.text : block.type).join()}`))
      .toEqual(['user:Change the fixture.', 'assistant:first', 'user:Change the fixture.', 'assistant:remembered']);
  } finally { await codex.close(); }
});

test('turns route by owner and an unscripted turn fails cleanly', async () => {
  const routed = new FakeRuntime([], { nativeFormat: 'codex' });
  try {
    routed.enqueueTurn(({ say }) => { say('thread B'); return { status: 'completed' }; }, forThread((input) => input.prompt.includes('task B')));
    routed.enqueueTurn(({ say }) => { say('coordinator'); return { status: 'completed' }; }, forCoordinator);
    const texts = async (input: TurnInput) => { const run = routed.startTurn(input); try { const events = await collectEvents(run); return { done: await run.done, text: events.flatMap((event) => event.type === 'text' ? [event.delta] : []).join(''), sessionId: run.native.sessionId! }; } finally { await run.terminate(); } };
    expect(await texts(coordinatorTurn('Owner says hello.'))).toMatchObject({ done: { status: 'completed' }, text: 'coordinator' });
    expect(await texts(turn('fake', { prompt: 'Do task A.' }))).toMatchObject({ done: { status: 'failed', error: { kind: 'other', message: 'No scripted turn remains.' } }, text: '' });
    const b = await texts(turn('fake', { prompt: 'Do task B.' }));
    expect(b).toMatchObject({ done: { status: 'completed' }, text: 'thread B' });
    expect(fakeNativeSessionFile('codex', turn().account.home, b.sessionId)).toBeTruthy();
    expect(routed.turnStarts.map((input) => input.owner.kind)).toEqual(['coordinator', 'thread', 'thread']);
  } finally { await routed.close(); }
});

test('bridge calls use the turn token and land in the native session; interruption drops late events', async () => {
  const requests: Array<{ authorization: string | undefined; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as { operation: string; name?: string }; requests.push({ authorization: request.headers.authorization, body: parsed }); response.setHeader('Content-Type', 'application/json');
    if (parsed.operation === 'list') { response.end(JSON.stringify({ schema: 'bridge-tools-v1', tools: [{ name: 'memory_read', description: 'Read a note.', inputSchema: { type: 'object' } }] })); return; }
    if (parsed.name === 'memory_search') { response.writeHead(400).end(JSON.stringify({ schema: 'error-v1', code: 'invalid', message: 'This turn already reported.' })); return; }
    response.end(JSON.stringify({ schema: 'bridge-result-v1', result: { schema: 'fixture-result-v1', ok: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const launch = { env: { JEVELLAN_STRETCH_TOKEN: 'fixture-turn-token', JEVELLAN_DAEMON_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, mcpServers: {} };
    let release!: () => void;
    runtime.enqueueTurn(async ({ bridge, tools, say }) => {
      expect(await tools()).toEqual(['memory_read']);
      expect(await bridge('memory_read', { permalink: 'note' })).toEqual({ schema: 'fixture-result-v1', ok: true });
      await expect(bridge('memory_search', { query: 'x' })).rejects.toThrow('This turn already reported.');
      say('Started.'); await new Promise<void>((resolve) => { release = resolve; }); say('Late.');
      return { status: 'completed' };
    });
    const input = turn('fake', { launch }); const run = runtime.startTurn(input);
    const iterator = run.events[Symbol.asyncIterator](); expect((await iterator.next()).value).toEqual({ type: 'text', delta: 'Started.' });
    await run.interrupt('steer'); release(); expect((await run.done).status).toBe('interrupted'); expect(await collectEvents(run)).toEqual([]);
    expect(requests.map((request) => request.authorization)).toEqual(['Bearer fixture-turn-token', 'Bearer fixture-turn-token', 'Bearer fixture-turn-token']);
    expect(requests.map((request) => BridgeRequestSchema.safeParse(request.body).success)).toEqual([true, true, true]);
    const rows = transcript('claude', input.account.home, run.native.sessionId!);
    expect(rows.flatMap((entry) => entry.blocks).map((block) => block.type === 'tool' ? `${block.name}:${block.state}` : block.type === 'text' ? block.text : block.type))
      .toEqual(['Change the fixture.', 'mcp__jevellan__memory_read:completed', 'mcp__jevellan__memory_search:failed', 'Started.']);
    await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
