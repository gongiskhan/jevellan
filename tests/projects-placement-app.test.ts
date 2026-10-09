// Phase 4 acceptance (brief 13 PJ4, PJ4b; design 5.2.13, 5.2.14): Jev places owner threads on a booted daemon through a scripted
// Jev transport, over two simulated runtimes; overrides change the next launch and restarts replace a thread. Simulated: the Jev
// answers, runtime turns and GitHub. Live: git, HTTP, the hub, the ledgers and the process groups. Since phase 6 Call A asks the
// isolation first and the scripted Jev keeps worktrees, so main placement is covered by project-main-publication and the pure tests;
// Call B asks for the device when a second device qualifies (phase 5).
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountSchema, DeviceSchema, ProjectSchema, ProjectWorkViewSchema, SecretRedactor, ThreadCreatedViewSchema, ThreadOverrideViewSchema, ThreadViewSchema, mapEffort, type CoordinatorEvent, type ModelOption,
  type ProjectLedgerData, type ProjectLedgerEvent,
} from '../packages/core/dist/index.js';
import { HubAccounts, joinHub } from '../packages/mesh/dist/index.js';
import { PlacementStateSchema, type JevQuestions, type PlacementState } from '../packages/decisions/dist/index.js';
import { FakeRuntime, forThread } from '../packages/runtime-contract/dist/index.js';
import { PHASE_GATES } from '../packages/projects/dist/index.js';
import { commitStep, expectNoLeaks, holdStep, never, projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});

const SWIFT: ModelOption = { id: 'swift', runtime: 'fake', model: 'swift-model', label: 'Swift', description: 'Quick model for small, contained changes.', efforts: ['low', 'high'], enabled: true };
const DEEP: ModelOption = { id: 'deep', runtime: 'fake2', model: 'deep-model', label: 'Deep', description: 'Careful model for large changes.', efforts: ['high', 'max'], enabled: true };
const DEEP_LITE: ModelOption = { id: 'deep-lite', runtime: 'fake2', model: 'deep-lite-model', label: 'Deep Lite', description: 'Lighter careful model.', efforts: ['low', 'high'], enabled: true };
const SECOND_RUNTIME = 'Second test runtime';
/** Jev's distributions per question; every other option gets 0, and an unknown question puts everything on its first option. */
const ANSWERS: Record<string, Record<string, number>> = {
  isolation: { worktree: 0.8, main: 0.2 }, pick_model: { deep: 0.7, swift: 0.3 }, effort: { max: 0.6, xhigh: 0.2, high: 0.1, medium: 0.05, low: 0.05 },
};
type JevCallSeen = { model: string; questions: JevQuestions; packet: PlacementState; authorization: string | null };

/** The scripted Jev transport: placement packets only; `auth` answers 401 with a provider body that must never be stored. */
function jev() {
  const state = { mode: 'answer' as 'answer' | 'auth', calls: [] as JevCallSeen[], answers: { ...ANSWERS } };
  const fetcher: typeof fetch = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ models: [{ name: 'jev-latest', description: 'Fixture.', release_date: '2026-01-01' }] });
    const body = JSON.parse(String(init!.body)) as { model: string; state: string; questions: JevQuestions };
    const packet = JSON.parse(body.state) as { schema?: string };
    if (packet.schema !== 'placement-state-v1') return new Response('Only placements are scripted here.', { status: 400 });
    state.calls.push({ model: body.model, questions: body.questions, packet: PlacementStateSchema.parse(packet), authorization: new Headers(init!.headers).get('authorization') });
    if (state.mode === 'auth') return new Response('Private provider body is not evidence.', { status: 401 });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const keys = question.type === 'choice' ? Object.keys(question.criteria) : [];
      const table = state.answers[id] ?? {}; const known = keys.some((key) => (table[key] ?? 0) > 0);
      const probabilities = Object.fromEntries(keys.map((key, n) => [key, known ? table[key] ?? 0 : n === 0 ? 1 : 0]));
      const choice = keys.reduce((best, key) => probabilities[key]! > probabilities[best]! ? key : best, keys[0]!);
      return [id, { type: 'choice', choice, probabilities, confidence: probabilities[choice] }];
    }));
    return Response.json({ model: 'jev-fixture', usage: { input_tokens: 40, output_tokens: 4 }, answers });
  };
  return { state, fetch: fetcher };
}

