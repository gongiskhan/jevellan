import { afterEach, expect, test, vi } from 'vitest';
import { AccountSchema, HubUnavailable, ThreadCreatedViewSchema, ThreadViewSchema } from '../packages/core/dist/index.js';
import { FakeRuntime, RunResultSchema, forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
async function start(f: ProjectFixture, fixedAccount = false) {
  const result = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'account_recovery_start', title: 'A small change', task: 'Make a small change.', modelId: 'fixture', isolation: 'worktree',
    ...(fixedAccount ? { accountId: 'acc_fixture' } : {}),
  });
  await f.app.projectWork.idle(); return result.threadId;
}
async function usage(f: ProjectFixture, accountId: string, pct: number, reset: string) {
  await f.app.accounts.recordUsage(accountId, { fiveHourPct: pct, fiveHourResetsAt: reset, source: 'probe', observedAt: new Date().toISOString() });
}
async function backup(f: ProjectFixture) {
  f.app.hub.put('accounts', 'acc_backup', AccountSchema, { schema: 'account-v1', id: 'acc_backup', runtime: 'fake', label: 'Backup', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0);
  await f.app.accounts.check('acc_backup');
}
const limitStep = () => RunResultSchema.parse({ status: 'failed', error: { kind: 'rate-limit', message: 'The account reached its usage limit.', scope: 'account', resetsAt: new Date(Date.now() + 3_600_000).toISOString() } });

test('a hub outage before account admission preserves a pending verification for the waiting sweep', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Ready.' }), forThread()); const id = await start(f);
  const unavailable = vi.spyOn(f.app.accounts, 'list').mockRejectedValue(new HubUnavailable('accounts'));
  await f.app.projectWork.threads.runner(id)!.requestTurn('verification', 'Run the narrow regression.'); await f.app.projectWork.idle();
  expect(f.thread(id).state).toBe('idle'); expect(f.thread(id).turns).toBe(1);
  expect(f.thread(id).stateReason).toContain('hub'); expect(f.local(id).pendingTurn?.body).toBe('Run the narrow regression.');
  unavailable.mockRestore(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Continued.' }), forThread());
  await f.app.projectWork.threads.sweepWaiting(); await f.app.projectWork.idle(); expect(f.fake.turnStarts).toHaveLength(2);
});

test('a blocked owner command waits for the owner without escalating the model', { timeout: 120_000 }, async () => {
  const f = await twoProviders(); f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'The owner must run the reserved command.', ownerCommands: [{ command: './scripts/owner-only.sh', why: 'The project reserves this action for the owner.', cwd: 'worktree' }] }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'owner_command_wait', title: 'Seed data', task: 'Prepare seed data.', isolation: 'worktree' });
  await f.app.projectWork.idle(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Continued after the owner action.' }), forThread());
  await f.app.projectWork.threads.message('project', made.threadId, 'coordinator', 'The owner ran the command successfully.', false); await f.app.projectWork.idle();
  expect(f.local(made.threadId).escalations ?? []).toHaveLength(0); expect(f.fake.turnStarts[1]?.resume).toBeDefined();
});

test('a limited account keeps a verification pending and the sweep resumes it after eligibility returns', { timeout: 120_000 }, async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } });
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Ready for another step.' }), forThread());
  const id = await start(f), reset = new Date(now + 60_000).toISOString();
  await usage(f, 'acc_fixture', 95, reset); await f.app.accounts.recordError('acc_fixture', 'rate-limit', undefined, { model: 'scripted-model', resetsAt: reset });
  await f.app.projectWork.threads.runner(id)!.requestTurn('verification', 'Repair the narrow regression.'); await f.app.projectWork.idle();
  expect(f.thread(id).state).toBe('idle'); expect(f.thread(id).turns).toBe(1); expect(f.thread(id).lastReport?.status).toBe('progress');
  expect(f.local(id).waitingForAccount).toMatchObject({ runtime: 'fake', modelId: 'fixture', earliestEligibleAt: reset, moved: false });
  expect(f.local(id).pendingTurn).toMatchObject({ reason: 'verification', body: 'Repair the narrow regression.' });
  await f.app.projectWork.threads.sweepWaiting(); await f.app.projectWork.idle(); expect(f.fake.turnStarts).toHaveLength(1);
  now += 61_000; await usage(f, 'acc_fixture', 5, new Date(now + 3_600_000).toISOString());
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Repaired the regression.' }), forThread());
  await f.app.projectWork.threads.sweepWaiting(); await f.app.projectWork.idle();
  expect(f.thread(id).turns).toBe(2); expect(f.fake.turnStarts[1]!.prompt).toContain('Repair the narrow regression.');
  expect(f.local(id).waitingForAccount).toBeUndefined(); expect(f.local(id).pendingTurn).toBeUndefined();
});

