import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSchema, Homes, StretchSchema, type Handoff } from '../packages/core/dist/index.js';
import { ConversationLedger, ConversationWork, StretchExecution } from '../packages/conversations/dist/index.js';
import { FakeRuntime, groupAlive, type FakeStep, type StretchInput } from '../packages/runtime-contract/dist/index.js';

let root: string; let work: ConversationWork; let input: StretchInput;
const adapters: FakeRuntime[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-execution-')); mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'data'), join(root, 'user'));
  work = new ConversationWork(new ConversationLedger(homes, 'conversation'));
  work.create({ title: 'Fixture', projectId: 'project', ownerDeviceId: 'device' }); work.message('Keep the original request.', 'message'); work.baseCommit('base');
  const view = work.load();
  work.start(StretchSchema.parse({ schema: 'stretch-v2', n: 1, workId: view.conversation.work!.id, action: 'implement', modelId: 'model', runtime: 'fake', model: 'fixture', effortRequested: 'high', effortEffective: 'high', accountId: 'acc_fixture', deviceId: 'device', decisionId: 'decision', startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }), view.conversation.generation);
  input = { schema: 'stretch-input-v1', conversationId: 'conversation', stretch: 1, action: 'implement', cwd: root, permissions: 'write', memoryWrite: true, systemAppend: 'Implement the request.', brief: 'Keep the original request.', model: 'fixture', effort: 'high', timeoutMs: 5000,
    account: { account: AccountSchema.parse({ schema: 'account-v1', id: 'acc_fixture', runtime: 'fake', kind: 'api-key', credential: 'shared', label: 'Fixture', enabled: true, paidUse: 'always' }), home: homes.account('fake', 'acc_fixture'), env: {} }, launch: { mcpServers: {}, env: {} } };
});
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.close())); rmSync(root, { recursive: true, force: true }); });
function handoff(status: Handoff['status'] = 'done', summary = 'Original native handoff') {
  return work.ledger.acceptHandoff({ schema: 'handoff-v2', stretch: 1, action: 'implement', status, summary, evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [] });
}
function adapter(...steps: FakeStep[]): FakeRuntime {
  const runtime = new FakeRuntime(steps); runtime.capabilities.readOnlyEnforced = true; adapters.push(runtime); return runtime;
}
function execute(runtime: FakeRuntime, extra: Partial<ConstructorParameters<typeof StretchExecution>[0]> = {}) {
  return new StretchExecution({ work, input, adapter: runtime, enterRepair: () => {}, cancelHandoffTimeoutMs: 100, ...extra });
}
const waitForAbort: FakeStep = ({ signal, emit }) => new Promise((resolve) => {
  emit({ type: 'tool-start', id: 'waiting', name: 'Read', input: {} });
  signal.addEventListener('abort', () => resolve({ status: 'interrupted' }), { once: true });
});

