// Terminal takeover on the daemon (brief phase 7; design 3.7; D46, D47, D81, D297): the local control routes, attach and detach.
import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, utimesSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  AccountSchema, DeviceSchema, DoctorControlSchema, ThreadAttachViewSchema, ThreadCreatedViewSchema, ThreadDetachViewSchema, ThreadIndexSchema, ThreadMessageReceiptSchema, ThreadViewSchema,
  doctorControlPath, readDocument, type CoordinatorEvent, type ModelOption, type ProjectLedgerEvent, type ProjectLedgerData,
} from '../packages/core/dist/index.js';
import { HubProjectAccess } from '../packages/mesh/dist/index.js';
import { FakeRuntime, forThread, writeFakeNativeSession } from '../packages/runtime-contract/dist/index.js';
import {
  ATTACH_RUNTIMES_ONLY, NO_SESSION_TO_ATTACH, THREAD_ATTACHED, THREAD_ENDED, THREAD_NOT_FOUND, THREAD_WORKING, adoptedSession, alreadyAttached, attachEnvironment, ownerWorkedLine,
  threadRunsOn,
} from '../packages/projects/dist/index.js';
import { createDaemon } from '../apps/daemon/dist/index.js';
import { FIXTURE_MENU, commitStep, expectNoLeaks, holdStep, projectFixture, reportStep, type ProjectFixture, type ProjectFixtureOptions } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

const LOCAL_REQUIRED = 'Local commands require the installation control file.';
const MENU: ModelOption[] = [...FIXTURE_MENU,
  { id: 'claude_fixture', runtime: 'claude', model: 'scripted-model', label: 'Claude fixture', description: 'Simulated model.', efforts: ['high'], enabled: true },
  { id: 'codex_fixture', runtime: 'codex', model: 'scripted-model', label: 'Codex fixture', description: 'Simulated model.', efforts: ['high'], enabled: true }];
