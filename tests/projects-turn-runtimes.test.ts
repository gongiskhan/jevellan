import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountSchema, Homes, SecretRedactor, projectToolNames } from '../packages/core/dist/index.js';
import { createRuntime as claude } from '../runtimes/claude/dist/index.js';
import { createRuntime as codex } from '../runtimes/codex/dist/index.js';
import { checkTurnResume, collectEvents, groupAlive, COORDINATOR_READ_ONLY_REASON, THREAD_SAFETY_REASON, type RuntimeAdapter, type TurnInput } from '../packages/runtime-contract/dist/index.js';

let root: string; let homes: Homes;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan.turns-'))); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'jevellan'), join(root, 'user')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const directive = (mode: string, requests: unknown[]) => `CONTRACT:${JSON.stringify({ mode, requests })}`;

function setup(runtime: 'claude' | 'codex') {
  const executable = join(root, 'fixture-cli');
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixtures/contract-cli.mjs', import.meta.url)))} "$@"\n`, { mode: 0o700 });
  const adapter = (runtime === 'claude' ? claude : codex)({ homes, executable, redactor: new SecretRedactor() });
  const input: TurnInput = { schema: 'turn-input-v1', owner: { kind: 'thread', projectId: 'proj_fixture', id: 'thread_fixture' }, turn: 2, cwd: root, permissions: 'write', model: 'fixture-model', effort: 'low',
    systemAppend: 'FIXTURE_APPEND', prompt: 'Read the fixture.', safetyProfile: 'thread', timeoutMs: 10_000, launch: { mcpServers: {}, env: {} },
    account: { account: AccountSchema.parse({ schema: 'account-v1', id: 'acc_fixture', runtime, label: 'Fixture', kind: 'subscription', credential: runtime === 'codex' ? 'per-device' : 'shared', enabled: true }), home: homes.account(runtime, 'acc_fixture'), env: {} } };
  const coordinator: TurnInput = { ...input, owner: { kind: 'coordinator', projectId: 'proj_fixture', id: 'proj_fixture' }, permissions: 'read-only', safetyProfile: 'coordinator' };
  return { adapter, input, coordinator };
}
// One turn per worker: the run settles, refuses continuation and leaves no process behind once terminated.
async function respond(adapter: RuntimeAdapter, input: TurnInput) {
  const run = adapter.startTurn(input);
  try {
    const events = await collectEvents(run); const done = await run.done; expect(done.status, done.error?.message).toBe('completed');
    expect(run.native.sessionId).toBe('22222222-2222-4222-8222-222222222222');
    await expect(run.continue('Continue.', 5000)).rejects.toThrow('Turns do not continue; start a new turn.');
    return JSON.parse(events.flatMap((event) => event.type === 'text' ? [event.delta] : []).join('')) as unknown;
  } finally { await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false); }
}

test.each(['claude', 'codex'] as const)('PJ1e resumed turns pass the stored session id and write permissions (%s)', async (runtime) => {
  const { adapter, input } = setup(runtime);
  const requests = [{ tool: 'Bash', input: { command: 'git push' } }, { tool: 'Bash', input: { command: 'git rebase origin/main' } }, { tool: 'Write', input: { file_path: join(root, 'allowed'), content: 'thread writes' } }];
  const prompt = directive('permissions', requests);
  const response = await respond(adapter, { ...input, resume: { sessionId: 'stored-session' }, prompt });
  if (runtime === 'claude') expect(response).toEqual({ replies: [denied(THREAD_SAFETY_REASON), {}, {}], permissionMode: 'bypassPermissions', bypassAllowed: true, resume: 'stored-session', model: 'fixture-model', effort: 'low', allowedTools: null, append: 'FIXTURE_APPEND', prompt });
  else expect(response).toEqual({ sandbox: 'workspace-write', network: true, approval: 'never', cwd: root, projectTrust: 'untrusted', resume: 'stored-session', effort: 'low', addDirs: [], prompt });
  // The per-launch Safety hook receives the thread profile: rebase is allowed, push keeps the thread denial.
  expect(await respond(adapter, { ...input, resume: { sessionId: 'stored-session' }, prompt: directive('safety', requests.slice(0, 2)) })).toEqual([denied(THREAD_SAFETY_REASON), {}]);
}, 45_000);

