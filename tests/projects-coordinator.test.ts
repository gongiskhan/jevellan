// Phase 2 acceptance (brief 13 PJ2-PJ2e, 8.1, 8.6, 9.1-9.3; design 5.2.7-5.2.10, 3.2-3.4): the coordinator on a booted daemon,
// driven only through the browser routes, with FakeRuntime coordinator and thread turns that call the daemon's own bridge, live
// git on a bare origin behind a GitHub-shaped remote, and the fake GitHub server. Assertions run after the scripted turns,
// never inside them: a throwing step would read as a failed turn.
import { afterEach, expect, test } from 'vitest';
import {
  CoordinatorMessageReceiptSchema, CoordinatorStateSchema, DecisionAnsweredViewSchema, ProjectEventFrameSchema, ProjectNotebookViewSchema, ProjectWorkSettingsViewSchema, ProjectWorkViewSchema,
  ThreadCreatedViewSchema, writeDocument, type CoordinatorEvent, type ProjectEventFrame, type ProjectLedgerData, type ProjectLedgerEvent, type ProjectLedgerEventType,
} from '../packages/core/dist/index.js';
import { forCoordinator, forThread, groupAlive, type FakeTurnStep, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import {
  EVENT_CURSOR_AHEAD, MESSAGE_ID_REUSED, RESTARTED, coordinatorFailedTwiceNotice, coordinatorSystemAppend, coordinatorUnavailableNotice, derivedId, noCoordinatorAccount, noCoordinatorModel,
} from '../packages/projects/dist/index.js';
import {
  FIXTURE_MENU, commitStep, expectNoLeaks, holdStep, never, projectFixture, reportStep, type ProjectFixture, type ProjectFixtureOptions,
} from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
async function setup(options: ProjectFixtureOptions = {}): Promise<ProjectFixture> { fixture = await projectFixture(options); return fixture; }

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
const say = (text: string): FakeTurnStep => (turn) => { turn.say(text); return { status: 'completed' }; };
const fail = (text: string): FakeTurnStep => () => ({ status: 'failed', error: { kind: 'other', message: text } });
const route = (f: ProjectFixture, suffix: string) => `/api/projects/${f.project.id}${suffix}`;
const message = (clientMessageId: string, text: string) => ({ schema: 'coordinator-message-request-v1', clientMessageId, text });
const answer = (clientRequestId: string, optionLabel: string) => ({ schema: 'decision-answer-request-v1', clientRequestId, optionLabel });
const refused = (code: string, text: string) => ({ schema: 'error-v1', code, message: text });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** An exact prompt in which every `HH:MM` is the coordinator device's local clock. */
const clocked = (text: string) => new RegExp(`^${escape(text).replaceAll('HH:MM', '\\d{2}:\\d{2}')}$`);

async function call(f: ProjectFixture, path: string, method: string, body: unknown, status: number): Promise<unknown> {
  const response = await f.request(path, method, body); const value: unknown = await response.json();
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
  return value;
}
async function post(f: ProjectFixture, clientMessageId: string, text: string): Promise<boolean> {
  return CoordinatorMessageReceiptSchema.parse(await call(f, route(f, '/coordinator/messages'), 'POST', message(clientMessageId, text), 202)).repeated;
}
async function startThread(f: ProjectFixture, title: string, task: string): Promise<string> {
  return (await f.json(route(f, '/threads'), ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: `req_${title.replace(/\W/g, '_')}`, title, task })).threadId;
}
const work = (f: ProjectFixture) => f.json(route(f, '/work'), ProjectWorkViewSchema);
const idle = (f: ProjectFixture) => f.app.projectWork.idle(f.project.id);
const coordinatorTurns = (f: ProjectFixture): TurnInput[] => f.fake.turnStarts.filter((input) => input.owner.kind === 'coordinator');
const threadTurns = (f: ProjectFixture, threadId: string): TurnInput[] => f.fake.turnStarts.filter((input) => input.owner.kind === 'thread' && input.owner.id === threadId);
/** The native session a turn ran in: FakeRuntime records each turn's run in start order. */
const sessionOf = (f: ProjectFixture, input: TurnInput) => f.fake.runs[f.fake.turnStarts.indexOf(input)]!.native;
function payloads<T extends ProjectLedgerEventType>(f: ProjectFixture, type: T): ProjectLedgerData<T>[] {
  const ledger = f.app.projectWork.coordinatorLedger(f.project.id);
  return ledger.events().filter((event) => event.type === type).map((event) => ledger.payload(event as ProjectLedgerEvent & { type: T }));
}
const received = (f: ProjectFixture): CoordinatorEvent[] => payloads(f, 'coordinator-event');
const notices = (f: ProjectFixture) => payloads(f, 'notice').map((data) => data.text);
const ledgerTypes = (f: ProjectFixture) => f.app.projectWork.coordinatorLedger(f.project.id).events().map((event) => event.type);
const state = (f: ProjectFixture, threadId: string, wanted: string) => f.waitFor(() => f.thread(threadId).state, (value) => value === wanted);

