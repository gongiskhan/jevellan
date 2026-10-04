import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import {
  AccountSchema, ContextPanelSchema, Homes, MergeResultViewSchema, ProjectSchema, ProjectVisibilitySchema, ProjectWorkListViewSchema, ProjectWorkViewSchema, ThreadCreatedViewSchema,
  ThreadIndexSchema, ThreadMessageReceiptSchema, ThreadViewSchema, type Project,
} from '../packages/core/dist/index.js';
import { HubProjectAccess, HubUnavailable } from '../packages/mesh/dist/index.js';
import { FakeRuntime, forThread, type FakeTurnStep } from '../packages/runtime-contract/dist/index.js';
import {
  DISCARD_REFUSED, MESSAGE_ID_REUSED, NO_PULL_REQUEST, PROJECT_NOT_FOUND, REMOTE_THREADS_LATER, START_REQUEST_REUSED, STOPPED_BY_YOU, THREAD_ENDED, THREAD_NOT_FOUND, isDiscarded,
} from '../packages/projects/dist/index.js';
import { Application, createDaemon, projectWorkRoute } from '../apps/daemon/dist/index.js';
import { startGitHubFixture, type GitHubFixture } from './fixtures/github-server.mjs';

const METHOD = 'This operation does not support that method.';

test('the Projects route table is closed: exact paths, ids validated, 405 for known paths, other project routes left alone', () => {
  const thread = (suffix: string) => `/api/projects/proj_a/threads/thread_1${suffix}`;
  expect(projectWorkRoute('/api/project-work', 'GET')).toEqual({ name: 'list', target: 'any' });
  expect(projectWorkRoute('/api/projects/proj_a/work', 'GET')).toEqual({ name: 'view', target: 'any', projectId: 'proj_a' });
  expect(projectWorkRoute('/api/projects/proj_a/threads', 'POST')).toEqual({ name: 'thread-create', target: 'coordinator', projectId: 'proj_a' });
  expect(projectWorkRoute(thread(''), 'GET')).toEqual({ name: 'thread', target: 'owner', projectId: 'proj_a', threadId: 'thread_1' });
  for (const [suffix, name] of [['/messages', 'thread-message'], ['/stop', 'thread-stop'], ['/discard', 'thread-discard'], ['/allow-turns', 'thread-allow'], ['/pr/merge', 'pr-merge'], ['/pr/refresh', 'pr-refresh']]) {
    expect(projectWorkRoute(thread(suffix!), 'POST')).toEqual({ name, target: 'owner', projectId: 'proj_a', threadId: 'thread_1' });
  }
  // Paths owned by api.ts, and near misses, are not Projects routes.
  for (const path of ['/api/projects/proj_a/visibility', '/api/projects/proj_a/context', '/api/projects/proj_a/context/operations', '/api/projects/proj_a/memory', '/api/project-folders',
    '/api/project-work/', '/api/projects/proj_a/work/x', '/api/projects/proj_a', thread('/pr'), thread('/pr/close'), thread('/messages/1'), '/api/projects/a/b/threads', '/hub/projects']) {
    expect(projectWorkRoute(path, 'GET'), path).toBeNull(); expect(projectWorkRoute(path, 'POST'), path).toBeNull();
  }
  for (const [path, method] of [['/api/project-work', 'POST'], ['/api/project-work', 'HEAD'], ['/api/projects/proj_a/work', 'PUT'], ['/api/projects/proj_a/threads', 'GET'],
    [thread(''), 'POST'], [thread('/messages'), 'GET'], [thread('/pr/merge'), 'GET'], [thread('/stop'), 'DELETE']]) {
    expect(() => projectWorkRoute(path!, method!), `${method} ${path}`).toThrow(expect.objectContaining({ message: METHOD, status: 405 }));
  }
  // Encoded slashes and dot segments never match a row (the URL parser resolves real dot segments before routing).
  for (const path of ['/api/projects/..%2Fx/work', '/api/projects/a%2Fb/work', thread('%2Fstop'), '/api/projects/proj_a/threads/..%2F..%2Fx', '/api/projects/proj_a/threads/.%2E',
    '/api/projects/../work', '/api/projects/./work', '/api/projects/proj_a/threads/../work', '/api/projects/proj_a/threads/./stop']) {
    expect(projectWorkRoute(path, 'GET'), path).toBeNull(); expect(projectWorkRoute(path, 'POST'), path).toBeNull();
  }
  expect(() => projectWorkRoute('/api/projects/-proj/work', 'GET')).toThrow(ZodError);
  expect(() => projectWorkRoute(`/api/projects/proj_a/threads/${'t'.repeat(129)}`, 'GET')).toThrow(ZodError);
});

