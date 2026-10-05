// Phase 5 acceptance (brief 13 PJ5; design 5.2.15, 3.5): the coordinator on the hub places a thread on a simulated member device
// through Jev, the member runs it in its own worktree with its own account, the hub's browser reads and steers it through the
// proxy, the member's events wait in its outbox while the hub is down and arrive in order after, and the coordinator moves to the
// member for good. Simulated: the member device (local HTTP), the Jev answers, runtime turns and GitHub. Live: git, HTTP, the
// hub, the relay, the ledgers and the process groups.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  ProjectEnvelopeSchema, ProjectWorkViewSchema, ThreadCreatedViewSchema, ThreadMessageReceiptSchema, ThreadOverrideViewSchema, ThreadViewSchema, type CoordinatorEvent, type ProjectLedgerEvent,
} from '../packages/core/dist/index.js';
import { PlacementStateSchema, type JevQuestions } from '../packages/decisions/dist/index.js';
import { forCoordinator, forThread, type FakeRuntime, type FakeTurnStep, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import { PROJECT_OPERATION_NOT_FOUND, STOPPED_BY_YOU, WAITING_FOR_HUB, type ProjectWork } from '../packages/projects/dist/index.js';
import { expectNoLeaks, holdStep, projectFixture, projectMember, type ProjectFixture, type ProjectMember } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});