test('an owner follow-up survives account unavailability and is delivered once when an account returns', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Ready.' }), forThread()); const id = await start(f);
  const reset = new Date(Date.now() + 300_000).toISOString(); await usage(f, 'acc_fixture', 95, reset);
  const response = await f.request(`/api/projects/project/threads/${id}/messages`, 'POST', { schema: 'thread-message-request-v1', clientMessageId: 'followup_wait', text: 'Keep the README short.', interrupt: false }); expect(response.ok).toBe(true);
  await f.waitFor(() => ({ reason: f.thread(id).stateReason, state: f.thread(id).state, turns: f.thread(id).turns }), thread => thread.reason !== undefined || thread.state === 'failed' || thread.turns > 1);
  await f.app.projectWork.idle(); expect(f.thread(id).state).toBe('idle'); expect(f.thread(id).turns).toBe(1);
  expect(f.thread(id).queuedMessages.map(message => message.text)).toEqual(['Keep the README short.']);
  await usage(f, 'acc_fixture', 5, reset); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Kept it short.' }), forThread());
  await f.app.projectWork.threads.sweepWaiting(); await f.app.projectWork.idle();
  expect(f.fake.turnStarts).toHaveLength(2); expect(f.fake.turnStarts[1]!.prompt).toContain('Keep the README short.'); expect(f.thread(id).queuedMessages).toHaveLength(0);
});

async function twoProviders() {
  const second = new FakeRuntime(); Object.defineProperty(second, 'id', { value: 'fake2' });
  const f = fixture = await projectFixture({ runtimes: { fake: new FakeRuntime(), fake2: second }, menu: [
    { id: 'fixture', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'A small task.', efforts: ['low', 'high'], enabled: true },
    { id: 'second', runtime: 'fake2', model: 'second-model', label: 'Second', description: 'An alternative.', efforts: ['high', 'max'], enabled: true },
  ] });
  f.app.hub.put('accounts', 'acc_second', AccountSchema, { schema: 'account-v1', id: 'acc_second', runtime: 'fake2', label: 'Second account', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0);
  await f.app.accounts.check('acc_second'); return f;
}
test('an unknown long account wait moves an automatic model once to another eligible provider', { timeout: 120_000 }, async () => {
  const f = await twoProviders(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Keep working.' }), forThread());
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'automatic_wait', title: 'A small task', task: 'Keep working.', isolation: 'worktree' });
  await f.app.projectWork.idle(); const id = created.threadId; expect(f.thread(id).placement.runtime).toBe('fake');
  await f.app.accounts.recordUsage('acc_fixture', { weeklyPct: 95, source: 'probe', observedAt: new Date().toISOString() });
  f.runtimes.fake2!.enqueueTurn(reportStep({ status: 'progress', summary: 'Continued elsewhere.' }), forThread());
  await f.app.projectWork.threads.runner(id)!.requestTurn('continue', 'Continue the small task.'); await f.app.projectWork.idle();
  expect(f.thread(id).placement).toMatchObject({ runtime: 'fake2', modelId: 'second', reason: 'model-unavailable' });
  expect(f.runtimes.fake2!.turnStarts[0]?.resume).toBeUndefined(); expect(f.local(id).waitingForAccount).toBeUndefined();
  expect(f.coordinatorState().queue).toContainEqual(expect.objectContaining({ kind: 'thread-placement-changed', reason: 'model-unavailable' }));
});
test('a fixed model keeps its pending turn rather than moving during a long wait', { timeout: 120_000 }, async () => {
  const f = await twoProviders(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Ready.' }), forThread()); const id = await start(f);
  await f.app.accounts.recordUsage('acc_fixture', { weeklyPct: 95, source: 'probe', observedAt: new Date().toISOString() });
  await f.app.projectWork.threads.runner(id)!.requestTurn('continue', 'Continue.'); await f.app.projectWork.idle();
  expect(f.thread(id).placement.modelId).toBe('fixture'); expect(f.thread(id).turns).toBe(1); expect(f.local(id).waitingForAccount?.moved).toBe(false); expect(f.runtimes.fake2!.turnStarts).toHaveLength(0);
});
test('a real blocked report re-asks placement once with trouble and never lowers effort', { timeout: 120_000 }, async () => {
  const f = await twoProviders(); f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'The narrow parsing test fails.' }), forThread());
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'escalate_blocked', title: 'A parsing fix', task: 'Fix the parser.', isolation: 'worktree' });
  await f.app.projectWork.idle(); const id = created.threadId, first = f.thread(id).placement;
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'The same model continued.' }), forThread());
  await f.app.projectWork.threads.message('project', id, 'coordinator', 'Try the narrow test again.', false); await f.app.projectWork.idle();
  expect(f.thread(id).placement.reason).toBe('escalation'); expect(f.thread(id).placement.effortEffective).toBe(first.effortEffective);
  expect(f.local(id).escalations).toHaveLength(1); expect(f.fake.turnStarts[1]?.resume).toBeDefined();
});