/** A fixture with the second runtime (its own display name, so refusals name both) and one account per runtime. */
async function setup(menu: ModelOption[], transport: ReturnType<typeof jev>): Promise<ProjectFixture> {
  const second = new FakeRuntime();
  Object.defineProperty(second, 'id', { value: 'fake2' }); Object.defineProperty(second, 'displayName', { value: SECOND_RUNTIME });
  const f = fixture = await projectFixture({ menu, runtimes: { fake: new FakeRuntime(), fake2: second }, jevKey: true, decisionFetch: transport.fetch });
  f.app.hub.put('accounts', 'acc_deep', AccountSchema, { schema: 'account-v1', id: 'acc_deep', runtime: 'fake2', label: 'Deep account', kind: 'subscription', enabled: true, ceilingPct: 90,
    credential: 'per-device' }, 0);
  await f.app.accounts.check('acc_deep');
  return f;
}
const createBody = (title: string, task: string) => ({ schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task });
const start = (f: ProjectFixture, title: string, task: string, project = 'project') => f.json(`/api/projects/${project}/threads`, ThreadCreatedViewSchema, 'POST', createBody(title, task));
const overrideBody = (mode: 'next-turn' | 'restart', fields: object, clientRequestId = `ovr_${randomUUID()}`) => ({ schema: 'thread-override-request-v1', clientRequestId, mode, ...fields });
const override = (f: ProjectFixture, threadId: string, body: object) => f.request(`/api/projects/project/threads/${threadId}/override`, 'POST', body);
const queue = (f: ProjectFixture): CoordinatorEvent[] => f.coordinatorState().queue;
const placementEvents = (f: ProjectFixture) => queue(f).filter((event) => event.kind === 'placement-override');
const view = (f: ProjectFixture, threadId: string) => f.json(`/api/projects/project/threads/${threadId}`, ThreadViewSchema);
async function settle(f: ProjectFixture, threadId: string, turns: number): Promise<void> {
  await f.waitFor(() => f.thread(threadId).turns, (count) => count === turns); await f.app.projectWork.idle('project');
}
/** An owner message that runs one more turn of `runtime`, reporting progress. */
async function message(f: ProjectFixture, runtime: FakeRuntime, threadId: string, text: string): Promise<void> {
  const turns = f.thread(threadId).turns;
  runtime.enqueueTurn(reportStep({ status: 'progress', summary: text }), forThread());
  const response = await f.request(`/api/projects/project/threads/${threadId}/messages`, 'POST', { schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text, interrupt: false });
  expect(response.status).toBe(202);
  await settle(f, threadId, turns + 1);
}

