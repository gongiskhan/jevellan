import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSchema, AccountStatusSchema, BackgroundDraftRequestSchema, BridgeToolsSchema, Homes, SecretRedactor, seedConfiguration, type AccountStatus, type BackgroundDraftRequest } from '../packages/core/dist/index.js';
import { applyAccountError } from '../packages/accounts/dist/index.js';
import { BackgroundDrafts, ConversationLedger, ConversationWork, StretchBridges } from '../packages/conversations/dist/index.js';
import { FakeRuntime, groupAlive, type StretchInput } from '../packages/runtime-contract/dist/index.js';

let root: string; let homes: Homes; let drafts: BackgroundDrafts; let bridges: StretchBridges; let runtime: FakeRuntime; let settings: ReturnType<typeof seedConfiguration>['x-jevellan'];
let active: number; let accountRuns: Set<string>; let current: AccountStatus | undefined; let recorded: Array<{ kind: string; limit: { model?: string; resetsAt?: string } }>;
const request: BackgroundDraftRequest = { schema: 'background-draft-request-v1', id: 'draft_one', title: 'Routing suggestion', projectId: null,
  brief: 'Draft one precise routing edit and return the complete JSON through the handoff.', resultType: 'suggestion', files: { 'input.json': '{"routingProfile":"Existing guidance"}' } };
function create() {
  const account = AccountSchema.parse({ schema: 'account-v1', id: 'account', runtime: 'fake', label: 'Fixture', enabled: true, kind: 'subscription', credential: 'per-device' });
  const status = () => current ??= AccountStatusSchema.parse({ schema: 'account-status-v1', accountId: 'account', deviceId: 'hub', auth: 'ready', observedAt: new Date().toISOString() });
  return new BackgroundDrafts({ homes, deviceId: 'hub', bridges, redactor: new SecretRedactor(), runtimes: new Map([['fake', runtime]]), settings: () => settings,
    riggingItems: () => [], accountRuns, enterOperation: () => { active++; return () => { active--; }; },
    accounts: { async list() { return [{ schema: 'account-view-v1' as const, revision: 1, account, statuses: [status()] }]; },
      async resolve() { return { account, home: homes.account('fake', 'account'), env: {} }; }, async markUsed() {}, async recordUsage(_id, usage) { return AccountStatusSchema.parse({ ...status(), usage }); },
      async recordError(_id, kind, _credential, limit = {}) { recorded.push({ kind, limit }); current = applyAccountError(status(), kind, Date.now(), limit); return current; } } });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-background-drafts-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'home'), join(root, 'user'));
  bridges = new StretchBridges(new SecretRedactor()); runtime = new FakeRuntime(); runtime.capabilities.readOnlyEnforced = true; active = 0; accountRuns = new Set(); current = undefined; recorded = [];
  settings = seedConfiguration()['x-jevellan']; settings.runtimes.fake = { enabled: true }; settings.menu = [
    { id: 'disabled', runtime: 'fake', model: 'disabled', enabled: false, label: 'Disabled', description: 'Not available.', efforts: ['high'] },
    { id: 'first', runtime: 'fake', model: 'first-model', enabled: true, label: 'First eligible', description: 'A general model.', efforts: ['low', 'medium'] },
    { id: 'second', runtime: 'fake', model: 'second-model', enabled: true, label: 'Second', description: 'A general model.', efforts: ['high'] },
  ]; drafts = create(); drafts.daemonUrl = 'http://127.0.0.1:9999';
});
afterEach(async () => { await drafts.close(); await runtime.close(); await bridges.close(); rmSync(root, { recursive: true, force: true }); });
async function handoff(input: StretchInput, type = 'suggestion') {
  await bridges.request(input.launch.env.JEVELLAN_STRETCH_TOKEN, { schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
    schema: 'handoff-v2', stretch: 1, action: 'reply', status: 'done', summary: 'Draft ready for review.', result: { type, content: { schema: 'fixture-draft-v1', after: 'Revised guidance.' } },
    evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [],
  } });
}

test('the first eligible menu model drafts through a read-only scoped bridge, with no live-project memory tools', async () => {
  let token: string | undefined;
  runtime.enqueue(async ({ input, emit }) => {
    token = input.launch.env.JEVELLAN_STRETCH_TOKEN;
    expect(input.model).toBe('first-model'); expect(input.effort).toBe('medium'); expect(input.permissions).toBe('read-only'); expect(input.memoryWrite).toBe(false); expect(input.inputCopy).toBe(true);
    expect(input.cwd).toBe(homes.at('tmp', 'draft_draft_one')); expect(readFileSync(join(input.cwd, 'input.json'), 'utf8')).toBe(request.files['input.json']);
    const tools = BridgeToolsSchema.parse(await bridges.request(token, { schema: 'bridge-request-v1', operation: 'list' }));
    expect(tools.tools.some(tool => tool.name.startsWith('memory_'))).toBe(false);
    await expect(bridges.request(token, { schema: 'bridge-request-v1', operation: 'call', name: 'memory_propose', arguments: { title: 'No', content: 'No', reason: 'No' } })).rejects.toThrow('cannot use');
    emit({ type: 'usage', inputTokens: 10, outputTokens: 5 }); await handoff(input); return { status: 'completed' };
  });
  const result = await drafts.run(request, new AbortController().signal);
  expect(result).toMatchObject({ runId: request.id, modelId: 'first', effort: 'medium', content: { schema: 'fixture-draft-v1' }, usage: { inputTokens: 10, outputTokens: 5 } });
  expect(runtime.runs.every(run => !groupAlive(run.native.pgid))).toBe(true); expect(active).toBe(0);
  await expect(bridges.request(token, { schema: 'bridge-request-v1', operation: 'list' })).rejects.toThrow('expired');
  expect(JSON.stringify(result)).not.toContain(runtime.runs[0]!.native.sessionId);
});