/** A fake runtime registered under a real runtime id, so threads place on `claude` or `codex` and write that runtime's native journals. */
function named(id: 'claude' | 'codex'): FakeRuntime {
  const runtime = new FakeRuntime(); Object.defineProperty(runtime, 'id', { value: id }); return runtime;
}
async function setup(options: ProjectFixtureOptions = {}): Promise<ProjectFixture> {
  fixture = await projectFixture({ control: true, menu: MENU, ...options });
  return fixture;
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const control = (f: ProjectFixture) => readDocument(doctorControlPath(f.homes), DoctorControlSchema);
/** A request from the installed command: loopback, the control token, no Origin. */
function local(f: ProjectFixture, path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<Response> {
  const { origin, token } = control(f);
  return fetch(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}
const ATTACH = { schema: 'thread-attach-request-v1' };
const DETACH = { schema: 'thread-detach-request-v1', exitCode: 0 };
async function refused(response: Response, status: number, code: string, message: string): Promise<void> {
  expect({ status: response.status, body: await response.json() }).toEqual({ status, body: { schema: 'error-v1', code, message } });
}
async function start(f: ProjectFixture, title: string, task: string, modelId?: string): Promise<string> {
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST',
    { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task, ...(modelId ? { modelId } : {}) });
  return created.threadId;
}
async function rest(f: ProjectFixture, threadId: string, state = 'idle'): Promise<void> {
  await f.waitFor(() => f.thread(threadId).state, (current) => current === state); await f.app.projectWork.idle('project');
}
const queue = (f: ProjectFixture): CoordinatorEvent[] => f.coordinatorState().queue;
const worked = (f: ProjectFixture, threadId: string) => queue(f).filter((event) => event.kind === 'thread-user-message' && event.threadId === threadId && event.text.startsWith('[owner worked'));
function states(f: ProjectFixture, threadId: string): string[] {
  const ledger = f.app.projectWork.ledgers.thread('project', threadId);
  return ledger.events().filter((event) => event.type === 'thread-state').map((event) => (ledger.payload(event as ProjectLedgerEvent & { type: 'thread-state' }) as ProjectLedgerData<'thread-state'>).to);
}
/** Writes a native journal into an account home, optionally dated `at` (ms). */
function journal(format: 'claude' | 'codex', home: string, cwd: string, at?: number): string {
  const sessionId = randomUUID();
  const file = writeFakeNativeSession({ format, home, sessionId, cwd, rows: [{ role: 'user', text: 'Worked here.' }, { role: 'assistant', text: 'Done here.' }], append: false });
  if (at !== undefined) utimesSync(file, new Date(at), new Date(at));
  return sessionId;
}

test('the session a terminal left is the newest one in the thread directory after the attach started, never one Jevellan runs', () => {
  const since = '2026-10-05T10:00:00.000Z'; const at = Date.parse(since);
  const row = (nativeId: string, cwd: string | null, mtimeMs: number) => ({ nativeId, cwd, file: `/journals/${nativeId}.jsonl`, mtimeMs });
  const journals = [row('older', '/work/thread', at - 1), row('same-time', '/work/thread', at), row('newer', '/work/thread', at + 10), row('newest', '/work/thread', at + 20),
    row('elsewhere', '/work/other', at + 30), row('unknown', null, at + 40), row('coordinator', '/work/thread', at + 50)];
  expect(adoptedSession(journals, '/work/thread', since, new Set(['coordinator']))).toBe('newest');
  expect(adoptedSession([...journals].reverse(), '/work/thread/', since, new Set(['coordinator', 'newest']))).toBe('newer');
  expect(adoptedSession(journals, '/work/thread', since)).toBe('coordinator');
  expect(adoptedSession(journals.slice(0, 2), '/work/thread', since)).toBeUndefined();
  expect(adoptedSession(journals, '/work/none', since)).toBeUndefined();
  // Only the account home and its own authentication variables: never the runtime's other keys or the API key Codex logged in with.
  expect(attachEnvironment('claude', { home: '/homes/claude/acc', env: { CLAUDE_CODE_OAUTH_TOKEN: 'token', ANTHROPIC_BASE_URL: 'https://example.invalid' } }))
    .toEqual({ HOME: '/homes/claude/acc', CLAUDE_CONFIG_DIR: '/homes/claude/acc', CLAUDE_CODE_OAUTH_TOKEN: 'token' });
  expect(attachEnvironment('codex', { home: '/homes/codex/acc', env: { OPENAI_API_KEY: 'key' } })).toEqual({ HOME: '/homes/codex/acc', CODEX_HOME: '/homes/codex/acc' });
});

test('local control routes take only the installation control file, keep doctor as it was and refuse threads they cannot attach', { timeout: 120_000 }, async () => {
  const f = await setup();
  const { origin, token } = control(f); const path = '/api/local/threads/thread_missing/attach';
  // Doctor rules for every local route: loopback, no Origin, the exact token.
  await refused(await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ATTACH) }), 401, 'unauthenticated', LOCAL_REQUIRED);
  await refused(await local(f, path, ATTACH, { Authorization: `Bearer ${token.slice(1)}x` }), 401, 'unauthenticated', LOCAL_REQUIRED);
  await refused(await local(f, path, ATTACH, { Origin: origin }), 401, 'unauthenticated', LOCAL_REQUIRED);
  await refused(await local(f, '/api/local/threads/thread_missing/detach', DETACH, { Origin: origin }), 401, 'unauthenticated', LOCAL_REQUIRED);
  // A server without the control file (the browser test server) refuses even the right token.
  const bare = createDaemon({ application: f.app }); await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
  try {
    await refused(await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ATTACH) }), 401, 'unauthenticated', LOCAL_REQUIRED);
  } finally { await new Promise<void>((resolve) => { bare.close(() => resolve()); bare.closeAllConnections(); }); }
  // Doctor is unchanged: another method is unauthenticated, a bad body is the one 503 sentence.
  await refused(await local(f, '/api/local/doctor', undefined, {}, 'GET'), 401, 'unauthenticated', 'Local diagnostics require the installation control file.');
  await refused(await local(f, '/api/local/doctor', {}), 503, 'request-failed', 'Diagnostics are unavailable while Jevellan is changing or stopping.');
  // Once authorized: unknown paths, methods and bodies.
  await refused(await local(f, '/api/local/nothing', ATTACH), 404, 'not-found', 'Not found.');
  await refused(await local(f, '/api/local/threads/thread_missing/close', ATTACH), 404, 'not-found', 'Not found.');
  await refused(await local(f, path, undefined, {}, 'GET'), 405, 'request-failed', 'This operation does not support that method.');
  await refused(await local(f, path, { schema: 'thread-detach-request-v1', exitCode: 0 }), 400, 'request-failed', 'Check the submitted fields.');
  await refused(await local(f, '/api/local/threads/-thread/attach', ATTACH), 400, 'request-failed', 'Check the submitted fields.');
  await refused(await local(f, path, ATTACH, { 'Content-Type': 'text/plain' }), 415, 'request-failed', 'Send this request as JSON.');
  await refused(await local(f, path, ATTACH), 404, 'not-found', THREAD_NOT_FOUND);
  await refused(await local(f, '/api/local/threads/thread_missing/detach', DETACH), 404, 'not-found', THREAD_NOT_FOUND);

  // A thread on another device names that device, for attach and detach alike.
  const at = new Date().toISOString();
  f.app.hub.put('devices', 'dev_laptop', DeviceSchema, { schema: 'device-v1', id: 'dev_laptop', name: 'Laptop', role: 'member', url: 'http://127.0.0.1:9', os: 'darwin', version: '0.1.0', joinedAt: at }, 0);
  await new HubProjectAccess(f.app.hub, 'dev_laptop').publishThread(ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id: 'thread_remote', projectId: 'project',
    title: 'Elsewhere', state: 'idle', isolation: 'worktree', ownerDeviceId: 'dev_laptop', runtime: 'claude', modelLabel: 'Claude fixture', effort: 'high', accountLabel: 'Laptop account',
    turns: 1, createdAt: at, updatedAt: at }), 1);
  await refused(await local(f, '/api/local/threads/thread_remote/attach', ATTACH), 409, 'conflict', threadRunsOn('Laptop'));
  await refused(await local(f, '/api/local/threads/thread_remote/detach', DETACH), 409, 'conflict', threadRunsOn('Laptop'));
  expect((await f.index('thread_remote'))!.state).toBe('idle');

  // A thread at rest with a session on a runtime without a terminal command, then without a session, then ended: nothing changes.
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Planned the copy.' }), forThread());
  const threadId = await start(f, 'Fix copy', 'Fix the footer copy.');
  await rest(f, threadId);
  expect(f.thread(threadId).nativeSessionId).toBeTruthy();
  await refused(await local(f, `/api/local/threads/${threadId}/attach`, ATTACH), 409, 'conflict', ATTACH_RUNTIMES_ONLY);
  expect(f.thread(threadId).state).toBe('idle'); expect(f.thread(threadId).attach).toBeUndefined();
  // Detaching a thread that is not attached changes nothing and tells nobody.
  const before = queue(f).length;
  expect(ThreadDetachViewSchema.parse(await (await local(f, `/api/local/threads/${threadId}/detach`, DETACH)).json())).toEqual({ schema: 'thread-detach-v1', adopted: false, state: 'idle' });
  expect(queue(f)).toHaveLength(before);
  f.app.projectWork.store.update(threadId, (thread) => { const next = { ...thread }; delete next.nativeSessionId; return next; });
  await refused(await local(f, `/api/local/threads/${threadId}/attach`, ATTACH), 409, 'conflict', NO_SESSION_TO_ATTACH);
  expect((await f.request(`/api/projects/project/threads/${threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' })).status).toBe(202);
  await refused(await local(f, `/api/local/threads/${threadId}/attach`, ATTACH), 409, 'conflict', THREAD_ENDED);
  expect(f.thread(threadId).state).toBe('stopped');
});

test('a Claude thread attaches at rest with its session and account, queues owner messages, and adopts the terminal session at detach', { timeout: 120_000 }, async () => {
  const claude = named('claude');
  const f = await setup({ runtimes: { fake: new FakeRuntime(), claude } });
  const secret = `fixture-${randomUUID()}`;
  const account = await f.app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Claude subscription', kind: 'subscription', secret });
  await f.app.accounts.check(account.account.id);
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  claude.enqueueTurn(holdStep(held), forThread());
  const threadId = await start(f, 'Rename button', 'Rename the save button.', 'claude_fixture');

  // 1. Refused while a turn runs, and the turn is untouched.
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'running');
  await refused(await local(f, `/api/local/threads/${threadId}/attach`, ATTACH), 409, 'conflict', THREAD_WORKING);
  expect(f.thread(threadId).state).toBe('running');
  release(); await rest(f, threadId);
  // A message at rest queued a turn whose preparation is still awaiting: the thread reads idle, yet attach is refused, so that turn can
  // never overwrite an attached thread.
  const projects = f.app.state.projects; const read = projects.get.bind(projects); const runner = f.app.projectWork.threads.runner(threadId)!;
  let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; }); let gated = false;
  const spy = vi.spyOn(projects, 'get').mockImplementation(async (projectId) => { if (runner.busy) { gated = true; await gate; } return read(projectId); });
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Checked the label.' }), forThread());
  await f.app.projectWork.threads.message('project', threadId, 'owner', 'Check the label first.', false);
  await f.waitFor(() => gated); expect(f.thread(threadId).state).toBe('idle');
  await refused(await local(f, `/api/local/threads/${threadId}/attach`, ATTACH), 409, 'conflict', THREAD_WORKING);
  open(); spy.mockRestore();
  await f.waitFor(() => claude.turnStarts.length, (count) => count === 2); await rest(f, threadId);
  expect(states(f, threadId)).not.toContain('attached');
  const thread = f.thread(threadId); const home = f.homes.at('homes', 'claude', account.account.id);
  expect(thread.placement.accountId).toBe(account.account.id); expect(thread.nativeSessionId).toBeTruthy();

  // 2. Attach answers what the command needs, unredacted (the redactor knows the account secret), and only on this socket.
  const attachedResponse = await local(f, `/api/local/threads/${threadId}/attach`, ATTACH);
  expect(attachedResponse.status).toBe(200); expect(attachedResponse.headers.get('cache-control')).toBe('no-store');
  const view = ThreadAttachViewSchema.parse(await attachedResponse.json());
  expect(view).toEqual({ schema: 'thread-attach-v1', cwd: thread.cwd, runtime: 'claude', nativeSessionId: thread.nativeSessionId, model: 'scripted-model', effort: 'high',
    env: { HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_OAUTH_TOKEN: secret }, deviceName: f.deviceName });
  expect(f.app.redactor.text(secret)).not.toContain(secret);
  const attached = f.thread(threadId); const startedAt = attached.attach!.startedAt;
  expect(attached.state).toBe('attached'); expect(Date.parse(startedAt)).toBeLessThanOrEqual(Date.now());
  expect((await f.index(threadId))!.state).toBe('attached');
  const page = await f.json(`/api/projects/project/threads/${threadId}`, ThreadViewSchema);
  expect(page).toMatchObject({ canMessage: false, attach: { startedAt } }); expect(page.thread.state).toBe('attached');
  await refused(await local(f, `/api/local/threads/${threadId}/attach`, ATTACH), 409, 'conflict', alreadyAttached(threadId));

  // 3. While attached: the owner's API message waits, the coordinator is refused and queues nothing, no turn starts (D81).
  const sent = await f.request(`/api/projects/project/threads/${threadId}/messages`, 'POST',
    { schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text: 'Also rename the cancel button.', interrupt: false });
  expect(sent.status).toBe(202); expect(ThreadMessageReceiptSchema.parse(await sent.json()).repeated).toBe(false);
  await expect(f.app.projectWork.threads.message('project', threadId, 'coordinator', 'Hurry up.', false)).rejects.toMatchObject({ status: 409, message: THREAD_ATTACHED });
  await f.app.projectWork.pulse(); await f.app.projectWork.idle('project');
  expect(f.thread(threadId).queuedMessages.map((message) => [message.from, message.text])).toEqual([['owner', 'Also rename the cancel button.']]);
  expect(f.thread(threadId).state).toBe('attached'); expect(claude.turnStarts).toHaveLength(2);

  // 4. The terminal leaves a new session in the thread's directory (named through /var on macOS, where the worktree is under /private/var),
  // next to an older session there and a newer one in another directory: the new one is adopted.
  await delay(5);
  const alias = thread.cwd.startsWith('/private/') ? thread.cwd.slice('/private'.length) : thread.cwd;
  const adopted = journal('claude', home, alias);
  journal('claude', home, thread.cwd, Date.parse(startedAt) - 60_000);
  await delay(5); journal('claude', home, f.checkout);
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Renamed the cancel button.' }), forThread());
  const detached = await local(f, `/api/local/threads/${threadId}/detach`, { schema: 'thread-detach-request-v1', exitCode: null });
  expect(detached.status).toBe(200);
  expect(ThreadDetachViewSchema.parse(await detached.json())).toMatchObject({ schema: 'thread-detach-v1', adopted: true });
  expect(f.thread(threadId).nativeSessionId).toBe(adopted); expect(f.thread(threadId).attach).toBeUndefined();

  // 5. The coordinator hears the owner-worked line, then the waiting message runs as the next turn on the adopted session.
  expect(worked(f, threadId).map((event) => event.kind === 'thread-user-message' && event.text)).toEqual([ownerWorkedLine('Rename button')]);
  await f.waitFor(() => claude.turnStarts.length, (count) => count === 3); await rest(f, threadId);
  expect(claude.turnStarts[2]!.resume).toEqual({ sessionId: adopted });
  expect(claude.turnStarts[2]!.prompt).toBe('Also rename the cancel button.');
  expect(states(f, threadId).slice(-4)).toEqual(['attached', 'idle', 'running', 'idle']);
  expect(f.thread(threadId).queuedMessages).toEqual([]);

  // 6. A second detach (the command retried) changes nothing.
  expect(ThreadDetachViewSchema.parse(await (await local(f, `/api/local/threads/${threadId}/detach`, DETACH)).json())).toEqual({ schema: 'thread-detach-v1', adopted: false, state: 'idle' });
  expect(worked(f, threadId)).toHaveLength(1);
  // The session id and the account secret stay out of every browser answer, hub record and ledger.
  await expectNoLeaks(f);
  expect([...f.responses, f.ledgerText(), f.ledgerText(threadId), JSON.stringify(await f.index(threadId))].some((text) => text.includes(secret) || text.includes(adopted))).toBe(false);
});

test('a Codex thread in review attaches with its home only, keeps its session when the terminal left none, and concludes its merge after detach', { timeout: 120_000 }, async () => {
  const codex = named('codex');
  const f = await setup({ runtimes: { fake: new FakeRuntime(), codex } });
  f.app.hub.put('accounts', 'acc_codex', AccountSchema, { schema: 'account-v1', id: 'acc_codex', runtime: 'codex', label: 'Codex', kind: 'subscription', enabled: true, ceilingPct: 90,
    credential: 'per-device' }, 0);
  await f.app.accounts.check('acc_codex');
  codex.enqueueTurn(commitStep({ 'cancel.txt': 'cancel\n' }, { status: 'done', summary: 'Added the cancel copy.', changedFiles: ['cancel.txt'] }), forThread());
  const threadId = await start(f, 'Cancel copy', 'Add the cancel copy.', 'codex_fixture');
  await rest(f, threadId, 'in-review');
  const thread = f.thread(threadId); const home = f.homes.at('homes', 'codex', 'acc_codex');
  expect(thread.pr?.state).toBe('open');

  const view = ThreadAttachViewSchema.parse(await (await local(f, `/api/local/threads/${threadId}/attach`, ATTACH)).json());
  expect(view).toEqual({ schema: 'thread-attach-v1', cwd: thread.cwd, runtime: 'codex', nativeSessionId: thread.nativeSessionId, model: 'scripted-model', effort: 'high',
    env: { HOME: home, CODEX_HOME: home }, deviceName: f.deviceName });
  const startedAt = f.thread(threadId).attach!.startedAt;
  // A restart keeps the thread attached (brief 8.6); detach reaches the new daemon through its new control file.
  await f.restart();
  expect(f.thread(threadId)).toMatchObject({ state: 'attached', attach: { startedAt } });

  // Merged on GitHub while the owner works in the worktree: nothing concludes and the worktree stays (D297).
  f.github.markMerged(1); await f.app.projectWork.pulse(); await f.app.projectWork.idle('project');
  expect(f.thread(threadId).state).toBe('attached'); expect(f.thread(threadId).pr?.state).toBe('open'); expect(existsSync(thread.cwd)).toBe(true);

  // Only a session changed just before the attach (after the thread's own) is in the directory: the thread keeps its own.
  journal('codex', home, thread.cwd, Date.parse(startedAt) - 1);
  expect(ThreadDetachViewSchema.parse(await (await local(f, `/api/local/threads/${threadId}/detach`, DETACH)).json())).toEqual({ schema: 'thread-detach-v1', adopted: false, state: 'idle' });
  expect(f.thread(threadId).nativeSessionId).toBe(thread.nativeSessionId); expect(f.thread(threadId).state).toBe('idle');
  expect(worked(f, threadId).map((event) => event.kind === 'thread-user-message' && event.text)).toEqual([ownerWorkedLine('Cancel copy')]);
  expect(codex.turnStarts).toHaveLength(1);

  // The next poll concludes the merge as usual.
  await f.app.projectWork.pulse(); await f.app.projectWork.idle('project');
  expect(f.thread(threadId).state).toBe('done'); expect(f.thread(threadId).pr?.state).toBe('merged'); expect(existsSync(thread.cwd)).toBe(false);
});