test('PJ4 Jev places threads with recorded probabilities and falls back on failure', { timeout: 120_000 }, async () => {
  const transport = jev(); const f = await setup([SWIFT, DEEP], transport); const deep = f.runtimes.fake2!;
  const deviceId = f.app.device.deviceId;

  // 1. Call A asks the model and the effort; Jev's most probable options win and the effort is mapped for the model.
  deep.enqueueTurn(reportStep({ status: 'progress', summary: 'Planned the search box.' }), forThread());
  const created = await start(f, 'Add search', 'Add a search box to the catalog page.');
  expect(created.placement).toBe(`${SECOND_RUNTIME} Deep · max · Worktree · ${f.deviceName}`);
  expect(transport.state.calls).toHaveLength(1);
  const [call] = transport.state.calls;
  // The isolation question comes first once main isolation exists (phase 6, D88).
  expect(Object.keys(call!.questions)).toEqual(PHASE_GATES.mainIsolation ? ['isolation', 'pick_model', 'effort'] : ['pick_model', 'effort']);
  expect(call!.questions.pick_model).toEqual({ type: 'choice', instructions: 'Choose the model that should carry this thread end to end.', criteria: { swift: SWIFT.description, deep: DEEP.description } });
  expect(call!.questions.effort).toEqual({ type: 'choice', instructions: 'Choose the reasoning effort this thread needs.', criteria: f.app.hub.configuration.current()!.configuration['x-jevellan'].effortGuide });
  expect(call!.model).toBe(f.app.hub.configuration.current()!.configuration['x-jevellan'].decisions.model);
  expect(call!.authorization).toBe(`Bearer ${f.jevKey!}`);
  expect(call!.packet).toMatchObject({ project: { name: 'Shop', defaultIsolation: 'worktree' }, thread: { title: 'Add search', task: 'Add a search box to the catalog page.' }, activeThreads: [],
    rules: { recentOverrides: [] } });
  const thread = f.thread(created.threadId);
  expect(thread.placement).toMatchObject({ schema: 'placement-v1', questionSet: 'p-v1', source: 'jev', fixed: [], isolation: 'worktree', runtime: 'fake2', modelId: 'deep', model: 'deep-model',
    effortRequested: 'max', effortEffective: 'max', deviceId, accountId: 'acc_deep', eligibleModels: ['swift', 'deep'], excludedModels: [], eligibleDevices: [deviceId],
    probabilities: { pick_model: { swift: 0.3, deep: 0.7 }, effort: ANSWERS.effort } });
  expect(thread.placement.jevCalls).toEqual([expect.objectContaining({ schema: 'jev-call-v1', kind: 'placement', requestedModel: call!.model, returnedModel: 'jev-fixture' })]);
  expect('error' in thread.placement).toBe(false);
  expect((await view(f, created.threadId)).placement).toEqual(thread.placement);
  // The first turn runs on the placed runtime, model, effort and ranked account.
  await settle(f, created.threadId, 1);
  expect(deep.turnStarts).toHaveLength(1); expect(f.fake.turnStarts).toEqual([]);
  expect(deep.turnStarts[0]).toMatchObject({ model: 'deep-model', effort: 'max', account: { account: { id: 'acc_deep' } } });
  // A Jev-placed thread carries no fallback chip in its index line.
  await f.app.projectWork.pulse();
  expect(await f.index(created.threadId)).toMatchObject({ runtime: 'fake2', modelLabel: 'Deep', effort: 'max', accountLabel: 'Deep account' });

  // 2. A Leave git project can edit its existing checkout without automating git; its packet lists only its own threads.
  const docs = join(f.root, 'docs'); f.git(f.root, 'clone', f.origin, docs);
  await f.app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'docs', name: 'Docs', paths: { [deviceId]: docs },
    branchPolicy: 'external', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
  deep.enqueueTurn(reportStep({ status: 'progress', summary: 'Outlined the guide.' }), forThread());
  const external = await start(f, 'Write a guide', 'Write the setup guide.', 'docs');
  expect(Object.keys(transport.state.calls[1]!.questions)).toEqual(['isolation', 'pick_model', 'effort']);
  expect(transport.state.calls[1]!.packet).toMatchObject({ project: { name: 'Docs', defaultIsolation: 'worktree' }, activeThreads: [] });
  await f.waitFor(() => f.app.projectWork.store.get(external.threadId)?.turns, (turns) => turns === 1); await f.app.projectWork.idle();

  // 3. Jev refuses the key: the deterministic fallback with the recorded error; the provider body is stored nowhere.
  transport.state.mode = 'auth';
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Found the typo.' }), forThread());
  const fallback = await start(f, 'Fix typo', 'Fix the typo in the footer.');
  expect(transport.state.calls).toHaveLength(3);
  expect(transport.state.calls[2]!.packet.activeThreads).toEqual([{ title: 'Add search', isolation: 'worktree', device: f.deviceName, model: 'Deep', effort: 'max', reservedPaths: [] }]);
  const effort = mapEffort('medium', SWIFT.efforts);
  expect(fallback.placement).toBe(`Scripted test runtime Swift · ${effort} · Worktree · ${f.deviceName} · placed without Jev: authentication failed`);
  const placed = f.thread(fallback.threadId).placement;
  expect(placed).toMatchObject({ source: 'fallback', fixed: [], modelId: 'swift', runtime: 'fake', effortRequested: 'medium', effortEffective: effort, deviceId, accountId: 'acc_fixture',
    error: { kind: 'auth', message: 'authentication failed' }, jevCalls: [] });
  expect('probabilities' in placed).toBe(false);
  const fallbackView = await f.request(`/api/projects/project/threads/${fallback.threadId}`);
  expect(fallbackView.status).toBe(200);
  for (const text of [JSON.stringify(placed), await fallbackView.text(), f.ledgerText(fallback.threadId), JSON.stringify(await f.index(fallback.threadId))]) {
    expect(text).not.toContain('Private provider body');
  }
  await settle(f, fallback.threadId, 1);

  // 4. No account can run any model: the start is refused with every reason, nothing is created and Jev is not asked.
  for (const id of ['acc_fixture', 'acc_deep']) {
    const stored = f.app.hub.get('accounts', id, AccountSchema)!; f.app.hub.put('accounts', id, AccountSchema, { ...stored.document, enabled: false }, stored.revision);
  }
  const threads = f.app.projectWork.store.list('project').length;
  const refused = await f.request('/api/projects/project/threads', 'POST', createBody('Blocked', 'Nothing can run this.'));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ schema: 'error-v1', code: 'conflict',
    message: `No device can run any enabled model: ${f.deviceName}: Scripted test runtime account disabled; ${f.deviceName}: ${SECOND_RUNTIME} account disabled.` });
  expect(f.app.projectWork.store.list('project')).toHaveLength(threads); expect(transport.state.calls).toHaveLength(3);
});

