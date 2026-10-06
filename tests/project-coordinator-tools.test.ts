// The coordinator's bridge tools (brief 7.1, 8.1, 9.5, 12.2; design 3.2 g): every tool called through the daemon's own
// /api/bridge with the scoped token of a FakeRuntime coordinator turn, on a booted daemon with live git, the fake GitHub and
// simulated thread turns. Each call leaves one line in the coordinator chat; tokens die with their turn.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  CONCLUDED_WINDOW_MS, CoordinatorEventSchema, ProjectToolResultSchemas, ProjectWorkSettingsSchema, ThreadIndexSchema, concludedRecently, defaultProjectWorkSettings, projectToolNames,
  type ProjectLedgerData, type ProjectLedgerEvent, type ThreadIndex,
} from '../packages/core/dist/index.js';
import { HubProjectAccess } from '../packages/mesh/dist/index.js';
import { forCoordinator, forThread, type FakeTurn, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import {
  ASK_USER_OPTIONS, NO_PULL_REQUEST, QUESTION_NOT_FOUND, THREAD_ATTACHED, THREAD_ENDED, THREAD_NOT_FOUND, TOOL_NOT_IN_TURN,
  UNKNOWN_PLACEMENT_DEVICE, coordinatorToolSummary, firstSentence, notebookConflict, queuedReason, transcriptStaysOn,
} from '../packages/projects/dist/index.js';
import { commitStep, expectNoLeaks, holdStep, never, projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
/** Every bridge result and refusal the coordinator read, checked with the API responses for native session ids and tokens. */
let bridgeTexts: Array<[string, string]> = [];
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture, bridgeTexts); } finally { await fixture?.close(); fixture = undefined; bridgeTexts = []; }
});

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
type Refusal = { status: number; message: string };
type Tool = keyof typeof ProjectToolResultSchemas;
type ResultOf<N extends Tool> = ReturnType<(typeof ProjectToolResultSchemas)[N]['parse']>;
type Held = {
  turn: FakeTurn;
  /** A tool call that must succeed; returns its result document, checked against the tool's result schema. */
  call<N extends Tool>(name: N, args: unknown): Promise<ResultOf<N>>;
  /** A tool call that must fail: the HTTP status and the daemon's sentence. */
  refused(name: string, args: unknown): Promise<Refusal>;
  release(): void;
};
async function bridge(input: TurnInput, body: object): Promise<Response> {
  return fetch(new URL('/api/bridge', input.launch.env.JEVELLAN_DAEMON_URL), { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', ...body }) });
}
/** An owner message starts a coordinator turn that stays open until `release`, so the test can call tools with its token. */
async function hold(f: ProjectFixture, text: string): Promise<Held> {
  const opened = deferred<FakeTurn>(); const gate = deferred();
  f.fake.enqueueTurn(async (turn) => { opened.resolve(turn); await Promise.race([gate.promise, aborted(turn.signal)]); turn.say('Done for now.'); return { status: 'completed' }; }, forCoordinator);
  await f.app.projectWork.postMessage(f.project.id, { schema: 'coordinator-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text });
  const turn = await opened.promise;
  return {
    turn, release: () => gate.resolve(),
    call: async <N extends Tool>(name: N, args: unknown) => {
      const result = await turn.bridge(name, args); bridgeTexts.push([`bridge ${name}`, JSON.stringify(result)]);
      return ProjectToolResultSchemas[name].parse(result) as ResultOf<N>;
    },
    async refused(name, args) {
      const response = await bridge(turn.input, { operation: 'call', name, arguments: args });
      expect(response.ok, `${name} should be refused`).toBe(false);
      const text = await response.text(); bridgeTexts.push([`bridge ${name} ${response.status}`, text]);
      return { status: response.status, message: (JSON.parse(text) as { message: string }).message };
    },
  };
}
/** The next coordinator turns only acknowledge their events; their prompts are kept. */
function acknowledge(f: ProjectFixture, count: number): string[] {
  const prompts: string[] = [];
  for (let n = 0; n < count; n += 1) f.fake.enqueueTurn((turn) => { prompts.push(turn.input.prompt); turn.say('Noted.'); return { status: 'completed' }; }, forCoordinator);
  return prompts;
}
type ToolLine = ProjectLedgerData<'coordinator-tool'>;
function toolLines(f: ProjectFixture): ToolLine[] {
  const ledger = f.app.projectWork.coordinatorLedger(f.project.id);
  return ledger.events().filter((event) => event.type === 'coordinator-tool').map((event) => ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-tool' }));
}
const line = (tool: string, ok: boolean, summary: string | RegExp, ids: Partial<Pick<ToolLine, 'threadId' | 'decisionId' | 'reason'>> = {}) =>
  ({ schema: 'coordinator-tool-v1', tool, ok, summary: typeof summary === 'string' ? summary : expect.stringMatching(summary), ...ids });
const fieldSentence = (field: string) => new RegExp(`^${field}: .+\\. Check the tool input\\.$`);
async function index(f: ProjectFixture, threadId: string, accept: (value: ThreadIndex | undefined) => boolean): Promise<ThreadIndex> {
  return (await f.waitFor(() => f.index(threadId), accept))!;
}
const state = (f: ProjectFixture, threadId: string, wanted: string) => f.waitFor(() => f.thread(threadId).state, (value) => value === wanted);
function remoteIndex(over: Partial<ThreadIndex>): ThreadIndex {
  const at = new Date().toISOString();
  return ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id: 'thread_remote', projectId: 'project', title: 'Remote work', state: 'idle', isolation: 'worktree',
    ownerDeviceId: 'dev_other', runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture', turns: 2, createdAt: at, updatedAt: at, ...over });
}

test('thread tools start, list, read, message and stop as brief 7.1 says, refuse ended and attached threads, and leave one chat line per call', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  const placement = `Scripted test runtime Fixture · high · Worktree · ${f.deviceName} · placed without Jev: no key configured`;
  // Fix login holds its first turn until it is interrupted; Add docs reports progress at once.
  f.fake.enqueueTurn(holdStep(never()), forThread((input) => input.prompt.startsWith('Task: Fix login')));
  f.fake.enqueueTurn(async (turn) => { turn.say('Fixed the cookie path.'); await turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'Cookie path fixed.' }); return { status: 'completed' }; },
    forThread((input) => input.prompt.includes('Use the session cookie.')));
  f.fake.enqueueTurn(async (turn) => { turn.say(`${'x'.repeat(9000)}END`); await turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'Login remembers the user.' }); return { status: 'completed' }; },
    forThread((input) => input.prompt.includes('remember the user')));
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Docs outlined.' }), forThread((input) => input.prompt.startsWith('Task: Add docs')));
  // Another device's threads: an idle one, one that ended yesterday and one that ended fifteen days ago.
  const other = new HubProjectAccess(f.app.hub, 'dev_other'); const day = 24 * 60 * 60 * 1000;
  await other.publishThread(remoteIndex({}), 1);
  await other.publishThread(remoteIndex({ id: 'thread_recent', title: 'Recent work', state: 'done', endedAt: new Date(Date.now() - day).toISOString() }), 1);
  await other.publishThread(remoteIndex({ id: 'thread_old', title: 'Old work', state: 'done', endedAt: new Date(Date.now() - 15 * day).toISOString() }), 1);

  const c = await hold(f, 'Fix the login and write docs.');
  const token = c.turn.input.launch.env.JEVELLAN_STRETCH_TOKEN!;
  // The token lists exactly this scope's tools (D104); other scopes' tools are refused before any handler runs.
  expect(await c.turn.tools()).toEqual(projectToolNames({ kind: 'coordinator' }));
  for (const name of ['memory_write', 'jevellan_thread_report', 'jevellan_mail_inbox', 'jevellan_reserve', 'jevellan_handoff']) expect(await c.refused(name, {})).toEqual({ status: 403, message: TOOL_NOT_IN_TURN });

  // Start: zod errors are field sentences; a valid start answers after placement, preparation continues in the background.
  expect(await c.refused('jevellan_thread_start', { title: 'Fix login' })).toEqual({ status: 400, message: expect.stringMatching(fieldSentence('task')) });
  expect(await c.refused('jevellan_thread_start', { title: 'Fix login', task: 'Make the login form work.', note: 'n'.repeat(601) }))
    .toEqual({ status: 400, message: expect.stringMatching(fieldSentence('note')) });
  const startLogin = { title: 'Fix login', task: 'Make the login form work.', note: 'The owner asked for this first.' };
  const login = await c.call('jevellan_thread_start', startLogin);
  expect(login).toEqual({ schema: 'thread-start-result-v1', threadId: expect.stringMatching(/^thread_/), state: 'preparing', placement });
  expect(f.thread(login.threadId)).toMatchObject({ createdBy: 'coordinator', title: 'Fix login', placement: { fixed: [] } });
  // A retried call of the same turn (an MCP transport retry) gets the same thread, never a second one (D201).
  expect((await c.call('jevellan_thread_start', startLogin)).threadId).toBe(login.threadId);
  const docs = await c.call('jevellan_thread_start', { title: 'Add docs', task: 'Outline the docs.' });
  expect(f.app.projectWork.paths.threadIds(f.project.id).sort()).toEqual([login.threadId, docs.threadId].sort());
  await state(f, login.threadId, 'running'); await state(f, docs.threadId, 'idle');
  await index(f, login.threadId, (value) => value?.state === 'running'); await index(f, docs.threadId, (value) => value?.state === 'idle');

  // List: active threads by default; all adds threads concluded in the last 14 days.
  const row = (id: string, title: string, over: object) => ({ id, title, isolation: 'worktree', runtime: 'fake', modelLabel: 'Fixture', effort: 'high', ...over });
  const local = [row(login.threadId, 'Fix login', { state: 'running', device: f.deviceName, branch: f.thread(login.threadId).branch, turns: 0 }),
    row(docs.threadId, 'Add docs', { state: 'idle', device: f.deviceName, branch: f.thread(docs.threadId).branch, lastSummary: 'Docs outlined.', turns: 1 })];
  const remote = row('thread_remote', 'Remote work', { state: 'idle', device: 'dev_other', turns: 2 });
  const byId = (rows: Array<{ id: string }>) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const active = await c.call('jevellan_threads_list', {});
  expect(active.schema).toBe('threads-list-result-v1'); expect(byId(active.threads)).toEqual(byId([...local, remote]));
  expect(byId((await c.call('jevellan_threads_list', { include: 'all' })).threads)).toEqual(byId([...local, remote, row('thread_recent', 'Recent work', { state: 'done', device: 'dev_other', turns: 2 })]));

  // Message: a running thread queues it for the next turn, or is interrupted with it; an idle thread starts a turn now.
  expect(await c.call('jevellan_thread_message', { threadId: login.threadId, message: 'Check the cookie path.' }))
    .toEqual({ schema: 'thread-message-result-v1', threadId: login.threadId, state: 'running', delivery: 'queued' });
  expect(await c.call('jevellan_thread_message', { threadId: login.threadId, message: 'Use the session cookie.', interrupt: true }))
    .toEqual({ schema: 'thread-message-result-v1', threadId: login.threadId, state: 'running', delivery: 'interrupting' });
  await f.waitFor(() => f.thread(login.threadId), (thread) => thread.state === 'idle' && thread.turns === 2);
  const loginTurns = () => f.fake.turnStarts.filter((input) => input.owner.kind === 'thread' && input.owner.id === login.threadId);
  expect(loginTurns()[1]).toMatchObject({ turn: 2, resume: { sessionId: expect.any(String) }, prompt: 'From the coordinator:\nCheck the cookie path.\n\n---\n\nFrom the coordinator:\nUse the session cookie.' });
  const turnEnds = () => { const ledger = f.app.projectWork.ledgers.thread(f.project.id, login.threadId);
    return ledger.events().filter((event) => event.type === 'thread-turn-end').map((event) => ledger.payload(event as ProjectLedgerEvent & { type: 'thread-turn-end' }).status); };
  expect(turnEnds()).toEqual(['steered', 'completed']);
  expect(await c.call('jevellan_thread_message', { threadId: login.threadId, message: 'Now make it remember the user.' }))
    .toEqual({ schema: 'thread-message-result-v1', threadId: login.threadId, state: expect.stringMatching(/^(idle|running)$/), delivery: 'started' });
  await f.waitFor(() => f.thread(login.threadId), (thread) => thread.state === 'idle' && thread.turns === 3);

  // Read: the last reports, state and pull request; transcript adds the last 8,000 characters of assistant text.
  const summary = await c.call('jevellan_thread_read', { threadId: login.threadId });
  expect(summary).toMatchObject({ schema: 'thread-read-result-v1', threadId: login.threadId, state: 'idle' });
  expect(summary.reports.map((report) => [report.turn, report.summary])).toEqual([[2, 'Cookie path fixed.'], [3, 'Login remembers the user.']]);
  expect('transcript' in summary).toBe(false); expect('pr' in summary).toBe(false);
  const detailed = await c.call('jevellan_thread_read', { threadId: login.threadId, detail: 'transcript' });
  expect(detailed.transcript).toHaveLength(8000); expect(detailed.transcript?.endsWith('xEND')).toBe(true); expect(detailed.transcript).not.toContain('Fixed the cookie path.');
  // Another device's thread (D42): its index, the reports this coordinator received, and where the transcript stays.
  const remoteReport = { schema: 'thread-report-v1', turn: 2, status: 'progress', summary: 'Halfway there.', changedFiles: [], synthesized: false };
  f.app.projectWork.coordinators.get(f.project.id).enqueue(CoordinatorEventSchema.parse({ schema: 'coordinator-event-v1', kind: 'thread-report', id: 'cev_remote', at: new Date().toISOString(),
    threadId: 'thread_remote', report: remoteReport }));
  expect(await c.call('jevellan_thread_read', { threadId: 'thread_remote', detail: 'transcript' }))
    .toEqual({ schema: 'thread-read-result-v1', threadId: 'thread_remote', state: 'idle', reports: [remoteReport], transcript: null, transcriptNote: transcriptStaysOn('dev_other') });

  // Stop: the turn ends, the thread is stopped with the coordinator's reason, its worktree stays, and no event comes back (D28).
  expect(await c.call('jevellan_thread_stop', { threadId: login.threadId, reason: 'The owner changed plans.' }))
    .toEqual({ schema: 'thread-stop-result-v1', threadId: login.threadId, state: 'stopped' });
  expect(f.thread(login.threadId)).toMatchObject({ state: 'stopped', stateReason: 'The owner changed plans.' }); expect(existsSync(f.thread(login.threadId).cwd)).toBe(true);
  expect(f.coordinatorState().queue.filter((event) => event.kind === 'thread-interrupted')).toEqual([]);

  // Refusals: ended and attached threads (D81), unknown threads and questions about them.
  expect(await c.refused('jevellan_thread_message', { threadId: login.threadId, message: 'One more thing.' })).toEqual({ status: 409, message: THREAD_ENDED });
  f.app.projectWork.store.update(docs.threadId, (thread) => ({ ...thread, state: 'attached' }));
  expect(await c.refused('jevellan_thread_message', { threadId: docs.threadId, message: 'Add a section.' })).toEqual({ status: 409, message: THREAD_ATTACHED });
  // The terminal session ends: an attached thread holds its account, which the coordinator's next turn below uses too (phase 8).
  f.app.projectWork.store.update(docs.threadId, (thread) => ({ ...thread, state: 'idle' }));
  for (const [name, args] of [['jevellan_thread_message', { message: 'Hello.' }], ['jevellan_thread_read', {}], ['jevellan_thread_stop', { reason: 'Not needed.' }],
    ['jevellan_ask_user', { question: 'Which one?' }]] as const) {
    expect(await c.refused(name, { threadId: 'thread_missing', ...args })).toEqual({ status: 404, message: THREAD_NOT_FOUND });
  }

  // The chat lines, in call order (refusals before the scope checks leave none).
  const placementOf = (state: string) => `${state} "Fix login" · ${placement}`;
  expect(toolLines(f)).toEqual([
    line('jevellan_thread_start', false, /^Could not start "Fix login": task: .+\.$/),
    line('jevellan_thread_start', false, /^Could not start "Fix login": note: .+\.$/),
    line('jevellan_thread_start', true, placementOf('Started'), { threadId: login.threadId }),
    line('jevellan_thread_start', true, placementOf('Started'), { threadId: login.threadId }),
    line('jevellan_thread_start', true, `Started "Add docs" · ${placement}`, { threadId: docs.threadId }),
    line('jevellan_threads_list', true, 'Listed threads'),
    line('jevellan_threads_list', true, 'Listed threads'),
    line('jevellan_thread_message', true, 'Sent a message to "Fix login"', { threadId: login.threadId }),
    line('jevellan_thread_message', true, 'Sent a message to "Fix login" and interrupted its turn', { threadId: login.threadId }),
    line('jevellan_thread_message', true, 'Sent a message to "Fix login"', { threadId: login.threadId }),
    line('jevellan_thread_read', true, 'Read "Fix login"', { threadId: login.threadId }),
    line('jevellan_thread_read', true, 'Read "Fix login"', { threadId: login.threadId }),
    line('jevellan_thread_read', true, 'Read "Remote work"', { threadId: 'thread_remote' }),
    line('jevellan_thread_stop', true, 'Stopped "Fix login"', { threadId: login.threadId }),
    line('jevellan_thread_message', false, 'Could not send a message to "Fix login": This thread has ended.', { threadId: login.threadId }),
    line('jevellan_thread_message', false, 'Could not send a message to "Add docs": The thread is attached in a terminal.', { threadId: docs.threadId }),
    line('jevellan_thread_message', false, 'Could not send a message to "(unknown thread)": This thread was not found.'),
    line('jevellan_thread_read', false, 'Could not read "(unknown thread)": This thread was not found.'),
    line('jevellan_thread_stop', false, 'Could not stop "(unknown thread)": This thread was not found.'),
    line('jevellan_ask_user', false, 'Could not ask you: This thread was not found.'),
  ]);
  expect(f.ledgerText()).not.toContain(token); expect(f.ledgerText()).not.toContain(f.homes.at('worktrees'));

  // The turn ends: its token stops working at once, for listing and for calls.
  const prompts = acknowledge(f, 2);
  c.release(); await f.app.projectWork.idle(f.project.id);
  for (const body of [{ operation: 'list' }, { operation: 'call', name: 'jevellan_threads_list', arguments: {} }]) expect((await bridge(c.turn.input, body)).status).toBe(401);
  // The events that arrived during the turn come together in the next one, the remote report among them.
  expect(prompts).toHaveLength(1); expect(prompts[0]).toContain(`[thread "Add docs" (${docs.threadId}) reported progress] Docs outlined.`);
  expect(prompts[0]).toContain('[thread "Remote work" (thread_remote) reported progress] Halfway there.');
});

