// Phase 5, threads on other devices (design 3.5.1, 3.5.2, 2.10; D9, D9a, D40, D41, D42, D88, D264-D268): a hub fixture and a simulated
// member over real HTTP. Remote starts, thread events and commands travel through the hub relay; thread and coordinator requests
// from the browser are proxied to the device that runs them. Simulated: the member device (local HTTP), runtime turns and GitHub.
// Live: git, HTTP, the hub, the ledgers and the process groups.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  AccountSchema, BridgeToolSchemas, DeviceSchema, MergeResultViewSchema, ProjectEnvelopeSchema, ProjectWorkListViewSchema, ProjectWorkSettingsSchema, ProjectWorkViewSchema, ThreadCreatedViewSchema, ThreadMessageReceiptSchema,
  ThreadOverrideViewSchema, ThreadViewSchema, defaultProjectWorkSettings, type CoordinatorEvent, type ProjectWorkSettings,
} from '../packages/core/dist/index.js';
import { HubAccounts } from '../packages/mesh/dist/index.js';
import { forThread, type FakeTurnStep } from '../packages/runtime-contract/dist/index.js';
import {
  ALLOW_MORE_TURNS, COORDINATOR_NOT_HERE, PROJECT_OPERATION_NOT_FOUND, STOPPED_BY_YOU, THREAD_NOT_FOUND, coordinatorToolHandlers, restartedReason, threadDeviceOffline,
  transcriptStaysOn,
} from '../packages/projects/dist/index.js';
import { commitStep, expectNoLeaks, holdStep, projectFixture, projectMember, reportStep, type ProjectFixture, type ProjectMember } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
async function setup(): Promise<{ f: ProjectFixture; m: ProjectMember }> {
  const f = fixture = await projectFixture();
  const m = await projectMember(f);
  return { f, m };
}

const createBody = (title: string, extra: object = {}, clientRequestId = `req_${randomUUID()}`) => ({ schema: 'thread-create-request-v1', clientRequestId, title, task: `Do ${title}.`, ...extra });
const empty = { schema: 'empty-request-v1' };
const queue = (f: ProjectFixture): CoordinatorEvent[] => f.coordinatorState().queue;
const reports = (f: ProjectFixture) => queue(f).flatMap((event) => event.kind === 'thread-report' ? [`${event.threadId} ${event.report.summary}`] : []);
async function settings(f: ProjectFixture, over: Partial<ProjectWorkSettings>): Promise<void> {
  const current = await f.app.projectHub.settings('project');
  await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({ ...(current?.document ?? defaultProjectWorkSettings('project')), ...over }), current?.revision ?? 0);
}
/** A member turn that says `text` (the transcript shows it) and reports progress with the same summary. */
const sayStep = (text: string): FakeTurnStep => async (turn) => {
  turn.say(text); await turn.bridge('jevellan_thread_report', { status: 'progress', summary: text }); return { status: 'completed' };
};
/** The member reads its relayed envelopes, then the hub reads its own: one round of each side's periodic work. */
async function round(f: ProjectFixture, m: ProjectMember): Promise<void> {
  await m.app.projectWork.pulse(); await m.app.projectWork.idle(); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
}
async function turns(f: ProjectFixture, m: ProjectMember, threadId: string, count: number): Promise<void> {
  await f.waitFor(async () => { await m.app.projectWork.pulse(); return existsSync(m.app.projectWork.paths.threadFile('project', threadId)) ? m.thread(threadId).turns : -1; },
    (value) => value === count);
  await m.app.projectWork.idle('project');
}
/**
 * The member's private values never reach the hub's side: its native session ids, its turns' bridge tokens, its worktree paths and
 * its browser session are absent from every response the hub's browser read (proxied views included), the hub's views, indexes,
 * questions and coordinator files (D10, D17).
 */
