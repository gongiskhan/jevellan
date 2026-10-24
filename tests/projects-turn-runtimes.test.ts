import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountSchema, Homes, SecretRedactor, projectToolNames } from '../packages/core/dist/index.js';
import { createRuntime as claude } from '../runtimes/claude/dist/index.js';
import { createRuntime as codex } from '../runtimes/codex/dist/index.js';
import { checkTurnResume, collectEvents, groupAlive, ownerCommandDenial, COORDINATOR_READ_ONLY_REASON, THREAD_SAFETY_REASON, type RuntimeAdapter, type TurnInput } from '../packages/runtime-contract/dist/index.js';

let root: string; let homes: Homes;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan.turns-'))); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'jevellan'), join(root, 'user')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: ownerCommandDenial(reason) } });
const directive = (mode: string, requests: unknown[]) => `CONTRACT:${JSON.stringify({ mode, requests })}`;
test.skipIf(process.platform !== 'darwin' && !existsSync('/usr/bin/bwrap'))('native hooks run after Safety and cannot replace its denial on resumed Claude turns', async () => {
  const { adapter, input } = setup('claude'), native = join(homes.userHome, '.claude'); mkdirSync(native);
  writeFileSync(join(native, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'exit 2' }] }] } }));
  const result = await respond(adapter, { ...input, resume: { sessionId: 'stored-session' }, prompt: directive('permissions', [{ tool: 'Bash', input: { command: 'rm -rf /' } }, { tool: 'Read', input: { file_path: 'README.md' } }]) }) as { replies: unknown[] };
  expect(result.replies[0]).toEqual(denied(THREAD_SAFETY_REASON));
  expect(result.replies[1]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'A native user hook blocked this tool.' } });
});

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
  else expect(response).toEqual({ sandbox: 'danger-full-access', network: true, approval: 'never', cwd: root, projectTrust: 'untrusted', resume: 'stored-session', effort: 'low', addDirs: [], prompt: `FIXTURE_APPEND\n\n${prompt}` });
  // The per-launch Safety hook receives the thread profile: rebase is allowed, push keeps the thread denial.
  expect(await respond(adapter, { ...input, resume: { sessionId: 'stored-session' }, prompt: directive('safety', requests.slice(0, 2)) })).toEqual([denied(THREAD_SAFETY_REASON), {}]);
}, 45_000);

test.each(['claude', 'codex'] as const)('a first thread turn carries the system append once and Codex adds the root AGENTS.md (%s)', async (runtime) => {
  const { adapter, input } = setup(runtime);
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture rules\nKeep the tests.\n');
  const prompt = directive('permissions', []);
  const response = await respond(adapter, { ...input, turn: 1, prompt });
  if (runtime === 'claude') expect(response).toMatchObject({ permissionMode: 'bypassPermissions', resume: null, append: 'FIXTURE_APPEND', prompt });
  else expect(response).toMatchObject({ sandbox: 'danger-full-access', resume: null, prompt: `# Project instructions: AGENTS.md\n# Fixture rules\nKeep the tests.\n\n\nFIXTURE_APPEND\n\n${prompt}` });
}, 30_000);

test.each(['claude', 'codex'] as const)('a resumed coordinator turn stays read-only with exactly its scope tools (%s)', async (runtime) => {
  const { adapter, coordinator } = setup(runtime);
  const requests = [{ tool: 'Write', input: { file_path: join(root, 'blocked'), content: 'no' } }, { tool: 'mcp__jevellan__jevellan_task_create', input: { title: 'Fixture', brief: 'Fixture task.', type: 'feature', source: 'owner-request' } }, { tool: 'Bash', input: { command: 'git status' } }];
  const prompt = directive('permissions', requests);
  const response = await respond(adapter, { ...coordinator, resume: { sessionId: 'stored-coordinator' }, prompt });
  const tools = projectToolNames({ kind: 'coordinator' }).map((name) => `mcp__jevellan__${name}`);
  expect(tools).not.toContain('mcp__jevellan__jevellan_mail_send');
  if (runtime === 'claude') expect(response).toEqual({ replies: [denied(COORDINATOR_READ_ONLY_REASON), {}, denied(COORDINATOR_READ_ONLY_REASON)], permissionMode: 'dontAsk', bypassAllowed: false, resume: 'stored-coordinator', model: 'fixture-model', effort: 'low', allowedTools: tools.join(','), append: 'FIXTURE_APPEND', prompt });
  else expect(response).toEqual({ sandbox: 'read-only', network: false, approval: 'never', cwd: root, projectTrust: 'untrusted', resume: 'stored-coordinator', effort: 'low', addDirs: [], prompt: `FIXTURE_APPEND\n\n${prompt}` });
}, 30_000);