/** The coordinator chat stream as raw SSE text, read until the frame with id `last`; every frame must be exactly id, event and data. */
async function stream(f: ProjectFixture, last: number, headers: Record<string, string> = {}): Promise<{ text: string; frames: ProjectEventFrame[] }> {
  const abort = new AbortController();
  const response = await fetch(`${f.base}${route(f, '/coordinator/events')}`, { headers: { Cookie: f.cookie, ...headers }, signal: abort.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); const frames: ProjectEventFrame[] = [];
  let text = ''; let consumed = 0;
  try {
    while (frames.at(-1)?.event.id !== last) {
      const chunk = await reader.read(); if (chunk.done) throw new Error('The stream ended early.');
      text += decoder.decode(chunk.value, { stream: true });
      for (let end = text.indexOf('\n\n', consumed); end >= 0; end = text.indexOf('\n\n', consumed)) {
        const block = text.slice(consumed, end); consumed = end + 2;
        if (block === ': keepalive') continue;
        const match = /^id: (\d+)\nevent: project\ndata: (.+)$/.exec(block); expect(match, block).not.toBeNull();
        const frame = ProjectEventFrameSchema.parse(JSON.parse(match![2]!)); expect(frame.event.id).toBe(Number(match![1])); frames.push(frame);
      }
    }
  } finally { abort.abort(); }
  return { text, frames };
}

test('PJ2 one owner message starts two threads and the publications arrive batched', { timeout: 120_000 }, async () => {
  const f = await setup({ coordinator: true }); const pid = f.project.id;
  const bothInReview = deferred(); const starts: unknown[] = [];
  // Coordinator turn 1 starts both threads and stays open until both pull requests are open, so their publications batch.
  f.fake.enqueueTurn(async (turn) => {
    starts.push(await turn.bridge('jevellan_thread_start', { title: 'Add A', task: 'Create a.txt.' }));
    starts.push(await turn.bridge('jevellan_thread_start', { title: 'Fix B', task: 'Create b.txt.' }));
    await Promise.race([bothInReview.promise, aborted(turn.signal)]);
    turn.say('Started two threads.'); return { status: 'completed' };
  }, forCoordinator);
  f.fake.enqueueTurn(say('Both pull requests are open.'), forCoordinator);
  f.fake.enqueueTurn(commitStep({ 'a.txt': 'a\n' }, { status: 'done', summary: 'Created a.txt.' }), forThread((input) => input.prompt.startsWith('Task: Add A')));
  f.fake.enqueueTurn(commitStep({ 'b.txt': 'b\n' }, { status: 'done', summary: 'Created b.txt.' }), forThread((input) => input.prompt.startsWith('Task: Fix B')));

  expect(await post(f, 'msg_pj2', 'add A and fix B')).toBe(false);
  const ids = await f.waitFor(() => f.app.projectWork.paths.threadIds(pid), (value) => value.length === 2);
  await f.waitFor(async () => Promise.all(ids.map((id) => f.index(id))), (indexes) => indexes.every((index) => index?.state === 'in-review'));
  // Both publications are queued for the coordinator before the turn ends (the index can publish before the event is enqueued).
  await f.waitFor(() => f.coordinatorState().queue.filter((event) => event.kind === 'thread-published').length, (count) => count === 2);
  bothInReview.resolve(); await idle(f);

  const byTitle = new Map(ids.map((id) => [f.thread(id).title, id])); const idA = byTitle.get('Add A')!; const idB = byTitle.get('Fix B')!;
  expect(starts).toEqual([{ schema: 'thread-start-result-v1', threadId: idA, state: 'preparing', placement: expect.stringMatching(/^Scripted test runtime Fixture · high · Worktree · /) },
    { schema: 'thread-start-result-v1', threadId: idB, state: 'preparing', placement: expect.stringMatching(/^Scripted test runtime Fixture · high · Worktree · /) }]);
  for (const id of [idA, idB]) expect(f.thread(id)).toMatchObject({ createdBy: 'coordinator', state: 'in-review' });

  // 1-3. Two coordinator turns: the first read-only with the fresh context, the second resumes it with exactly the two publications.
  const [first, second] = coordinatorTurns(f);
  expect(coordinatorTurns(f)).toHaveLength(2);
  expect(first).toMatchObject({ owner: { kind: 'coordinator', projectId: pid, id: pid }, turn: 1, permissions: 'read-only', safetyProfile: 'coordinator', cwd: f.checkout,
    systemAppend: coordinatorSystemAppend('Shop') });
  expect(first!.resume).toBeUndefined();
  expect(first!.prompt).toMatch(clocked('Project notebook:\n(empty)\n\nActive threads:\n(none)\n\nOpen questions to the owner:\n(none)\n\nRecent conversation with the owner:\n(none)\n\nEvents since your last turn:\n[owner HH:MM] add A and fix B'));
  expect(second!.resume).toEqual({ sessionId: sessionOf(f, first!).sessionId });
  const pr = async (id: string) => (await f.index(id))!.pr!.number;
  const [lineA, lineB] = [`[thread "Add A" (${idA})] Pull request #${await pr(idA)} opened.`, `[thread "Fix B" (${idB})] Pull request #${await pr(idB)} opened.`];
  const [header, ...lines] = second!.prompt.split('\n');
  expect(header).toBe('Events since your last turn:'); expect(lines).toHaveLength(2); expect(new Set(lines)).toEqual(new Set([lineA, lineB]));
  expect([await pr(idA), await pr(idB)].sort()).toEqual([1, 2]);

  // 4. The chat: the owner message, two start lines, both publications received during turn 1, both replies and completed ends.
  expect(ledgerTypes(f)).toEqual(['coordinator-event', 'coordinator-turn-start', 'coordinator-tool', 'coordinator-tool', 'coordinator-event', 'coordinator-event', 'coordinator-text',
    'coordinator-turn-end', 'coordinator-turn-start', 'coordinator-text', 'coordinator-turn-end']);
  expect(payloads(f, 'coordinator-tool')).toEqual([
    { schema: 'coordinator-tool-v1', tool: 'jevellan_thread_start', ok: true, summary: expect.stringMatching(/^Started "Add A" · Scripted test runtime Fixture · high · Worktree · /), threadId: idA },
    { schema: 'coordinator-tool-v1', tool: 'jevellan_thread_start', ok: true, summary: expect.stringMatching(/^Started "Fix B" · Scripted test runtime Fixture · high · Worktree · /), threadId: idB }]);
  expect(payloads(f, 'coordinator-text').map((data) => data.text)).toEqual(['Started two threads.', 'Both pull requests are open.']);
  expect(payloads(f, 'coordinator-turn-end')).toEqual([{ schema: 'coordinator-turn-end-v1', turn: 1, status: 'completed' }, { schema: 'coordinator-turn-end-v1', turn: 2, status: 'completed' }]);
  const events = received(f);
  expect(events[0]).toMatchObject({ kind: 'user-message', clientMessageId: 'msg_pj2', text: 'add A and fix B' });
  expect(new Set(events.slice(1).map((event) => event.kind === 'thread-published' ? `${event.threadId}:${event.result}:${event.prNumber}` : event.kind)))
    .toEqual(new Set([`${idA}:pr-opened:${await pr(idA)}`, `${idB}:pr-opened:${await pr(idB)}`]));
  expect(payloads(f, 'coordinator-turn-start').map((data) => [data.turn, data.fresh, data.eventIds])).toEqual([[1, true, [events[0]!.id]], [2, false, events.slice(1).map((event) => event.id)]]);

  // 5. coordinator.json and the hub status.
  expect(f.coordinatorState()).toMatchObject({ state: 'idle', queue: [], failedTurnsInARow: 0, session: { turns: 2 } });
  expect((await f.app.projectHub.coordinatorStatus(pid))?.document).toMatchObject({ state: 'idle', failedTurnsInARow: 0, session: { turns: 2 } });

  // 6. The chat stream: ledger ids in order, resumable by Last-Event-ID, cursor refusals, the session required, no native session id.
  const ledger = f.app.projectWork.coordinatorLedger(pid); const all = ledger.events(); const last = all.at(-1)!.id;
  const whole = await stream(f, last);
  expect(whole.frames.map((frame) => frame.event.id)).toEqual(all.map((event) => event.id));
  expect(whole.frames.map((frame) => frame.event.type)).toEqual(ledgerTypes(f));
  const resumed = await stream(f, last, { 'Last-Event-ID': '4' });
  expect(resumed.frames.map((frame) => frame.event.id)).toEqual(all.slice(4).map((event) => event.id));
  expect(await call(f, route(f, '/coordinator/events?after=999999'), 'GET', undefined, 400)).toEqual(refused('request-failed', EVENT_CURSOR_AHEAD));
  expect((await fetch(`${f.base}${route(f, '/coordinator/events')}`)).status).toBe(401);
  // Neither coordinator session nor either thread session appears in any frame.
  const sessions = Object.values(f.runtimes).flatMap((runtime) => runtime.runs.map((run) => run.native.sessionId ?? ''));
  expect(sessions).toHaveLength(4); expect(sessions).toEqual(expect.arrayContaining([sessionOf(f, first!).sessionId, sessionOf(f, second!).sessionId]));
  for (const id of sessions) { expect(id.length).toBeGreaterThanOrEqual(16); expect(whole.text + resumed.text).not.toContain(id); }

  // 7. The project view.
  const view = await work(f);
  expect(view.coordinator).toMatchObject({ state: 'idle', deviceId: f.app.device.deviceId, session: { turns: 2 } });
  expect(view.threads.map((thread) => [thread.id, thread.state]).sort()).toEqual([[idA, 'in-review'], [idB, 'in-review']].sort());
  expect(view.pullRequests).toHaveLength(2);
  expect(view.pullRequests.map((entry) => [entry.threadId, entry.pr?.number]).sort()).toEqual([[idA, await pr(idA)], [idB, await pr(idB)]].sort());
  expect(view.lastEventId).toBe(last);
});

test('PJ2b a needs-decision report becomes an owner question and the answer reaches the thread', { timeout: 120_000 }, async () => {
  const f = await setup({ coordinator: true });
  const question = 'Which database should Store data use?';
  let threadId = ''; const results: unknown[] = [];
  // One coordinator script for every turn, chosen by the events it receives (batching decides which turn sees what).
  const coordinate: FakeTurnStep = async (turn) => {
    const events = turn.input.prompt.slice(turn.input.prompt.indexOf('Events since your last turn:'));
    if (events.includes('[owner answered]')) {
      results.push(await turn.bridge('jevellan_thread_message', { threadId, message: 'Use SQLite.' })); turn.say('Told Store data to use SQLite.');
    } else if (events.includes('reported needs-decision]')) {
      results.push(await turn.bridge('jevellan_ask_user', { question, options: [{ label: 'SQLite', detail: 'Single file' }, { label: 'Postgres' }], threadId }));
      turn.say('Asked you which database to use.');
    } else if (/\[owner \d{2}:\d{2}\]/.test(events)) {
      const started = await turn.bridge('jevellan_thread_start', { title: 'Store data', task: 'Store the data.' }) as { threadId: string };
      threadId = started.threadId; results.push(started); turn.say('Started Store data.');
    } else turn.say('Noted.');
    return { status: 'completed' };
  };
  for (let n = 0; n < 8; n += 1) f.fake.enqueueTurn(coordinate, forCoordinator);
  f.fake.enqueueTurn(reportStep({ status: 'needs-decision', summary: 'Need a database choice.', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }),
    forThread((input) => input.prompt.startsWith('Task: Store data')));
  f.fake.enqueueTurn(commitStep({ 'store.txt': 'sqlite\n' }, { status: 'done', summary: 'Stored the data in SQLite.' }), forThread((input) => input.prompt === 'Use SQLite.'));

  expect(await post(f, 'msg_pj2b', 'Store the data.')).toBe(false);
  const asked = await f.waitFor(async () => (await work(f)).decisions.open, (open) => open.length === 1);
  await idle(f);
  // The thread waits for the owner with the first line of its question; the coordinator received exactly its report and asked.
  expect(f.thread(threadId)).toMatchObject({ state: 'waiting-for-you', stateReason: 'Which database?', turns: 1 });
  expect(coordinatorTurns(f)).toHaveLength(2);
  expect(coordinatorTurns(f)[1]!.prompt).toBe(`Events since your last turn:\n[thread "Store data" (${threadId}) reported needs-decision] Need a database choice.\nQuestion: Which database?\nOptions: SQLite; Postgres`);
  const decisionId = asked[0]!.id;
  expect(asked[0]).toMatchObject({ from: 'coordinator', threadId, question, options: [{ label: 'SQLite', detail: 'Single file' }, { label: 'Postgres' }] });
  expect(results[1]).toEqual({ schema: 'ask-user-result-v1', decisionId });

  // The owner answers with an option; a retry repeats without a second event; another answer is refused.
  const path = route(f, `/decisions/${decisionId}/answer`);
  expect(DecisionAnsweredViewSchema.parse(await call(f, path, 'POST', answer('ans_1', 'SQLite'), 202))).toEqual({ schema: 'decision-answered-view-v1', repeated: false });
  expect(await call(f, path, 'POST', answer('ans_1', 'SQLite'), 202)).toEqual({ schema: 'decision-answered-view-v1', repeated: true });
  expect(await call(f, path, 'POST', answer('ans_2', 'Postgres'), 409)).toEqual(refused('conflict', 'This question was already answered.'));
  await state(f, threadId, 'in-review'); await idle(f);

  // The coordinator's next turn holds the exact answer line and messages the thread, which resumes its session and finishes.
  const answeredTurn = coordinatorTurns(f)[2]!;
  expect(answeredTurn.prompt).toBe(`Events since your last turn:\n[owner answered] "${question}" → SQLite`);
  // The state is read after the turn was handed to the runner chain, so it may already read `running`.
  expect(results[2]).toEqual({ schema: 'thread-message-result-v1', threadId, state: expect.stringMatching(/^(waiting-for-you|running)$/), delivery: 'started' });
  const [turnOne, turnTwo] = threadTurns(f, threadId);
  expect(threadTurns(f, threadId)).toHaveLength(2);
  expect(turnTwo).toMatchObject({ prompt: 'Use SQLite.', resume: { sessionId: sessionOf(f, turnOne!).sessionId } });
  expect(f.thread(threadId)).toMatchObject({ state: 'in-review', lastReport: { status: 'done', summary: 'Stored the data in SQLite.', synthesized: false } });
  expect(received(f).filter((event) => event.kind === 'decision-answer')).toEqual([expect.objectContaining({ id: derivedId('cev', 'answer', decisionId), decisionId, threadId, question,
    answer: { optionLabel: 'SQLite' } })]);
  expect(received(f).filter((event) => event.kind === 'thread-published')).toEqual([expect.objectContaining({ threadId, result: 'pr-opened', prNumber: 1 })]);
  expect(coordinatorTurns(f)).toHaveLength(4);
  expect(coordinatorTurns(f)[3]!.prompt).toBe(`Events since your last turn:\n[thread "Store data" (${threadId})] Pull request #1 opened.`);
  expect(f.coordinatorState()).toMatchObject({ state: 'idle', queue: [], failedTurnsInARow: 0 });
  const view = await work(f);
  expect(view.decisions.open).toEqual([]);
  expect(view.decisions.answered).toEqual([expect.objectContaining({ id: decisionId, answer: { optionLabel: 'SQLite' } })]);
  expect(payloads(f, 'coordinator-tool').map((line) => [line.tool, line.ok])).toEqual([['jevellan_thread_start', true], ['jevellan_ask_user', true], ['jevellan_thread_message', true]]);
  expect(payloads(f, 'coordinator-tool')[1]).toEqual({ schema: 'coordinator-tool-v1', tool: 'jevellan_ask_user', ok: true, summary: `Asked you: ${question}`, threadId, decisionId });
});

test('PJ2c without a coordinator account the thread question goes to the owner directly', { timeout: 120_000 }, async () => {
  const f = await setup({ coordinatorAccountless: true }); const pid = f.project.id;
  const reason = noCoordinatorAccount(f.deviceName);
  expect(reason).toBe(`No account can run the coordinator model on ${f.deviceName}.`);
  f.fake.enqueueTurn(reportStep({ status: 'needs-decision', summary: 'Need a database choice.', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }),
    forThread((input) => input.prompt.startsWith('Task: Store data')));
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Using SQLite.' }), forThread((input) => input.prompt === 'SQLite'));

  // Two messages: the coordinator is unavailable for lack of an account, said once in the chat.
  expect(await post(f, 'msg_c1', 'Store the data.')).toBe(false); expect(await post(f, 'msg_c2', 'Keep it small.')).toBe(false);
  await idle(f);
  expect(f.coordinatorState()).toMatchObject({ state: 'unavailable', unavailableReason: reason });
  expect(notices(f)).toEqual([coordinatorUnavailableNotice(reason)]);
  expect(notices(f)).toEqual([`The coordinator cannot run: No account can run the coordinator model on ${f.deviceName}.`]);
  expect((await work(f)).coordinator).toMatchObject({ state: 'unavailable', unavailableReason: reason });
  expect((await f.app.projectHub.coordinatorStatus(pid))?.document).toMatchObject({ state: 'unavailable', unavailableReason: reason });

  // The owner's thread asks a question: with no coordinator, the item comes from the thread itself (decision 7).
  const threadId = await startThread(f, 'Store data', 'Store the data.');
  await state(f, threadId, 'waiting-for-you');
  const open = await f.waitFor(async () => (await work(f)).decisions.open, (items) => items.length === 1);
  const report = received(f).find((event) => event.kind === 'thread-report')!;
  expect(open[0]).toMatchObject({ id: derivedId('pdec', 'fallback', report.id), from: 'thread', threadId, question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] });
  expect(f.thread(threadId).placement).toMatchObject({ runtime: 'fake', modelId: 'fixture' });

  // Answering with an option reaches the thread as the owner's message, which the coordinator queue also records.
  expect(await call(f, route(f, `/decisions/${open[0]!.id}/answer`), 'POST', answer('ans_c', 'SQLite'), 202)).toEqual({ schema: 'decision-answered-view-v1', repeated: false });
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 2); await idle(f);
  expect(threadTurns(f, threadId).map((input) => input.prompt)).toEqual([expect.stringMatching(/^Task: Store data\n\nStore the data\./), 'SQLite']);
  expect(f.coordinatorState().queue.map((event) => event.kind)).toEqual(['user-message', 'user-message', 'thread-user-message', 'thread-report', 'thread-user-message', 'thread-report']);
  expect(f.coordinatorState().queue[4]).toMatchObject({ kind: 'thread-user-message', threadId, text: 'SQLite' });
  // Nothing ran on the coordinator runtime, and the reason was told once however many events arrived and sweeps ran.
  await f.app.projectWork.pulse(); await idle(f);
  expect(coordinatorTurns(f)).toEqual([]); expect(f.runtimes.fake2!.turnStarts).toEqual([]);
  expect(notices(f)).toEqual([coordinatorUnavailableNotice(reason)]);
  expect((await work(f)).decisions.open).toEqual([]);
});