async function expectNoMemberLeaks(f: ProjectFixture, m: ProjectMember): Promise<void> {
  const secrets: Array<[string, string]> = [['member worktree path', m.homes.at('worktrees')], ['member session', m.cookie.slice(m.cookie.indexOf('=') + 1)],
    ...m.fake.runs.map((run): [string, string] => ['member native session id', run.native.sessionId ?? '']),
    ...m.fake.turnStarts.map((input): [string, string] => ['member bridge token', input.launch.env.JEVELLAN_STRETCH_TOKEN ?? ''])];
  for (const [kind, value] of secrets) expect(value.length, kind).toBeGreaterThanOrEqual(16);
  const threads = (await f.app.projectHub.threads('project')).records;
  for (const thread of threads) await f.request(`/api/projects/project/threads/${thread.id}`);
  const texts: Array<[string, string]> = [...f.responses.map((text): [string, string] => ['hub response', text]), ['hub thread indexes', JSON.stringify(threads)],
    ['hub list', JSON.stringify(await f.json('/api/project-work', ProjectWorkListViewSchema))], ['hub page', JSON.stringify(await f.json('/api/projects/project/work', ProjectWorkViewSchema))],
    ['hub questions', JSON.stringify(await f.app.projectHub.decisions('project'))], ['hub coordinator ledger', f.ledgerText()], ['hub coordinator queue', JSON.stringify(f.coordinatorState())]];
  expect(texts.flatMap(([where, text]) => secrets.filter(([, value]) => text.includes(value)).map(([kind]) => `${kind} in ${where}`))).toEqual([]);
}
/** A bearer request straight to a peer route, as another device forwards it: the browser session and its device. */
function peer(base: string, path: string, init: { method?: string; token?: string; source?: string; origin?: string; body?: unknown } = {}) {
  return fetch(`${base}/api/mesh/projects/${path}`, { method: init.method ?? 'GET', headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    ...(init.source ? { 'X-Jevellan-Source-Device': init.source } : {}), ...(init.origin ? { Origin: init.origin } : {}), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
}

test('a thread placed on a member starts there with its account, counts until the member publishes it, reports through the relay, and its page and actions are proxied from the hub', { timeout: 180_000 }, async () => {
  const { f, m } = await setup();
  const hubId = f.app.device.deviceId; const route = (threadId: string, suffix = '') => `/api/projects/project/threads/${threadId}${suffix}`;

  // 1. The owner starts a thread on the member from the hub (D9a): placement runs on the hub, the start travels as an envelope.
  m.fake.enqueueTurn(sayStep('Member step one.'), forThread());
  const request = createBody('Add search', { deviceId: m.deviceId });
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', request);
  expect(created).toMatchObject({ state: 'preparing', placement: `Scripted test runtime Fixture · high · Worktree · ${m.name} · placed without Jev: no key configured` });
  const threadId = created.threadId;
  expect(existsSync(f.app.projectWork.paths.threadFile('project', threadId))).toBe(false);
  // Before the member runs it, the placed account needs a login there; the member ranks its accounts again (D16).
  f.app.hub.put('accounts', 'acc_member2', AccountSchema, { schema: 'account-v1', id: 'acc_member2', runtime: 'fake', label: 'Second member account', kind: 'subscription', enabled: true,
    ceilingPct: 90, credential: 'per-device' }, 0);
  await m.app.accounts.check('acc_member2');
  new HubAccounts(f.app.hub, m.deviceId).writeStatus({ schema: 'account-status-v2', accountId: 'acc_member', deviceId: m.deviceId, auth: 'needs-login', observedAt: new Date().toISOString() }, null);
  expect(f.app.projectWork.outbox.pending()).toEqual([]);
  // The slot is taken until the member publishes the thread (3.5.1 step 1), and a retried start answers the same thread.
  expect(Object.fromEntries((await f.app.projectWork.admission.counts('project')).devices)).toEqual({ [m.deviceId]: 1 });
  expect(await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', request)).toEqual(created);
  // The coordinator heard of the owner's thread on its own device.
  expect(queue(f).map((event) => event.kind)).toEqual(['thread-user-message']);

  // 2. The member creates it from its inbox, prepares a worktree in its own home and runs the turn with an account eligible there.
  await turns(f, m, threadId, 1);
  const thread = m.thread(threadId);
  expect(thread).toMatchObject({ ownerDeviceId: m.deviceId, coordinatorDeviceId: hubId, state: 'idle', placement: { deviceId: m.deviceId, accountId: 'acc_member2' } });
  expect(thread.cwd.startsWith(m.homes.at('worktrees'))).toBe(true);
  expect(m.fake.turnStarts[0]).toMatchObject({ account: { account: { id: 'acc_member2' } } }); expect(f.fake.turnStarts).toEqual([]);
  // Its report reached the hub coordinator through the relay; the published index released the slot.
  await f.waitFor(() => reports(f), (seen) => seen.includes(`${threadId} Member step one.`));
  await m.app.projectWork.pulse();
  expect((await f.app.projectWork.admission.counts('project')).project).toBe(0);
  expect(await f.index(threadId)).toMatchObject({ ownerDeviceId: m.deviceId, state: 'idle', accountLabel: 'Second member account' });

  // 3. The hub's browser opens the thread: the view comes from the member, with the transcript read there (D266).
  const view = await f.json(route(threadId), ThreadViewSchema);
  expect(view).toMatchObject({ deviceName: m.name, thread: { id: threadId, ownerDeviceId: m.deviceId }, placement: { accountId: 'acc_member2' }, canMessage: true });
  expect(JSON.stringify(view.transcript?.turns)).toContain('Member step one.'); expect(view.transcript?.session.cwd).toBeNull();
  expect(JSON.stringify(view)).not.toContain(m.homes.at('worktrees'));

  // 4. Messages, next-turn overrides, allow-turns and refresh are proxied to the member and act there.
  m.fake.enqueueTurn(sayStep('Member step two.'), forThread());
  const message = { schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text: 'Also handle empty queries.', interrupt: false };
  expect(ThreadMessageReceiptSchema.parse(await (await f.request(route(threadId, '/messages'), 'POST', message)).json())).toEqual({ schema: 'thread-message-receipt-v1', repeated: false });
  expect(ThreadMessageReceiptSchema.parse(await (await f.request(route(threadId, '/messages'), 'POST', message)).json()).repeated).toBe(true);
  await turns(f, m, threadId, 2);
  expect(m.fake.turnStarts[1]).toMatchObject({ prompt: expect.stringContaining('Also handle empty queries.') });
  await f.waitFor(() => queue(f).map((event) => event.kind === 'thread-user-message' ? event.text : ''), (texts) => texts.includes('Also handle empty queries.'));
  const override = await f.request(route(threadId, '/override'), 'POST', { schema: 'thread-override-request-v1', clientRequestId: `ovr_${randomUUID()}`, mode: 'next-turn', effort: 'low' });
  expect(override.status).toBe(200); expect(ThreadOverrideViewSchema.parse(await override.json())).toEqual({ schema: 'thread-override-view-v1' });
  expect(m.thread(threadId).placement).toMatchObject({ effortRequested: 'low', effortEffective: 'high' });
  expect((await f.app.projectHub.recentOverrides('project', 8))[0]).toMatchObject({ threadId, mode: 'next-turn', changes: [{ field: 'effort', from: 'medium', to: 'low' }] });
  expect(ThreadViewSchema.parse(await (await f.request(route(threadId, '/allow-turns'), 'POST', empty)).json()).turnAllowance).toBe(thread.turnAllowance);
  const refresh = await f.request(route(threadId, '/pr/refresh'), 'POST', empty); expect(refresh.status).toBe(202);

  // 5. A member that stopped reporting is offline: requests for its threads are refused at once, with the thread's wording.
  const memberRow = f.app.hub.get('devices', m.deviceId, DeviceSchema)!;
  f.app.hub.put('devices', m.deviceId, DeviceSchema, { ...memberRow.document, lastHeartbeatAt: new Date(Date.now() - 3_600_000).toISOString() }, memberRow.revision);
  const offline = await f.request(route(threadId));
  expect(offline.status).toBe(409); expect(await offline.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: threadDeviceOffline(m.name) });
  await m.heartbeat();

  // 6. Stop and Discard: the member stops the thread, tells the coordinator and removes the worktree.
  const stopped = ThreadViewSchema.parse(await (await f.request(route(threadId, '/stop'), 'POST', { schema: 'thread-stop-request-v1' })).json());
  expect(stopped).toMatchObject({ thread: { state: 'stopped', stateReason: STOPPED_BY_YOU }, canDiscard: true });
  expect(m.thread(threadId).state).toBe('stopped');
  await f.waitFor(() => queue(f).map((event) => event.kind), (seen) => seen.includes('thread-interrupted'));
  const discarded = ThreadViewSchema.parse(await (await f.request(route(threadId, '/discard'), 'POST', empty)).json());
  expect(discarded.canDiscard).toBe(false); expect(existsSync(thread.cwd)).toBe(false);

  // 7. The peer receiver (D41): browsers and missing sessions are refused; the brief's background routes are absent on every
  // device (D40); a device answers only for what it runs, never proxying again.
  const token = f.cookie.slice(f.cookie.indexOf('=') + 1);
  const direct = await peer(m.base, `project/threads/${threadId}`, { token, source: hubId });
  expect(direct.status).toBe(200); expect(ThreadViewSchema.parse(await direct.json()).thread.id).toBe(threadId);
  expect((await peer(m.base, `project/threads/${threadId}`, { token, source: hubId, origin: f.base })).status).toBe(403);
  const anonymous = await peer(m.base, `project/threads/${threadId}`, { source: hubId });
  expect(anonymous.status).toBe(401); expect(await anonymous.json()).toMatchObject({ message: 'Sign in to Jevellan.' });
  expect((await peer(m.base, `project/threads/${threadId}`, { token: m.cookie.slice(m.cookie.indexOf('=') + 1), source: hubId })).status).toBe(401);
  for (const base of [f.base, m.base]) {
    for (const path of ['project/threads', 'project/coordinator/events']) {
      const absent = await peer(base, path, { method: 'POST', token, source: hubId, body: createBody('Background') });
      expect(absent.status, `${base} ${path}`).toBe(404); expect(await absent.json()).toMatchObject({ message: PROJECT_OPERATION_NOT_FOUND });
    }
    expect((await peer(base, 'project/work', { token, source: hubId })).status).toBe(404);
  }
  const elsewhere = await peer(f.base, `project/threads/${threadId}`, { token, source: hubId });
  expect(elsewhere.status).toBe(404); expect(await elsewhere.json()).toMatchObject({ message: THREAD_NOT_FOUND });
  const notCoordinator = await peer(m.base, 'project/coordinator/stop', { method: 'POST', token, source: hubId, body: empty });
  expect(notCoordinator.status).toBe(404); expect(await notCoordinator.json()).toMatchObject({ message: COORDINATOR_NOT_HERE });
  await expectNoMemberLeaks(f, m);
});

test('from the member, coordinator requests and its chat reach the hub coordinator, New thread places there, lists cost one hub read, and a restart of a member thread starts through the hub', { timeout: 180_000 }, async () => {
  const { f, m } = await setup();
  const hubId = f.app.device.deviceId; const pid = 'project';
  expect(await f.app.projectWork.coordinators.ensureAssigned(pid)).toBe(hubId);

  // 1. An owner message on the member's page goes to the coordinator on the hub, idempotent by its client id (3.5.2).
  const hello = { schema: 'coordinator-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text: 'Hello from the member.' };
  const sent = await m.request(`/api/projects/${pid}/coordinator/messages`, 'POST', hello);
  expect(sent.status).toBe(202); expect(await sent.json()).toEqual({ schema: 'coordinator-message-receipt-v1', repeated: false });
  expect(await (await m.request(`/api/projects/${pid}/coordinator/messages`, 'POST', hello)).json()).toEqual({ schema: 'coordinator-message-receipt-v1', repeated: true });
  expect(queue(f).flatMap((event) => event.kind === 'user-message' ? [event.text] : [])).toEqual(['Hello from the member.']);
  expect(existsSync(m.app.projectWork.paths.coordinator(pid))).toBe(false);

  // 2. The chat streams from the hub through the member, resumable by cursor.
  const controller = new AbortController();
  const stream = await fetch(`${m.base}/api/projects/${pid}/coordinator/events`, { headers: { Cookie: m.cookie, Origin: m.base }, signal: controller.signal });
  expect(stream.status).toBe(200); expect(stream.headers.get('content-type')).toContain('text/event-stream');
  let text = ''; const reader = stream.body!.getReader(); const decoder = new TextDecoder();
  while (!text.includes('Hello from the member.')) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
  controller.abort(); await reader.cancel().catch(() => undefined);
  expect(text).toMatch(/^id: \d+\nevent: project\ndata: /m);
  const stopped = await m.request(`/api/projects/${pid}/coordinator/stop`, 'POST', empty);
  expect(stopped.status).toBe(202); expect(ProjectWorkViewSchema.parse(await stopped.json()).coordinator.deviceId).toBe(hubId);
  expect((await m.request(`/api/projects/${pid}/coordinator/fresh`, 'POST', empty)).status).toBe(202);

  // 3. Lists and project pages are read from the hub on any device; the member's list is one hub read whatever the projects (D267).
  m.hubCalls.length = 0;
  const list = await m.json('/api/project-work', ProjectWorkListViewSchema);
  expect(m.hubCalls.filter((call) => !call.endsWith('/auth/check'))).toEqual(['/hub/mesh/projects/work work-summaries']);
  expect(list).toEqual(await f.json('/api/project-work', ProjectWorkListViewSchema));
  expect(list.projects).toEqual([{ projectId: pid, name: 'Shop', waiting: 0, running: 0, inReview: 0, coordinator: { deviceId: hubId, state: f.coordinatorState().state } }]);
  const page = await m.json(`/api/projects/${pid}/work`, ProjectWorkViewSchema);
  const status = (await f.app.projectHub.coordinatorStatus(pid))!.document;
  expect(page.coordinator).toMatchObject({ deviceId: hubId, deviceName: f.deviceName, online: true, state: status.state });
  // The chat history bound is the coordinator's own ledger (D268), not the member's empty one.
  expect(status.lastEventId).toBeGreaterThan(0); expect(page.lastEventId).toBe(status.lastEventId);

  // 4. New thread on the member's page is placed by the hub (D9a) and lands on the member through the relay.
  m.fake.enqueueTurn(sayStep('Member turn.'), forThread());
  const created = await m.json(`/api/projects/${pid}/threads`, ThreadCreatedViewSchema, 'POST', createBody('Fix login', { deviceId: m.deviceId }));
  expect(created.placement).toContain(`· ${m.name}`);
  await turns(f, m, created.threadId, 1);
  expect(queue(f).some((event) => event.kind === 'thread-user-message' && event.threadId === created.threadId)).toBe(true);

  // 5. Restart from the hub's page: the member owns the thread and asks the hub, which places the new one, here on the hub (D266).
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Restarted here.' }), forThread());
  const restart = { schema: 'thread-override-request-v1', clientRequestId: `ovr_${randomUUID()}`, mode: 'restart', deviceId: hubId, note: 'Run it on the hub.' };
  const answered = await f.request(`/api/projects/${pid}/threads/${created.threadId}/override`, 'POST', restart);
  const body = await answered.json() as { newThreadId: string };
  expect(answered.status, JSON.stringify(body)).toBe(200);
  const newThreadId = body.newThreadId;
  expect(m.thread(created.threadId)).toMatchObject({ state: 'stopped', stateReason: restartedReason(newThreadId) });
  expect(existsSync(m.thread(created.threadId).cwd)).toBe(false);
  await f.waitFor(() => f.app.projectWork.store.get(newThreadId)?.turns ?? 0, (count) => count === 1); await f.app.projectWork.idle();
  expect(f.thread(newThreadId)).toMatchObject({ title: 'Fix login', ownerDeviceId: hubId, placement: { fixed: ['device'], deviceId: hubId } });
  expect((await f.app.projectHub.recentOverrides(pid, 8))[0]).toMatchObject({ threadId: created.threadId, mode: 'restart', note: 'Run it on the hub.',
    changes: [{ field: 'device', from: m.deviceId, to: hubId }] });
  await f.waitFor(() => queue(f).flatMap((event) => event.kind === 'placement-override' ? [event.summary] : []), (summaries) => summaries.some((summary) => summary.includes(restartedReason(newThreadId))));
  // A retried restart answers the same new thread and starts nothing else.
  expect(await (await f.request(`/api/projects/${pid}/threads/${created.threadId}/override`, 'POST', restart)).json()).toEqual({ schema: 'thread-override-view-v1', newThreadId });
  expect(f.app.projectWork.store.list(pid).map((thread) => thread.id)).toEqual([newThreadId]);
  await expectNoMemberLeaks(f, m);
});

test('the coordinator acts on member threads through commands, reads them with the transcript left there, follows their pull requests from GitHub, and starts queued member threads from its sweep', { timeout: 240_000 }, async () => {
  const { f, m } = await setup();
  const hubId = f.app.device.deviceId; const pid = 'project'; const work = f.app.projectWork;
  expect(await work.coordinators.ensureAssigned(pid)).toBe(hubId);
  const tools = coordinatorToolHandlers({ deviceId: hubId, deviceName: f.deviceName, threads: work.threads, store: work.store, decisions: work.decisions, pullRequests: work.tracker,
    hub: f.app.projectHub, ledgers: work.ledgers, roster: () => f.app.roster(), now: Date.now, memory: async () => { throw new Error('No memory in this test.'); } });
  const tool = <T extends keyof typeof BridgeToolSchemas>(name: T, input: unknown, turn = 1) => tools.call({ kind: 'coordinator', projectId: pid, turn }, name as never,
    BridgeToolSchemas[name].parse(input), new AbortController().signal) as Promise<Record<string, unknown>>;
  const startOnMember = (title: string) => f.json(`/api/projects/${pid}/threads`, ThreadCreatedViewSchema, 'POST', createBody(title, { deviceId: m.deviceId }));
  const envelopesFor = (deviceId: string) => f.app.hub.list('project-envelopes', ProjectEnvelopeSchema).map((row) => row.document).filter((envelope) => envelope.targetDeviceId === deviceId);

  // 1. A member thread reports done and opens its pull request there; the coordinator reads it on the hub (D42) and asks GitHub
  // directly from the pull request's address, changing nothing on either device (3.5.1 step 8).
  m.fake.enqueueTurn(commitStep({ 'search.txt': 'search\n' }, { status: 'done', summary: 'Added search.', changedFiles: ['search.txt'] }), forThread());
  const published = (await startOnMember('Add search')).threadId;
  await f.waitFor(async () => { await round(f, m); return (await f.index(published))?.state; }, (state) => state === 'in-review');
  const read = await tool('jevellan_thread_read', { threadId: published, detail: 'transcript' });
  expect(read).toMatchObject({ threadId: published, state: 'in-review', pr: { number: 1, state: 'open' }, transcript: null, transcriptNote: transcriptStaysOn(m.name) });
  expect(await tool('jevellan_pr_status', { threadId: published })).toMatchObject({ pr: { number: 1, state: 'open', checks: 'none' } });
  f.github.setChecks(1, 'passing');
  expect(await tool('jevellan_pr_status', { threadId: published })).toMatchObject({ pr: { number: 1, checks: 'passing' } });
  expect((await f.index(published))?.pr?.checks).toBe('none'); expect(existsSync(work.paths.thread(pid, published))).toBe(false);
  // Merge from the hub's page runs on the member (PR polling and merging stay with the owner).
  const merged = await f.request(`/api/projects/${pid}/threads/${published}/pr/merge`, 'POST', empty);
  expect(merged.status).toBe(200); expect(MergeResultViewSchema.parse(await merged.json())).toMatchObject({ merged: true });
  expect(m.thread(published)).toMatchObject({ state: 'done', pr: { state: 'merged' } });
  await f.waitFor(() => queue(f).flatMap((event) => event.kind === 'pr-update' ? [event.change] : []), (changes) => changes.includes('merged'));

  // 2. The coordinator's message and stop reach a member thread as commands, each applied once (D265).
  m.fake.enqueueTurn(sayStep('Ready.'), forThread());
  const steered = (await startOnMember('Tune cache')).threadId; await turns(f, m, steered, 1);
  m.fake.enqueueTurn(sayStep('Applied the hint.'), forThread());
  expect(await tool('jevellan_thread_message', { threadId: steered, message: 'Use the cache.' }, 2)).toEqual({ schema: 'thread-message-result-v1', threadId: steered, state: 'idle', delivery: 'queued' });
  await turns(f, m, steered, 2);
  expect(m.fake.turnStarts.at(-1)).toMatchObject({ prompt: expect.stringContaining('Use the cache.') });
  // An MCP retry of the same call repeats its command; the member runs nothing more.
  await tool('jevellan_thread_message', { threadId: steered, message: 'Use the cache.' }, 2); await round(f, m);
  expect(m.thread(steered).turns).toBe(2);
  // Only owner messages are echoed to the coordinator.
  expect(queue(f).some((event) => event.kind === 'thread-user-message' && event.threadId === steered && event.text === 'Use the cache.')).toBe(false);
  expect(await tool('jevellan_thread_stop', { threadId: steered, reason: 'Superseded.' }, 3)).toMatchObject({ threadId: steered, state: 'stopped' });
  await round(f, m);
  expect(m.thread(steered)).toMatchObject({ state: 'stopped', stateReason: 'Superseded.' });
  expect(queue(f).some((event) => event.kind === 'thread-interrupted' && event.threadId === steered)).toBe(false);
  await expect(tool('jevellan_thread_message', { threadId: steered, message: 'Too late.' }, 4)).rejects.toThrow('This thread has ended.');

  // 3. A turn-limit question from a member thread is answered on the hub's page; the member applies the answer once.
  m.fake.enqueueTurn(sayStep('First pass.'), forThread());
  const limited = (await startOnMember('Write docs')).threadId; await turns(f, m, limited, 1);
  // The smallest cap is 5 turns; the thread's own allowance is lowered so that its next turn meets the limit.
  m.app.projectWork.store.update(limited, (thread) => ({ ...thread, turnAllowance: 1 }));
  await tool('jevellan_thread_message', { threadId: limited, message: 'Add an example.' }, 5);
  const asked = await f.waitFor(async () => { await round(f, m); return (await f.app.projectHub.decisions(pid)).find((decision) => decision.threadId === limited && !decision.answer); }, Boolean);
  expect(m.thread(limited)).toMatchObject({ state: 'waiting-for-you', turnAllowance: 1 });
  m.fake.enqueueTurn(sayStep('Added the example.'), forThread());
  const answer = { schema: 'decision-answer-request-v1', clientRequestId: `ans_${randomUUID()}`, optionLabel: ALLOW_MORE_TURNS };
  expect((await f.request(`/api/projects/${pid}/decisions/${asked!.id}/answer`, 'POST', answer)).status).toBe(202);
  await turns(f, m, limited, 2);
  expect(m.thread(limited).turnAllowance).toBe(11);
  expect(await (await f.request(`/api/projects/${pid}/decisions/${asked!.id}/answer`, 'POST', answer)).json()).toMatchObject({ repeated: true });
  await round(f, m); expect(m.thread(limited).turnAllowance).toBe(11);

  // 4. Over the project limit threads are created queued on their owner and wait for the coordinator's sweep, oldest first across
  // devices (D9, D9a): the member never starts its own queued thread, and the sweep sends it one dispatch when its turn comes.
  await settings(f, { maxRunningThreads: 1 });
  let releaseBusy!: () => void; const busyHeld = new Promise<void>((resolve) => { releaseBusy = resolve; });
  m.fake.enqueueTurn(holdStep(busyHeld), forThread());
  const busy = (await startOnMember('Long job')).threadId;
  await f.waitFor(async () => { await m.app.projectWork.pulse(); return (await f.index(busy))?.state; }, (state) => state === 'running');
  const first = await f.json(`/api/projects/${pid}/threads`, ThreadCreatedViewSchema, 'POST', createBody('Hub job', { deviceId: hubId }));
  const second = await startOnMember('Member job');
  expect([first.state, second.state]).toEqual(['queued', 'queued']); expect(second.placement).toContain(`· ${m.name}`);
  // Each side's periodic work, without waiting for idle: the held turn keeps the member busy.
  await m.app.projectWork.pulse(); await work.pulse(); await m.app.projectWork.pulse();
  expect(m.thread(second.threadId)).toMatchObject({ state: 'queued', stateReason: 'Queued: the project is at its limit of 1 running threads.' });
  expect(envelopesFor(m.deviceId)).toEqual([]);
  // The member's job ends: the hub's older queued thread takes the slot; the member's stays queued, on the member too.
  let releaseHub!: () => void; const hubHeld = new Promise<void>((resolve) => { releaseHub = resolve; });
  f.fake.enqueueTurn(holdStep(hubHeld), forThread());
  const started = m.fake.turnStarts.length;
  releaseBusy(); await turns(f, m, busy, 1);
  await f.waitFor(async () => { await work.pulse(); return f.app.projectWork.store.get(first.threadId)?.state; }, (state) => state === 'running');
  await m.app.projectWork.pulse(); await work.pulse(); await m.app.projectWork.pulse();
  expect(m.thread(second.threadId).state).toBe('queued'); expect(m.fake.turnStarts.length).toBe(started);
  // Only the coordinator sweeps: the hub's own thread started from its sweep, never from a command another device sent.
  expect(f.app.projectWork.store.local(first.threadId).seenCommands).toBeUndefined();
  // The hub's job rests: the sweep dispatches the member's thread once, and the member runs it.
  m.fake.enqueueTurn(sayStep('Member job done.'), forThread());
  releaseHub();
  await f.waitFor(async () => { await work.pulse(); await m.app.projectWork.pulse(); return m.thread(second.threadId).turns; }, (count) => count === 1);
  await m.app.projectWork.idle(); await work.idle(); await work.pulse(); await m.app.projectWork.pulse();
  expect(m.app.projectWork.store.local(second.threadId).seenCommands).toEqual([expect.stringMatching(/^tcmd_/)]);
  expect(m.fake.turnStarts.length).toBe(started + 1); expect(envelopesFor(m.deviceId)).toEqual([]);
  await f.waitFor(() => reports(f), (seen) => seen.includes(`${second.threadId} Member job done.`));
  await expectNoMemberLeaks(f, m);
});