let root: string; let homes: Homes; let app: Application; let fake: FakeRuntime; let github: GitHubFixture; let server: Server; let base: string; let cookie: string;
let checkout: string; let project: Project; let githubCalls: number;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const empty = { schema: 'empty-request-v1' };
function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}${route}`, { method, headers: { Cookie: cookie, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function call(route: string, method: string, body: unknown, status: number): Promise<unknown> {
  const response = await request(route, method, body); const value: unknown = await response.json();
  expect(response.status, `${method} ${route}: ${JSON.stringify(value)}`).toBe(status);
  return value;
}
const refused = (code: string, message: string) => ({ schema: 'error-v1', code, message });
const commit = (files: Record<string, string>, report: object): FakeTurnStep => async (turn) => {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(turn.input.cwd, name), content);
  git(turn.input.cwd, 'add', '-A'); git(turn.input.cwd, 'commit', '-m', 'Work');
  await turn.bridge('jevellan_thread_report', report); return { status: 'completed' };
};
const hold = (): FakeTurnStep => async ({ signal }) => { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); return { status: 'completed' }; };
const create = (title: string, clientRequestId: string) => ({ schema: 'thread-create-request-v1', clientRequestId, title, task: `Do ${title}.` });
const message = (clientMessageId: string, text: string) => ({ schema: 'thread-message-request-v1', clientMessageId, text, interrupt: false });

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-project-work-api-'))); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user'));
  const origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin); checkout = join(root, 'project'); git(root, 'clone', origin, checkout);
  git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(checkout, 'value.txt'), '1\n'); git(checkout, 'add', '-A'); git(checkout, 'commit', '-m', 'Seed'); git(checkout, 'push', '-u', 'origin', 'main');
  git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/fixture/repo.git'); git(checkout, 'config', `url.${origin}.insteadOf`, 'https://github.com/fixture/repo.git');
  const token = `fixture-${randomUUID()}`; github = await startGitHubFixture({ token, repositories: { 'fixture/repo': origin } }); githubCalls = 0;
  fake = new FakeRuntime();
  app = new Application({ homes, timers: false, repositoryVisibility: async () => 'PUBLIC', runtimes: () => new Map([['fake', fake]]), githubBaseUrl: github.url,
    githubFetch: (input, init) => { githubCalls += 1; return fetch(input, init); } });
  await app.started;
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].runtimes.fake = { enabled: true };
  config.configuration['x-jevellan'].menu = [{ id: 'fixture-model', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated model', efforts: ['high'], enabled: true }];
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  app.hub.put('accounts', 'acc_fixture', AccountSchema, { schema: 'account-v1', id: 'acc_fixture', runtime: 'fake', label: 'Fixture', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0);
  await app.accounts.check('acc_fixture');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Shop', paths: { [app.device.deviceId]: checkout }, branchPolicy: 'main', testCommand: 'test -f greeting.txt',
    memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project });
  server = createDaemon({ application: app }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'disposable projects passphrase' }) });
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  await call('/hub/secrets/github', 'PUT', { schema: 'save-secret-v1', value: token }, 200);
});
afterEach(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await app.close(); await fake.close(); await github.close();
  rmSync(root, { recursive: true, force: true });
});

test('Projects routes need the session, answer versioned documents, run a thread to a merged pull request, and leave the other project routes working', { timeout: 120_000 }, async () => {
  // Authentication comes first, and the existing project routes still answer.
  expect((await fetch(`${base}/api/project-work`)).status).toBe(401);
  expect((await fetch(`${base}/api/projects/project/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(create('Nope', 'req_anon')) })).status).toBe(401);
  expect(ProjectVisibilitySchema.parse(await call('/api/projects/project/visibility', 'GET', undefined, 200))).toMatchObject({ projectId: 'project', visibility: 'PUBLIC' });
  expect(await call('/api/projects/project/context', 'GET', undefined, 200)).toMatchObject({ projectId: 'project' });
  ContextPanelSchema.parse(await call('/api/projects/project/context/operations', 'GET', undefined, 200));
  expect(await call('/api/projects/project/memory', 'GET', undefined, 400)).toEqual(refused('request-failed', 'Enter a memory search.'));
  expect(await call('/api/projects/project/notebook', 'GET', undefined, 404)).toEqual(refused('not-found', 'Not found.'));

  const before = { head: git(checkout, 'rev-parse', 'HEAD'), status: git(checkout, 'status', '--porcelain=v1') };
  expect(ProjectWorkListViewSchema.parse(await call('/api/project-work', 'GET', undefined, 200)).projects)
    .toEqual([{ projectId: 'project', name: 'Shop', waiting: 0, running: 0, inReview: 0, coordinator: { deviceId: null, state: 'none' } }]);
  expect(ProjectWorkViewSchema.parse(await call('/api/projects/project/work', 'GET', undefined, 200))).toMatchObject({ project: { id: 'project', name: 'Shop', baseBranch: 'main' }, threads: [] });
  expect(await call('/api/projects/missing/work', 'GET', undefined, 404)).toEqual(refused('not-found', PROJECT_NOT_FOUND));
  expect(await call('/api/projects/project/threads', 'GET', undefined, 405)).toEqual(refused('request-failed', METHOD));
  expect(await call('/api/projects/project/threads', 'POST', { schema: 'thread-create-request-v1', title: 'No task' }, 400)).toEqual(refused('request-failed', 'Check the submitted fields.'));
  // A hub outage is retryable only for requests that carry a client id.
  const outage = new HubUnavailable('Fixture hub');
  const start = vi.spyOn(app.projectWork, 'createThread').mockRejectedValueOnce(outage);
  expect(await call('/api/projects/project/threads', 'POST', create('Outage', 'req_outage'), 503)).toEqual({ schema: 'error-v1', code: 'hub-unavailable', retryable: true, message: outage.message });
  start.mockRestore();

  // An owner thread: its report arrives through the daemon's own bridge route, publication uses the injected GitHub transport.
  fake.enqueueTurn(commit({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt.' }), forThread());
  const created = ThreadCreatedViewSchema.parse(await call('/api/projects/project/threads', 'POST', create('Add greeting', 'req_api_1'), 201));
  expect(created).toMatchObject({ state: 'preparing', placement: expect.stringContaining('placed without Jev') });
  const { threadId } = created;
  expect(ThreadCreatedViewSchema.parse(await call('/api/projects/project/threads', 'POST', create('Add greeting', 'req_api_1'), 201)).threadId).toBe(threadId);
  expect(await call('/api/projects/project/threads', 'POST', create('Something else', 'req_api_1'), 409)).toEqual(refused('conflict', START_REQUEST_REUSED));
  await app.projectWork.idle('project');
  const thread = app.projectWork.store.get(threadId)!;
  expect(thread).toMatchObject({ state: 'in-review', pr: { number: 1, state: 'open' }, lastReport: { status: 'done', summary: 'Added greeting.txt.', synthesized: false } });
  expect(githubCalls).toBeGreaterThan(0); expect(github.pulls).toHaveLength(1);
  const view = ThreadViewSchema.parse(await call(`/api/projects/project/threads/${threadId}`, 'GET', undefined, 200));
  expect(view).toMatchObject({ thread: { id: threadId, state: 'in-review' }, reports: [{ status: 'done', synthesized: false }], canMessage: true, queuedMessages: [], deviceName: app.device.name });
  // No native session id and no worktree path leave the owner device.
  for (const route of ['/api/project-work', '/api/projects/project/work', `/api/projects/project/threads/${threadId}`]) {
    const text = await (await request(route)).text();
    expect(text).not.toContain(thread.nativeSessionId!); expect(text).not.toContain(thread.cwd);
  }
  expect(ProjectWorkListViewSchema.parse(await call('/api/project-work', 'GET', undefined, 200)).projects[0]).toMatchObject({ inReview: 1, coordinator: { deviceId: app.device.deviceId, state: 'idle' } });

  // Pull request routes: refresh answers the thread view, merge squashes and concludes, then the thread refuses more work.
  github.setChecks(1, 'passing');
  expect(ThreadViewSchema.parse(await call(`/api/projects/project/threads/${threadId}/pr/refresh`, 'POST', empty, 202)).thread.pr).toMatchObject({ number: 1, checks: 'passing' });
  expect(MergeResultViewSchema.parse(await call(`/api/projects/project/threads/${threadId}/pr/merge`, 'POST', empty, 200))).toMatchObject({ merged: true });
  await app.projectWork.idle('project');
  expect(app.projectWork.store.get(threadId)).toMatchObject({ state: 'done', pr: { state: 'merged' } });
  expect(await call(`/api/projects/project/threads/${threadId}/messages`, 'POST', message('msg_late', 'More.'), 409)).toEqual(refused('conflict', THREAD_ENDED));
  expect(await call(`/api/projects/project/threads/${threadId}/discard`, 'POST', empty, 409)).toEqual(refused('conflict', DISCARD_REFUSED));
  expect(ThreadViewSchema.parse(await call(`/api/projects/project/threads/${threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' }, 202)).thread.state).toBe('done');
  expect({ head: git(checkout, 'rev-parse', 'HEAD'), status: git(checkout, 'status', '--porcelain=v1') }).toEqual(before);

  // A running thread: messages wait and repeat by client id, stop and discard answer the view, allow-turns is a no-op there.
  fake.enqueueTurn(hold(), forThread());
  const held = ThreadCreatedViewSchema.parse(await call('/api/projects/project/threads', 'POST', create('Long work', 'req_api_2'), 201)).threadId;
  const route = `/api/projects/project/threads/${held}`;
  for (let tries = 0; app.projectWork.store.get(held)?.state !== 'running'; tries += 1) { expect(tries).toBeLessThan(400); await new Promise((resolve) => setTimeout(resolve, 25)); }
  expect(ThreadMessageReceiptSchema.parse(await call(`${route}/messages`, 'POST', message('msg_1', 'Also add tests.'), 202))).toEqual({ schema: 'thread-message-receipt-v1', repeated: false });
  expect(await call(`${route}/messages`, 'POST', message('msg_1', 'Also add tests.'), 202)).toEqual({ schema: 'thread-message-receipt-v1', repeated: true });
  expect(await call(`${route}/messages`, 'POST', message('msg_1', 'Other text.'), 409)).toEqual(refused('conflict', MESSAGE_ID_REUSED));
  expect(ThreadViewSchema.parse(await call(route, 'GET', undefined, 200)).queuedMessages.map((entry) => entry.id)).toEqual(['msg_1']);
  expect(await call(`${route}/pr/merge`, 'POST', empty, 409)).toEqual(refused('conflict', NO_PULL_REQUEST));
  expect(await call(`${route}/stop`, 'POST', {}, 400)).toEqual(refused('request-failed', 'Check the submitted fields.'));
  const stop = vi.spyOn(app.projectWork, 'stopThread').mockRejectedValueOnce(outage);
  expect(await call(`${route}/stop`, 'POST', { schema: 'thread-stop-request-v1' }, 503)).toEqual({ schema: 'error-v1', code: 'hub-unavailable', retryable: false, message: outage.message });
  stop.mockRestore();
  const stopped = ThreadViewSchema.parse(await call(`${route}/stop`, 'POST', { schema: 'thread-stop-request-v1' }, 202));
  expect(stopped).toMatchObject({ thread: { state: 'stopped', stateReason: STOPPED_BY_YOU }, canMessage: false, canDiscard: true });
  expect(ThreadViewSchema.parse(await call(`${route}/allow-turns`, 'POST', empty, 202)).turnAllowance).toBe(stopped.turnAllowance);
  expect(ThreadViewSchema.parse(await call(`${route}/pr/refresh`, 'POST', empty, 202)).thread.state).toBe('stopped');
  const discarded = ThreadViewSchema.parse(await call(`${route}/discard`, 'POST', empty, 202));
  expect(isDiscarded(discarded.thread.stateReason)).toBe(true); expect(discarded.canDiscard).toBe(false);

  // Unknown threads are not found; a thread owned by another device is refused until phase 5.
  expect(await call('/api/projects/project/threads/thread_missing', 'GET', undefined, 404)).toEqual(refused('not-found', THREAD_NOT_FOUND));
  expect(await call('/api/projects/project/threads/thread_missing/stop', 'POST', { schema: 'thread-stop-request-v1' }, 404)).toEqual(refused('not-found', THREAD_NOT_FOUND));
  const at = new Date().toISOString();
  await new HubProjectAccess(app.hub, 'dev_other').publishThread(ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id: 'thread_remote', projectId: 'project', title: 'Elsewhere',
    state: 'idle', isolation: 'worktree', ownerDeviceId: 'dev_other', runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture', turns: 1, createdAt: at, updatedAt: at }), 1);
  expect(await call('/api/projects/project/threads/thread_remote', 'GET', undefined, 409)).toEqual(refused('conflict', REMOTE_THREADS_LATER));
  expect(await call('/api/projects/other/threads/thread_remote', 'GET', undefined, 404)).toEqual(refused('not-found', THREAD_NOT_FOUND));
});
