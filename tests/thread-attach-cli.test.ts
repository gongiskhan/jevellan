// Terminal takeover from the installed command (brief phase 7; design 3.7; D47, D300-D303): `jevellan thread attach|detach` runs as
// a real process (`bin/jevellan.mjs`) against a daemon that wrote its installation control file, with simulated `claude` and `codex`
// CLIs (`tests/fixtures/agent-cli.mjs`) first on PATH. The owner's own CLIs and homes are never reachable: PATH holds only the
// fixture directory and the system directories, and HOME is the fixture's user directory.
import { afterEach, expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { AccountSchema, DeviceSchema, DoctorControlSchema, Homes, ThreadIndexSchema, doctorControlPath, writeDocument } from '../packages/core/dist/index.js';
import { HubProjectAccess } from '../packages/mesh/dist/index.js';
import { FakeRuntime, fakeNativeSessionFile, forThread, writeFakeNativeSession } from '../packages/runtime-contract/dist/index.js';
import { THREAD_NOT_FOUND, THREAD_WORKING, ownerWorkedLine, threadRunsOn } from '../packages/projects/dist/index.js';
import { attachThread, detachThread, prepareClaudeInteractiveHome, staysAttached } from '../packages/cli/dist/thread-attach.js';
import { runningDiagnostics } from '../packages/cli/dist/doctor.js';
import { holdStep, projectFixture, reportStep, type ProjectFixture, type ProjectFixtureOptions } from './helpers/project-fixture.js';
import { ATTACH_MENU, BACK, BACK_ADOPTED, CANARY, agents, claudeAccount, finished, jevellan, named, rest, start, stopCommands, worked, type AgentRecord } from './helpers/attach-cli.js';

const STACK = /^\s+at /mu;
function claudeIntegration(run: AgentRecord, session: string, effort = true) {
  expect(run.argv!.slice(0, effort ? 6 : 4)).toEqual(['--resume', session, '--model', 'scripted-model', ...(effort ? ['--effort', 'high'] : [])]);
  const settings = JSON.parse(run.argv![run.argv!.indexOf('--settings') + 1]!);
  expect(settings.cleanupPeriodDays).toBe(36500); expect(settings.skipDangerousModePermissionPrompt).toBe(true); expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('safety-hook.js');
  const servers = JSON.parse(run.argv![run.argv!.indexOf('--mcp-config') + 1]!);
  expect(servers.mcpServers.jevellan.args.at(-1)).toBe('mcp-bridge'); expect(run.argv!.slice(-2)).toEqual(['--permission-mode', 'bypassPermissions']);
}
function codexIntegration(run: AgentRecord, session: string) {
  expect(run.argv!.slice(0, 4)).toEqual(['resume', session, '-m', 'scripted-model']);
  const overrides = run.argv!.filter((_value, index, args) => args[index - 1] === '-c').join('\n');
  const config = parseToml(overrides);
  expect(config).toMatchObject({ model_reasoning_effort: 'high', approval_policy: 'never', sandbox_mode: 'danger-full-access', features: { hooks: true },
    mcp_servers: { jevellan: { env_vars: ['JEVELLAN_STRETCH_TOKEN', 'JEVELLAN_DAEMON_URL', 'JEVELLAN_PROJECT_MEMORY_MODE'], default_tools_approval_mode: 'approve' } } });
  expect((config.hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse[0]!.hooks[0]!.command).toContain('safety-hook.js');
}

let fixture: ProjectFixture | undefined; const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  stopCommands();
  await fixture?.close(); fixture = undefined;
});

async function setup(options: ProjectFixtureOptions = {}): Promise<ProjectFixture> {
  fixture = await projectFixture({ control: true, menu: ATTACH_MENU, ...options });
  return fixture;
}

