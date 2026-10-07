import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSchema, AccountStatusSchema, BridgeToolsSchema, Homes, SecretRedactor, projectToolNames, type Account, type AccountStatus } from '../packages/core/dist/index.js';
import { StretchBridges } from '../packages/conversations/dist/index.js';
import { FakeRuntime, forThread, groupAlive, type FakeTurnStep, type NativeProcess } from '../packages/runtime-contract/dist/index.js';
import {
  ACCOUNT_BUSY, ProjectLedgers, ProjectPaths, ProjectTools, REPORT_ALREADY_SENT, TOOL_NOT_IN_TURN, TURN_ENDED, TurnExecution, TurnLauncher, cannotRunHere, noTurnAccount,
  type LaunchRequest, type ProjectScope, type ProjectToolHandlers,
} from '../packages/projects/dist/index.js';

let root: string; let homes: Homes; let redactor: SecretRedactor; let fake: FakeRuntime;
const thread: ProjectScope = { kind: 'thread', projectId: 'proj_a', threadId: 'thread_a', turn: 2, isolation: 'worktree' };
const coordinator: ProjectScope = { kind: 'coordinator', projectId: 'proj_a', turn: 4 };
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-turns-'))); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); redactor = new SecretRedactor(); fake = new FakeRuntime();
});
afterEach(async () => { await fake.close(); await rm(root, { recursive: true, force: true }); });

function tools(scope: ProjectScope, over: Partial<ProjectToolHandlers> & { current?: () => boolean } = {}, ledger?: ConstructorParameters<typeof ProjectTools>[3]) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const handlers: ProjectToolHandlers = {
    isCurrent: over.current ?? (() => true),
    call: over.call ?? (async (_scope, name, input) => { calls.push({ name, input }); return { schema: 'notebook-read-result-v1', content: 'Plan', revision: 2 }; }),
    memory: over.memory ?? (() => ({ search: async () => ({ schema: 'memory-search-v1', notes: [] }), read: async (permalink) => ({ schema: 'memory-note-v1', title: 'Note', permalink, content: 'Body', unresolved: false }) })),
    ...(over.line ? { line: over.line } : {}),
  };
  return { tools: new ProjectTools(scope, handlers, redactor, ledger), calls };
}
const rejects = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal'); }, (error: unknown) => error as Error & { status?: number });

test('thread tools accept exactly one report per turn, an identical retry repeats its receipt, and inputs fail with one field sentence (brief 7.2, D19)', async () => {
  const { tools: scope } = tools(thread);
  expect(scope.list().tools.map((tool) => tool.name)).toEqual(['jevellan_thread_report', 'jevellan_app_start', 'jevellan_app_stop', 'jevellan_apps_list', 'memory_search', 'memory_read']);
  const report = { status: 'done', summary: 'Added greeting.txt.', testsRun: { command: 'npm test', passed: true, summary: 'ok' } };
  expect(await scope.call('jevellan_thread_report', report)).toEqual({ schema: 'bridge-result-v1', result: { schema: 'thread-report-result-v1', turn: 2, status: 'done', accepted: true, repeated: false } });
  // The retry with the defaults spelled out is the same report.
  expect((await scope.call('jevellan_thread_report', { ...report, changedFiles: [] })).result).toMatchObject({ repeated: true });
  expect(await rejects(scope.call('jevellan_thread_report', { ...report, summary: 'Something else.' }))).toMatchObject({ message: REPORT_ALREADY_SENT, status: 409 });
  expect(scope.report).toEqual({ schema: 'thread-report-v1', turn: 2, status: 'done', summary: 'Added greeting.txt.', testsRun: { command: 'npm test', passed: true, summary: 'ok' }, changedFiles: [], synthesized: false });

  const { tools: fresh } = tools(thread);
  expect(await rejects(fresh.call('jevellan_thread_report', { status: 'needs-decision', summary: 'One choice left.' })))
    .toMatchObject({ status: 400, message: 'question: A needs-decision report needs a question. Check the tool input.' });
  expect((await rejects(fresh.call('jevellan_thread_report', { status: 'done', summary: 'x', extra: 1 }))).message).toMatch(/^Unrecognized key.*"extra"\. Check the tool input\.$/);
  expect((await rejects(fresh.call('jevellan_thread_report', { status: 'done', summary: 'x'.repeat(1201) }))).message).toMatch(/^summary: .*1200.*\. Check the tool input\.$/);
  expect((await rejects(fresh.call('jevellan_thread_report', { status: 'later', summary: 'x' }))).message).toMatch(/^status: .*\. Check the tool input\.$/);
  // Arguments are redacted before they are stored.
  redactor.add('fixture-secret-value-0001');
  await fresh.call('jevellan_thread_report', { status: 'progress', summary: 'Token fixture-secret-value-0001 seen.' });
  expect(fresh.report?.summary).toBe('Token [redacted] seen.');
  // Memory reads go through the scope's reader; the hook gets a valid answer and queues nothing.
  expect((await fresh.call('memory_read', { permalink: 'notes/plan' })).result).toMatchObject({ schema: 'memory-note-v1', permalink: 'notes/plan' });
  expect(await fresh.capture()).toEqual({ schema: 'bridge-result-v1', result: { queued: false, reason: 'disabled' } });
});

