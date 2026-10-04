// The coordinator HTTP API and its chat stream (brief 11, 5.1, 5.13, 8.1; design 2.10): every phase 2 route through a booted
// daemon with the browser session, FakeRuntime coordinator turns, the hub project store and live git. The stream is read as
// raw SSE bytes, so the frame format, the cursor rules and the per-flush authentication are checked on the wire.
import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import {
  CoordinatorMessageReceiptSchema, DecisionAnsweredViewSchema, ProjectEventFrameSchema, ProjectNotebookViewSchema, ProjectWorkListViewSchema, ProjectWorkSettingsSchema,
  ProjectWorkSettingsViewSchema, ProjectWorkViewSchema, ThreadIndexSchema, defaultProjectWorkSettings, type ProjectEventFrame, type ProjectLedgerEvent,
} from '../packages/core/dist/index.js';
import { HubProjectAccess, HubUnavailable } from '../packages/mesh/dist/index.js';
import { forCoordinator, type FakeTurn } from '../packages/runtime-contract/dist/index.js';
import {
  EVENT_CURSOR_AHEAD, EVENT_CURSOR_INVALID, LEAVE_GIT_SETTING, MAIN_NOT_AVAILABLE, MESSAGE_ID_REUSED, NOTEBOOK_CHANGED, PROJECT_NOT_FOUND, QUESTION_NOT_FOUND,
  REMOTE_THREADS_LATER, SETTINGS_CHANGED, UNKNOWN_OPTION, publicProjectData,
} from '../packages/projects/dist/index.js';
import { projectWorkRoute } from '../apps/daemon/dist/index.js';
import { streamLedger } from '../apps/daemon/dist/conversation-events.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

const METHOD = 'This operation does not support that method.';
const CHECK = 'Check the submitted fields.';
const PASSPHRASE = 'disposable projects passphrase';
let fixture: ProjectFixture | undefined; const streams: AbortController[] = [];
afterEach(async () => { for (const stream of streams.splice(0)) stream.abort(); await fixture?.close(); fixture = undefined; });

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
const empty = { schema: 'empty-request-v1' };
const refused = (code: string, message: string) => ({ schema: 'error-v1', code, message });
const message = (clientMessageId: string, text: string) => ({ schema: 'coordinator-message-request-v1', clientMessageId, text });
async function call(f: ProjectFixture, path: string, method: string, body: unknown, status: number): Promise<unknown> {
  const response = await f.request(path, method, body); const value: unknown = await response.json();
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
  return value;
}
/** The next coordinator turn replies `text`. */
function reply(f: ProjectFixture, text: string): void {
  f.fake.enqueueTurn((turn) => { turn.say(text); return { status: 'completed' }; }, forCoordinator);
}
/** The next coordinator turn stays open until it is interrupted. */
function holdTurn(f: ProjectFixture): Promise<FakeTurn> {
  const opened = deferred<FakeTurn>();
  f.fake.enqueueTurn(async (turn) => { opened.resolve(turn); await aborted(turn.signal); return { status: 'completed' }; }, forCoordinator);
  return opened.promise;
}