test('PJ4 Call B asks for the device when a second device qualifies', { timeout: 120_000 }, async () => {
  const transport = jev(); const f = await setup([SWIFT, DEEP], transport); const deep = f.runtimes.fake2!;
  const hubId = f.app.device.deviceId;
  // A second device: joined (so it is not revoked), online by its heartbeat, set up for the project, with an eligible account
  // for Deep's runtime that only it reports. It needs no daemon: placement reads the roster and the hub account list.
  const hubRow = f.app.hub.get('devices', hubId, DeviceSchema)!; f.app.hub.put('devices', hubId, DeviceSchema, { ...hubRow.document, url: f.base }, hubRow.revision);
  const joined = await joinHub({ hubUrl: f.base, hubName: 'Fixture hub', redactor: new SecretRedactor() }, { schema: 'join-device-v1', requestId: 'join_studio', code: f.app.mesh.invite().code,
    device: { id: 'dev_studio', name: 'Studio', url: 'http://127.0.0.1:9', os: 'linux', version: '0.1.0' } });
  expect(joined.membership.device.id).toBe('dev_studio');
  f.app.devices.heartbeat('dev_studio', { schema: 'heartbeat-v1', deviceId: 'dev_studio', at: new Date().toISOString(), version: '0.1.0', runningConversations: [], projects: [], externalSessions: [],
    load: { cpuPct: 0, memFreeMb: 1024 } });
  const stored = (await f.app.state.projects.get('project'))!;
  await f.app.conversations.saveProject({ schema: 'project-write-v1', revision: stored.revision, project: { ...stored.project, paths: { ...stored.project.paths, dev_studio: '/srv/shop' } } });
  new HubAccounts(f.app.hub, 'dev_studio').writeStatus({ schema: 'account-status-v2', accountId: 'acc_deep', deviceId: 'dev_studio', auth: 'ready', observedAt: new Date().toISOString() }, null);
  // Jev keeps the thread on the hub by naming its device key (never a position).
  transport.state.answers = { ...ANSWERS, device: { [hubId]: 0.75, dev_studio: 0.25 } };

  deep.enqueueTurn(reportStep({ status: 'progress', summary: 'Placed by device.' }), forThread());
  const created = await start(f, 'Add search', 'Add a search box to the catalog page.');
  expect(transport.state.calls).toHaveLength(2);
  const [callA, callB] = transport.state.calls;
  expect(Object.keys(callA!.questions)).toEqual(PHASE_GATES.mainIsolation ? ['isolation', 'pick_model', 'effort'] : ['pick_model', 'effort']);
  expect(Object.keys(callB!.questions)).toEqual(['device']);
  const device = callB!.questions.device;
  expect(device?.type === 'choice' && Object.keys(device.criteria).sort()).toEqual([hubId, 'dev_studio'].sort());
  // The hub's heartbeat reports its checkout branch; the second device reported no projects.
  const branch = f.git(f.checkout, 'rev-parse', '--abbrev-ref', 'HEAD');
  expect(device?.type === 'choice' && device.criteria).toEqual({ [hubId]: `${f.deviceName}: 0 threads running here, this is the coordinator's device, project checkout is on ${branch}`,
    dev_studio: 'Studio: 0 threads running here' });
  const record = f.thread(created.threadId).placement;
  expect(record).toMatchObject({ source: 'jev', modelId: 'deep', effortRequested: 'max', deviceId: hubId, accountId: 'acc_deep', probabilities: { device: { [hubId]: 0.75, dev_studio: 0.25 } } });
  expect([...record.eligibleDevices].sort()).toEqual([hubId, 'dev_studio'].sort());
  expect(record.jevCalls.map((call) => call.kind)).toEqual(['placement', 'placement']);
  expect(created.placement).toBe(`${SECOND_RUNTIME} Deep · max · Worktree · ${f.deviceName}`);
  await settle(f, created.threadId, 1);
  expect(deep.turnStarts[0]).toMatchObject({ model: 'deep-model', effort: 'max', account: { account: { id: 'acc_deep' } } });
});