test('questions, the notebook with its revision conflict, pull request status, queued and refused starts, and owner work reaching the coordinator', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({ ...defaultProjectWorkSettings(f.project.id), maxRunningThreads: 1 }), 0);
  const cache = deferred();
  f.fake.enqueueTurn(commitStep({ 'cache.txt': 'cache\n' }, { status: 'done', summary: 'Cache added.' }, () => cache.promise), forThread((input) => input.prompt.startsWith('Task: Add cache')));
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Tests planned.' }), forThread((input) => input.prompt.startsWith('Task: Write tests')));
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Cache covered.' }), forThread((input) => input.prompt.endsWith('Cover the cache too.')));
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Changelog drafted.' }), forThread((input) => input.prompt.startsWith('Task: Owner task')));
  const c = await hold(f, 'Add a cache and tests for it.');

  // Starts: the second waits at the running limit (queued, not refused); a fixed choice that cannot be placed is refused.
  const added = await c.call('jevellan_thread_start', { title: 'Add cache', task: 'Add the cache.' });
  expect(added.state).toBe('preparing');
  const tests = await c.call('jevellan_thread_start', { title: 'Write tests', task: 'Write the cache tests.' });
  expect(tests).toMatchObject({ schema: 'thread-start-result-v1', state: 'queued', stateReason: queuedReason(1, null) });
  expect(await c.refused('jevellan_thread_start', { title: 'Elsewhere', task: 'Work on another device.', deviceId: 'dev_unknown' })).toEqual({ status: 409, message: UNKNOWN_PLACEMENT_DEVICE });
  cache.resolve();
  const opened = await index(f, added.threadId, (value) => value?.state === 'in-review');
  await state(f, tests.threadId, 'idle');

  // Pull request status is read fresh from GitHub, without waiting for a poll.
  expect(await c.call('jevellan_pr_status', { threadId: added.threadId })).toEqual({ schema: 'pr-status-result-v1', threadId: added.threadId, pr: expect.objectContaining({ number: 1, state: 'open', checks: 'none' }) });
  expect(opened.pr).toMatchObject({ number: 1, checks: 'none' });
  f.github.setChecks(1, 'failing');
  expect((await c.call('jevellan_pr_status', { threadId: added.threadId })).pr).toMatchObject({ number: 1, state: 'open', checks: 'failing' });
  expect(await c.call('jevellan_pr_status', { threadId: tests.threadId })).toEqual({ schema: 'pr-status-result-v1', threadId: tests.threadId, pr: null, reason: NO_PULL_REQUEST });

  // Questions: 0 or 2-4 options; the answer arrives later as an event; withdrawing an answered question does nothing.
  const question = 'Which database?\nPick one for the cache.';
  const asked = await c.call('jevellan_ask_user', { question, options: [{ label: 'SQLite' }, { label: 'Postgres', detail: 'Needs a server.' }], threadId: added.threadId });
  expect(asked).toEqual({ schema: 'ask-user-result-v1', decisionId: expect.stringMatching(/^pdec_/) });
  expect((await f.app.projectHub.decision(asked.decisionId))?.document).toMatchObject({ from: 'coordinator', threadId: added.threadId, question,
    options: [{ label: 'SQLite' }, { label: 'Postgres', detail: 'Needs a server.' }] });
  const options = (count: number) => Array.from({ length: count }, (_, n) => ({ label: `Option ${n + 1}` }));
  for (const count of [1, 5]) expect(await c.refused('jevellan_ask_user', { question: 'Pick one.', options: options(count) })).toEqual({ status: 400, message: `options: ${ASK_USER_OPTIONS} Check the tool input.` });
  const open = await c.call('jevellan_ask_user', { question: 'Should the cache expire?' });
  expect((await f.app.projectHub.decision(open.decisionId))?.document).toMatchObject({ from: 'coordinator', options: [] });
  expect(await c.call('jevellan_withdraw_question', { decisionId: open.decisionId, reason: 'The thread solved it.' }))
    .toEqual({ schema: 'withdraw-question-result-v1', decisionId: open.decisionId, withdrawn: true });
  expect((await f.app.projectHub.decision(open.decisionId))?.document.withdrawnAt).toBeDefined();
  await f.app.projectWork.decisions.answer(f.project.id, asked.decisionId, { clientRequestId: 'req_answer', optionLabel: 'SQLite' });
  expect(await c.call('jevellan_withdraw_question', { decisionId: asked.decisionId, reason: 'No longer needed.' }))
    .toEqual({ schema: 'withdraw-question-result-v1', decisionId: asked.decisionId, withdrawn: false });
  expect(await c.refused('jevellan_withdraw_question', { decisionId: 'pdec_missing', reason: 'Gone.' })).toEqual({ status: 404, message: QUESTION_NOT_FOUND });

  // Notebook: revisions, the conflict carries the current content (D59), and 64 KiB at most.
  expect(await c.call('jevellan_notebook_read', {})).toEqual({ schema: 'notebook-read-result-v1', content: '', revision: 0 });
  expect(await c.call('jevellan_notebook_write', { content: 'Plan: SQLite.', expectedRevision: 0 })).toEqual({ schema: 'notebook-write-result-v1', revision: 1 });
  expect((await f.app.projectHub.notebook(f.project.id))?.document).toMatchObject({ content: 'Plan: SQLite.', updatedBy: 'coordinator', revision: 1 });
  await f.app.projectWork.putNotebook(f.project.id, { schema: 'notebook-request-v1', expectedRevision: 1, content: 'Owner plan.\nUse SQLite.' });
  expect(await c.refused('jevellan_notebook_write', { content: 'Plan: Postgres.', expectedRevision: 1 })).toEqual({ status: 409, message: notebookConflict(2, 'Owner plan.\nUse SQLite.') });
  expect(notebookConflict(2, 'Owner plan.\nUse SQLite.')).toBe('The notebook changed (revision 2). Current content:\nOwner plan.\nUse SQLite.');
  expect(await c.refused('jevellan_notebook_write', { content: 'x'.repeat(65_537), expectedRevision: 2 })).toEqual({ status: 400, message: expect.stringMatching(fieldSentence('content')) });
  expect(await c.call('jevellan_notebook_write', { content: 'x'.repeat(65_536), expectedRevision: 2 })).toEqual({ schema: 'notebook-write-result-v1', revision: 3 });
  expect(await c.call('jevellan_notebook_read', {})).toMatchObject({ content: 'x'.repeat(65_536), revision: 3 });

  // Owner work reaches the coordinator as thread-user-message events (brief 8.2, 9.5): a New thread and a message to a thread.
  const owned = await f.app.projectWork.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: 'req_owner', title: 'Owner task', task: 'Write the changelog.' });
  await state(f, owned.threadId, 'idle');
  await f.app.projectWork.threadMessage(f.project.id, tests.threadId, { schema: 'thread-message-request-v1', clientMessageId: 'msg_owner', text: 'Cover the cache too.', interrupt: false });
  await f.waitFor(() => f.thread(tests.threadId), (thread) => thread.state === 'idle' && thread.turns === 2);
  expect(f.thread(tests.threadId).lastReport).toMatchObject({ summary: 'Cache covered.', synthesized: false });

  expect(toolLines(f)).toEqual([
    line('jevellan_thread_start', true, /^Started "Add cache" · Scripted test runtime Fixture · high · Worktree · /, { threadId: added.threadId }),
    line('jevellan_thread_start', true, /^Queued "Write tests" · Scripted test runtime Fixture · high · Worktree · /, { threadId: tests.threadId }),
    line('jevellan_thread_start', false, `Could not start "Elsewhere": ${UNKNOWN_PLACEMENT_DEVICE}`),
    line('jevellan_pr_status', true, 'Checked PR #1', { threadId: added.threadId }),
    line('jevellan_pr_status', true, 'Checked PR #1', { threadId: added.threadId }),
    line('jevellan_pr_status', true, 'Checked "Write tests": no pull request', { threadId: tests.threadId }),
    line('jevellan_ask_user', true, 'Asked you: Which database?', { threadId: added.threadId, decisionId: asked.decisionId }),
    line('jevellan_ask_user', false, `Could not ask you: options: ${ASK_USER_OPTIONS}`),
    line('jevellan_ask_user', false, `Could not ask you: options: ${ASK_USER_OPTIONS}`),
    line('jevellan_ask_user', true, 'Asked you: Should the cache expire?', { decisionId: open.decisionId }),
    line('jevellan_withdraw_question', true, 'Withdrew a question: The thread solved it.', { decisionId: open.decisionId, reason: 'The thread solved it.' }),
    line('jevellan_withdraw_question', true, 'The owner already answered that question', { decisionId: asked.decisionId }),
    line('jevellan_withdraw_question', false, `Could not withdraw a question: ${QUESTION_NOT_FOUND}`),
    line('jevellan_notebook_read', true, 'Read the notebook'),
    line('jevellan_notebook_write', true, 'Updated the notebook'),
    line('jevellan_notebook_write', false, 'Could not update the notebook: The notebook changed (revision 2).'),
    line('jevellan_notebook_write', false, /^Could not update the notebook: content: .+\.$/),
    line('jevellan_notebook_write', true, 'Updated the notebook'),
    line('jevellan_notebook_read', true, 'Read the notebook'),
  ]);

  // Everything that happened during the turn reaches the next one together.
  const prompts = acknowledge(f, 2);
  c.release(); await f.app.projectWork.idle(f.project.id);
  expect(prompts).toHaveLength(1);
  for (const expected of [`[owner started thread "Owner task" (${owned.threadId})] Write the changelog.`, `[owner wrote directly to thread "Write tests" (${tests.threadId})] Cover the cache too.`,
    `[owner answered] "${question}" → SQLite`, `[thread "Add cache" (${added.threadId})] Pull request #1 opened.`, `[PR #1 "Add cache"] checks failing`]) expect(prompts[0]).toContain(expected);
});

