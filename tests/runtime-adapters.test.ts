import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSchema, Homes } from '../packages/core/dist/index.js';
import { createRuntime as claude } from '../runtimes/claude/dist/index.js';
import { createRuntime as codex } from '../runtimes/codex/dist/index.js';
import { codexSandboxCheck } from '../runtimes/codex/dist/control.js';
import { StretchInputSchema, checkEventsAndContinuation, classifyRuntimeError, collectEvents, groupAlive, type StretchInput, type StretchRun } from '../packages/runtime-contract/dist/index.js';
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
test('Claude keeps the reason of an error result, such as a model usage limit', async () => {
  const { input, adapter } = setup('claude'); input.brief = 'MODEL_LIMIT_RESULT';
  const run = adapter.startStretch(input); runs.push(run);
  const events = []; for await (const event of run.events) events.push(event);
  expect(events.some((event) => event.type === 'tool-start')).toBe(false);
  const result = await run.done;
  expect(result.status).toBe('failed');
  expect(result.error).toMatchObject({ kind: 'rate-limit', scope: 'model' }); expect(result.error?.message).toContain("You've reached your Fable limit.");
  await run.terminate();
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

test.each([false, true])('Codex preserves sandbox and approval policy when explicitly reading a private non-Git input copy: %s', async inputCopy => {
  const { input, adapter } = setup('codex'); input.brief = 'REPORT_INPUT_COPY_OPTIONS'; if (inputCopy) input.inputCopy = true;
  const run = adapter.startStretch(input); runs.push(run);
  const inspect = async () => {
    const events = await collectEvents(run); expect((await run.done).status).toBe('completed');
    const output = events.find(event => event.type === 'text' && event.delta.includes('fixture-input-copy-options-v1'));
    expect(output?.type).toBe('text');
    if (output?.type !== 'text') throw new Error('The SDK did not expose its fixture launch options.');
    expect(JSON.parse(output.delta)).toEqual({ schema: 'fixture-input-copy-options-v1', inputCopy, sandbox: 'read-only', neverApprove: true, networkDisabled: true, sandboxBypass: false });
  };
  await inspect(); await run.continue('REPORT_INPUT_COPY_OPTIONS', 5000); await inspect();
});

test('private input-copy launches cannot request writing permissions, memory writes or a writing action', () => {
  const { input } = setup('codex');
  expect(StretchInputSchema.safeParse({ ...input, inputCopy: true }).success).toBe(true);
  for (const change of [{ permissions: 'write' }, { memoryWrite: true }, { action: 'implement' }]) expect(StretchInputSchema.safeParse({ ...input, inputCopy: true, ...change }).success).toBe(false);
});
test('runtime errors say whether a limit belongs to one model or to the whole account', () => {
  for (const message of ["You've reached your Fable limit. Switch to another model to continue.", 'You have hit the Opus 5 usage limit for today.', 'Limit reached for this model; try a different model.'])
    expect(classifyRuntimeError(message), message).toMatchObject({ kind: 'rate-limit', scope: 'model' });
  for (const message of ["You've hit your limit · resets 5pm (Europe/Lisbon)", "You've reached your weekly limit.", 'HTTP 429 Too Many Requests', 'Claude AI usage limit reached|1790000000'])
    expect(classifyRuntimeError(message), message).toEqual({ kind: 'rate-limit', message });
  expect(classifyRuntimeError('rate_limit')).toEqual({ kind: 'rate-limit', message: 'rate_limit' });
  expect(classifyRuntimeError('Something unrelated failed.', 'rate-limit')).toEqual({ kind: 'rate-limit', message: 'Something unrelated failed.' });
  expect(classifyRuntimeError('Invalid API key · Please run /login')).toMatchObject({ kind: 'other' });
  expect(classifyRuntimeError('401 authentication failed')).toEqual({ kind: 'auth', message: '401 authentication failed' });
});
test('Codex declares no read-only or shell capability when its Linux sandbox cannot start', async () => {
  // The shape seen on Ubuntu 24.04 with AppArmor restricting unprivileged user namespaces.
  const broken = join(root, 'codex-no-sandbox'); writeFileSync(broken, '#!/bin/sh\nif [ "$1" = sandbox ]; then echo "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" >&2; exit 1; fi\nexit 0\n', { mode: 0o700 });
  const working = join(root, 'codex-sandbox'); writeFileSync(working, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const home = homes.ensure('runtime-checks', 'codex');
  const failed = codexSandboxCheck(broken, home, 'linux');
  expect(failed).toMatchObject({ available: false, reason: expect.stringContaining('bwrap: loopback: Failed RTM_NEWADDR') });
  expect(codex({ homes, executable: broken }).capabilities).toMatchObject(process.platform === 'linux' ? { readOnlyEnforced: false, shell: false, edit: true } : { readOnlyEnforced: true, shell: true });
  expect(codexSandboxCheck(working, home, 'linux')).toEqual({ available: true });
  expect(codex({ homes, executable: working }).capabilities).toMatchObject({ readOnlyEnforced: true, shell: true });
  // The account check carries the reason, so Settings → Runtimes shows it on the Codex account.
  if (process.platform === 'linux') expect((await codex({ homes, executable: broken }).probe(setup('codex').input.account)).error).toContain("Codex's sandbox can't start on this device");
  expect(codexSandboxCheck(broken, home, 'darwin')).toEqual({ available: true });
  expect(codexSandboxCheck(join(root, 'missing-codex'), home, 'linux')).toEqual({ available: true });
});
test('Codex separates consecutive agent messages in the streamed text', async () => {
  const { input, adapter } = setup('codex'); input.brief = 'TWO_AGENT_MESSAGES';
  const run = adapter.startStretch(input); runs.push(run);
  const events = []; for await (const event of run.events) events.push(event);
  expect((await run.done).status).toBe('completed');
  const text = events.flatMap((event) => event.type === 'text' ? [event.delta] : []).join('');
  expect(text).toBe('Checked the README.\n\nWhat would you like changed?\n\nfixture-answer');
  await run.terminate();
});

// Added for the shared transcript iteration; execution deferred by the user.
test.each(['claude', 'codex'] as const)('%s records only the SDK’s readable thinking text', async (runtime) => {
  const { input, adapter } = setup(runtime); input.brief = 'READABLE_THINKING';
  const run = adapter.startStretch(input); runs.push(run);
  const events = []; for await (const event of run.events) events.push(event);
  expect(events.flatMap(event => event.type === 'thinking' ? [event.delta] : []).join('').trim()).toBe('Readable summary');
  expect(JSON.stringify(events)).not.toContain('opaque-fixture');
  expect((await run.done).status).toBe('completed');
});