test('the work view gives every device the reason a thread of the project cannot run there, as placement would (D281)', { timeout: 120_000 }, async () => {
  const transport = jev(); const f = await setup([SWIFT, DEEP], transport);
  const hubId = f.app.device.deviceId;
  const hubRow = f.app.hub.get('devices', hubId, DeviceSchema)!; f.app.hub.put('devices', hubId, DeviceSchema, { ...hubRow.document, url: f.base }, hubRow.revision);
  const join = async (id: string, name: string) => {
    await joinHub({ hubUrl: f.base, hubName: 'Fixture hub', redactor: new SecretRedactor() }, { schema: 'join-device-v1', requestId: `join_${id}`, code: f.app.mesh.invite().code,
      device: { id, name, url: 'http://127.0.0.1:9', os: 'linux', version: '0.1.0' } });
  };
  const beat = (id: string) => f.app.devices.heartbeat(id, { schema: 'heartbeat-v1', deviceId: id, at: new Date().toISOString(), version: '0.1.0', runningConversations: [], projects: [],
    externalSessions: [], load: { cpuPct: 0, memFreeMb: 1024 } });
  // Studio: online, set up, an eligible Deep account. Bare: online without the project. Cold: online and set up, no account there.
  // Lab: set up but never reported a heartbeat. Gone: revoked, so not listed.
  for (const [id, name] of [['dev_studio', 'Studio'], ['dev_bare', 'Bare'], ['dev_cold', 'Cold'], ['dev_lab', 'Lab'], ['dev_gone', 'Gone']] as const) await join(id, name);
  for (const id of ['dev_studio', 'dev_bare', 'dev_cold', 'dev_gone']) beat(id);
  f.app.devices.revoke('dev_gone');
  const stored = (await f.app.state.projects.get('project'))!;
  await f.app.conversations.saveProject({ schema: 'project-write-v1', revision: stored.revision, project: { ...stored.project,
    paths: { ...stored.project.paths, dev_studio: '/srv/shop', dev_cold: '/srv/shop', dev_lab: '/srv/shop', dev_gone: '/srv/shop' } } });
  new HubAccounts(f.app.hub, 'dev_studio').writeStatus({ schema: 'account-status-v2', accountId: 'acc_deep', deviceId: 'dev_studio', auth: 'ready', observedAt: new Date().toISOString() }, null);
  const view = await f.json('/api/projects/project/work', ProjectWorkViewSchema);
  const entry = (deviceId: string, name: string, reason?: string) => ({ schema: 'project-device-setup-v1', deviceId, name, ...(reason ? { reason } : {}) });
  const expected = [entry(hubId, f.deviceName), entry('dev_studio', 'Studio'), entry('dev_bare', 'Bare', 'not set up for this project'),
    entry('dev_cold', 'Cold', `Scripted test runtime needs login; ${SECOND_RUNTIME} needs login`), entry('dev_lab', 'Lab', 'offline')];
  // In roster order, without the revoked device.
  const order = (await f.app.roster()).devices.filter((row) => !row.revoked).map((row) => row.device.id);
  expect(view.devices).toEqual(order.map((id) => expected.find((item) => item.deviceId === id)));
  expect(order).toHaveLength(expected.length);
  // Placement agrees: a thread fixed to a listed device is refused with the same reason.
  const refused = await f.request('/api/projects/project/threads', 'POST', { ...createBody('Add search', 'Add a search box.'), deviceId: 'dev_bare' });
  expect(refused.status).toBe(409); expect((await refused.json() as { message: string }).message).toContain('Bare: not set up for this project');
});