test('a turn token works only for its listed tools and only while its turn is current', async () => {
  let current = true;
  const { tools: scope, calls } = tools(thread, { current: () => current });
  expect(await rejects(scope.call('jevellan_thread_start', { title: 'x', task: 'y' }))).toMatchObject({ message: TOOL_NOT_IN_TURN, status: 403 });
  expect(await rejects(scope.call('jevellan_mail_inbox', {}))).toMatchObject({ status: 403 });
  current = false;
  expect(() => scope.list()).toThrow(TURN_ENDED);
  expect(await rejects(scope.call('memory_search', { query: 'x' }))).toMatchObject({ message: TURN_ENDED, status: 401 });
  const { tools: lead } = tools(coordinator);
  expect(lead.list().tools.map((tool) => tool.name)).toEqual(projectToolNames({ kind: 'coordinator' }));
  expect(await rejects(lead.call('jevellan_thread_report', { status: 'done', summary: 'x' }))).toMatchObject({ status: 403 });
  expect((await lead.call('jevellan_notebook_read', {})).result).toEqual({ schema: 'notebook-read-result-v1', content: 'Plan', revision: 2 });
  expect(calls).toEqual([]);
  // Through the shared registry: the same token rules, and a closed grant is gone.
  const bridges = new StretchBridges(redactor); const grant = bridges.issueTools(lead);
  expect(await bridges.request(grant.token, { schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_notebook_read', arguments: {} })).toMatchObject({ result: { revision: 2 } });
  await grant.close();
  expect(await rejects(bridges.request(grant.token, { schema: 'bridge-request-v1', operation: 'list' }))).toMatchObject({ status: 401 });
  expect(await rejects(lead.call('jevellan_notebook_read', {}))).toMatchObject({ message: TURN_ENDED, status: 401 });
});

test('coordinator calls leave one ledger line each, ok or not, and a line that cannot be written never fails the call', async () => {
  const ledger = new ProjectLedgers(new ProjectPaths(homes)).coordinator('proj_a');
  const { tools: lead } = tools(coordinator, {
    call: async (_scope, name) => { if (name === 'jevellan_thread_stop') throw Object.assign(new Error('This thread was not found.'), { status: 404 }); return { schema: 'notebook-read-result-v1', content: '', revision: 0 }; },
    line: (name, _input, outcome) => ({ summary: outcome.ok ? `Used ${name}` : `Failed ${name}: ${outcome.error}` }),
  }, ledger);
  await lead.call('jevellan_notebook_read', {});
  await rejects(lead.call('jevellan_thread_stop', { threadId: 'thread_x', reason: 'Done.' }));
  await rejects(lead.call('jevellan_thread_stop', { threadId: 'bad id', reason: 'Done.' }));
  expect(ledger.events().map((event) => [event.type, event.turn, event.data])).toEqual([
    ['coordinator-tool', 4, { schema: 'coordinator-tool-v1', tool: 'jevellan_notebook_read', ok: true, summary: 'Used jevellan_notebook_read' }],
    ['coordinator-tool', 4, { schema: 'coordinator-tool-v1', tool: 'jevellan_thread_stop', ok: false, summary: 'Failed jevellan_thread_stop: This thread was not found.' }],
    ['coordinator-tool', 4, expect.objectContaining({ ok: false, summary: expect.stringMatching(/^Failed jevellan_thread_stop: threadId: .*Check the tool input\.$/) })],
  ]);
  const { tools: broken } = tools(coordinator, { line: () => { throw new Error('no line'); } }, ledger);
  expect((await broken.call('jevellan_notebook_read', {})).result).toMatchObject({ revision: 2 });
});

const account = (id: string): Account => AccountSchema.parse({ schema: 'account-v1', id, runtime: 'fake', label: id === 'acc_work' ? 'Work' : 'Home', kind: 'subscription', enabled: true, credential: 'per-device' });
const status = (id: string, over: Partial<AccountStatus> = {}): AccountStatus => AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: id, deviceId: 'dev_a', auth: 'ready', observedAt: new Date().toISOString(), ...over });
function launcher(statuses: AccountStatus[], url = 'http://127.0.0.1:4100') {
  const used: string[] = []; const bridges = new StretchBridges(redactor); const accountRuns = new Set<string>();
  const value = new TurnLauncher({
    accounts: {
      list: async () => ['acc_work', 'acc_home'].map((id) => ({ schema: 'account-view-v1' as const, revision: 1, account: account(id), statuses: statuses.filter((entry) => entry.accountId === id) })),
      resolve: async (id) => ({ account: account(id), home: homes.ensure('homes', 'fake', id), env: {} }), markUsed: async (id) => { used.push(id); },
    }, runtimes: new Map([['fake', fake]]), accountRuns, riggingItems: async () => [], bridges, homes, deviceId: 'dev_a', deviceName: 'Mac mini', daemonUrl: () => url, redactor,
  });
  return { launcher: value, used, bridges, accountRuns };
}
function request(over: Partial<LaunchRequest> = {}): LaunchRequest {
  return { owner: { kind: 'thread', projectId: 'proj_a', id: 'thread_a' }, turn: 2, runtime: 'fake', modelId: 'fixture', model: 'scripted-model', modelLabel: 'Fixture', effort: 'high',
    permissions: 'write', cwd: root, systemAppend: 'Append.', prompt: (resumed) => resumed ? 'Next.' : 'Task: T\n\nDo it.\n\n---\n\nNext.', safetyProfile: 'thread', timeoutMs: 5000,
    tools: tools(thread).tools, ...over };
}
const done: FakeTurnStep = () => ({ status: 'completed' });

test('the launcher keeps a session on its account, starts fresh on another eligible one, and passes the scoped bridge and the git identity (D15, D16, D94)', async () => {
  const repo = join(root, 'repo'); execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, 'config', 'user.name', 'Owner']); execFileSync('git', ['-C', repo, 'config', 'user.email', 'owner@example.invalid']);
  const { launcher: value, used, bridges } = launcher([status('acc_work'), status('acc_home')]);
  fake.enqueueTurn(done, forThread()); fake.enqueueTurn(done, forThread());
  const kept = await value.launch(request({ pinnedAccountId: 'acc_home', resume: 'session-1', gitIdentityFrom: repo }));
  if (kept.kind !== 'started') throw new Error(kept.reason);
  expect(kept).toMatchObject({ accountId: 'acc_home', accountLabel: 'Home', accountChanged: false, resumed: true, secretRef: null, gitIdentity: { name: 'Owner', email: 'owner@example.invalid' } });
  const input = fake.turnStarts[0]!;
  expect(input).toMatchObject({ owner: { kind: 'thread', id: 'thread_a' }, turn: 2, permissions: 'write', safetyProfile: 'thread', resume: { sessionId: 'session-1' }, prompt: 'Next.', model: 'scripted-model', effort: 'high' });
  expect(input.launch.env).toEqual({ JEVELLAN_STRETCH_TOKEN: expect.any(String), JEVELLAN_DAEMON_URL: 'http://127.0.0.1:4100', GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid',
    GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  expect(input.launch.mcpServers.jevellan).toMatchObject({ command: process.execPath, args: [expect.stringMatching(/bin\/jevellan\.mjs$/), 'mcp-bridge'], env: input.launch.env });
  expect(BridgeToolsSchema.parse(await bridges.request(input.launch.env.JEVELLAN_STRETCH_TOKEN, { schema: 'bridge-request-v1', operation: 'list' })).tools.map((tool) => tool.name)).toContain('jevellan_thread_report');
  await kept.release(); await kept.release();
  expect(await rejects(bridges.request(input.launch.env.JEVELLAN_STRETCH_TOKEN, { schema: 'bridge-request-v1', operation: 'list' }))).toMatchObject({ status: 401 });
  // The pinned account cooled down: another account of the runtime, a fresh session, the task block first.
  const { launcher: moved } = launcher([status('acc_work'), status('acc_home', { coolingUntil: new Date(Date.now() + 3_600_000).toISOString() })]);
  const fresh = await moved.launch(request({ pinnedAccountId: 'acc_home', resume: 'session-1' }));
  expect(fresh).toMatchObject({ kind: 'started', accountId: 'acc_work', accountChanged: true, resumed: false });
  expect(fake.turnStarts[1]).toMatchObject({ prompt: 'Task: T\n\nDo it.\n\n---\n\nNext.' }); expect(fake.turnStarts[1]!.resume).toBeUndefined();
  expect(used).toEqual(['acc_home']);
  if (fresh.kind === 'started') await fresh.release();
  // Coordinator turns never carry the git identity.
  fake.capabilities.readOnlyEnforced = true; fake.enqueueTurn(done);
  try {
    const lead = await value.launch(request({ owner: { kind: 'coordinator', projectId: 'proj_a', id: 'proj_a' }, permissions: 'read-only', safetyProfile: 'coordinator', gitIdentityFrom: repo, tools: tools(coordinator).tools }));
    expect(lead.kind).toBe('started'); expect(Object.keys(fake.turnStarts[2]!.launch.env).sort()).toEqual(['JEVELLAN_DAEMON_URL', 'JEVELLAN_STRETCH_TOKEN']);
    if (lead.kind === 'started') await lead.release();
  } finally { fake.capabilities.readOnlyEnforced = false; }
});

test('the launcher refuses with a reason before any process: capability, account, a busy serial account; it needs the daemon address', async () => {
  const { launcher: value, accountRuns } = launcher([status('acc_work', { auth: 'needs-login' }), status('acc_home', { auth: 'needs-login' })]);
  expect(await value.launch(request({ owner: { kind: 'coordinator', projectId: 'proj_a', id: 'proj_a' }, permissions: 'read-only', safetyProfile: 'coordinator' })))
    .toEqual({ kind: 'unavailable', reason: cannotRunHere('Scripted test runtime') });
  expect(await value.launch(request())).toEqual({ kind: 'unavailable', reason: noTurnAccount('Fixture', 'Mac mini', 'Scripted test runtime needs login') });
  expect(noTurnAccount('Fixture', 'Mac mini', 'Scripted test runtime needs login')).toBe('No account can run Fixture on Mac mini right now: Scripted test runtime needs login.');
  const serial = launcher([status('acc_work')]);
  fake.capabilities.perLaunchConfig = false; fake.enqueueTurn(done, forThread());
  try {
    const first = await serial.launcher.launch(request());
    expect(first.kind).toBe('started'); expect(serial.accountRuns.has('acc_work')).toBe(true);
    expect(await serial.launcher.launch(request())).toEqual({ kind: 'unavailable', reason: ACCOUNT_BUSY });
    if (first.kind === 'started') await first.release();
    expect(serial.accountRuns.size).toBe(0);
  } finally { fake.capabilities.perLaunchConfig = true; }
  expect(accountRuns.size).toBe(0);
  await expect(launcher([status('acc_work')], '').launcher.launch(request())).rejects.toThrow('Project turns start after the daemon is listening.');
  expect(fake.turnStarts).toHaveLength(1);
});

function execution(step: FakeTurnStep, over: { timeoutMs?: number } = {}) {
  fake.enqueueTurn(step);
  const run = fake.startTurn({ schema: 'turn-input-v1', owner: { kind: 'thread', projectId: 'proj_a', id: 'thread_a' }, turn: 1, cwd: root, permissions: 'write', model: 'scripted-model',
    effort: 'high', systemAppend: '', prompt: 'Go.', safetyProfile: 'thread', timeoutMs: over.timeoutMs ?? 5000, launch: { env: {}, mcpServers: {} },
    account: { account: account('acc_work'), home: homes.ensure('homes', 'fake', 'acc_work'), env: {} } });
  const recorded: unknown[][] = []; const sessions: string[] = []; const processes: NativeProcess[] = [];
  const turn = new TurnExecution({ run, accountId: 'acc_work', secretRef: 'sec_work', model: 'scripted-model', deviceId: 'dev_a', redactor,
    accounts: { recordUsage: async (...args: unknown[]) => { recorded.push(['usage', ...args]); return undefined as never; }, recordError: async (...args: unknown[]) => { recorded.push(['error', ...args]); return undefined as never; } },
    initialUsage: { fiveHourPct: 10, weeklyPct: 20, source: 'probe', observedAt: '2026-10-03T09:00:00.000Z' }, onSession: (id) => sessions.push(id), onProcess: (native) => processes.push(native) });
  return { run, turn, recorded, sessions, processes };
}

test('a turn keeps text in memory, records usage and limits like a stretch, and always ends its process (brief 8.2, D20)', async () => {
  const { run, turn, recorded, sessions, processes } = execution(({ emit, say }) => {
    say('Looking.'); emit({ type: 'tool-start', id: 'a', name: 'Read', input: {} }); emit({ type: 'tool-end', id: 'a', ok: true });
    say('\n\nAll done.'); emit({ type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.5, costSource: 'reported' }); emit({ type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0.25, costSource: 'estimated' });
    emit({ type: 'rate-limit', fiveHourPct: 55 });
    return { status: 'completed' };
  });
  const outcome = await turn.done;
  expect(outcome).toEqual({ status: 'completed', finalText: 'All done.', sessionId: run.native.sessionId, usage: { inputTokens: 11, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.75, costSource: 'estimated' } });
  expect(sessions).toEqual([run.native.sessionId]); expect(processes).toEqual([{ pid: run.native.pid, pgid: run.native.pgid, ...(run.native.startIdentity ? { startIdentity: run.native.startIdentity } : {}) }]);
  expect(recorded).toEqual([['usage', 'acc_work', expect.objectContaining({ fiveHourPct: 55, weeklyPct: 20, source: 'stream' }), 'sec_work']]);
  expect(groupAlive(run.native.pgid)).toBe(false);
  // No text after the last tool call: all of the turn's text.
  const tail = execution(({ emit, say }) => { say('Only before.'); emit({ type: 'tool-start', id: 'b', name: 'Edit', input: {} }); return { status: 'completed' }; });
  expect((await tail.turn.done).finalText).toBe('Only before.');
});

test('failures record the account error with the model scope, timeouts read timed-out, and own intent wins the status', async () => {
  redactor.add('fixture-secret-value-0002');
  const failed = execution(() => ({ status: 'failed', error: { kind: 'rate-limit', scope: 'model', resetsAt: '2026-10-03T12:00:00.000Z', message: 'Limit for fixture-secret-value-0002.' } }));
  expect(await failed.turn.done).toMatchObject({ status: 'failed', error: { kind: 'rate-limit', message: 'Limit for [redacted].' } });
  expect(failed.recorded).toEqual([['error', 'acc_work', 'rate-limit', 'sec_work', { model: 'scripted-model', resetsAt: '2026-10-03T12:00:00.000Z' }]]);
  const auth = execution(() => ({ status: 'failed', error: { kind: 'auth', message: 'Not logged in.' } }));
  await auth.turn.done; expect(auth.recorded).toEqual([['error', 'acc_work', 'auth', 'sec_work', {}]]);
  const wait: FakeTurnStep = ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ status: 'interrupted' })); });
  expect((await execution(wait, { timeoutMs: 50 }).turn.done).status).toBe('timed-out');
  for (const [intent, status] of [['steer', 'steered'], ['stop', 'stopped'], ['shutdown', 'shutdown']] as const) {
    const held = execution(wait); await new Promise((resolve) => setTimeout(resolve, 20));
    await held.turn[intent](); const outcome = await held.turn.done;
    expect(outcome.status).toBe(status); expect(groupAlive(held.run.native.pgid)).toBe(false);
  }
  // A steer that arrives after the turn finished interrupts nothing.
  const finished = execution(done); expect((await finished.turn.done).status).toBe('completed'); await finished.turn.steer();
});