test('PJ2c after two failed turns the coordinator waits for a message, and thread questions go to the owner directly meanwhile', { timeout: 120_000 }, async () => {
  const f = await setup({ coordinator: true });
  f.fake.enqueueTurn(fail('Model overloaded.'), forCoordinator); f.fake.enqueueTurn(fail('Model overloaded.'), forCoordinator);
  f.fake.enqueueTurn(reportStep({ status: 'needs-decision', summary: 'Need a database choice.', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }),
    forThread((input) => input.prompt.startsWith('Task: Store data')));

  expect(await post(f, 'msg_f1', 'Plan the release.')).toBe(false);
  await idle(f);
  expect(coordinatorTurns(f)).toHaveLength(2);
  expect(f.coordinatorState()).toMatchObject({ state: 'idle', failedTurnsInARow: 2 });
  expect(notices(f)).toEqual([coordinatorFailedTwiceNotice('Model overloaded.')]);
  expect(notices(f)).toEqual(['The coordinator failed twice: Model overloaded. Send a message to try again.']);
  expect(payloads(f, 'coordinator-turn-end').map((data) => data.status)).toEqual(['failed', 'failed']);

  // Owner work is not a message to the coordinator: no third turn, and the thread's question goes to the owner directly.
  const threadId = await startThread(f, 'Store data', 'Store the data.');
  await state(f, threadId, 'waiting-for-you');
  const open = await f.waitFor(async () => (await work(f)).decisions.open, (items) => items.length === 1);
  await idle(f);
  expect(coordinatorTurns(f)).toHaveLength(2);
  const report = received(f).find((event) => event.kind === 'thread-report')!;
  expect(open[0]).toMatchObject({ id: derivedId('pdec', 'fallback', report.id), from: 'thread', threadId, question: 'Which database?' });

  // A new owner message runs a successful turn with everything queued; the count resets.
  f.fake.enqueueTurn(say('Back on track.'), forCoordinator);
  expect(await post(f, 'msg_f2', 'Try again.')).toBe(false);
  await idle(f);
  expect(coordinatorTurns(f)).toHaveLength(3);
  const prompt = coordinatorTurns(f)[2]!.prompt;
  for (const line of [/\[owner \d{2}:\d{2}\] Plan the release\.\n/, new RegExp(escape(`[owner started thread "Store data" (${threadId})] Store the data.`)),
    new RegExp(escape(`[thread "Store data" (${threadId}) reported needs-decision] Need a database choice.\nQuestion: Which database?\nOptions: SQLite; Postgres (Jevellan asked the owner directly.)`)),
    /\[owner \d{2}:\d{2}\] Try again\.$/]) expect(prompt).toMatch(line);
  expect(f.coordinatorState()).toMatchObject({ state: 'idle', failedTurnsInARow: 0, queue: [] });
  expect(payloads(f, 'coordinator-turn-end').map((data) => data.status)).toEqual(['failed', 'failed', 'completed']);
});