test('PJ4b overrides change the next launch and restarts feed the packet', { timeout: 180_000 }, async () => {
  const transport = jev(); const f = await setup([SWIFT, DEEP, DEEP_LITE], transport); const deep = f.runtimes.fake2!;
  deep.enqueueTurn(reportStep({ status: 'progress', summary: 'Planned the search box.' }), forThread());
  const { threadId } = await start(f, 'Add search', 'Add a search box to the catalog page.');
  await settle(f, threadId, 1);
  expect(f.thread(threadId).placement).toMatchObject({ source: 'jev', modelId: 'deep', effortRequested: 'max', effortEffective: 'max', accountId: 'acc_deep' });
  const firstSession = f.thread(threadId).nativeSessionId; expect(firstSession).toBeDefined();
  expect(await view(f, threadId)).toMatchObject({ canOverride: { nextTurn: true, restart: true } });

  // 1. From the next turn, the effort: the hub records only the change (from = the requested value) and the coordinator hears it.
  const lower = overrideBody('next-turn', { effort: 'low' });
  const answer = await override(f, threadId, lower);
  expect(answer.status).toBe(200); expect(await answer.json()).toEqual({ schema: 'thread-override-view-v1' });
  const [first] = await f.app.projectHub.recentOverrides('project', 8);
  expect(first).toEqual({ schema: 'placement-override-v1', id: expect.stringMatching(/^povr_/), projectId: 'project', threadId, mode: 'next-turn',
    changes: [{ field: 'effort', from: 'max', to: 'low' }], at: expect.any(String) });
  expect(placementEvents(f)).toEqual([expect.objectContaining({ kind: 'placement-override', threadId, summary: 'Effort changed from max to low.' })]);
  expect(f.thread(threadId).placement).toMatchObject({ modelId: 'deep', effortRequested: 'low', effortEffective: mapEffort('low', DEEP.efforts) });
  // The same request again changes nothing more.
  expect((await override(f, threadId, lower)).status).toBe(200);
  expect(await f.app.projectHub.recentOverrides('project', 8)).toHaveLength(1); expect(placementEvents(f)).toHaveLength(1);
  await message(f, deep, threadId, 'Add the input field.');
  expect(deep.turnStarts.at(-1)).toMatchObject({ model: 'deep-model', effort: 'high', resume: { sessionId: firstSession }, account: { account: { id: 'acc_deep' } } });
  expect(mapEffort('low', DEEP.efforts)).toBe('high');

  // 2. From the next turn, a model of the same runtime: the effort is already low, so only the model is recorded.
  const session = f.thread(threadId).nativeSessionId;
  const lite = await override(f, threadId, overrideBody('next-turn', { modelId: 'deep-lite', effort: 'low', note: 'Lighter is enough now.' }));
  expect(lite.status).toBe(200);
  const recent = await f.app.projectHub.recentOverrides('project', 8);
  expect(recent.map((entry) => [entry.mode, entry.changes, entry.note])).toEqual([['next-turn', [{ field: 'model', from: 'deep', to: 'deep-lite' }], 'Lighter is enough now.'],
    ['next-turn', [{ field: 'effort', from: 'max', to: 'low' }], undefined]]);
  expect(placementEvents(f).at(-1)).toMatchObject({ threadId, summary: 'Model changed from deep to deep-lite. Note: Lighter is enough now.' });
  await message(f, deep, threadId, 'Wire the results list.');
  // Same runtime and account: the session continues on the new model.
  expect(deep.turnStarts.at(-1)).toMatchObject({ model: 'deep-lite-model', effort: 'low', resume: { sessionId: session }, account: { account: { id: 'acc_deep' } } });
  expect(f.thread(threadId).placement).toMatchObject({ modelId: 'deep-lite', model: 'deep-lite-model', effortRequested: 'low', effortEffective: 'low', accountId: 'acc_deep' });
  await f.app.projectWork.pulse();
  expect(await f.index(threadId)).toMatchObject({ modelLabel: 'Deep Lite', effort: 'low' });

  // 3. Another runtime only by a restart; next-turn may change account, model and effort within that runtime.
  const runtime = await override(f, threadId, overrideBody('next-turn', { modelId: 'swift' }));
  expect(runtime.status).toBe(409);
  expect(await runtime.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: 'From the next turn, the model must use the same runtime.' });
  const fields = await override(f, threadId, overrideBody('next-turn', { isolation: 'worktree' }));
  expect(fields.status).toBe(400); expect(await fields.json()).toMatchObject({ message: 'From the next turn, only the account, model and effort can change within the same runtime.' });
  expect(await f.app.projectHub.recentOverrides('project', 8)).toHaveLength(2);

  // 4. Restart with these choices: a new thread with the same title and task and the model fixed; the old one ends and loses its worktree.
  const old = f.thread(threadId); expect(existsSync(old.cwd)).toBe(true);
  f.fake.enqueueTurn(commitStep({ 'search.txt': 'search\n' }, { status: 'done', summary: 'Added the search box.', changedFiles: ['search.txt'] }), forThread());
  const restart = overrideBody('restart', { modelId: 'swift', note: 'Swift is enough for this.' });
  const restarted = await f.json(`/api/projects/project/threads/${threadId}/override`, ThreadOverrideViewSchema, 'POST', restart);
  const newId = restarted.newThreadId!; expect(newId).toMatch(/^thread_/); expect(newId).not.toBe(threadId);
  expect(f.thread(threadId)).toMatchObject({ state: 'stopped', stateReason: `Restarted as ${newId}.` });
  expect(existsSync(old.cwd)).toBe(false);
  expect(f.git(f.checkout, 'branch', '--list', old.branch!)).toBe('');
  const replacement = f.thread(newId);
  expect(replacement).toMatchObject({ title: 'Add search', task: 'Add a search box to the catalog page.', createdBy: 'owner',
    placement: { source: 'jev', fixed: ['model'], modelId: 'swift', runtime: 'fake', accountId: 'acc_fixture' } });
  // The restart's own placement asked the isolation (main is allowed since phase 6) and the effort, with the owner's note and the earlier
  // overrides in its packet; Jev kept the worktree.
  const restartCall = transport.state.calls.at(-1)!;
  expect(Object.keys(restartCall.questions)).toEqual(['isolation', 'effort']);
  expect(replacement.isolation).toBe('worktree');
  expect(restartCall.packet.thread).toEqual({ title: 'Add search', task: 'Add a search box to the catalog page.', coordinatorNote: 'Swift is enough for this.' });
  expect(restartCall.packet.rules.recentOverrides).toEqual(["model changed from deep to deep-lite for 'Add search' (next-turn)", "effort changed from max to low for 'Add search' (next-turn)"]);
  // The change is recorded from the model the thread had (deep-lite after step 2) and the coordinator hears both threads.
  expect((await f.app.projectHub.recentOverrides('project', 1))[0]).toMatchObject({ mode: 'restart', threadId, changes: [{ field: 'model', from: 'deep-lite', to: 'swift' }], note: 'Swift is enough for this.' });
  // The new thread's own events may follow at any time, so only these two are compared, in order.
  const told = () => queue(f).filter((event) => (event.kind === 'thread-user-message' && event.threadId === newId) || event.kind === 'placement-override');
  expect(told().slice(2)).toEqual([
    expect.objectContaining({ kind: 'thread-user-message', threadId: newId, text: `[owner started thread "Add search" (${newId})] Add a search box to the catalog page.` }),
    expect.objectContaining({ kind: 'placement-override', threadId, summary: `Model changed from deep-lite to swift. Restarted as ${newId}. Note: Swift is enough for this.` })]);
  // A retried restart answers with the same thread and repeats nothing.
  const threads = f.app.projectWork.store.list('project').length;
  expect(await f.json(`/api/projects/project/threads/${threadId}/override`, ThreadOverrideViewSchema, 'POST', restart)).toEqual({ schema: 'thread-override-view-v1', newThreadId: newId });
  expect(told()).toHaveLength(4); expect(f.app.projectWork.store.list('project')).toHaveLength(threads);
  expect(await f.app.projectHub.recentOverrides('project', 8)).toHaveLength(3);
  // The old thread offers neither override again, nor Discard; a new restart of it is refused.
  expect(await view(f, threadId)).toMatchObject({ canOverride: { nextTurn: false, restart: false, restartReason: 'This thread was already restarted.' }, canDiscard: false });
  const again = await override(f, threadId, overrideBody('restart', { effort: 'high' }));
  expect(again.status).toBe(409); expect(await again.json()).toMatchObject({ message: 'This thread was already restarted.' });

  // 5. The next placement's packet carries both kinds of override, newest first, with the stored values.
  await f.waitFor(() => f.thread(newId).state, (state) => state === 'in-review'); await f.app.projectWork.idle('project');
  deep.enqueueTurn(reportStep({ status: 'progress', summary: 'Planned the filters.' }), forThread());
  const filters = await start(f, 'Add filters', 'Add price filters to the catalog page.');
  const packet = transport.state.calls.at(-1)!.packet;
  expect(packet.rules.recentOverrides).toEqual(["model changed from deep-lite to swift for 'Add search' (restart)", "model changed from deep to deep-lite for 'Add search' (next-turn)",
    "effort changed from max to low for 'Add search' (next-turn)"]);
  expect(packet.activeThreads).toEqual([{ title: 'Add search', isolation: 'worktree', device: f.deviceName, model: 'Swift', effort: replacement.placement.effortEffective, reservedPaths: [] }]);
  await settle(f, filters.threadId, 1);

  // 6. An open pull request blocks a restart; the next turn can still change.
  const reviewed = await view(f, newId);
  expect(reviewed.thread.pr).toMatchObject({ state: 'open' });
  expect(reviewed.canOverride).toEqual({ nextTurn: true, restart: false, restartReason: 'This thread has an open pull request.' });
  const blocked = await override(f, newId, overrideBody('restart', { modelId: 'deep' }));
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: 'This thread has an open pull request.' });
  expect(f.thread(newId)).toMatchObject({ state: 'in-review' });
});

