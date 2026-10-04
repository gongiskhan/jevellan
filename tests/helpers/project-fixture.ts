// Shared Projects integration harness (design 5.1.1, D48): a booted daemon on a real git origin with a GitHub-shaped remote
// redirected by `insteadOf` (D18), the fake GitHub server, FakeRuntime turns that report through the daemon's own bridge, and
// a signed-in browser session. Everything is simulated except git, HTTP, the ledgers and the process groups.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountSchema, CoordinatorStateSchema, Homes, ProjectSchema, ThreadLocalSchema, ThreadSchema, readDocument, type CoordinatorState, type DocumentSchema, type ModelOption, type Project,
  type Thread, type ThreadIndex, type ThreadLocal,
} from '../../packages/core/dist/index.js';
import { FakeRuntime, type FakeTurn, type FakeTurnStep } from '../../packages/runtime-contract/dist/index.js';
import type { ProjectTimers } from '../../packages/projects/dist/index.js';
import { Application, createDaemon } from '../../apps/daemon/dist/index.js';
import { startGitHubFixture, type GitHubFixture } from '../fixtures/github-server.mjs';

export type ProjectFixtureOptions = {
  /** Default true: `remote.origin.url` is `https://github.com/fixture/repo.git`, redirected to the bare origin by `insteadOf`. */
  github?: boolean;
  /** Default true; false removes the origin (publication `no-remote`). */
  remote?: boolean;
  /** Default true: the hub keeps a `fixture-<uuid>` GitHub token. */
  githubToken?: boolean;
  branchPolicy?: 'main' | 'external';
  /** Default null (no test command). */
  testCommand?: string | null;
  /** Default false: the fake runtime cannot enforce read-only turns, so the coordinator is unavailable (D97). */
  coordinator?: boolean;
  menu?: ModelOption[];
  /** Default `{ fake: new FakeRuntime() }`; `fake` must be present. */
  runtimes?: Record<string, FakeRuntime>;
  decisionFetch?: typeof fetch;
  projectTimers?: Partial<ProjectTimers>;
};