test('PJ2c without a model that runs read-only turns the coordinator is unavailable with the capability reason', { timeout: 60_000 }, async () => {
  const f = await setup();
  expect(await post(f, 'msg_cap', 'Hello.')).toBe(false); await idle(f);
  const reason = noCoordinatorModel(f.deviceName);
  expect(reason).toBe(`No enabled model can run the coordinator on ${f.deviceName}.`);
  expect(f.coordinatorState()).toMatchObject({ state: 'unavailable', unavailableReason: reason });
  expect(notices(f)).toEqual([coordinatorUnavailableNotice(reason)]);
  expect(coordinatorTurns(f)).toEqual([]);
});

test('PJ2d the coordinator rotates its session at 40 turns and on Fresh coordinator session', { timeout: 120_000 }, async () => {
  const menu = [...FIXTURE_MENU, { id: 'fixture-alt', runtime: 'fake', model: 'scripted-model', label: 'Fixture alt', description: 'Another simulated model.', efforts: ['high' as const], enabled: true }];
  const f = await setup({ coordinator: true, menu }); const pid = f.project.id;
  let threadId = '';
  f.fake.enqueueTurn(async (turn) => {
    await turn.bridge('jevellan_ask_user', { question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] });
    threadId = (await turn.bridge('jevellan_thread_start', { title: 'Store data', task: 'Draft the storage schema.' }) as { threadId: string }).threadId;
    turn.say('Started Store data and asked about the database.'); return { status: 'completed' };
  }, forCoordinator);
  f.fake.enqueueTurn(say('Noted.'), forCoordinator);
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Schema drafted.' }), forThread((input) => input.prompt.startsWith('Task: Store data')));
  await post(f, 'msg_d1', 'Plan storage.');
  await f.waitFor(() => threadId && f.thread(threadId).lastReport?.summary, (summary) => summary === 'Schema drafted.');
  await f.waitFor(() => coordinatorTurns(f).length, (count) => count === 2); await idle(f);
  expect(f.thread(threadId)).toMatchObject({ state: 'idle' });
  expect(f.coordinatorState()).toMatchObject({ state: 'idle', queue: [], session: { turns: 2 } });
  expect(ProjectNotebookViewSchema.parse(await call(f, route(f, '/notebook'), 'PUT', { schema: 'notebook-request-v1', expectedRevision: 0, content: 'Prefer SQLite.' }, 200)).revision).toBe(1);
  const old = f.coordinatorState().session!;

  // 40 turns in the stored session: after a restart the next turn starts a fresh session with the fresh context.
  await f.restart(() => {
    writeDocument(f.app.projectWork.paths.coordinator(pid), CoordinatorStateSchema, { ...f.coordinatorState(), session: { ...old, turns: 40 } });
  });
  expect(f.coordinatorState().session).toMatchObject({ turns: 40, nativeSessionId: old.nativeSessionId });
  const next = async (clientMessageId: string, text: string): Promise<TurnInput> => {
    f.fake.enqueueTurn(say('Okay.'), forCoordinator); await post(f, clientMessageId, text); await idle(f);
    return coordinatorTurns(f).at(-1)!;
  };
  // Notebook, active threads and open questions: the part of the fresh context that does not depend on the recap.
  const context = `Project notebook:\nPrefer SQLite.\n\nActive threads:\n- Store data (${threadId}): idle, worktree, Scripted test runtime Fixture high on ${f.deviceName}. Last report: Schema drafted.\n\nOpen questions to the owner:\n- Which database?\n\nRecent conversation with the owner:\n`;
  const rotated = await next('msg_d2', 'What next?');
  expect(rotated.resume).toBeUndefined();
  expect(rotated.prompt).toMatch(clocked(`${context}Owner: Plan storage.\n\nYou: Started Store data and asked about the database.\n\nYou: Noted.\n\nEvents since your last turn:\n[owner HH:MM] What next?`));
  expect(f.coordinatorState().session).toMatchObject({ turns: 1, modelId: 'fixture' });
  expect(f.coordinatorState().session!.nativeSessionId).not.toBe(old.nativeSessionId);
  expect(payloads(f, 'coordinator-turn-start').at(-1)).toMatchObject({ turn: 3, fresh: true, modelLabel: 'Fixture' });

  // A normal turn resumes the new session and sends only the events.
  const resumed = await next('msg_d3', 'Go on.');
  expect(resumed.resume).toEqual({ sessionId: sessionOf(f, rotated).sessionId });
  expect(resumed.prompt).toMatch(clocked('Events since your last turn:\n[owner HH:MM] Go on.'));

  // Fresh coordinator session: the next turn starts over with the fresh context.
  expect(ProjectWorkViewSchema.parse(await call(f, route(f, '/coordinator/fresh'), 'POST', { schema: 'empty-request-v1' }, 202)).coordinator.session).toBeNull();
  const fresh = await next('msg_d4', 'Start over.');
  expect(fresh.resume).toBeUndefined(); expect(fresh.prompt.startsWith(context)).toBe(true);
  expect(fresh.prompt).toMatch(/\n\nEvents since your last turn:\n\[owner \d{2}:\d{2}\] Start over\.$/);
  expect((await next('msg_d5', 'Carry on.')).resume).toEqual({ sessionId: sessionOf(f, fresh).sessionId });

  // Another coordinator model in the work settings: a fresh session on that model.
  const current = await f.json(route(f, '/work-settings'), ProjectWorkSettingsViewSchema);
  const settings: Record<string, unknown> = { ...current.settings, coordinator: { ...current.settings.coordinator, modelId: 'fixture-alt' } };
  for (const key of ['schema', 'projectId', 'revision']) delete settings[key];
  await f.json(route(f, '/work-settings'), ProjectWorkSettingsViewSchema, 'PUT', { schema: 'project-work-settings-request-v1', revision: current.settings.revision, settings });
  const switched = await next('msg_d6', 'Use the other model.');
  expect(switched.resume).toBeUndefined(); expect(switched.prompt.startsWith(context)).toBe(true);
  expect(f.coordinatorState().session).toMatchObject({ modelId: 'fixture-alt', turns: 1 });
  expect(payloads(f, 'coordinator-turn-start').map((data) => [data.turn, data.fresh, data.modelLabel])).toEqual([[1, true, 'Fixture'], [2, false, 'Fixture'], [3, true, 'Fixture'],
    [4, false, 'Fixture'], [5, true, 'Fixture'], [6, false, 'Fixture'], [7, true, 'Fixture alt']]);
});