test('PJ4b an override during a running turn applies from the next turn, and a restart ends the running turn', { timeout: 120_000 }, async () => {
  const transport = jev(); const f = await setup([SWIFT, DEEP, DEEP_LITE], transport); const deep = f.runtimes.fake2!;
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  deep.enqueueTurn(holdStep(held), forThread());
  const { threadId } = await start(f, 'Add search', 'Add a search box to the catalog page.');
  const ledger = f.app.projectWork.ledgers.thread('project', threadId);
  const starts = () => ledger.events().filter((event) => event.type === 'thread-turn-start')
    .map((event) => ledger.payload(event as ProjectLedgerEvent & { type: 'thread-turn-start' }) as ProjectLedgerData<'thread-turn-start'>);
  await f.waitFor(() => starts().length, (count) => count === 1);

  // The override answers while the turn runs; the running turn keeps the model and effort it started with.
  const response = await override(f, threadId, overrideBody('next-turn', { modelId: 'deep-lite', effort: 'low' }));
  expect(response.status).toBe(200);
  expect(f.thread(threadId)).toMatchObject({ state: 'running', placement: { modelId: 'deep-lite', model: 'deep-lite-model', effortRequested: 'low', effortEffective: 'low' } });
  expect(starts()).toEqual([expect.objectContaining({ turn: 1, modelId: 'deep', model: 'deep-model', effort: 'max' })]);
  expect(deep.turnStarts).toHaveLength(1); expect(deep.turnStarts[0]).toMatchObject({ model: 'deep-model', effort: 'max' });
  release(); await settle(f, threadId, 1);
  // The turn's own writes (its report, its turn count) keep the override.
  expect(f.thread(threadId).placement).toMatchObject({ modelId: 'deep-lite', effortRequested: 'low', effortEffective: 'low', accountId: 'acc_deep' });
  const session = f.thread(threadId).nativeSessionId;
  await message(f, deep, threadId, 'Add the input field.');
  expect(deep.turnStarts.at(-1)).toMatchObject({ model: 'deep-lite-model', effort: 'low', resume: { sessionId: session } });
  expect(starts().at(-1)).toMatchObject({ turn: 2, modelId: 'deep-lite', model: 'deep-lite-model', effort: 'low' });

  // A restart during a running turn stops it without telling the coordinator about a stop, and the new thread runs.
  deep.enqueueTurn(holdStep(never()), forThread());
  const sent = await f.request(`/api/projects/project/threads/${threadId}/messages`, 'POST', { schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text: 'Wire the results.', interrupt: false });
  expect(sent.status).toBe(202);
  await f.waitFor(() => starts().length, (count) => count === 3); expect(f.thread(threadId).state).toBe('running');
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Started over with Swift.' }), forThread());
  const restarted = await f.json(`/api/projects/project/threads/${threadId}/override`, ThreadOverrideViewSchema, 'POST', overrideBody('restart', { modelId: 'swift' }));
  const newId = restarted.newThreadId!;
  expect(f.thread(threadId)).toMatchObject({ state: 'stopped', stateReason: `Restarted as ${newId}.` });
  expect(existsSync(f.thread(threadId).cwd)).toBe(false);
  await settle(f, newId, 1);
  expect(f.thread(newId)).toMatchObject({ state: 'idle', placement: { modelId: 'swift', fixed: ['model'] } });
  expect(f.fake.turnStarts.at(-1)).toMatchObject({ model: 'swift-model', owner: { kind: 'thread', id: newId } });
  expect(queue(f).filter((event) => event.kind === 'thread-interrupted' && event.threadId === threadId)).toEqual([]);
  expect(placementEvents(f).map((event) => event.kind === 'placement-override' && event.summary)).toEqual(['Model changed from deep to deep-lite. Effort changed from max to low.',
    `Model changed from deep-lite to swift. Restarted as ${newId}.`]);
});