test.each(['claude', 'codex'] as const)('a first thread turn carries the system append once and Codex adds the root AGENTS.md (%s)', async (runtime) => {
  const { adapter, input } = setup(runtime);
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture rules\nKeep the tests.\n');
  const prompt = directive('permissions', []);
  const response = await respond(adapter, { ...input, turn: 1, prompt });
  if (runtime === 'claude') expect(response).toMatchObject({ permissionMode: 'bypassPermissions', resume: null, append: 'FIXTURE_APPEND', prompt });
  else expect(response).toMatchObject({ sandbox: 'workspace-write', resume: null, prompt: `# Project instructions: AGENTS.md\n# Fixture rules\nKeep the tests.\n\n\nFIXTURE_APPEND\n\n${prompt}` });
}, 30_000);

test.each(['claude', 'codex'] as const)('a resumed coordinator turn stays read-only with exactly its scope tools (%s)', async (runtime) => {
  const { adapter, coordinator } = setup(runtime);
  const requests = [{ tool: 'Write', input: { file_path: join(root, 'blocked'), content: 'no' } }, { tool: 'mcp__jevellan__jevellan_thread_start', input: { title: 'Fixture', task: 'Fixture task.' } }, { tool: 'Bash', input: { command: 'git status' } }];
  const prompt = directive('permissions', requests);
  const response = await respond(adapter, { ...coordinator, resume: { sessionId: 'stored-coordinator' }, prompt });
  const tools = projectToolNames({ kind: 'coordinator' }).map((name) => `mcp__jevellan__${name}`);
  expect(tools).not.toContain('mcp__jevellan__jevellan_mail_send');
  if (runtime === 'claude') expect(response).toEqual({ replies: [denied(COORDINATOR_READ_ONLY_REASON), {}, denied(COORDINATOR_READ_ONLY_REASON)], permissionMode: 'dontAsk', bypassAllowed: false, resume: 'stored-coordinator', model: 'fixture-model', effort: 'low', allowedTools: tools.join(','), append: 'FIXTURE_APPEND', prompt });
  else expect(response).toEqual({ sandbox: 'read-only', network: false, approval: 'never', cwd: root, projectTrust: 'untrusted', resume: 'stored-coordinator', effort: 'low', addDirs: [], prompt });
}, 30_000);

test('a Codex write turn in a linked worktree may write the shared objects, refs and logs but not the owner checkout', async () => {
  const { adapter, input } = setup('codex');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, stdio: 'ignore' });
  const checkout = join(root, 'checkout'); mkdirSync(checkout); git(checkout, 'init', '-b', 'main'); writeFileSync(join(checkout, 'value.txt'), '1\n'); git(checkout, 'add', '-A'); git(checkout, 'commit', '-m', 'Seed');
  const worktree = join(root, 'worktree'); git(checkout, 'worktree', 'add', '-b', 'jv/fixture-abc123', worktree);
  const common = join(checkout, '.git');
  const response = await respond(adapter, { ...input, cwd: worktree, prompt: directive('permissions', []) }) as { addDirs: string[]; sandbox: string };
  expect(response.sandbox).toBe('workspace-write');
  expect(response.addDirs).toEqual([join(common, 'objects'), join(common, 'refs'), join(common, 'logs'), join(common, 'worktrees', 'worktree')]);
  expect(response.addDirs).not.toContain(common);
}, 30_000);

test.each(['claude', 'codex'] as const)('a later turn resumes the native session in a new worker (%s)', async (runtime) => {
  const { adapter, input } = setup(runtime);
  await checkTurnResume(adapter, { ...input, turn: 1 }, { resumedText: 'remembered-fixture' });
}, 30_000);

test('Claude turn text gets a blank line after a tool call while stretch text stays unchanged', async () => {
  const { input } = setup('claude');
  const executable = join(root, 'stream-cli'); writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixtures/stream-cli.mjs', import.meta.url)))} "$@"\n`, { mode: 0o700 });
  const adapter = claude({ homes, executable });
  const text = async (run: ReturnType<RuntimeAdapter['startTurn']>) => {
    try { const events = await collectEvents(run); expect((await run.done).status).toBe('completed'); return events.flatMap((event) => event.type === 'text' ? [event.delta] : []).join(''); }
    finally { await run.terminate(); }
  };
  expect(await text(adapter.startTurn({ ...input, prompt: 'TEXT_BEFORE_TOOL' }))).toBe('Looking.\n\nfixture-answer');
  expect(await text(adapter.startTurn({ ...input, prompt: 'Read the fixture.' }))).toBe('fixture-answer');
  expect(await text(adapter.startStretch({ schema: 'stretch-input-v1', conversationId: 'fixture', stretch: 1, action: 'reply', cwd: root, permissions: 'read-only', memoryWrite: false, systemAppend: '', brief: 'TEXT_BEFORE_TOOL', model: 'fixture-model', effort: 'low', timeoutMs: 10_000, account: input.account, launch: { mcpServers: {}, env: {} } }))).toBe('Looking.fixture-answer');
}, 30_000);