test('PJ2e coordinator messages are idempotent by client id', { timeout: 120_000 }, async () => {
  const f = await setup({ coordinator: true });
  const gate = deferred();
  f.fake.enqueueTurn(holdStep(gate.promise, async (turn) => { turn.say('Adding a changelog.'); }), forCoordinator);
  const body = message('msg_pj2e', 'Add a changelog.');
  // While queued or running, after delivery, and after a restart: the same message repeats; other text under its id is refused.
  const repeatChecks = async () => {
    expect(await call(f, route(f, '/coordinator/messages'), 'POST', body, 202)).toEqual({ schema: 'coordinator-message-receipt-v1', repeated: true });
    expect(await call(f, route(f, '/coordinator/messages'), 'POST', { ...body, text: 'Add a readme.' }, 409)).toEqual(refused('conflict', MESSAGE_ID_REUSED));
  };
  expect(await post(f, 'msg_pj2e', 'Add a changelog.')).toBe(false);
  await repeatChecks();
  gate.resolve(); await idle(f);
  await repeatChecks();
  await f.restart(); await idle(f);
  await repeatChecks(); await idle(f);
  expect(MESSAGE_ID_REUSED).toBe('This message id was already used for different content.');
  expect(received(f).filter((event) => event.kind === 'user-message' && event.clientMessageId === 'msg_pj2e')).toHaveLength(1);
  expect(coordinatorTurns(f)).toHaveLength(1);
  expect(coordinatorTurns(f)[0]!.prompt.match(/\] Add a changelog\./g)).toHaveLength(1);
  expect(f.coordinatorState()).toMatchObject({ state: 'idle', queue: [], session: { turns: 1 } });
  expect(payloads(f, 'coordinator-turn-start')).toHaveLength(1);
});

