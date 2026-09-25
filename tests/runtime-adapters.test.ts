import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSchema, Homes } from '../packages/core/dist/index.js';
import { createRuntime as claude } from '../runtimes/claude/dist/index.js';
import { createRuntime as codex } from '../runtimes/codex/dist/index.js';
import { checkEventsAndContinuation, collectEvents, groupAlive, type StretchInput, type StretchRun } from '../packages/runtime-contract/dist/index.js';
let root: string; let homes: Homes; const runs: StretchRun[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-adapter-fixture-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'jevellan'), join(root, 'user')); });
afterEach(async () => { await Promise.all(runs.splice(0).map((run) => run.terminate())); await rm(root, { recursive: true, force: true }); });
function setup(runtime: 'claude' | 'codex') {
  const executable = join(root, 'fixture-cli'); writeFileSync(executable, readFileSync(new URL(runtime === 'claude' ? './fixtures/stream-cli.mjs' : './fixtures/exec-cli.mjs', import.meta.url)), { mode: 0o700 });
  const input: StretchInput = { schema: 'stretch-input-v1', conversationId: 'fixture', stretch: 1, action: 'reply', cwd: root, permissions: 'read-only', memoryWrite: false, systemAppend: '', brief: 'Read the fixture.', model: 'fixture-model', effort: 'low', timeoutMs: 5000,
    account: { account: AccountSchema.parse({ schema: 'account-v1', id: 'acc_fixture', runtime, label: 'Fixture', kind: 'subscription', credential: runtime === 'codex' ? 'per-device' : 'shared', enabled: true }), home: homes.account(runtime, 'acc_fixture'), env: {} }, launch: { mcpServers: {}, env: {} } };
  return { input, adapter: (runtime === 'claude' ? claude : codex)({ homes, executable }) };
}
test.each(['claude', 'codex'] as const)('%s adapter normalizes real SDK transport events and resumes the session with a fixture CLI', async (runtime) => {
  const { input, adapter } = setup(runtime);
  await checkEventsAndContinuation(adapter, input, { message: 'What do you remember?', expectedText: 'remembered-fixture' });
});
test.each(['claude', 'codex'] as const)('%s adapter interrupts its SDK turn and terminates the owned process group', async (runtime) => {
  const { input, adapter } = setup(runtime); input.brief = 'WAIT_FOR_INTERRUPT';
  const run = adapter.startStretch(input); runs.push(run);
  const iterator = run.events[Symbol.asyncIterator](); expect((await iterator.next()).value?.type).toBe('tool-start');
  const first = run.interrupt('steer'); const second = run.interrupt('cancel');
  expect(first).toBe(second);
  await Promise.all([first, second]); expect((await run.done).status).toBe('interrupted');
  await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false);
});
test.each(['claude', 'codex'] as const)('%s timeout interrupts the turn without leaving background cleanup promises', async (runtime) => {
  const { input, adapter } = setup(runtime); input.brief = 'WAIT_FOR_INTERRUPT'; input.timeoutMs = 1500;
  const run = adapter.startStretch(input); runs.push(run);
  expect((await run.done).status).toBe('interrupted');
  await run.interrupt('timeout');
  await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false);
});
test('Claude model discovery initializes without sending a model turn', async () => {
  const { input, adapter } = setup('claude'); expect(await adapter.listModels(input.account)).toEqual([{ id: 'fixture-model', label: 'Fixture', efforts: ['low', 'high'] }]);
});
test('Codex accepts native null fields while shell and MCP calls run', async () => {
  const { input, adapter } = setup('codex'); const run = adapter.startStretch(input); runs.push(run);
  const events = await collectEvents(run); expect((await run.done).status).toBe('completed');
  expect(events.find((event) => event.type === 'tool-end')).toMatchObject({ ok: true, output: 'fixture' });
  expect(events.find((event) => event.type === 'tool-end' && event.id === 'mcp')).toMatchObject({ ok: true });
});

test.each([false, true])('Codex streams an in-progress patch until its terminal outcome (failed: %s)', async (failed) => {
  const { input, adapter } = setup('codex'); input.brief = `PATCH_LIFECYCLE ${failed ? 'FAILED_PATCH' : ''}`;
  const run = adapter.startStretch(input); runs.push(run); const events = await collectEvents(run);
  expect((await run.done).status).toBe('completed');
  const patch = events.filter((event) => 'id' in event && event.id === 'patch');
  expect(patch).toEqual([
    { type: 'tool-start', id: 'patch', name: 'Edit', input: [{ path: 'src/sum.ts', kind: 'update' }] },
    { type: 'tool-end', id: 'patch', ok: !failed, output: JSON.stringify([{ path: 'src/sum.ts', kind: 'update' }]) },
  ]);
});