test('a Codex write turn in a linked worktree may write the shared objects, refs and logs but not the owner checkout', async () => {
  const { adapter, input } = setup('codex');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, stdio: 'ignore' });
  const checkout = join(root, 'checkout'); mkdirSync(checkout); git(checkout, 'init', '-b', 'main'); writeFileSync(join(checkout, 'value.txt'), '1\n'); git(checkout, 'add', '-A'); git(checkout, 'commit', '-m', 'Seed');
  const worktree = join(root, 'worktree'); git(checkout, 'worktree', 'add', '-b', 'jv/fixture-abc123', worktree);
  const guarded = { ...input, cwd: worktree, protectedPaths: [checkout] };
  const response = await respond(adapter, { ...guarded, prompt: directive('permissions', []) }) as { addDirs: string[]; sandbox: string };
  expect(response.sandbox).toBe('danger-full-access'); expect(response.addDirs).toEqual([]);
  const replies = await respond(adapter, { ...guarded, prompt: directive('safety', [{ tool: 'Bash', input: { command: 'git status' } }, { tool: 'Bash', input: { command: `git -C ${checkout} status` } }]) });
  expect(replies).toEqual([{}, denied(`A worktree thread cannot act inside a registered checkout or protected path. ${THREAD_SAFETY_REASON}`)]);
}, 30_000);