test('a restart drops the running coordinator turn; its events stay queued and the next turn delivers them with the thread interruption (brief 8.6)', { timeout: 120_000 }, async () => {
  const f = await setup({ coordinator: true }); const pid = f.project.id;
  let threadId = ''; const opened = deferred();
  f.fake.enqueueTurn(async (turn) => {
    threadId = (await turn.bridge('jevellan_thread_start', { title: 'Add cache', task: 'Add the cache.' }) as { threadId: string }).threadId;
    opened.resolve(); await aborted(turn.signal); return { status: 'completed' };
  }, forCoordinator);
  f.fake.enqueueTurn(holdStep(never()), forThread((input) => input.prompt.startsWith('Task: Add cache')));
  expect(await post(f, 'msg_restart', 'Build the cache.')).toBe(false);
  await opened.promise;
  await state(f, threadId, 'running'); await f.waitFor(() => threadTurns(f, threadId).length, (count) => count === 1);
  await f.waitFor(() => f.coordinatorState().state, (value) => value === 'running');
  const queued = f.coordinatorState().queue.map((event) => event.id);
  expect(queued).toHaveLength(1);
  const coordinatorGroup = sessionOf(f, coordinatorTurns(f)[0]!); const threadGroup = sessionOf(f, threadTurns(f, threadId)[0]!);
  expect(groupAlive(coordinatorGroup.pgid)).toBe(true);
  // The next turn's script is in place before the daemon starts again, because the start runs the queue at once.
  f.fake.enqueueTurn(say('Add cache was interrupted; I will resume it.'), forCoordinator);

  await f.restart();
  await f.waitFor(() => coordinatorTurns(f).length, (count) => count === 2); await idle(f);
  // The dropped turn's processes are gone; the thread rests with the restart reason and no thread turn was launched.
  expect(groupAlive(coordinatorGroup.pgid)).toBe(false); expect(groupAlive(threadGroup.pgid)).toBe(false);
  expect(f.thread(threadId)).toMatchObject({ state: 'idle', stateReason: RESTARTED });
  expect(threadTurns(f, threadId)).toHaveLength(1);
  // The ledger shows the dropped turn; the next turn delivers the undelivered message and the interruption, in a normal turn.
  const interrupted = received(f).find((event) => event.kind === 'thread-interrupted')!;
  expect(interrupted).toMatchObject({ threadId, reason: 'restart', message: RESTARTED });
  expect(payloads(f, 'coordinator-turn-end')).toEqual([{ schema: 'coordinator-turn-end-v1', turn: 1, status: 'dropped' }, { schema: 'coordinator-turn-end-v1', turn: 2, status: 'completed' }]);
  expect(payloads(f, 'coordinator-turn-start').map((data) => [data.turn, data.eventIds])).toEqual([[1, queued], [2, [...queued, interrupted.id]]]);
  const next = coordinatorTurns(f)[1]!;
  // A normal new turn: the dropped turn's session carries on, and the turn sends the undelivered events.
  expect(next.resume).toEqual({ sessionId: coordinatorGroup.sessionId });
  expect(next.prompt).toMatch(clocked(`Events since your last turn:\n[owner HH:MM] Build the cache.\n[thread "Add cache" (${threadId}) interrupted: restart] ${RESTARTED}`));
  expect(f.coordinatorState()).toMatchObject({ state: 'idle', queue: [], failedTurnsInARow: 0 });
  expect(f.app.projectWork.coordinators.store.local(pid).process).toBeUndefined();
  expect((await f.app.projectHub.coordinatorStatus(pid))?.document).toMatchObject({ state: 'idle' });
  expect(payloads(f, 'coordinator-text').map((data) => data.text)).toEqual(['Add cache was interrupted; I will resume it.']);
});
