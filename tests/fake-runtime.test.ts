import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountSchema, Homes } from '../packages/core/dist/index.js';
import { FakeRuntime, collectEvents, groupAlive, checkEventsAndContinuation, type StretchInput } from '../packages/runtime-contract/dist/index.js';
let root: string; let homes: Homes; const runtime = new FakeRuntime();
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-scripted-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'jevellan'), join(root, 'user')); });
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