test('owner follow-up classification cannot overwrite the blocked-report escalation', { timeout: 120_000 }, async () => {
  const f = await twoProviders(); f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'The narrow parser test still fails.' }), forThread());
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'escalate_owner_followup', title: 'A parsing fix', task: 'Fix the parser.', isolation: 'worktree' });
  await f.app.projectWork.idle(); const id = created.threadId;
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Continued with the failure context.' }), forThread());
  await f.app.projectWork.threads.message('project', id, 'owner', 'Continue fixing the narrow test.', false); await f.app.projectWork.idle();
  expect(f.thread(id).placement.reason).toBe('escalation'); expect(f.local(id).escalations).toHaveLength(1);
});

test('blocked work can escalate to another allowed provider with its own report in fresh context', { timeout: 120_000 }, async () => {
  const f = await twoProviders(); f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'The parser needs the multi-byte input regression fixed.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'escalate_provider', title: 'A parsing fix', task: 'Fix the parser.', isolation: 'worktree' });
  await f.app.projectWork.idle(); const id = made.threadId, settings = await f.app.projectWork.admission.settings('project');
  await f.app.projectHub.putSettings({ ...settings, placement: { ...settings.placement, allowedModelIds: ['second'] } }, settings.revision);
  f.runtimes.fake2!.enqueueTurn(reportStep({ status: 'progress', summary: 'Continued with the earlier report.' }), forThread());
  await f.app.projectWork.threads.message('project', id, 'coordinator', 'Continue the parser fix.', false); await f.app.projectWork.idle();
  expect(f.thread(id).placement).toMatchObject({ reason: 'escalation', runtime: 'fake2', modelId: 'second', effortEffective: 'high' });
  expect(f.runtimes.fake2!.turnStarts[0]?.resume).toBeUndefined(); expect(f.runtimes.fake2!.turnStarts[0]?.prompt).toContain('The parser needs the multi-byte input regression fixed.');
  expect(f.coordinatorState().queue).toContainEqual(expect.objectContaining({ kind: 'thread-placement-changed', reason: 'escalation' }));
});

test('a mid-turn usage limit continues on another account with fresh context and no blocked report', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(); await backup(f); const reset = new Date(Date.now() + 3_600_000).toISOString();
  await usage(f, 'acc_fixture', 5, reset); await usage(f, 'acc_backup', 20, reset);
  f.fake.enqueueTurn(async turn => { turn.say('I updated the parser; the narrow regression still needs running.'); return limitStep(); }, forThread()); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Continued on the available account.' }), forThread());
  const id = await start(f);
  expect((await f.app.accounts.status('acc_fixture')).coolingUntil).toBeDefined();
  expect(f.fake.turnStarts).toHaveLength(2); expect(f.fake.turnStarts.map(turn => turn.account.account.id)).toEqual(['acc_fixture', 'acc_backup']);
  expect(f.fake.turnStarts[1]!.resume).toBeUndefined(); expect(f.fake.turnStarts[1]!.prompt).toContain('Your previous turn stopped at a usage limit. Continue the task from where it stopped.');
  expect(f.fake.turnStarts[1]!.prompt).toContain('I updated the parser; the narrow regression still needs running.');
  expect(f.thread(id).turns).toBe(2); expect(f.thread(id).lastReport?.status).toBe('progress');
  const view = await f.json(`/api/projects/project/threads/${id}`, ThreadViewSchema);
  expect(view.notices).toContainEqual(expect.objectContaining({ text: 'The turn stopped at a usage limit on Fixture. Continuing on Backup.' }));
  expect(f.thread(id).placement.reason).toBe('account-limit');
  expect(f.coordinatorState().queue).toContainEqual(expect.objectContaining({ kind: 'thread-placement-changed', reason: 'account-limit', threadId: id }));
  const reports = f.app.projectWork.ledgers.thread(f.project.id, id).events().filter(event => event.type === 'thread-report'); expect(reports).toHaveLength(1);
  expect(f.coordinatorState().queue.some(event => event.kind === 'thread-report' && event.report.status === 'blocked')).toBe(false);
});