test.each(['claude', 'codex'] as const)('resumed file and shell hooks protect registered checkouts on %s', async runtime => {
  const { adapter, input } = setup(runtime); const checkout = join(root, 'owner-checkout'); mkdirSync(checkout);
  const prompt = directive('safety', [{ tool: 'Write', input: { file_path: join(checkout, 'new.txt'), content: 'blocked' } }, { tool: 'Bash', input: { command: `git -C ${checkout} status` } }, { tool: 'Write', input: { file_path: join(root, 'allowed.txt'), content: 'allowed' } }]);
  const response = await respond(adapter, { ...input, protectedPaths: [checkout], resume: { sessionId: 'stored-session' }, prompt });
  expect(response).toEqual([denied(`A worktree thread cannot act inside a registered checkout or protected path. ${THREAD_SAFETY_REASON}`), denied(`A worktree thread cannot act inside a registered checkout or protected path. ${THREAD_SAFETY_REASON}`), {}]);
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

test('every Claude launch on an account home keeps its transcripts: turns and stretches carry a 100-year retention setting (P8 review R-T1)', async () => {
  const { adapter, input } = setup('claude');
  const settings = async (run: ReturnType<RuntimeAdapter['startTurn']>) => {
    try { const events = await collectEvents(run); expect((await run.done).status).toBe('completed'); return JSON.parse(events.flatMap((event) => event.type === 'text' ? [event.delta] : []).join('')) as { settings: string | null }; }
    finally { await run.terminate(); }
  };
  const prompt = directive('settings', []);
  const turn = await settings(adapter.startTurn({ ...input, prompt }));
  expect(JSON.parse(turn.settings ?? '{}')).toEqual({ cleanupPeriodDays: 36500 });
  const stretch = await settings(adapter.startStretch({ schema: 'stretch-input-v1', conversationId: 'fixture', stretch: 1, action: 'reply', cwd: root, permissions: 'read-only', memoryWrite: false,
    systemAppend: '', brief: prompt, model: 'fixture-model', effort: 'low', timeoutMs: 10_000, launch: input.launch, account: input.account }));
  expect(JSON.parse(stretch.settings ?? '{}')).toEqual({ cleanupPeriodDays: 36500 });
}, 30_000);

test('a Claude resume of a session that no longer exists fails with one sentence that names no session id (P8 review R-T1)', async () => {
  const { adapter, input } = setup('claude');
  const run = adapter.startTurn({ ...input, resume: { sessionId: 'missing-session' } });
  try {
    await collectEvents(run);
    const done = await run.done;
    expect(done).toEqual({ status: 'failed', error: { kind: 'other', message: 'The session to resume no longer exists.' } });
  } finally { await run.terminate(); }
}, 30_000);

test('Codex uses CLAUDE-only root instructions and refreshes them on resumed turns', async () => {
  const { adapter, input } = setup('codex'); const prompt = directive('permissions', []);
  writeFileSync(join(root, 'CLAUDE.md'), 'First project rules');
  const first = await respond(adapter, { ...input, turn: 1, prompt }) as { prompt: string };
  expect(first.prompt).toBe(`# Project instructions: CLAUDE.md\nFirst project rules\n\nFIXTURE_APPEND\n\n${prompt}`);
  writeFileSync(join(root, 'CLAUDE.md'), 'Changed project rules');
  const resumed = await respond(adapter, { ...input, turn: 2, resume: { sessionId: 'stored-session' }, prompt }) as { prompt: string };
  expect(resumed.prompt).toContain('# Project instructions: CLAUDE.md\nChanged project rules');
  expect(resumed.prompt).not.toContain('First project rules');
  writeFileSync(join(root, 'AGENTS.md'), 'Authoritative Codex rules');
  const precedence = await respond(adapter, { ...input, turn: 3, resume: { sessionId: 'stored-session' }, prompt }) as { prompt: string };
  expect(precedence.prompt).toContain('# Project instructions: AGENTS.md\nAuthoritative Codex rules');
  expect(precedence.prompt).not.toContain('Changed project rules');
}, 45_000);

test('Codex keeps large project instructions and a sufficient document budget on first and resumed turns', async () => {
  const { adapter, input } = setup('codex');
  const prompt = directive('instruction-settings', []);
  for (const resume of [undefined, { sessionId: 'stored-session' }]) {
    const instructions = 'Keep every instruction.\n' + 'ç'.repeat(21_000) + `\nFINAL_RULE_${resume ? 'RESUMED' : 'FIRST'}`;
    writeFileSync(join(root, 'AGENTS.md'), instructions);
    const response = await respond(adapter, { ...input, ...(resume ? { resume } : { turn: 1 }), prompt }) as { projectDocMaxBytes: number; prompt: string };
    expect(response.projectDocMaxBytes).toBeGreaterThanOrEqual(Buffer.byteLength(instructions));
    expect(response.prompt.startsWith(`# Project instructions: AGENTS.md\n${instructions}\n\n`)).toBe(true);
    expect(response.prompt.endsWith(`FIXTURE_APPEND\n\n${prompt}`)).toBe(true);
  }
}, 45_000);

test('Codex stretches refresh large root instructions without reducing their native document budget', async () => {
  const { adapter, input } = setup('codex'), prompt = directive('instruction-settings', []);
  const instructions = 'Keep every instruction.\n' + 'ç'.repeat(21_000) + '\nFINAL_STRETCH_RULE';
  writeFileSync(join(root, 'AGENTS.md'), instructions);
  const run = adapter.startStretch({ schema: 'stretch-input-v1', conversationId: 'fixture', stretch: 1, action: 'reply', cwd: root,
    permissions: 'read-only', memoryWrite: false, systemAppend: '', brief: prompt, model: input.model, effort: input.effort,
    timeoutMs: 10_000, account: input.account, launch: input.launch });
  try {
    for (const content of [instructions, instructions + '\nNEW_CONTINUATION_RULE']) {
      if (content !== instructions) { writeFileSync(join(root, 'AGENTS.md'), content); await run.continue(prompt, 10_000); }
      const events = await collectEvents(run); expect((await run.done).status).toBe('completed');
      const response = JSON.parse(events.flatMap(event => event.type === 'text' ? [event.delta] : []).join('')) as { projectDocMaxBytes: number; prompt: string };
      expect(response.projectDocMaxBytes).toBeGreaterThanOrEqual(Buffer.byteLength(content));
      expect(response.prompt.startsWith(`# Project instructions: AGENTS.md\n${content}\n\n`)).toBe(true);
    }
  } finally { await run.terminate(); expect(groupAlive(run.native.pgid)).toBe(false); }
}, 30_000);

test.each(['claude', 'codex'] as const)('compaction settings apply to first and resumed Projects turns without changing native homes (%s)', async runtime => {
  const { adapter, input } = setup(runtime); const native = join(homes.userHome, runtime === 'claude' ? '.claude' : '.codex'); mkdirSync(native);
  const file = join(native, runtime === 'claude' ? 'settings.json' : 'config.toml'); const original = runtime === 'claude' ? '{"env":{}}\n' : 'model = "owner-model"\n'; writeFileSync(file, original);
  for (const resume of [undefined, { sessionId: 'stored-session' }]) {
    const result = await respond(adapter, { ...input, compaction: { thresholdPercent: 70, contextWindow: 10001 }, ...(resume ? { resume } : {}), prompt: directive('compaction-settings', []) });
    expect(result).toEqual(runtime === 'claude' ? { percent: '70' } : { limit: 7000 });
    expect((await import('node:fs')).readFileSync(file, 'utf8')).toBe(original);
  }
}, 45_000);

test('Claude SDK compact boundaries and context use are forwarded independently of billed usage', async () => {
  const { adapter, coordinator } = setup('claude'); const run = adapter.startTurn({ ...coordinator, compaction: { thresholdPercent: 70 }, prompt: directive('compaction-events', []) });
  try {
    const events = await collectEvents(run); expect((await run.done).status).toBe('completed');
    expect(events.filter(event => ['context', 'compacted'].includes(event.type))).toEqual([
      { type: 'context', tokens: 7500, contextWindow: 10000 }, { type: 'compacted', beforeTokens: 7500, afterTokens: 1500 }, { type: 'context', tokens: 1500, contextWindow: 10000 },
    ]);
  } finally { await run.terminate(); }
}, 30_000);

test('the Claude coordinator can write scoped hub memory while native edits and shell remain refused', async () => {
  const { adapter, coordinator } = setup('claude');
  const response = await respond(adapter, { ...coordinator, launch: { ...coordinator.launch, env: { JEVELLAN_PROJECT_MEMORY_MODE: 'hub' } },
    prompt: directive('permissions', [{ tool: 'mcp__jevellan__memory_write', input: { title: 'Test convention', content: 'Use TZ=UTC.' } },
      { tool: 'Write', input: { file_path: join(root, 'refused'), content: 'no' } }, { tool: 'Bash', input: { command: 'git status' } }]) }) as { replies: unknown[] };
  expect(response.replies).toEqual([{}, denied(COORDINATOR_READ_ONLY_REASON), denied(COORDINATOR_READ_ONLY_REASON)]);
}, 30_000);

test('a Codex memory session carries its safety profile without failing the hook schema', async () => {
  const { adapter, input } = setup('codex');
  const response = await respond(adapter, { ...input, owner: { kind: 'memory', projectId: 'proj_fixture', id: 'memory_fixture' }, permissions: 'read-only', safetyProfile: 'memory',
    prompt: directive('safety', [{ tool: 'Bash', input: { command: 'git push' } }]) });
  expect(response).toEqual([denied('Jevellan handles this. Say what you need in your handoff.')]);
}, 30_000);