test('chat lines name what the coordinator did or could not do, in one short line', () => {
  const ok = (result: unknown) => ({ ok: true as const, result });
  const failed = (error: string) => ({ ok: false as const, error });
  expect(coordinatorToolSummary('jevellan_thread_start', { title: 'Fix login' }, ok({ state: 'preparing', placement: 'Codex gpt-x · high · Worktree · Mac mini' })))
    .toBe('Started "Fix login" · Codex gpt-x · high · Worktree · Mac mini');
  expect(coordinatorToolSummary('jevellan_thread_start', { title: 'Fix login' }, ok({ state: 'queued', placement: 'Codex gpt-x · high · Worktree · Mac mini' })))
    .toBe('Queued "Fix login" · Codex gpt-x · high · Worktree · Mac mini');
  expect(coordinatorToolSummary('jevellan_thread_start', {}, failed('title: Invalid input. Check the tool input.'))).toBe('Could not start a thread: title: Invalid input.');
  expect(coordinatorToolSummary('jevellan_thread_message', {}, ok({ delivery: 'queued' }), 'Fix login')).toBe('Sent a message to "Fix login"');
  expect(coordinatorToolSummary('jevellan_ask_user', { question: `${'Which database? '.repeat(10)}\nDetails.` }, ok({})))
    .toBe(`Asked you: ${'Which database? '.repeat(10).trim().slice(0, 120)}`);
  expect(coordinatorToolSummary('jevellan_pr_status', {}, ok({ pr: { number: 42 } }), 'Fix login')).toBe('Checked PR #42');
  expect(coordinatorToolSummary('memory_search', { query: 'x' }, ok({}))).toBe('Searched project memory');
  expect(coordinatorToolSummary('memory_read', { permalink: 'x' }, ok({}))).toBe('Read a project memory note');
  expect(coordinatorToolSummary('memory_search', {}, failed('Basic Memory is not installed.'))).toBe('Could not search project memory: Basic Memory is not installed.');
  expect(coordinatorToolSummary('jevellan_mail_send', { to: 'all', subject: 'Heads up' }, ok({}))).toBe('Sent mail to all: Heads up');
  expect(coordinatorToolSummary('jevellan_notebook_write', {}, failed(notebookConflict(4, `${'y'.repeat(70_000)}`)))).toBe('Could not update the notebook: The notebook changed (revision 4).');
  expect(coordinatorToolSummary('jevellan_thread_read', {}, failed('e'.repeat(1000)), 'Fix login')).toHaveLength(400);
  expect(firstSentence("Can't reach the hub (hub). This will continue when it's back.")).toBe("Can't reach the hub (hub).");
  expect(firstSentence('No period here')).toBe('No period here');
  expect(transcriptStaysOn('Mac mini')).toBe('The transcript stays on Mac mini.');
  // Concluded threads stay listed for 14 days after they end.
  const now = Date.parse('2026-10-04T12:00:00.000Z'); const at = (ms: number) => new Date(now - ms).toISOString();
  expect(concludedRecently({ state: 'done', endedAt: at(CONCLUDED_WINDOW_MS), updatedAt: at(0) }, now)).toBe(true);
  expect(concludedRecently({ state: 'stopped', endedAt: at(CONCLUDED_WINDOW_MS + 1), updatedAt: at(0) }, now)).toBe(false);
  expect(concludedRecently({ state: 'failed', updatedAt: at(1000) }, now)).toBe(true);
  expect(concludedRecently({ state: 'idle', updatedAt: at(CONCLUDED_WINDOW_MS * 2) }, now)).toBe(false);
});