test('a model-scoped limit is recorded against the account and the next draft uses the next eligible model', async () => {
  const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const limit = { kind: 'rate-limit' as const, scope: 'model' as const, resetsAt, message: "You've reached your First limit. Switch to another model to continue." };
  runtime.enqueue(async ({ input }) => { expect(input.model).toBe('first-model'); return { status: 'failed', error: limit }; });
  runtime.enqueue(async () => ({ status: 'failed', error: limit }));
  await expect(drafts.run(request, new AbortController().signal)).rejects.toThrow('did not finish successfully');
  expect(recorded).toEqual([{ kind: 'rate-limit', limit: { model: 'first-model', resetsAt } }]);
  expect(current).toMatchObject({ modelCooling: { 'first-model': resetsAt } }); expect(current?.coolingUntil).toBeUndefined();
  runtime.enqueue(async ({ input }) => { expect(input.model).toBe('second-model'); await handoff(input); return { status: 'completed' }; });
  expect(await drafts.run({ ...request, id: 'draft_two' }, new AbortController().signal)).toMatchObject({ modelId: 'second' });
});

test('completed draft retries survive restart without a second runtime launch; changed contents are refused', async () => {
  runtime.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; });
  const result = await drafts.run(request, new AbortController().signal); await drafts.close(); drafts = create();
  expect(await drafts.run(request, new AbortController().signal)).toEqual(result); expect(runtime.starts).toHaveLength(1);
  await expect(drafts.run({ ...request, brief: 'Different request.' }, new AbortController().signal)).rejects.toThrow('another request');
  expect(runtime.starts).toHaveLength(1);
});

test('read-only input changes fail the draft and remain failed on retry without launching again', async () => {
  runtime.enqueue(async ({ input }) => { writeFileSync(join(input.cwd, 'input.json'), 'Changed'); await handoff(input); return { status: 'completed' }; });
  await expect(drafts.run(request, new AbortController().signal)).rejects.toThrow('changed its input copies');
  const work = new ConversationWork(new ConversationLedger(drafts.homes, request.id)); expect(work.load().stretches[0]?.status).toBe('failed');
  await expect(drafts.run(request, new AbortController().signal)).rejects.toThrow('interrupted or failed'); expect(runtime.starts).toHaveLength(1);
});

test('a handoff of the wrong result type cannot become a suggestion', async () => {
  runtime.enqueue(async ({ input }) => { await handoff(input, 'answer'); return { status: 'completed' }; });
  await expect(drafts.run(request, new AbortController().signal)).rejects.toThrow('required handoff result');
  expect(new ConversationWork(new ConversationLedger(drafts.homes, request.id)).load().conversation.state).not.toBe('done');
});

test('an active request is deduplicated and cancellation terminates its recorded process before releasing activity', async () => {
  let arrived!: () => void; const started = new Promise<void>(resolve => { arrived = resolve; });
  runtime.enqueue(async ({ signal }) => { arrived(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { status: 'interrupted' }; });
  const controller = new AbortController(); const first = drafts.run(request, controller.signal); const failed = expect(first).rejects.toThrow('cancelled'); await started;
  const second = drafts.run(request, new AbortController().signal); const alsoFailed = expect(second).rejects.toThrow('cancelled');
  expect(active).toBe(1); controller.abort(); await failed; await alsoFailed;
  expect(runtime.starts).toHaveLength(1); expect(runtime.runs.every(run => !groupAlive(run.native.pgid))).toBe(true); expect(active).toBe(0);
}, 60_000);

test('shared account reservations prevent concurrent launches on a runtime without per-launch configuration', async () => {
  runtime.capabilities.perLaunchConfig = false; accountRuns.add('account');
  await expect(drafts.run(request, new AbortController().signal)).rejects.toThrow('already running'); expect(runtime.starts).toHaveLength(0);
  accountRuns.delete('account'); runtime.enqueue(async ({ input }) => { expect(accountRuns.has('account')).toBe(true); await handoff(input); return { status: 'completed' }; });
  await drafts.run(request, new AbortController().signal); expect(accountRuns.size).toBe(0);
});

test('an unsupported read-only runtime and unsafe file paths never launch', async () => {
  runtime.capabilities.readOnlyEnforced = false;
  await expect(drafts.run(request, new AbortController().signal)).rejects.toThrow('No eligible model'); expect(runtime.starts).toHaveLength(0);
  expect(BackgroundDraftRequestSchema.safeParse({ ...request, files: { '../outside.md': 'No' } }).success).toBe(false);
  expect(BackgroundDraftRequestSchema.safeParse({ ...request, files: { '.git/hooks/pre-commit': 'No' } }).success).toBe(false);
});

test('closing an active draft cancels and waits for its process instead of releasing early', async () => {
  let arrived!: () => void; const started = new Promise<void>(resolve => { arrived = resolve; });
  runtime.enqueue(async ({ signal }) => { arrived(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { status: 'interrupted' }; });
  const pending = expect(drafts.run(request, new AbortController().signal)).rejects.toThrow('cancelled'); await started;
  await drafts.close(); await pending; expect(runtime.runs.every(run => !groupAlive(run.native.pgid))).toBe(true); expect(active).toBe(0);
}, 60_000);