type Stream = { text(): string; through(last: number): Promise<ProjectEventFrame[]>; ended(): Promise<void> };
/** The coordinator chat stream read as raw bytes: every frame must be exactly `id`, `event: project` and one `data` line. */
async function watch(f: ProjectFixture, options: { query?: string; headers?: Record<string, string>; cookie?: string } = {}): Promise<Stream> {
  const abort = new AbortController(); streams.push(abort);
  const response = await fetch(`${f.base}/api/projects/${f.project.id}/coordinator/events${options.query ?? ''}`,
    { headers: { Cookie: options.cookie ?? f.cookie, ...options.headers }, signal: abort.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let text = ''; let consumed = 0; let taken = 0; const frames: ProjectEventFrame[] = [];
  const read = async () => { const chunk = await reader.read(); if (chunk.done) return false; text += decoder.decode(chunk.value, { stream: true }); return true; };
  const parse = () => {
    for (let end = text.indexOf('\n\n', consumed); end >= 0; end = text.indexOf('\n\n', consumed)) {
      const block = text.slice(consumed, end); consumed = end + 2;
      if (block === ': keepalive') continue;
      const match = /^id: (\d+)\nevent: project\ndata: (.+)$/.exec(block); expect(match, block).not.toBeNull();
      const frame = ProjectEventFrameSchema.parse(JSON.parse(match![2]!)); expect(frame.event.id).toBe(Number(match![1])); frames.push(frame);
    }
  };
  return {
    text: () => text,
    async through(last) {
      const out: ProjectEventFrame[] = [];
      for (;;) {
        parse();
        while (taken < frames.length) { const frame = frames[taken++]!; out.push(frame); if (frame.event.id >= last) return out; }
        if (!await read()) throw new Error('The stream ended early.');
      }
    },
    async ended() { while (await read()); parse(); },
  };
}
const resolved = (f: ProjectFixture, events: readonly ProjectLedgerEvent[]) => { const ledger = f.app.projectWork.coordinatorLedger(f.project.id); return events.map((event) => ({ ...event, data: ledger.data(event) })); };

test('the phase 2 rows of the route table: coordinator, settings, notebook and answers, with their ids, methods and stream flag', () => {
  const project = (suffix: string) => `/api/projects/proj_a${suffix}`;
  expect(projectWorkRoute(project('/coordinator/events'), 'GET')).toEqual({ name: 'events', target: 'coordinator', stream: true, projectId: 'proj_a' });
  for (const [suffix, name] of [['/coordinator/messages', 'message'], ['/coordinator/stop', 'stop'], ['/coordinator/fresh', 'fresh']]) {
    expect(projectWorkRoute(project(suffix!), 'POST')).toEqual({ name, target: 'coordinator', projectId: 'proj_a' });
  }
  for (const method of ['GET', 'PUT']) {
    expect(projectWorkRoute(project('/work-settings'), method)).toEqual({ name: 'settings', target: 'any', projectId: 'proj_a' });
    expect(projectWorkRoute(project('/notebook'), method)).toEqual({ name: 'notebook', target: 'any', projectId: 'proj_a' });
  }
  expect(projectWorkRoute(project('/decisions/pdec_1/answer'), 'POST')).toEqual({ name: 'answer', target: 'any', projectId: 'proj_a', decisionId: 'pdec_1' });
  // Phase 1 rows keep their shape: no stream flag, the second id is the thread.
  expect(projectWorkRoute(project('/threads/thread_1/stop'), 'POST')).toEqual({ name: 'thread-stop', target: 'owner', projectId: 'proj_a', threadId: 'thread_1' });
  for (const [path, method] of [[project('/coordinator/events'), 'POST'], [project('/coordinator/events'), 'HEAD'], [project('/coordinator/messages'), 'GET'],
    [project('/coordinator/stop'), 'GET'], [project('/coordinator/fresh'), 'PUT'], [project('/work-settings'), 'POST'], [project('/work-settings'), 'DELETE'],
    [project('/notebook'), 'POST'], [project('/notebook'), 'PATCH'], [project('/decisions/pdec_1/answer'), 'GET'], [project('/decisions/pdec_1/answer'), 'PUT']]) {
    expect(() => projectWorkRoute(path!, method!), `${method} ${path}`).toThrow(expect.objectContaining({ message: METHOD, status: 405 }));
  }
  // Move is phase 5; partial paths, extra segments and other decision actions are no Projects route.
  for (const path of [project('/coordinator'), project('/coordinator/move'), project('/coordinator/events/3'), project('/coordinator/message'), project('/decisions'),
    project('/decisions/pdec_1'), project('/decisions/pdec_1/answer/x'), project('/decisions/pdec_1/withdraw'), project('/notebook/1'), project('/work-settings/x'),
    project('/settings'), project('/coordinator/..%2Fevents'), project('/decisions/a%2Fb/answer')]) {
    expect(projectWorkRoute(path, 'GET'), path).toBeNull(); expect(projectWorkRoute(path, 'POST'), path).toBeNull();
  }
  expect(() => projectWorkRoute(project('/decisions/-bad/answer'), 'POST')).toThrow(ZodError);
  expect(() => projectWorkRoute(`/api/projects/${'p'.repeat(129)}/coordinator/events`, 'GET')).toThrow(ZodError);
  // The public filter of every frame drops native identities and working directories at any depth (design 2.1.3).
  expect(publicProjectData({ schema: 'x', nativeSessionId: 'n', cwd: '/w', list: [{ sessionId: 's', keep: 1 }], nested: { cwd: '/x', text: 'ok' } }))
    .toEqual({ schema: 'x', list: [{ keep: 1 }], nested: { text: 'ok' } });
});

test('streamLedger: refusals before headers, exact frames in 64-event batches, drain backpressure, a 15 s keepalive and the end on a failed authentication', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const events = Array.from({ length: 150 }, (_, n) => ({ id: n + 1 }));
    let wake = () => {};
    const ledger = { events: (after = 0, limit = Number.MAX_SAFE_INTEGER) => events.filter((event) => event.id > after).slice(0, limit),
      subscribe: (listener: () => void) => { wake = listener; return () => { wake = () => {}; }; } };
    const writes: string[] = []; let accept = true; let ended = false; let allowed = true; const heads: unknown[] = [];
    const response = Object.assign(new EventEmitter(), { write: (chunk: string) => { writes.push(chunk); return accept; }, writeHead: (status: number, headers: object) => { heads.push({ status, headers }); },
      flushHeaders: () => {}, end: () => { ended = true; }, destroy: () => {} }) as unknown as ServerResponse;
    const frame = { name: 'project', payload: (event: { id: number }) => ({ n: event.id }), invalidCursor: 'Bad cursor.', aheadCursor: 'Ahead.' };
    const open = (headers: Record<string, string>, query = '') => streamLedger(ledger, { headers } as unknown as IncomingMessage, response, new URL(`http://daemon.invalid/${query}`), () => allowed, frame);
    expect(() => open({ 'last-event-id': '151' })).toThrow('Ahead.');
    expect(() => open({}, '?after=x')).toThrow('Bad cursor.');
    expect(() => open({ 'last-event-id': '1.5' })).toThrow('Bad cursor.');
    expect(heads).toEqual([]); expect(writes).toEqual([]);
    // The header wins over the query; 140 events arrive in three batches without any append.
    open({ 'last-event-id': '10' }, '?after=0');
    expect(heads).toEqual([{ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' } }]);
    await vi.waitFor(() => expect(writes).toHaveLength(140));
    expect(writes[0]).toBe('id: 11\nevent: project\ndata: {"n":11}\n\n');
    expect(writes.map((chunk) => Number(/^id: (\d+)\n/.exec(chunk)![1]))).toEqual(Array.from({ length: 140 }, (_, n) => n + 11));
    // A full socket pauses the stream until it drains.
    accept = false; events.push({ id: 151 }, { id: 152 }); wake();
    await vi.waitFor(() => expect(writes).toHaveLength(141));
    await new Promise((resolve) => setImmediate(resolve)); expect(writes).toHaveLength(141);
    accept = true; response.emit('drain');
    await vi.waitFor(() => expect(writes.at(-1)).toBe('id: 152\nevent: project\ndata: {"n":152}\n\n'));
    // Every 15 s a comment keeps proxies from closing an idle stream.
    vi.advanceTimersByTime(15_000);
    await vi.waitFor(() => expect(writes.at(-1)).toBe(': keepalive\n\n'));
    // Authentication is checked on every flush: a signed-out viewer's stream ends before the next frame.
    allowed = false; events.push({ id: 153 }); wake();
    await vi.waitFor(() => expect(ended).toBe(true));
    expect(writes.join('')).not.toContain('id: 153');
  } finally { vi.useRealTimers(); }
});

test('coordinator routes: session required, assignment by the first message, idempotent messages, a resumable chat stream, Stop, Fresh and no native session id', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  const pid = f.project.id; const work = f.app.projectWork; const ledger = work.coordinatorLedger(pid);
  const route = (suffix: string) => `/api/projects/${pid}${suffix}`;
  // Every Projects route needs the browser session.
  for (const [path, method] of [['/api/project-work', 'GET'], [route('/work'), 'GET'], [route('/coordinator/events'), 'GET'], [route('/coordinator/messages'), 'POST'],
    [route('/coordinator/stop'), 'POST'], [route('/coordinator/fresh'), 'POST'], [route('/work-settings'), 'GET'], [route('/work-settings'), 'PUT'], [route('/notebook'), 'GET'],
    [route('/notebook'), 'PUT'], [route('/decisions/pdec_x/answer'), 'POST']]) {
    const response = await fetch(`${f.base}${path!}`, { method: method!, ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: '{}' }) });
    expect(response.status, `${method} ${path}`).toBe(401);
  }

  // Before the first message: no coordinator, the planned session (D91), an empty chat; Stop and Fresh assign nothing.
  const planned = { runtime: 'fake', modelLabel: 'Fixture', effort: 'high' };
  const before = ProjectWorkViewSchema.parse(await call(f, route('/work'), 'GET', undefined, 200));
  expect(before.coordinator).toEqual({ state: 'none', deviceId: null, deviceName: null, online: false, session: null, planned, canMoveHere: false });
  expect(before).toMatchObject({ lastEventId: 0, notebookRevision: 0, decisions: { open: [], answered: [] } });
  for (const action of ['stop', 'fresh']) expect(ProjectWorkViewSchema.parse(await call(f, route(`/coordinator/${action}`), 'POST', empty, 202)).coordinator.state).toBe('none');
  expect(await call(f, route('/coordinator/stop'), 'POST', { schema: 'stop-v1' }, 400)).toEqual(refused('request-failed', CHECK));
  expect(await f.app.projectHub.coordinator(pid)).toBeNull();
  const early = await watch(f);
  expect(await call(f, route('/coordinator/events?after=1'), 'GET', undefined, 400)).toEqual(refused('request-failed', EVENT_CURSOR_AHEAD));
  expect(await call(f, route('/coordinator/events?after=one'), 'GET', undefined, 400)).toEqual(refused('request-failed', EVENT_CURSOR_INVALID));
  expect(await call(f, route('/coordinator/events?after=-1'), 'GET', undefined, 400)).toEqual(refused('request-failed', EVENT_CURSOR_INVALID));
  expect(await call(f, '/api/projects/missing/coordinator/events', 'GET', undefined, 404)).toEqual(refused('not-found', PROJECT_NOT_FOUND));
  expect(await call(f, '/api/projects/missing/coordinator/messages', 'POST', message('msg_missing', 'Hello.'), 404)).toEqual(refused('not-found', PROJECT_NOT_FOUND));

  // The first message assigns this device and runs a turn; the same client id repeats, other text under it is refused.
  reply(f, 'Noted. I will split this into two threads.');
  const first = message('msg_api_1', 'Add A and fix B.');
  expect(await call(f, route('/coordinator/messages'), 'POST', { ...first, text: '' }, 400)).toEqual(refused('request-failed', CHECK));
  expect(await f.app.projectHub.coordinator(pid)).toBeNull();
  expect(CoordinatorMessageReceiptSchema.parse(await call(f, route('/coordinator/messages'), 'POST', first, 202))).toEqual({ schema: 'coordinator-message-receipt-v1', repeated: false });
  expect(await call(f, route('/coordinator/messages'), 'POST', first, 202)).toEqual({ schema: 'coordinator-message-receipt-v1', repeated: true });
  expect(await call(f, route('/coordinator/messages'), 'POST', { ...first, text: 'Something else.' }, 409)).toEqual(refused('conflict', MESSAGE_ID_REUSED));
  expect((await f.app.projectHub.coordinator(pid))?.document.deviceId).toBe(f.app.device.deviceId);
  await work.idle(pid);
  const turnOne = ledger.events();
  expect(turnOne.map((event) => event.type)).toEqual(['coordinator-event', 'coordinator-turn-start', 'coordinator-text', 'coordinator-turn-end']);
  expect(f.fake.turnStarts.filter((turn) => turn.owner.kind === 'coordinator')).toHaveLength(1);

  // The stream opened before any event received every one live, in ledger order, exactly as the ledger holds it.
  const lastOne = turnOne.at(-1)!.id;
  const live = await early.through(lastOne);
  expect(live.map((frame) => frame.event)).toEqual(resolved(f, turnOne));
  expect(early.text().startsWith(`id: 1\nevent: project\ndata: {"schema":"project-event-v1","event":{"schema":"project-ledger-event-v1",`)).toBe(true);
  expect(live[0]!.event.data).toMatchObject({ kind: 'user-message', clientMessageId: 'msg_api_1', text: 'Add A and fix B.' });
  expect(live[2]!.event.data).toEqual({ schema: 'coordinator-text-v1', text: 'Noted. I will split this into two threads.' });
  // Two viewers see the same frames.
  const second = await watch(f);
  expect(await second.through(lastOne)).toEqual(live);

  // The project view and the list show the coordinator here with its session.
  const native = f.coordinatorState().session!.nativeSessionId!; expect(native).toBeTruthy();
  const after = ProjectWorkViewSchema.parse(await call(f, route('/work'), 'GET', undefined, 200));
  expect(after.coordinator).toEqual({ state: 'idle', deviceId: f.app.device.deviceId, deviceName: f.deviceName, online: true,
    session: { runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture', turns: 1 }, planned, canMoveHere: false });
  expect(after.lastEventId).toBe(lastOne);
  expect(ProjectWorkListViewSchema.parse(await call(f, '/api/project-work', 'GET', undefined, 200)).projects)
    .toEqual([{ projectId: pid, name: 'Shop', waiting: 0, running: 0, inReview: 0, coordinator: { deviceId: f.app.device.deviceId, state: 'idle' } }]);

  // Resume: Last-Event-ID, else ?after=; the header wins; a resumed stream continues live.
  const resumed = await watch(f, { headers: { 'Last-Event-ID': '2' } });
  expect((await resumed.through(lastOne)).map((frame) => frame.event.id)).toEqual(turnOne.slice(2).map((event) => event.id));
  const byQuery = await watch(f, { query: '?after=3' });
  expect((await byQuery.through(lastOne)).map((frame) => frame.event.id)).toEqual([4]);
  const headerWins = await watch(f, { query: '?after=0', headers: { 'Last-Event-ID': '3' } });
  expect((await headerWins.through(lastOne)).map((frame) => frame.event.id)).toEqual([4]);

  // Stop interrupts the running turn and answers the project view; the turn's events count as delivered (D33).
  const held = holdTurn(f);
  expect(await call(f, route('/coordinator/messages'), 'POST', message('msg_api_2', 'Plan the release.'), 202)).toEqual({ schema: 'coordinator-message-receipt-v1', repeated: false });
  await held;
  await f.waitFor(async () => ProjectWorkViewSchema.parse(await call(f, route('/work'), 'GET', undefined, 200)).coordinator.state, (state) => state === 'running');
  const stopped = ProjectWorkViewSchema.parse(await call(f, route('/coordinator/stop'), 'POST', empty, 202));
  expect(stopped.coordinator).toMatchObject({ state: 'idle', session: { turns: 2 } });
  await work.idle(pid);
  const turnTwo = ledger.events().slice(turnOne.length);
  expect(turnTwo.map((event) => event.type)).toEqual(['coordinator-event', 'coordinator-turn-start', 'coordinator-turn-end']);
  expect(ledger.data(turnTwo.at(-1)!)).toMatchObject({ status: 'interrupted' });
  expect(f.coordinatorState().queue).toEqual([]);
  const lastTwo = turnTwo.at(-1)!.id;
  expect((await resumed.through(lastTwo)).map((frame) => frame.event)).toEqual(resolved(f, turnTwo));
  expect(await second.through(lastTwo)).toEqual(await early.through(lastTwo));

  // Fresh drops the session; the chip falls back to the planned session (D77, D91).
  const fresh = ProjectWorkViewSchema.parse(await call(f, route('/coordinator/fresh'), 'POST', empty, 202));
  expect(fresh.coordinator).toMatchObject({ state: 'idle', session: null, planned });
  expect(f.coordinatorState().session).toBeNull();
  reply(f, 'Starting over.');
  await call(f, route('/coordinator/messages'), 'POST', message('msg_api_3', 'Fresh start.'), 202); await work.idle(pid);
  const freshTurn = f.fake.turnStarts.filter((turn) => turn.owner.kind === 'coordinator').at(-1)!;
  expect(freshTurn.resume).toBeUndefined(); expect(freshTurn.prompt.startsWith('Project notebook:')).toBe(true);

  // Authentication is checked again on every flush: a signed-out viewer's stream ends before the next frame.
  const login = await fetch(`${f.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: PASSPHRASE }) });
  expect(login.status).toBe(200); const other = login.headers.get('set-cookie')!.split(';')[0]!;
  const leaving = await watch(f, { cookie: other }); const lastThree = ledger.lastId();
  await leaving.through(lastThree);
  const logout = await fetch(`${f.base}/api/auth/logout`, { method: 'POST', headers: { Cookie: other, Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify(empty) });
  expect(logout.status).toBe(200);
  const notice = ledger.append({ type: 'notice', data: { schema: 'project-notice-v1', text: 'Only for signed-in viewers.', kind: 'info' } });
  await leaving.ended();
  expect(leaving.text()).not.toContain('Only for signed-in viewers.');
  expect((await early.through(notice.id)).at(-1)!.event.data).toEqual({ schema: 'project-notice-v1', text: 'Only for signed-in viewers.', kind: 'info' });

  // No response, frame or ledger record carries the coordinator's native session id.
  expect(f.responses.filter((entry) => entry.includes('"session":{"runtime":"fake"')).length).toBeGreaterThan(1);
  for (const text of [...f.responses, early.text(), second.text(), resumed.text(), f.ledgerText()]) expect(text).not.toContain(native);
});

test('work settings, notebook and answers: revision checks, the main default coerced with its reason, idempotent answers, counts and retryable outages', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  const pid = f.project.id; const route = (suffix: string) => `/api/projects/${pid}${suffix}`;
  const base = defaultProjectWorkSettings(pid);
  const defaults = { defaultIsolation: base.defaultIsolation, coordinator: base.coordinator, setupCommand: base.setupCommand, maxRunningThreads: base.maxRunningThreads,
    maxRunningPerDevice: base.maxRunningPerDevice, threadTurnCap: base.threadTurnCap };
  const put = (revision: number, over: object = {}, clientRequestId?: string) =>
    ({ schema: 'project-work-settings-request-v1', revision, settings: { ...defaults, ...over }, ...(clientRequestId ? { clientRequestId } : {}) });

  // Settings: defaults first, then a compare-and-swap on the revision; the body is checked before the revision.
  expect(ProjectWorkSettingsViewSchema.parse(await call(f, route('/work-settings'), 'GET', undefined, 200))).toEqual({ schema: 'project-work-settings-view-v1', settings: defaultProjectWorkSettings(pid) });
  expect(await call(f, route('/work-settings'), 'PUT', put(0, { maxRunningThreads: 3 }), 200)).toEqual({ schema: 'project-work-settings-view-v1',
    settings: { ...defaultProjectWorkSettings(pid), revision: 1, maxRunningThreads: 3 } });
  expect(await call(f, route('/work-settings'), 'PUT', put(0, { maxRunningThreads: 4 }), 409)).toEqual(refused('conflict', SETTINGS_CHANGED));
  expect(await call(f, route('/work-settings'), 'PUT', put(0, { maxRunningThreads: 21 }), 400)).toEqual(refused('request-failed', CHECK));
  expect(await call(f, route('/work-settings'), 'PUT', { ...put(1), settings: { ...defaults, setupCommand: 'x'.repeat(501) } }, 400)).toEqual(refused('request-failed', CHECK));
  expect(await call(f, '/api/projects/missing/work-settings', 'GET', undefined, 404)).toEqual(refused('not-found', PROJECT_NOT_FOUND));
  // A main default is stored, but reads show worktree with the reason: the phase text until main isolation exists (D88).
  expect(await call(f, route('/work-settings'), 'PUT', put(1, { maxRunningThreads: 3, defaultIsolation: 'main' }), 200)).toEqual({ schema: 'project-work-settings-view-v1',
    settings: { ...defaultProjectWorkSettings(pid), revision: 2, maxRunningThreads: 3, defaultIsolation: 'worktree' }, notice: MAIN_NOT_AVAILABLE });
  expect((await f.app.projectHub.settings(pid))?.document).toMatchObject({ revision: 2, defaultIsolation: 'main' });
  expect(await call(f, route('/work-settings'), 'GET', undefined, 200)).toMatchObject({ settings: { defaultIsolation: 'worktree' }, notice: MAIN_NOT_AVAILABLE });
  expect(ProjectWorkViewSchema.parse(await call(f, route('/work'), 'GET', undefined, 200))).toMatchObject({ settings: { defaultIsolation: 'worktree', revision: 2 }, settingsNotice: MAIN_NOT_AVAILABLE });
  // On a Leave git project the brief's text wins over the phase text (5.1, D88).
  const stored = await f.app.state.projects.get(pid);
  await f.app.conversations.saveProject({ schema: 'project-write-v1', revision: stored!.revision, project: { ...f.project, branchPolicy: 'external' } });
  expect(await call(f, route('/work-settings'), 'GET', undefined, 200)).toMatchObject({ settings: { defaultIsolation: 'worktree' }, notice: LEAVE_GIT_SETTING });
  expect(ProjectWorkViewSchema.parse(await call(f, route('/work'), 'GET', undefined, 200))).toMatchObject({ project: { branchPolicy: 'external' }, settingsNotice: LEAVE_GIT_SETTING });
  // A retried save with its client request id repeats instead of conflicting (D101).
  const retried = put(2, { maxRunningThreads: 5 }, 'set_retry');
  const saved = await call(f, route('/work-settings'), 'PUT', retried, 200);
  expect(saved).toEqual({ schema: 'project-work-settings-view-v1', settings: { ...defaultProjectWorkSettings(pid), revision: 3, maxRunningThreads: 5 } });
  expect(await call(f, route('/work-settings'), 'PUT', retried, 200)).toEqual(saved);
  expect(ProjectWorkSettingsSchema.parse((await f.app.projectHub.settings(pid))!.document)).toMatchObject({ revision: 3, maxRunningThreads: 5 });

  // Notebook: the owner's edit with a revision check and the coordinator's conflict sentence.
  expect(await call(f, route('/notebook'), 'GET', undefined, 200)).toEqual({ schema: 'project-notebook-view-v1', notebook: null, revision: 0 });
  const edited = ProjectNotebookViewSchema.parse(await call(f, route('/notebook'), 'PUT', { schema: 'notebook-request-v1', expectedRevision: 0, content: 'Use SQLite.' }, 200));
  expect(edited).toEqual({ schema: 'project-notebook-view-v1', revision: 1,
    notebook: { schema: 'project-notebook-v1', projectId: pid, revision: 1, content: 'Use SQLite.', updatedAt: expect.any(String), updatedBy: 'owner' } });
  expect(await call(f, route('/notebook'), 'PUT', { schema: 'notebook-request-v1', expectedRevision: 0, content: 'Stale.' }, 409)).toEqual(refused('conflict', NOTEBOOK_CHANGED));
  expect(await call(f, route('/notebook'), 'PUT', { schema: 'notebook-request-v1', expectedRevision: 1, content: 'x'.repeat(65_537) }, 400)).toEqual(refused('request-failed', CHECK));
  expect(await call(f, route('/notebook'), 'GET', undefined, 200)).toEqual(edited);
  expect(await call(f, '/api/projects/missing/notebook', 'GET', undefined, 404)).toEqual(refused('not-found', PROJECT_NOT_FOUND));

  // Answers: a coordinator question answered once, repeats reported, the answer queued for the coordinator exactly once.
  const decisions = f.app.projectWork.decisions;
  const asked = await decisions.ask(pid, { question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres', detail: 'Needs a server' }] }, 'coordinator');
  // Two threads on another device fill the Running and In review counts.
  const other = new HubProjectAccess(f.app.hub, 'dev_other'); const at = new Date().toISOString();
  for (const [id, state] of [['thread_running', 'running'], ['thread_review', 'in-review']] as const) {
    await other.publishThread(ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id, projectId: pid, title: id, state, isolation: 'worktree', ownerDeviceId: 'dev_other',
      runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture', turns: 1, createdAt: at, updatedAt: at }), 1);
  }
  expect(ProjectWorkListViewSchema.parse(await call(f, '/api/project-work', 'GET', undefined, 200)).projects[0]).toMatchObject({ waiting: 1, running: 1, inReview: 1 });
  expect(ProjectWorkViewSchema.parse(await call(f, route('/work'), 'GET', undefined, 200)).decisions).toMatchObject({ open: [{ id: asked, question: 'Which database?' }], answered: [] });
  const answer = (clientRequestId: string, over: object) => ({ schema: 'decision-answer-request-v1', clientRequestId, ...over });
  expect(await call(f, route(`/decisions/${asked}/answer`), 'POST', answer('ans_0', { optionLabel: 'MySQL' }), 400)).toEqual(refused('request-failed', UNKNOWN_OPTION));
  expect(await call(f, route(`/decisions/${asked}/answer`), 'POST', answer('ans_0', {}), 400)).toEqual(refused('request-failed', CHECK));
  expect(await call(f, route('/decisions/pdec_missing/answer'), 'POST', answer('ans_0', { optionLabel: 'SQLite' }), 404)).toEqual(refused('not-found', QUESTION_NOT_FOUND));
  expect(DecisionAnsweredViewSchema.parse(await call(f, route(`/decisions/${asked}/answer`), 'POST', answer('ans_1', { optionLabel: 'SQLite', text: 'Keep it simple.' }), 202)))
    .toEqual({ schema: 'decision-answered-view-v1', repeated: false });
  expect(await call(f, route(`/decisions/${asked}/answer`), 'POST', answer('ans_1', { optionLabel: 'SQLite', text: 'Keep it simple.' }), 202)).toEqual({ schema: 'decision-answered-view-v1', repeated: true });
  expect(await call(f, route(`/decisions/${asked}/answer`), 'POST', answer('ans_2', { optionLabel: 'SQLite', text: 'Keep it simple.' }), 202)).toEqual({ schema: 'decision-answered-view-v1', repeated: true });
  expect(await call(f, route(`/decisions/${asked}/answer`), 'POST', answer('ans_3', { optionLabel: 'Postgres' }), 409)).toMatchObject({ code: 'conflict' });
  const answers = f.coordinatorState().queue.filter((event) => event.kind === 'decision-answer');
  expect(answers).toEqual([expect.objectContaining({ decisionId: asked, question: 'Which database?', answer: { optionLabel: 'SQLite', text: 'Keep it simple.' } })]);
  // Waiting shows open items plus the last 10 answered, newest first (D52).
  for (let n = 0; n < 11; n += 1) {
    const id = await decisions.ask(pid, { question: `Question ${n}?`, options: [] }, 'coordinator');
    await call(f, route(`/decisions/${id}/answer`), 'POST', answer(`ans_more_${n}`, { text: `Answer ${n}.` }), 202);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const waiting = ProjectWorkViewSchema.parse(await call(f, route('/work'), 'GET', undefined, 200)).decisions;
  expect(waiting.open).toEqual([]);
  expect(waiting.answered.map((decision) => decision.question)).toEqual(Array.from({ length: 10 }, (_, n) => `Question ${10 - n}?`));
  expect(ProjectWorkListViewSchema.parse(await call(f, '/api/project-work', 'GET', undefined, 200)).projects[0]).toMatchObject({ waiting: 0 });

  // A hub outage is retryable only where the body carries a client id (settings only when it has one).
  const outage = new HubUnavailable('Fixture hub');
  const unavailable = (retryable: boolean) => ({ schema: 'error-v1', code: 'hub-unavailable', retryable, message: outage.message });
  const work = f.app.projectWork;
  const spies = [vi.spyOn(work, 'putSettings').mockRejectedValue(outage), vi.spyOn(work, 'putNotebook').mockRejectedValue(outage),
    vi.spyOn(work, 'answerDecision').mockRejectedValue(outage), vi.spyOn(work, 'postMessage').mockRejectedValue(outage)];
  expect(await call(f, route('/work-settings'), 'PUT', put(3, {}, 'set_outage'), 503)).toEqual(unavailable(true));
  expect(await call(f, route('/work-settings'), 'PUT', put(3), 503)).toEqual(unavailable(false));
  expect(await call(f, route('/notebook'), 'PUT', { schema: 'notebook-request-v1', expectedRevision: 1, content: 'Later.' }, 503)).toEqual(unavailable(false));
  expect(await call(f, route(`/decisions/${asked}/answer`), 'POST', answer('ans_outage', { optionLabel: 'SQLite' }), 503)).toEqual(unavailable(true));
  expect(await call(f, route('/coordinator/messages'), 'POST', message('msg_outage', 'Hello.'), 503)).toEqual(unavailable(true));
  for (const spy of spies) spy.mockRestore();

  // The unassigned coordinator's chat streams from this device; a history longer than one 64-event batch replays whole, in order.
  expect(await f.app.projectHub.coordinator(pid)).toBeNull();
  const ledger = work.coordinatorLedger(pid);
  for (let n = 0; n < 140; n += 1) ledger.append({ type: 'notice', data: { schema: 'project-notice-v1', text: `Notice ${n}.`, kind: 'info' } });
  const last = ledger.lastId(); expect(last).toBeGreaterThan(128);
  const replay = await watch(f);
  expect((await replay.through(last)).map((frame) => frame.event.id)).toEqual(Array.from({ length: last }, (_, n) => n + 1));
});

test('a coordinator assigned to another device is refused here until phase 5 and shows offline', { timeout: 60_000 }, async () => {
  const f = fixture = await projectFixture();
  const pid = f.project.id; const route = (suffix: string) => `/api/projects/${pid}${suffix}`;
  await new HubProjectAccess(f.app.hub, 'dev_other').assignCoordinator(pid, 'dev_other', 0);
  expect(await call(f, route('/coordinator/messages'), 'POST', message('msg_remote', 'Hello.'), 409)).toEqual(refused('conflict', REMOTE_THREADS_LATER));
  expect(await call(f, route('/coordinator/events'), 'GET', undefined, 409)).toEqual(refused('conflict', REMOTE_THREADS_LATER));
  for (const action of ['stop', 'fresh']) expect(await call(f, route(`/coordinator/${action}`), 'POST', empty, 409)).toEqual(refused('conflict', REMOTE_THREADS_LATER));
  expect(existsSync(f.app.projectWork.paths.coordinator(pid))).toBe(false);
  expect(ProjectWorkViewSchema.parse(await call(f, route('/work'), 'GET', undefined, 200)).coordinator)
    .toMatchObject({ state: 'offline', deviceId: 'dev_other', deviceName: null, online: false, session: null });
  expect(ProjectWorkListViewSchema.parse(await call(f, '/api/project-work', 'GET', undefined, 200)).projects[0]!.coordinator).toEqual({ deviceId: 'dev_other', state: 'offline' });
});