const pid = 'project';
const empty = { schema: 'empty-request-v1' };
const route = (threadId: string, suffix = '') => `/api/projects/${pid}/threads/${threadId}${suffix}`;
const ownerMessage = (text: string) => ({ schema: 'coordinator-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text });
const threadMessage = (text: string) => ({ schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text, interrupt: false });
const say = (text: string): FakeTurnStep => (turn) => { turn.say(text); return { status: 'completed' }; };
/** A thread turn that says `text` (its transcript shows it) and reports progress with the same summary. */
const sayStep = (text: string): FakeTurnStep => async (turn) => {
  turn.say(text); await turn.bridge('jevellan_thread_report', { status: 'progress', summary: text }); return { status: 'completed' };
};
const coordinatorTurns = (fake: FakeRuntime): TurnInput[] => fake.turnStarts.filter((input) => input.owner.kind === 'coordinator');

/**
 * The scripted Jev transport: placement packets only. Effort `high`, the first model, and the device by its explicit key (never
 * a position: criteria order is not a contract); the chosen option gets 0.6 and the rest share the remainder.
 */
function jev(device: () => string) {
  const calls: JevQuestions[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ models: [{ name: 'jev-latest', description: 'Fixture.', release_date: '2026-01-01' }] });
    const body = JSON.parse(String(init!.body)) as { state: string; questions: JevQuestions };
    PlacementStateSchema.parse(JSON.parse(body.state)); calls.push(body.questions);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const keys = question.type === 'choice' ? Object.keys(question.criteria) : [];
      const choice = id === 'device' ? device() : id === 'effort' ? 'high' : keys[0]!;
      if (!keys.includes(choice)) throw new Error(`The fixture cannot answer ${id}.`);
      const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? 0.6 : Math.round((0.4 / (keys.length - 1)) * 1000) / 1000]));
      return [id, { type: 'choice', choice, probabilities, confidence: 0.6 }];
    }));
    return Response.json({ model: 'jev-fixture', usage: { input_tokens: 40, output_tokens: 4 }, answers });
  };
  return { calls, fetch: fetcher };
}
/** Every coordinator turn of `fake` takes the next queued step, or says `Noted.`: an unscripted coordinator turn would fail. */
function coordinatorScript(fake: FakeRuntime): FakeTurnStep[] {
  const steps: FakeTurnStep[] = []; const start = fake.startTurn.bind(fake);
  fake.startTurn = (input) => { if (input.owner.kind === 'coordinator') fake.enqueueTurn(steps.shift() ?? say('Noted.'), forCoordinator); return start(input); };
  return steps;
}
/** The coordinator events a device's ledger recorded, in order. */
function ledgerEvents(work: ProjectWork): CoordinatorEvent[] {
  const ledger = work.coordinatorLedger(pid);
  return ledger.events().filter((event) => event.type === 'coordinator-event').map((event) => ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' }));
}
const reportSummaries = (work: ProjectWork, threadId: string) => ledgerEvents(work).flatMap((event) => event.kind === 'thread-report' && event.threadId === threadId ? [event.report.summary] : []);
/** The member reads its relayed envelopes, then the hub reads its own: one round of each side's periodic work. */
async function round(f: ProjectFixture, m: ProjectMember): Promise<void> {
  await m.app.projectWork.pulse(); await m.app.projectWork.idle(); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
}
/** Waits until the member's thread finished `count` turns, reading the relay meanwhile (the start arrives that way). */
async function turns(f: ProjectFixture, m: ProjectMember, threadId: string, count: number): Promise<void> {
  await f.waitFor(async () => { await m.app.projectWork.pulse(); return existsSync(m.app.projectWork.paths.threadFile(pid, threadId)) ? m.thread(threadId).turns : -1; },
    (value) => value === count);
  await m.app.projectWork.idle(pid);
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
  const threads = (await f.app.projectHub.threads(pid)).records;
  for (const thread of threads) await f.request(route(thread.id));
  const texts: Array<[string, string]> = [...f.responses.map((text): [string, string] => ['hub response', text]), ['hub thread indexes', JSON.stringify(threads)],
    ['hub page', JSON.stringify(await f.json(`/api/projects/${pid}/work`, ProjectWorkViewSchema))], ['hub questions', JSON.stringify(await f.app.projectHub.decisions(pid))],
    ['hub coordinator ledger', f.ledgerText()], ['hub relay', JSON.stringify(f.app.hub.list('project-envelopes', ProjectEnvelopeSchema))]];
  expect(texts.flatMap(([where, text]) => secrets.filter(([, value]) => text.includes(value)).map(([kind]) => `${kind} in ${where}`))).toEqual([]);
}
/** A bearer request straight to a peer route, as another device forwards it: the browser session and its device. */
function peer(base: string, path: string, init: { method?: string; token?: string; source?: string; origin?: string; body?: unknown } = {}) {
  return fetch(`${base}/api/mesh/projects/${path}`, { method: init.method ?? 'GET', headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    ...(init.source ? { 'X-Jevellan-Source-Device': init.source } : {}), ...(init.origin ? { Origin: init.origin } : {}), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
}

test('PJ5 the hub coordinator runs a thread on a member through the relay', { timeout: 300_000 }, async () => {
  let memberId = '';
  const transport = jev(() => memberId);
  const f = fixture = await projectFixture({ coordinator: true, jevKey: true, decisionFetch: transport.fetch });
  // The member has its own account, checked there only; its runtime enforces read-only turns, so it can take the coordinator later.
  const m = await projectMember(f); memberId = m.deviceId; m.fake.capabilities.readOnlyEnforced = true;
  const hubId = f.app.device.deviceId; const hubSteps = coordinatorScript(f.fake);
  coordinatorScript(m.fake);

  // 1. An owner message on the hub: the coordinator starts a thread, Jev places it on the member (Call B names the member's key),
  // and the start travels through the relay. The member creates the thread and its worktree in its own home and runs the first
  // turn with its own account.
  let started: Record<string, unknown> | undefined;
  hubSteps.push(async (turn) => {
    started = await turn.bridge('jevellan_thread_start', { title: 'Add search', task: 'Add a search box to the catalog page.' }) as Record<string, unknown>;
    turn.say('Started "Add search".'); return { status: 'completed' };
  });
  m.fake.enqueueTurn(sayStep('Working.'), forThread());
  expect((await f.request(`/api/projects/${pid}/coordinator/messages`, 'POST', ownerMessage('Add search to the catalog.'))).status).toBe(202);
  await f.waitFor(() => started); await f.app.projectWork.idle();
  const threadId = String(started!.threadId);
  expect(started).toMatchObject({ threadId: expect.stringMatching(/^thread_/), state: 'preparing' });
  const device = transport.calls.find((questions) => 'device' in questions)?.device;
  expect(device?.type === 'choice' && Object.keys(device.criteria).sort()).toEqual([hubId, m.deviceId].sort());
  expect(existsSync(f.app.projectWork.paths.threadFile(pid, threadId))).toBe(false);
  expect(f.app.projectWork.outbox.pending()).toEqual([]);
  expect(f.app.hub.list('project-envelopes', ProjectEnvelopeSchema).map((row) => row.document)).toEqual([
    expect.objectContaining({ sourceDeviceId: hubId, targetDeviceId: m.deviceId, body: expect.objectContaining({ kind: 'thread-start' }) })]);
  await turns(f, m, threadId, 1);
  const thread = m.thread(threadId);
  expect(thread).toMatchObject({ ownerDeviceId: m.deviceId, coordinatorDeviceId: hubId, placement: { source: 'jev', deviceId: m.deviceId, accountId: m.accountId,
    probabilities: { device: { [m.deviceId]: 0.6, [hubId]: 0.4 } } } });
  expect(thread.cwd.startsWith(m.homes.at('worktrees'))).toBe(true);
  expect(m.fake.turnStarts[0]).toMatchObject({ owner: { kind: 'thread', id: threadId }, account: { account: { id: m.accountId } } });
  expect(f.fake.turnStarts.filter((input) => input.owner.kind === 'thread')).toEqual([]);

  // 2. The member's report reaches the hub coordinator through the relay, which runs a turn on it.
  await round(f, m);
  await f.waitFor(() => coordinatorTurns(f.fake).map((input) => input.prompt).join('\n'), (prompts) => prompts.includes(`[thread "Add search" (${threadId}) reported progress] Working.`));
  await f.app.projectWork.idle();
  expect(reportSummaries(f.app.projectWork, threadId)).toEqual(['Working.']);

  // 3. The hub's browser opens the thread: the view comes from the member through the proxy, with the transcript read there.
  const view = await f.json(route(threadId), ThreadViewSchema);
  expect(view).toMatchObject({ deviceName: m.name, thread: { id: threadId, ownerDeviceId: m.deviceId, state: 'idle' }, placement: { source: 'jev', deviceId: m.deviceId }, canMessage: true });
  expect(JSON.stringify(view.transcript?.turns)).toContain('Working.'); expect(view.transcript?.session.cwd).toBeNull();
  // Each brief peer route through the proxy: a message (the member's next turn reads it), a next-turn override (recorded on the
  // member), and Stop and Discard on a second member thread (its worktree goes).
  m.fake.enqueueTurn(sayStep('Read the hint.'), forThread());
  const sent = await f.request(route(threadId, '/messages'), 'POST', threadMessage('Search titles only.'));
  expect(sent.status).toBe(202); expect(ThreadMessageReceiptSchema.parse(await sent.json()).repeated).toBe(false);
  await turns(f, m, threadId, 2);
  expect(m.fake.turnStarts.at(-1)).toMatchObject({ owner: { id: threadId }, prompt: expect.stringContaining('Search titles only.') });
  const override = await f.request(route(threadId, '/override'), 'POST', { schema: 'thread-override-request-v1', clientRequestId: `ovr_${randomUUID()}`, mode: 'next-turn', effort: 'low' });
  expect(override.status).toBe(200); expect(ThreadOverrideViewSchema.parse(await override.json())).toEqual({ schema: 'thread-override-view-v1' });
  expect(m.thread(threadId).placement).toMatchObject({ effortRequested: 'low' });
  m.fake.enqueueTurn(sayStep('Second thread.'), forThread());
  const second = await f.json(`/api/projects/${pid}/threads`, ThreadCreatedViewSchema, 'POST',
    { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title: 'Fix login', task: 'Fix the login redirect.', deviceId: m.deviceId });
  await turns(f, m, second.threadId, 1);
  const worktree = m.thread(second.threadId).cwd; expect(existsSync(worktree)).toBe(true);
  const stopped = ThreadViewSchema.parse(await (await f.request(route(second.threadId, '/stop'), 'POST', { schema: 'thread-stop-request-v1' })).json());
  expect(stopped).toMatchObject({ thread: { state: 'stopped', stateReason: STOPPED_BY_YOU }, canDiscard: true }); expect(m.thread(second.threadId).state).toBe('stopped');
  const discarded = await f.request(route(second.threadId, '/discard'), 'POST', empty);
  expect(discarded.status).toBe(202); expect(ThreadViewSchema.parse(await discarded.json()).canDiscard).toBe(false); expect(existsSync(worktree)).toBe(false);
  // The member's receiver refuses browsers and requests without a signed-in session; the brief's background start and event
  // delivery routes do not exist on any device (D40).
  const token = f.cookie.slice(f.cookie.indexOf('=') + 1);
  expect((await peer(m.base, `${pid}/threads/${threadId}`, { token, source: hubId })).status).toBe(200);
  expect((await peer(m.base, `${pid}/threads/${threadId}`, { token, source: hubId, origin: f.base })).status).toBe(403);
  expect((await peer(m.base, `${pid}/threads/${threadId}`, { source: hubId })).status).toBe(401);
  for (const base of [f.base, m.base]) {
    for (const path of [`${pid}/threads`, `${pid}/coordinator/events`]) {
      const absent = await peer(base, path, { method: 'POST', token, source: hubId, body: empty });
      expect(absent.status, `${base} ${path}`).toBe(404); expect(await absent.json()).toMatchObject({ message: PROJECT_OPERATION_NOT_FOUND });
    }
  }
  await round(f, m);

  // 4. The hub stops while the member works. Three member threads have turns running when it goes; the owner left a message on the
  // member's page for the third one (a member's browser needs the hub to sign each request, so it is written before). The turns end
  // while the hub is down: the first two reports wait in the member's outbox, in order, and nothing reaches the hub coordinator. The
  // third thread's next turn cannot start without the hub (the project and the accounts live there), so it rests until it is back
  // and its report waits for that turn, as a report followed by waiting messages always does.
  const gates = new Map<string, () => void>();
  const heldThen = (text: string): FakeTurnStep => async (turn) => {
    await holdStep(new Promise<void>((resolve) => { gates.set(turn.input.owner.id, resolve); }))(turn); return sayStep(text)(turn);
  };
  const onMember = async (title: string) => (await f.json(`/api/projects/${pid}/threads`, ThreadCreatedViewSchema, 'POST',
    { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task: `${title}.`, deviceId: m.deviceId })).threadId;
  m.fake.enqueueTurn(heldThen('One.'), forThread((input) => input.owner.id === threadId));
  expect((await m.request(route(threadId, '/messages'), 'POST', threadMessage('Add a results count.'))).status).toBe(202);
  await f.waitFor(async () => { await m.app.projectWork.pulse(); return gates.size; }, (size) => size === 1);
  m.fake.enqueueTurn(heldThen('Two.'), forThread()); const styles = await onMember('Tidy the styles');
  await f.waitFor(async () => { await m.app.projectWork.pulse(); return gates.size; }, (size) => size === 2);
  m.fake.enqueueTurn(heldThen('Drafted.'), forThread()); const docs = await onMember('Write the docs');
  await f.waitFor(async () => { await m.app.projectWork.pulse(); return gates.size; }, (size) => size === 3);
  expect((await m.request(route(docs, '/messages'), 'POST', threadMessage('Then add examples.'))).status).toBe(202);
  // Everything sent so far reached the hub (the owner's messages are echoed to the coordinator).
  await f.waitFor(() => m.app.projectWork.outbox.pending().length, (count) => count === 0); await f.app.projectWork.idle();
  const hubEvents = ledgerEvents(f.app.projectWork).length; const hubTurns = coordinatorTurns(f.fake).length;
  m.offline = true;
  for (const id of [threadId, styles, docs]) { gates.get(id)!(); await f.waitFor(() => m.thread(id).state, (state) => state === 'idle'); }
  await m.app.projectWork.idle(pid);
  const waiting = m.app.projectWork.outbox.pending(pid);
  expect(waiting.map(({ envelope }) => envelope.body.kind === 'coordinator-event' && envelope.body.event.kind === 'thread-report' ? envelope.body.event.report.summary : envelope.body.kind))
    .toEqual(['One.', 'Two.']);
  expect(waiting[0]!.envelope.seq).toBeLessThan(waiting[1]!.envelope.seq);
  // The thread with the waiting message rests on the hub, says so once, and every sweep while the hub is away leaves it there.
  for (let sweep = 0; sweep < 3; sweep += 1) { await m.app.projectWork.pulse(); await m.app.projectWork.idle(pid); }
  expect(m.thread(docs)).toMatchObject({ state: 'idle', stateReason: WAITING_FOR_HUB, turns: 1, queuedMessages: [{ text: 'Then add examples.' }] });
  expect(m.app.projectWork.ledgers.thread(pid, docs).events().filter((event) => event.type === 'notice')).toHaveLength(1);
  expect(m.app.projectWork.outbox.pending(pid)).toHaveLength(2);
  await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect(ledgerEvents(f.app.projectWork)).toHaveLength(hubEvents); expect(coordinatorTurns(f.fake)).toHaveLength(hubTurns);
  // The hub is back. The first delivery reaches it but its reply is lost, so the member sends it again; each report reaches the
  // coordinator once, in the order the member wrote them, and the waiting message's turn runs after them.
  m.offline = false; let puts = 0;
  m.loseReply = (call) => call.endsWith(' envelope-put') && puts++ === 0;
  m.fake.enqueueTurn(sayStep('Examples added.'), forThread((input) => input.owner.id === docs));
  await f.waitFor(async () => { await m.app.projectWork.pulse(); return m.thread(docs).turns; }, (count) => count === 2);
  await m.app.projectWork.idle(); await f.app.projectWork.idle(); m.loseReply = null;
  expect(puts).toBeGreaterThanOrEqual(3); expect(m.app.projectWork.outbox.pending()).toEqual([]);
  expect(m.fake.turnStarts.at(-1)).toMatchObject({ owner: { id: docs }, prompt: expect.stringContaining('Then add examples.') });
  await f.waitFor(() => reportSummaries(f.app.projectWork, docs), (summaries) => summaries.length > 0); await f.app.projectWork.idle();
  expect(reportSummaries(f.app.projectWork, threadId)).toEqual(['Working.', 'Read the hint.', 'One.']);
  expect(reportSummaries(f.app.projectWork, styles)).toEqual(['Two.']); expect(reportSummaries(f.app.projectWork, docs)).toEqual(['Examples added.']);
  expect(ledgerEvents(f.app.projectWork).flatMap((event) => event.kind === 'thread-report' ? [event.report.summary] : []).slice(-3)).toEqual(['One.', 'Two.', 'Examples added.']);
  expect(m.thread(docs).stateReason).toBeUndefined();

  // 5. Move coordinator here, from the member's page while the hub's coordinator is idle. The hub's owner message is proxied to the
  // member, whose first coordinator turn is fresh, built from the hub's notebook; the member's thread reports now reach the
  // coordinator on the member itself, and the hub runs no coordinator turn again, not even after it restarts.
  expect((await f.app.projectHub.coordinatorStatus(pid))?.document).toMatchObject({ deviceId: hubId, state: 'idle' });
  expect((await f.request(`/api/projects/${pid}/notebook`, 'PUT', { schema: 'notebook-request-v1', expectedRevision: 0, content: 'Ship search before filters.' })).status).toBe(200);
  const hubTurnsBefore = coordinatorTurns(f.fake).length;
  expect((await m.request(`/api/projects/${pid}/coordinator/move`, 'POST', empty)).status).toBe(200);
  expect((await f.app.projectHub.coordinator(pid))?.document.deviceId).toBe(m.deviceId);
  expect((await f.request(`/api/projects/${pid}/coordinator/messages`, 'POST', ownerMessage('Now add filters.'))).status).toBe(202);
  await f.waitFor(() => coordinatorTurns(m.fake).length, (count) => count === 1); await m.app.projectWork.idle();
  const fresh = coordinatorTurns(m.fake)[0]!;
  expect(fresh.resume).toBeUndefined(); expect(fresh.prompt.startsWith('Project notebook:\nShip search before filters.')).toBe(true); expect(fresh.prompt).toContain('Now add filters.');
  m.fake.enqueueTurn(sayStep('Filters planned.'), forThread((input) => input.owner.id === threadId));
  expect((await f.request(route(threadId, '/messages'), 'POST', threadMessage('Plan the filters.'))).status).toBe(202);
  await f.waitFor(() => coordinatorTurns(m.fake).map((input) => input.prompt).join('\n'), (prompts) => prompts.includes(`[thread "Add search" (${threadId}) reported progress] Filters planned.`));
  await round(f, m);
  expect(coordinatorTurns(f.fake)).toHaveLength(hubTurnsBefore); expect(reportSummaries(f.app.projectWork, threadId)).not.toContain('Filters planned.');
  expect((await f.json(`/api/projects/${pid}/work`, ProjectWorkViewSchema)).coordinator).toMatchObject({ deviceId: m.deviceId, deviceName: m.name, state: 'idle', canMoveHere: true });
  await expectNoMemberLeaks(f, m);
  // The hub keeps its former coordinator state until it starts again (or an event reaches it); at startup it hands it over.
  expect(existsSync(f.app.projectWork.paths.coordinator(pid))).toBe(true);
  await f.restart(); await f.app.projectWork.idle();
  expect(existsSync(f.app.projectWork.paths.coordinator(pid))).toBe(false); expect(coordinatorTurns(f.fake)).toHaveLength(hubTurnsBefore);
});