test('Claude takeover preferences are confined, validated and preserve completed account files byte-for-byte', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'takeover-preferences-'))); roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  const user = join(root, 'user'), homes = new Homes(join(root, 'jevellan'), user), home = homes.account('claude', 'account');
  mkdirSync(user); const native = join(user, '.claude.json'); writeFileSync(native, '{"owner":true}\n');
  expect(() => prepareClaudeInteractiveHome(homes, user, root)).toThrow('isolated account home');
  expect(readFileSync(native, 'utf8')).toBe('{"owner":true}\n');
  const file = join(home, '.claude.json'); symlinkSync(native, file);
  expect(() => prepareClaudeInteractiveHome(homes, home, root)).toThrow('preferences'); expect(readFileSync(native, 'utf8')).toBe('{"owner":true}\n');
  rmSync(file); writeFileSync(file, 'not json');
  expect(() => prepareClaudeInteractiveHome(homes, home, root)).toThrow(); expect(readFileSync(file, 'utf8')).toBe('not json');
  writeFileSync(file, `  { "hasCompletedOnboarding": true, "theme":"light", "projects": { ${JSON.stringify(root)}: { "hasTrustDialogAccepted": true } } }\n`);
  const before = readFileSync(file); prepareClaudeInteractiveHome(homes, home, root); expect(readFileSync(file)).toEqual(before);
  rmSync(file); prepareClaudeInteractiveHome(homes, home, root); expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hasCompletedOnboarding: true, projects: { [root]: { hasTrustDialogAccepted: true } } });
});

test('an authenticated isolated Claude takeover skips first-run onboarding and preserves account preferences', { timeout: 120_000 }, async () => {
  const claude = named('claude'), f = await setup({ runtimes: { fake: new FakeRuntime(), claude } });
  const { home } = await claudeAccount(f), file = join(home, '.claude.json');
  const preferences = { theme: 'light', numStartups: 7, projects: { fixture: { existing: true } } };
  writeFileSync(file, JSON.stringify(preferences));
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Ready for the owner.' }), forThread());
  const threadId = await start(f, 'Native takeover', 'Inspect the project then wait.', 'claude_fixture'); await rest(f, threadId);
  const cli = agents(f), command = jevellan(f, ['thread', 'attach', threadId], { path: `${cli.bin}:/usr/bin:/bin` });
  const run = await cli.started(1);
  expect(run.completedOnboarding).toBe(true);
  const trustRoot = realpathSync(f.checkout);
  expect(run.cwd).not.toBe(trustRoot);
  expect(JSON.parse(readFileSync(file, 'utf8')).projects[trustRoot]?.hasTrustDialogAccepted).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...preferences, hasCompletedOnboarding: true,
    projects: { ...preferences.projects, [trustRoot]: { hasTrustDialogAccepted: true } } });
  command.send('exit 0\n'); expect((await finished(command)).code).toBe(0);
});