export const FIXTURE_MENU: ModelOption[] = [{ id: 'fixture', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated model.', efforts: ['high'], enabled: true }];
export const FIXTURE_REMOTE = 'https://github.com/fixture/repo.git';
const IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];

/** `git` with the fixture identity; output trimmed, stderr dropped, failures throw. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ProjectFixture = {
  readonly root: string; readonly homes: Homes; readonly fake: FakeRuntime; readonly runtimes: Record<string, FakeRuntime>;
  readonly origin: string; readonly checkout: string; readonly project: Project; readonly github: GitHubFixture; readonly token: string;
  /** Replaced by `restart()`: always read them from the fixture. */
  readonly app: Application; readonly server: Server; readonly base: string; readonly cookie: string; readonly deviceName: string;
  git(cwd: string, ...args: string[]): string;
  /** A browser request with the session cookie and the daemon's own Origin. */
  request(path: string, method?: string, body?: unknown): Promise<Response>;
  /** Every response `request` received, as `<method> <path> <status> <body>`, for leak checks; event streams are not read. */
  readonly responses: readonly string[];
  /** A request that must succeed (2xx), parsed with `schema`. */
  json<T>(path: string, schema: DocumentSchema<T>, method?: string, body?: unknown): Promise<T>;
  /** `thread.json` on disk. */
  thread(threadId: string): Thread;
  /** `thread-local.json` on disk. */
  local(threadId: string): ThreadLocal;
  /** The hub's thread index. */
  index(threadId: string): Promise<ThreadIndex | undefined>;
  /** `coordinator.json` on disk. */
  coordinatorState(): CoordinatorState;
  /** Raw JSONL text of a ledger: the coordinator's when no thread id. */
  ledgerText(threadId?: string): string;
  /** Closes the server and the application, runs `between` while nothing runs, then boots a new application on the same homes. */
  restart(between?: () => void | Promise<void>): Promise<void>;
  waitFor<T>(read: () => T | Promise<T>, accept?: (value: T) => boolean, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
};

/**
 * Setup order of `tests/conversation-service.test.ts`: bare origin on `main`, clone, repo-local identity, seed `value.txt`, push;
 * GitHub-shaped remote; fake GitHub; `Application` with `timers: false`; menu, account, token, project; daemon; session.
 */
export async function projectFixture(options: ProjectFixtureOptions = {}): Promise<ProjectFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-projects-'))); mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'data'), join(root, 'user'));
  const origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin);
  const checkout = join(root, 'project'); git(root, 'clone', origin, checkout);
  git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(checkout, 'value.txt'), '1\n'); git(checkout, 'add', '-A'); git(checkout, 'commit', '-m', 'Seed'); git(checkout, 'push', '-u', 'origin', 'main');
  if (options.remote === false) git(checkout, 'remote', 'remove', 'origin');
  else if (options.github !== false) { git(checkout, 'remote', 'set-url', 'origin', FIXTURE_REMOTE); git(checkout, 'config', `url.${origin}.insteadOf`, FIXTURE_REMOTE); }
  const token = `fixture-${randomUUID()}`;
  const github = await startGitHubFixture({ token, repositories: { 'fixture/repo': origin } });
  const runtimes = options.runtimes ?? { fake: new FakeRuntime() };
  const fake = runtimes.fake; if (!fake) throw new Error('The project fixture needs a fake runtime.');
  if (options.coordinator) fake.capabilities.readOnlyEnforced = true;
  const boot = () => new Application({ homes, timers: false, repositoryVisibility: async () => 'PUBLIC', runtimes: () => new Map(Object.entries(runtimes)), githubBaseUrl: github.url,
    ...(options.decisionFetch ? { decisionFetch: options.decisionFetch } : {}), projectTimers: { periodic: false, coordinatorStartMs: 0, coordinatorRetryMs: 50, ...options.projectTimers } });
  const listen = async (app: Application) => {
    const server = createDaemon({ application: app }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  let app = boot(); await app.started;
  const config = app.hub.configuration.current()!;
  for (const id of Object.keys(runtimes)) config.configuration['x-jevellan'].runtimes[id] = { enabled: true };
  config.configuration['x-jevellan'].menu = options.menu ?? FIXTURE_MENU;
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  app.hub.put('accounts', 'acc_fixture', AccountSchema, { schema: 'account-v1', id: 'acc_fixture', runtime: 'fake', label: 'Fixture', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0);
  await app.accounts.check('acc_fixture');
  if (options.githubToken !== false) await app.state.github.put(token);
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Shop', paths: { [app.device.deviceId]: checkout }, branchPolicy: options.branchPolicy ?? 'main',
    ...(options.testCommand ? { testCommand: options.testCommand } : {}), memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project });
  let { server, base } = await listen(app);
  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'disposable projects passphrase' }) });
  if (setup.status !== 200) throw new Error(`Session setup failed with ${setup.status}.`);
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  if (await app.presence.pulse() === null) throw new Error('The fixture device did not report its heartbeat.');
  const ledger = (dir: string) => {
    const folder = join(dir, 'ledger'); if (!existsSync(folder)) return '';
    return readdirSync(folder).filter((name) => name.endsWith('.jsonl')).sort().map((name) => readFileSync(join(folder, name), 'utf8')).join('');
  };
  const responses: string[] = [];
  const fixture: ProjectFixture = {
    root, homes, fake, runtimes, origin, checkout, project, github, token, cookie, responses,
    get app() { return app; }, get server() { return server; }, get base() { return base; }, get deviceName() { return app.device.name; },
    git,
    async request(path, method = 'GET', body) {
      const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.headers.get('content-type')?.includes('text/event-stream')) responses.push(`${method} ${path} ${response.status} ${await response.clone().text()}`);
      return response;
    },
    async json(path, schema, method = 'GET', body) {
      const response = await fixture.request(path, method, body); const value: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${JSON.stringify(value)}`);
      return schema.parse(value);
    },
    thread: (threadId) => readDocument(app.projectWork.paths.threadFile(project.id, threadId), ThreadSchema),
    local: (threadId) => readDocument(app.projectWork.paths.threadLocal(project.id, threadId), ThreadLocalSchema),
    index: async (threadId) => (await app.projectHub.thread(threadId))?.document,
    coordinatorState: () => readDocument(app.projectWork.paths.coordinator(project.id), CoordinatorStateSchema),
    ledgerText: (threadId) => ledger(threadId === undefined ? app.projectWork.paths.project(project.id) : app.projectWork.paths.thread(project.id, threadId)),
    async restart(between) {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await app.close();
      await between?.();
      app = boot(); await app.started; ({ server, base } = await listen(app));
      if (await app.presence.pulse() === null) throw new Error('The restarted device did not report its heartbeat.');
    },
    async waitFor(read, accept = Boolean, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await read(); if (accept(value)) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting: ${JSON.stringify(value)}`);
        await delay(20);
      }
    },
    async close() {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      await app.close().catch(() => undefined);
      for (const runtime of Object.values(runtimes)) await runtime.close();
      await github.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

/**
 * A thread turn that writes `files` in its worktree, commits them with the fixture identity (an empty commit when nothing
 * changed, so verification still runs), runs `extra`, then reports through the daemon bridge.
 */
export function commitStep(files: Record<string, string>, report: object, extra?: (turn: FakeTurn) => Promise<void>): FakeTurnStep {
  return async (turn) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(turn.input.cwd, name), content);
    git(turn.input.cwd, 'add', '-A'); git(turn.input.cwd, 'commit', '--allow-empty', '-m', 'Work');
    await extra?.(turn);
    await turn.bridge('jevellan_thread_report', report);
    return { status: 'completed' };
  };
}
/** A turn that reports `report` through the bridge without touching files. */
export function reportStep(report: object): FakeTurnStep {
  return async (turn) => { await turn.bridge('jevellan_thread_report', report); return { status: 'completed' }; };
}
/** A turn that waits for `release` (or its abort), after `before`. */
export function holdStep(release: Promise<void>, before?: (turn: FakeTurn) => Promise<void>): FakeTurnStep {
  return async (turn) => {
    await before?.(turn);
    await Promise.race([release, new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve(), { once: true }))]);
    return { status: 'completed' };
  };
}
/** A promise that never settles (a turn held until it is interrupted). */
export const never = (): Promise<void> => new Promise<void>(() => undefined);