test('native handoff is accepted unchanged, with no formatting rewrite or extra model call', async () => {
  const runtime = adapter(({ emit }) => {
    emit({ type: 'text', delta: 'Full original answer' });
    emit({ type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    handoff(); return { status: 'completed' };
  });
  const repair = vi.fn(); const outcome = await execute(runtime, { enterRepair: repair }).done;
  expect(outcome).toMatchObject({ status: 'completed', repaired: false, handoff: { summary: 'Original native handoff' }, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } });
  expect(repair).not.toHaveBeenCalled(); expect(runtime.starts).toHaveLength(1);
  expect(work.ledger.search('Full original answer')).toHaveLength(1);
  expect(groupAlive(runtime.runs[0]!.native.pgid)).toBe(false);
  expect(work.load().stretches[0]!.status).toBe('running'); // The loop still owes a checkpoint and stretch-end.
});

test('one repair continues the same session after the bridge loses its writing permission', async () => {
  const repair = vi.fn();
  const runtime = adapter(({ emit }) => { emit({ type: 'text', delta: 'Partial implementation output' }); emit({ type: 'usage', inputTokens: 10, outputTokens: 2, costUsd: 0.01 }); return { status: 'completed' }; }, ({ input, message, emit }) => {
    expect(repair).toHaveBeenCalledOnce(); expect(input.permissions).toBe('read-only'); expect(input.memoryWrite).toBe(false);
    expect(message).toContain('Call jevellan_handoff now');
    emit({ type: 'usage', inputTokens: 3, outputTokens: 1, costUsd: 0.02, costSource: 'estimated' });
    handoff('partial', 'Repair only reports the work.'); return { status: 'completed' };
  });
  const outcome = await execute(runtime, { enterRepair: repair }).done;
  expect(outcome).toMatchObject({ status: 'completed', repaired: true, usage: { inputTokens: 13, outputTokens: 3, costUsd: 0.03, costSource: 'estimated' } });
  expect(runtime.runs).toHaveLength(1); expect(work.load().stretches[0]!.native?.sessionId).toBe(runtime.runs[0]!.native.sessionId);
  expect(work.ledger.search('Partial implementation output')).toHaveLength(1);
});

test('missing session continuation starts a read-only repair with original request and ledger tail, after termination', async () => {
  let firstGone = false;
  const runtime = adapter(({ emit }) => { emit({ type: 'tool-start', id: 'edit', name: 'Edit', input: { path: 'sum.ts' } }); emit({ type: 'text', delta: 'Implemented sum; tests still needed.' }); return { status: 'completed' }; }, ({ input, message }) => {
    firstGone = !groupAlive(runtime.runs[0]!.native.pgid);
    expect(input.permissions).toBe('read-only'); expect(input.memoryWrite).toBe(false);
    expect(message).toContain('Keep the original request.'); expect(message).toContain('Implemented sum; tests still needed.'); expect(message).toContain('[ledger/');
    handoff('partial'); return { status: 'completed' };
  });
  runtime.capabilities.continueSession = false;
  const outcome = await execute(runtime).done;
  expect(firstGone).toBe(true); expect(runtime.starts).toHaveLength(2); expect(outcome.repaired).toBe(true);
  expect(work.load().stretches).toHaveLength(1);
});

test('failed repair keeps the original output and records an honest code-written handoff exactly once', async () => {
  const repair = vi.fn(() => ({ status: 'completed' as const }));
  const runtime = adapter(({ emit }) => { emit({ type: 'text', delta: 'Useful output that must survive.' }); emit({ type: 'tool-start', id: 'tool', name: 'Read', input: {} }); return { status: 'completed' }; }, repair);
  const outcome = await execute(runtime).done;
  expect(repair).toHaveBeenCalledOnce(); expect(outcome).toMatchObject({ status: 'failed', repaired: false, handoff: { status: 'failed', summary: 'Stretch ended without a handoff; last tool: Read.' } });
  expect(work.ledger.handoffs()).toHaveLength(1); expect(work.ledger.search('Useful output that must survive.')).toHaveLength(1);
  expect(work.ledger.events().some((event) => event.type === 'error')).toBe(true);
});

test.each([false, true])('runtime failure remains visible after a successful handoff repair (already streamed: %s)', async (streamed) => {
  const error = { kind: 'other' as const, message: 'Codex returned a malformed file_change item.' };
  const runtime = adapter(({ emit }) => {
    if (streamed) emit({ type: 'error', ...error });
    return { status: 'failed', error };
  }, () => { handoff('partial', 'No changes were confirmed.'); return { status: 'completed' }; });
  const outcome = await execute(runtime).done;
  expect(outcome).toMatchObject({ status: 'failed', repaired: true, error });
  const events = work.ledger.events().filter((event) => event.type === 'error');
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject(error);
});

test('correction interrupts, keeps the work open and grants only a partial repair', async () => {
  let ready!: () => void; const started = new Promise<void>((resolve) => { ready = resolve; });
  const runtime = adapter(waitForAbort, ({ message }) => { expect(message).toContain('status partial'); handoff('partial'); return { status: 'completed' }; });
  const execution = execute(runtime, { onEvent: (event) => { if (event.type === 'tool-start') ready(); } });
  await started; const before = work.load().conversation.work!.id;
  work.message('Change direction.', 'correction'); await execution.steer();
  const outcome = await execution.done;
  expect(outcome).toMatchObject({ status: 'interrupted', correction: true, repaired: true, handoff: { status: 'partial' } });
  expect(work.load().conversation.work!.id).toBe(before); expect(groupAlive(runtime.runs[0]!.native.pgid)).toBe(false);
});

test('cancel terminates the owned process, preserves partial output and never launches a repair', async () => {
  let ready!: () => void; const started = new Promise<void>((resolve) => { ready = resolve; });
  const repair = vi.fn(); const runtime = adapter(waitForAbort, repair);
  const execution = execute(runtime, { onEvent: (event) => { if (event.type === 'tool-start') ready(); } });
  await started; await execution.cancel(); const outcome = await execution.done;
  expect(groupAlive(runtime.runs[0]!.native.pgid)).toBe(false); expect(repair).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ status: 'interrupted', handoff: { status: 'partial' } });
});

test('repair timeout remains bounded and an unknown-price turn keeps the cost unknown', async () => {
  const runtime = adapter(({ emit }) => { emit({ type: 'usage', inputTokens: 1, outputTokens: 1 }); return { status: 'completed' }; }, waitForAbort);
  const outcome = await execute(runtime, { repairTimeoutMs: 100 }).done;
  expect(outcome).toMatchObject({ status: 'failed', usage: { costSource: 'unknown' } });
  expect(outcome.usage.costUsd).toBeUndefined(); expect(groupAlive(runtime.runs[0]!.native.pgid)).toBe(false);
});

test('cancel accepts an in-flight partial handoff after termination within its bounded grace period', async () => {
  let ready!: () => void; const started = new Promise<void>((resolve) => { ready = resolve; });
  const runtime = adapter(waitForAbort);
  const execution = execute(runtime, { cancelHandoffTimeoutMs: 1000, onEvent: (event) => { if (event.type === 'tool-start') ready(); } });
  await started; await execution.cancel();
  expect(groupAlive(runtime.runs[0]!.native.pgid)).toBe(false);
  handoff('partial', 'Late partial evidence was preserved.');
  expect(await execution.done).toMatchObject({ status: 'interrupted', handoff: { status: 'partial', summary: 'Late partial evidence was preserved.' } });
});

test('cleanup failure cannot produce a settled result or release the running stretch', async () => {
  const runtime = adapter(() => { handoff(); return { status: 'completed' }; });
  const execution = execute(runtime);
  const terminate = runtime.runs[0]!.terminate.bind(runtime.runs[0]!);
  const spy = vi.spyOn(runtime.runs[0]!, 'terminate').mockRejectedValueOnce(new Error('simulated cleanup failure'));
  await expect(execution.done).rejects.toThrow('cleanup failure');
  expect(work.load().stretches[0]!.status).toBe('running');
  spy.mockRestore(); await terminate();
});