test('an attached owner session retains scoped read tools and capture, then expires on detach', async () => {
  const claude = named('claude'), f = await setup({ runtimes: { fake: new FakeRuntime(), claude } }); const { home } = await claudeAccount(f);
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Ready for the owner.' }), forThread());
  const threadId = await start(f, 'Terminal memory', 'Keep durable knowledge from takeover.', 'claude_fixture'); await rest(f, threadId);
  const view = await f.app.projectWork.attach(threadId), token = view.env.JEVELLAN_STRETCH_TOKEN!;
  const post = (body: unknown) => fetch(`${f.base}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  expect((await (await post({ schema: 'bridge-request-v1', operation: 'list' })).json()).tools.map((tool: { name: string }) => tool.name))
    .toEqual(['memory_search', 'memory_read', 'jevellan_github', 'jevellan_terminal_read']);
  expect((await post({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_thread_report', arguments: { status: 'done', summary: 'Forbidden while attached.' } })).status).toBe(403);
  const fork = randomUUID(); writeFakeNativeSession({ format: 'claude', home, sessionId: fork, cwd: view.cwd, append: false, rows: [{ role: 'assistant', text: 'Terminal convention: use the UTC test environment.' }] });
  expect((await post({ schema: 'bridge-request-v1', operation: 'memory-capture', event: 'Stop', sessionId: fork, transcriptPath: fakeNativeSessionFile('claude', home, fork) })).status).toBe(200);
  const slices = f.app.projectWork.captures.slices(f.project.id).filter(row => row.capture.scope === 'attached'); expect(slices.some(row => row.text.includes('Terminal convention'))).toBe(true);
  const outsider = randomUUID(); writeFakeNativeSession({ format: 'claude', home, sessionId: outsider, cwd: f.homes.userHome, append: false, rows: [{ role: 'assistant', text: 'Outside the project.' }] });
  expect((await post({ schema: 'bridge-request-v1', operation: 'memory-capture', event: 'Stop', sessionId: outsider })).status).toBe(403);
  await f.app.projectWork.detach(threadId); expect((await post({ schema: 'bridge-request-v1', operation: 'list' })).status).toBe(401);
});

test('a Claude thread is refused while it works, then resumes in the terminal with only its account environment and hands the new session back', { timeout: 120_000 }, async () => {
  const claude = named('claude');
  const f = await setup({ runtimes: { fake: new FakeRuntime(), claude } });
  const { secret, home } = await claudeAccount(f); const cli = agents(f); const path = `${cli.bin}:/usr/bin:/bin`;
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  claude.enqueueTurn(holdStep(held), forThread());
  const threadId = await start(f, 'Rename button', 'Rename the save button.', 'claude_fixture');

  // 1. A working thread: the daemon's sentence, exit 1, no native CLI, the turn untouched.
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'running');
  expect(await finished(jevellan(f, ['thread', 'attach', threadId], { path }))).toEqual({ code: 1, output: '', errors: `${THREAD_WORKING}\n` });
  expect(cli.records()).toEqual([]); expect(f.thread(threadId).state).toBe('running');
  release(); await rest(f, threadId);
  const stored = f.thread(threadId).nativeSessionId!; expect(stored).toBeTruthy();

  // 2. At rest: `claude --help` is probed once, then `claude --resume <id> --model <model> --effort <effort>` runs in the worktree with
  // the account home and its token in a minimal environment; the command's other variables never reach it.
  const command = jevellan(f, ['thread', 'attach', threadId], { path });
  const run = await cli.started(1);
  expect(cli.records().map((record) => record.kind)).toEqual(['help', 'run']);
  // The flag settings keep the account home's transcripts past the CLI's 30-day retention (P8 review R-T1).
  claudeIntegration(run, stored);
  expect(run.cwd).toBe(realpathSync(f.thread(threadId).cwd));
  expect(run.envKeys).toEqual(['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME', 'JEVELLAN_DAEMON_URL', 'JEVELLAN_PROJECT_MEMORY_MODE', 'JEVELLAN_STRETCH_TOKEN', 'LANG', 'PATH', 'TERM', 'TMPDIR']);
  expect(run.authDigest).toBe(createHash('sha256').update(secret).digest('hex'));
  expect(run.argv!.some((arg) => arg.includes(secret) || arg.includes(CANARY))).toBe(false);
  // HOME and CLAUDE_CONFIG_DIR are the account home: the terminal's session is written there.
  expect(fakeNativeSessionFile('claude', home, run.sessionId!)).toBeTruthy();
  await f.waitFor(() => command.output(), (text) => text.includes('agent-cli claude started'));
  expect(command.output()).toContain('Resuming the thread in Claude Code. Exit Claude Code to hand the thread back to Jevellan.\n');

  // 3. While attached: the thread reads attached, an owner message waits, and the terminal's input reaches the native CLI.
  expect(f.thread(threadId).state).toBe('attached');
  const sent = await f.request(`/api/projects/project/threads/${threadId}/messages`, 'POST',
    { schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text: 'Also rename the cancel button.', interrupt: false });
  expect(sent.status).toBe(202); expect(f.thread(threadId).queuedMessages.map((message) => message.text)).toEqual(['Also rename the cancel button.']);
  command.send('Rename it to Keep.\n');
  await f.waitFor(() => command.output(), (text) => text.includes('agent-cli claude heard: Rename it to Keep.'));
  expect(claude.turnStarts).toHaveLength(1);

  // 4. The native CLI exits 3: the command detaches, Jevellan adopts the terminal's session, and exits with the native CLI's code (D47).
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Renamed the cancel button.' }), forThread());
  command.send('exit 3\n');
  const result = await finished(command);
  expect(result.code).toBe(3); expect(result.output.endsWith(`${BACK_ADOPTED}\n`)).toBe(true); expect(result.errors).toBe('');
  expect(f.thread(threadId).nativeSessionId).toBe(run.sessionId); expect(f.thread(threadId).attach).toBeUndefined();
  expect(worked(f, threadId).map((event) => event.kind === 'thread-user-message' && event.text)).toEqual([ownerWorkedLine('Rename button')]);
  // The waiting message runs next, on the adopted session.
  await f.waitFor(() => claude.turnStarts.length, (count) => count === 2); await rest(f, threadId);
  expect(claude.turnStarts[1]!.resume).toEqual({ sessionId: run.sessionId }); expect(claude.turnStarts[1]!.prompt).toMatch(/^Project now \([\d:]+\):/u);
  expect(claude.turnStarts[1]!.prompt.endsWith('Also rename the cancel button.')).toBe(true);
  expect(`${result.output}${result.errors}`).not.toContain(secret); expect(`${result.output}${result.errors}`).not.toContain(CANARY);
});

test('a Codex thread resumes with its effort as a configuration override, and SIGTERM or Ctrl-C ends the native CLI once and still hands the thread back', { timeout: 120_000 }, async () => {
  const codex = named('codex');
  const f = await setup({ runtimes: { fake: new FakeRuntime(), codex } });
  f.app.hub.put('accounts', 'acc_codex', AccountSchema, { schema: 'account-v1', id: 'acc_codex', runtime: 'codex', label: 'Codex', kind: 'subscription', enabled: true, ceilingPct: 90,
    credential: 'per-device' }, 0);
  await f.app.accounts.check('acc_codex');
  codex.enqueueTurn(reportStep({ status: 'progress', summary: 'Planned the copy.' }), forThread());
  const threadId = await start(f, 'Cancel copy', 'Add the cancel copy.', 'codex_fixture');
  await rest(f, threadId);
  const stored = f.thread(threadId).nativeSessionId!; const cli = agents(f); const path = `${cli.bin}:/usr/bin:/bin`;
  const signals = (pid: number) => cli.records().filter((record) => record.kind === 'signal' && record.pid === pid).map((record) => record.signal);

  // 1. `codex resume <id> -m <model> -c model_reasoning_effort="<effort>"` with the account home only; no help probe for Codex.
  const first = jevellan(f, ['thread', 'attach', threadId], { path });
  const run = await cli.started(1);
  codexIntegration(run, stored);
  expect(run.envKeys).toEqual(['CODEX_HOME', 'HOME', 'JEVELLAN_DAEMON_URL', 'JEVELLAN_PROJECT_MEMORY_MODE', 'JEVELLAN_STRETCH_TOKEN', 'LANG', 'PATH', 'TERM', 'TMPDIR']); expect(run.authDigest).toBeUndefined();
  expect(cli.records().some((record) => record.kind === 'help')).toBe(false);
  expect(fakeNativeSessionFile('codex', f.homes.at('homes', 'codex', 'acc_codex'), run.sessionId!)).toBeTruthy();
  // SIGTERM to the command alone is forwarded once; the native CLI ends by it, so the command exits 128 + 15 after detaching.
  process.kill(first.child.pid!, 'SIGTERM');
  const ended = await finished(first);
  expect(ended.code).toBe(143); expect(ended.output.endsWith(`${BACK_ADOPTED}\n`)).toBe(true); expect(ended.errors).toBe('');
  expect(signals(run.pid)).toEqual(['SIGTERM']);
  expect(f.thread(threadId)).toMatchObject({ state: 'idle', nativeSessionId: run.sessionId });

  // 2. Ctrl-C in a terminal reaches the native CLI from the terminal itself: the command survives it, does not send it again, and
  // detaches when the native CLI ends (128 + 2). The pseudo-terminal comes from the BSD `script` of macOS, the owner's machines.
  let runs = 1, adopted = run.sessionId!;
  if (process.platform === 'darwin') {
    const second = jevellan(f, ['thread', 'attach', threadId], { path, terminal: true });
    const tty = await cli.started(runs += 1);
    expect(tty.tty).toBe(true); codexIntegration(tty, adopted);
    await f.waitFor(() => second.output(), (text) => text.includes('agent-cli codex started'));
    second.send('\u0003'); second.end();
    const interrupted = await finished(second);
    expect(interrupted.code).toBe(130); expect(interrupted.output).toContain(BACK_ADOPTED);
    expect(signals(tty.pid)).toEqual(['SIGINT']);
    expect(f.thread(threadId)).toMatchObject({ state: 'idle', nativeSessionId: tty.sessionId });
    adopted = tty.sessionId!;
  }

  // 3. Without a terminal nothing else delivers SIGINT to the native CLI, so the command forwards it, once.
  const third = jevellan(f, ['thread', 'attach', threadId], { path });
  const piped = await cli.started(runs += 1);
  expect(piped.tty).toBe(false); expect(piped.argv![1]).toBe(adopted);
  process.kill(third.child.pid!, 'SIGINT');
  expect((await finished(third)).code).toBe(130); expect(signals(piped.pid)).toEqual(['SIGINT']);
  expect(f.thread(threadId)).toMatchObject({ state: 'idle', nativeSessionId: piped.sessionId });
  expect(worked(f, threadId)).toHaveLength(runs); expect(codex.turnStarts).toHaveLength(1);
});

test('Codex takeover selects bounded root instructions again on each resume and hands back when AGENTS is invalid', { timeout: 120_000 }, async () => {
  const codex = named('codex'), f = await setup({ runtimes: { fake: new FakeRuntime(), codex } });
  f.app.hub.put('accounts', 'acc_codex', AccountSchema, { schema: 'account-v1', id: 'acc_codex', runtime: 'codex', label: 'Codex', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0);
  await f.app.accounts.check('acc_codex'); codex.enqueueTurn(reportStep({ status: 'progress', summary: 'Ready.' }), forThread());
  const id = await start(f, 'Instruction fallback', 'Follow project root instructions.', 'codex_fixture'); await rest(f, id);
  const cwd = f.thread(id).cwd, cli = agents(f), path = `${cli.bin}:/usr/bin:/bin`;
  writeFileSync(join(cwd, 'CLAUDE.md'), 'Keep the project convention.');
  const first = jevellan(f, ['thread', 'attach', id], { path }), run = await cli.started(1);
  const config = parseToml(run.argv!.filter((_v, i, args) => args[i - 1] === '-c').join('\n'));
  expect(config.project_doc_fallback_filenames).toEqual(['CLAUDE.md']);
  expect(run.argv!.at(-1)).toContain('# Project instructions: CLAUDE.md');
  expect(run.argv!.at(-1)).toContain('Read the current root CLAUDE.md');
  expect(run.argv!.join('\n')).not.toContain('Keep the project convention.');
  first.send('exit 0\n'); expect((await finished(first)).code).toBe(0); await rest(f, id);
  symlinkSync('CLAUDE.md', join(cwd, 'AGENTS.md'));
  const second = jevellan(f, ['thread', 'attach', id], { path }), changed = await cli.started(2);
  expect(changed.argv!.at(-1)).toContain('# Project instructions: AGENTS.md');
  second.send('exit 0\n'); expect((await finished(second)).code).toBe(0); await rest(f, id);
  rmSync(join(cwd, 'AGENTS.md')); writeFileSync(join(cwd, 'AGENTS.md'), 'x'.repeat(32769));
  const refused = await finished(jevellan(f, ['thread', 'attach', id], { path }));
  expect(refused.code).toBe(1); expect(refused.errors).toContain('AGENTS.md must be a file of at most 32768 bytes');
  expect(refused.output).toBe(`${BACK}\n`); expect(cli.records().filter(row => row.kind === 'run')).toHaveLength(2);
  expect(f.thread(id).state).toBe('idle');
});

test('a failed terminal capture never prevents handback, and the unprocessed journal stays retryable', async () => {
  const claude = named('claude'), f = await setup({ runtimes: { fake: new FakeRuntime(), claude } }); await claudeAccount(f);
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Ready.' }), forThread());
  const id = await start(f, 'Capture handback', 'Keep takeover available.', 'claude_fixture'); await rest(f, id);
  const view = await f.app.projectWork.attach(id);
  const capture = vi.spyOn(f.app.projectWork.captures, 'capture').mockRejectedValue(new Error('Project memory is unavailable: the hub is offline.'));
  expect(await f.app.projectWork.detach(id)).toMatchObject({ schema: 'thread-detach-v1', adopted: false });
  expect(f.thread(id).state).toBe('idle'); expect(capture).toHaveBeenCalledOnce(); capture.mockRestore();
  const old = await fetch(`${f.base}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${view.env.JEVELLAN_STRETCH_TOKEN}` },
    body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'list' }) });
  expect(old.status).toBe(401);
});

test('the command prints the daemon refusals, hands back a thread it cannot resume, and a thread whose detach missed Jevellan stays attached until thread detach', { timeout: 120_000 }, async () => {
  const claude = named('claude');
  const f = await setup({ runtimes: { fake: new FakeRuntime(), claude } });
  await claudeAccount(f); const cli = agents(f, { effort: false }); const path = `${cli.bin}:/usr/bin:/bin`;
  const refused = async (args: string[], errors: string, options: { path?: string; home?: string } = {}) => {
    expect(await finished(jevellan(f, args, { path, ...options }))).toEqual({ code: 1, output: '', errors: `${errors}\n` });
  };

  // 1. Usage and ids are checked before anything is sent; unknown threads and threads on another device get the daemon's sentence.
  await refused(['thread', 'attach'], 'Usage: jevellan thread attach threadId, or jevellan thread detach threadId');
  await refused(['thread', 'leave', 'thread_x'], 'Usage: jevellan thread attach threadId, or jevellan thread detach threadId');
  await refused(['thread', 'attach', '../thread'], 'That is not a thread id. Copy the command from the thread page.');
  await refused(['thread', 'attach', 'thread_missing'], THREAD_NOT_FOUND);
  const at = new Date().toISOString();
  f.app.hub.put('devices', 'dev_laptop', DeviceSchema, { schema: 'device-v1', id: 'dev_laptop', name: 'Laptop', role: 'member', url: 'http://127.0.0.1:9', os: 'darwin', version: '0.1.0', joinedAt: at }, 0);
  await new HubProjectAccess(f.app.hub, 'dev_laptop').publishThread(ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id: 'thread_remote', projectId: 'project',
    title: 'Elsewhere', state: 'idle', isolation: 'worktree', ownerDeviceId: 'dev_laptop', runtime: 'claude', modelLabel: 'Claude fixture', effort: 'high', accountLabel: 'Laptop account',
    turns: 1, createdAt: at, updatedAt: at }), 1);
  await refused(['thread', 'attach', 'thread_remote'], threadRunsOn('Laptop'));
  await refused(['thread', 'detach', 'thread_remote'], threadRunsOn('Laptop'));
  // Another installation home without a running daemon.
  const elsewhere = join(f.root, 'elsewhere');
  await refused(['thread', 'attach', 'thread_remote'], 'Jevellan could not be reached on this device. Check that it is running, then run the command again.', { home: elsewhere });
  await refused(['thread', 'detach', 'thread_remote'], 'Jevellan could not be reached on this device. Check that it is running, then run the command again.', { home: elsewhere });
  expect(cli.records()).toEqual([]);

  // 2. Without `claude` on PATH the thread is attached, then handed straight back with its session.
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Planned the rename.' }), forThread());
  const threadId = await start(f, 'Rename button', 'Rename the save button.', 'claude_fixture');
  await rest(f, threadId); const stored = f.thread(threadId).nativeSessionId!;
  expect(await finished(jevellan(f, ['thread', 'attach', threadId], { path: '/usr/bin:/bin' }))).toEqual({ code: 1, output: `${BACK}\n`,
    errors: 'Claude Code is not installed on this device: the claude command was not found on PATH.\n' });
  expect(f.thread(threadId)).toMatchObject({ state: 'idle', nativeSessionId: stored });

  // 3. A `claude` whose help lists no effort flag gets none.
  const command = jevellan(f, ['thread', 'attach', threadId], { path });
  const run = await cli.started(1);
  claudeIntegration(run, stored, false);

  // 4. Jevellan stops while the owner works: the native CLI's exit cannot detach, so the thread stays attached across the restart,
  // and `jevellan thread detach` hands it back later with the terminal's session.
  let missed: { code: number | null; output: string; errors: string } | undefined;
  await f.restart(async () => { command.send('exit 0\n'); missed = await finished(command); });
  expect(missed!.code).toBe(1); expect(missed!.errors).toBe(`${staysAttached(threadId)}\n`);
  expect(f.thread(threadId).state).toBe('attached');
  expect(await finished(jevellan(f, ['thread', 'detach', threadId], { path }))).toEqual({ code: 0, output: `${BACK_ADOPTED}\n`, errors: '' });
  expect(f.thread(threadId)).toMatchObject({ state: 'idle', nativeSessionId: run.sessionId });
  // A second detach finds nothing attached and changes nothing.
  expect(await finished(jevellan(f, ['thread', 'detach', threadId], { path }))).toEqual({ code: 0, output: `${BACK}\n`, errors: '' });
  expect(f.thread(threadId).nativeSessionId).toBe(run.sessionId);
  expect(missed!.errors).not.toMatch(STACK);
});

test('the shared local request keeps doctor\'s sentence, prints the daemon\'s own for threads, and hands back an attach answer it cannot use', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-attach-cli-'))); roots.push(root); mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'data'), join(root, 'user')); homes.ensure(); const token = 'x'.repeat(43);
  writeDocument(doctorControlPath(homes), DoctorControlSchema, { schema: 'doctor-control-v1', origin: 'http://127.0.0.1:9', token });
  const refusal = async () => Response.json({ schema: 'error-v1', code: 'conflict', message: 'Refused by the fixture.' }, { status: 409 });
  // Doctor keeps one sentence for every failed answer; the thread commands print the daemon's own.
  await expect(runningDiagnostics(homes, refusal)).rejects.toThrow('The local daemon did not answer its diagnostics check.');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {}), output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await detachThread('thread_x', { homes, fetcher: refusal })).toBe(1);
  expect(errors.mock.calls).toEqual([['Refused by the fixture.']]); expect(output).not.toHaveBeenCalled();

  // An attach answer with an authentication variable Claude never takes: nothing starts, the variable goes nowhere, and the thread
  // is handed straight back over the same control file.
  errors.mockClear(); const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') });
    return Response.json(url.endsWith('/attach')
      ? { schema: 'thread-attach-v1', cwd: root, runtime: 'claude', nativeSessionId: 'session', model: 'scripted-model', effort: 'high', deviceName: 'Fixture',
        env: { HOME: root, CLAUDE_CONFIG_DIR: root, OPENAI_API_KEY: CANARY } }
      : { schema: 'thread-detach-v1', adopted: false, state: 'idle' });
  };
  expect(await attachThread('thread_x', { homes, fetcher, env: { PATH: '/usr/bin:/bin' } })).toBe(1);
  expect(calls).toEqual([
    { url: 'http://127.0.0.1:9/api/local/threads/thread_x/attach', body: { schema: 'thread-attach-request-v1' }, authorization: `Bearer ${token}` },
    { url: 'http://127.0.0.1:9/api/local/threads/thread_x/detach', body: { schema: 'thread-detach-request-v1', exitCode: null }, authorization: `Bearer ${token}` }]);
  expect(errors.mock.calls).toEqual([['The answer from Jevellan could not be used.']]); expect(output.mock.calls).toEqual([[BACK]]);
  // An answer that is not JSON is not the daemon's sentence, and the control file is read again for every request.
  errors.mockClear(); output.mockClear();
  expect(await detachThread('thread_x', { homes, fetcher: async () => new Response('Not JSON', { status: 502 }) })).toBe(1);
  expect(errors.mock.calls).toEqual([['Jevellan did not answer this command.']]);
  rmSync(doctorControlPath(homes)); errors.mockClear();
  expect(await detachThread('thread_x', { homes, fetcher })).toBe(1);
  expect(errors.mock.calls).toEqual([['Jevellan could not be reached on this device. Check that it is running, then run the command again.']]);
});
