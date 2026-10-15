import { afterEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, SecretRedactor, TerminalSessionSchema, type TerminalSnapshot } from '../packages/core/dist/index.js';
import { TerminalBuffer, terminalPlain } from '../apps/daemon/dist/terminal-buffer.js';
import { terminalShell } from '../apps/daemon/dist/terminal-shell.js';
import { TerminalManager } from '../apps/daemon/dist/terminal-manager.js';

const managers: TerminalManager[] = [], roots: string[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const waitFor = async (fn: () => boolean, timeout = 7000) => { const until = Date.now() + timeout; while (!fn()) { if (Date.now() > until) throw new Error('Terminal evidence did not arrive.'); await new Promise(resolve => setTimeout(resolve, 25)); } };
function fixture(shell: string, options: { now?: () => number; idleMs?: number; unknownMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jv-terminal-')); roots.push(root); const user = join(root, 'owner'); mkdirSync(user);
  writeFileSync(join(user, '.zshenv'), 'export OWNER_SHELL_FILE=loaded\n'); writeFileSync(join(user, '.bash_profile'), 'export OWNER_SHELL_FILE=loaded\n');
  const homes = new Homes(join(root, 'data'), user), snapshots: TerminalSnapshot[] = [], results: { text: string; messageId: string }[] = [];
  const manager = new TerminalManager({ ...options, homes, deviceId: 'dev_terminal', deviceName: 'Terminal fixture', redactor: new SecretRedactor(),
    env: { ...process.env, HOME: user, SHELL: shell, JEVELLAN_BRIDGE_TOKEN: 'internal-terminal-fixture', JEVELLAN_TEST_JEV_KEY: 'internal-test-fixture' }, timers: false,
    publish: async snapshot => { snapshots.push(snapshot); }, deliver: async result => { results.push(result); } }); managers.push(manager);
  return { homes, user, manager, snapshots, results };
}
const create = (manager: TerminalManager, cwd: string, requestId = 'terminal_create') => manager.create({ requestId, fingerprint: requestId, cwd, title: 'Fixture terminal', projectId: 'project_terminal' });
const osc = (text: string) => `\x1b]${text}\x07`;

test('bash command records survive login setup with delayed WezTerm semantic hooks', async () => {
  const f = fixture('/bin/bash');
  const profile = `export OWNER_SHELL_FILE=loaded
if [[ "$WEZTERM_SHELL_SKIP_ALL" != 1 ]]; then
  __owner_terminal_install() {
    trap 'printf "\\033]133;C\\007"' DEBUG
    PROMPT_COMMAND='printf "\\033]133;D;0\\007\\033]133;A\\007"'
  }
  PROMPT_COMMAND=__owner_terminal_install
fi
`;
  writeFileSync(join(f.user, '.bash_profile'), profile);
  const session = await create(f.manager, f.user); await waitFor(() => !f.manager.snapshot(session.id).approximate);
  f.manager.input(session.id, "printf 'owner=%s\\n' \"$OWNER_SHELL_FILE\"; false\r");
  await waitFor(() => f.manager.snapshot(session.id).commands.some(row => row.command.includes('OWNER_SHELL_FILE') && row.endedAt !== null));
  expect(f.manager.snapshot(session.id).commands.at(-1)).toMatchObject({ exitCode: 1, approximate: false });
  expect(f.manager.snapshot(session.id).commands.at(-1)!.output).toContain('owner=loaded');
  expect(readFileSync(join(f.user, '.bash_profile'), 'utf8')).toBe(profile);
});

test('semantic boundaries survive split escapes and keep command, folder, exit code and plain output', () => {
  const buffer = new TerminalBuffer('term_unit', '/tmp'), raw = osc('7;file://localhost/tmp/space%20folder') + osc(`133;C;${Buffer.from('printf hello').toString('base64')}`) + '\x1b[31mhello\x1b[0m\r\n' + osc('133;D;7');
  for (const char of raw) buffer.feed(char);
  expect(buffer.commands).toHaveLength(1); expect(buffer.commands[0]).toMatchObject({ command: 'printf hello', cwd: '/tmp/space folder', exitCode: 7, output: 'hello\n', approximate: false });
  expect(buffer.commands[0]!.endedAt).not.toBeNull(); expect(terminalPlain(raw)).toBe('hello\n');
});
test('command reads keep beginnings and ends and apply both per-command and aggregate bounds', () => {
  const buffer = new TerminalBuffer('term_bounds', '/tmp');
  for (let index = 0; index < 20; index++) { buffer.begin(`command ${index}`, false); buffer.feed(`start-${index} ${'x'.repeat(16000)} end-${index}`); buffer.finish(0); }
  const records = buffer.records(20); expect(records).toHaveLength(20); expect(records.reduce((sum, row) => sum + row.output.length, 0)).toBeLessThanOrEqual(30000);
  for (const [index, record] of records.entries()) { expect(record.output.length).toBeLessThanOrEqual(8000); expect(record.output).toContain(`start-${index}`); expect(record.output).toContain(`end-${index}`); }
  buffer.feed('y'.repeat(3 * 1024 * 1024)); expect(Buffer.byteLength(buffer.raw)).toBeLessThanOrEqual(2 * 1024 * 1024);
});
test('an unsupported shell records visibly echoed commands approximately, without recording hidden input', () => {
  const buffer = new TerminalBuffer('term_approx', '/tmp'); buffer.input('echo visible\r'); buffer.feed('echo visible\r\nvisible\r\n'); buffer.finish(null);
  expect(buffer.commands[0]).toMatchObject({ command: 'echo visible', approximate: true, exitCode: null });
  buffer.input('hidden-password\r'); buffer.feed('\r\naccepted\r\n'); expect(buffer.commands).toHaveLength(1);
  buffer.input('echo next\r'); for (const char of 'echo next\r\nnext\r\n') buffer.feed(char); buffer.finish(null);
  expect(buffer.commands.at(-1)).toMatchObject({ command: 'echo next', approximate: true });
});
test('an ssh shell uses approximate inner command boundaries and plain copies preserve Unicode', () => {
  const buffer = new TerminalBuffer('term_ssh', '/tmp'); buffer.feed(osc(`133;C;${Buffer.from('ssh member').toString('base64')}`));
  buffer.input('pwd\r'); for (const char of 'pwd\r\n/home/owner\r\n') buffer.feed(char);
  expect(buffer.approximate).toBe(true);
  buffer.input('echo café 🧭\r'); buffer.feed('echo café 🧭\r\ncafé 🧭\r\n'); buffer.feed(osc('133;D;0') + osc('133;A'));
  expect(buffer.commands.slice(-2).map(row => [row.command, row.exitCode, row.approximate])).toEqual([['pwd', null, true], ['echo café 🧭', null, true]]);
  expect(buffer.approximate).toBe(false);
  expect(terminalPlain('\x1b[32mcafé 🧭\x1b[0m')).toBe('café 🧭');
});
for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
  test(`${shell} records input sent during startup only once after its actual command executes`, async () => {
    const f = fixture(shell), startup = join(f.user, shell.endsWith('bash') ? '.bash_profile' : '.zlogin');
    const source = 'export OWNER_SHELL_FILE=loaded\nsleep 0.4\n'; writeFileSync(startup, source);
    const session = await create(f.manager, f.user);
    f.manager.input(session.id, 'pwd\r');
    await waitFor(() => f.manager.snapshot(session.id).commands.some(row => row.command === 'pwd' && !row.approximate && row.endedAt !== null));
    const records = f.manager.snapshot(session.id).commands.filter(row => row.command === 'pwd');
    expect(records).toHaveLength(1); expect(records[0]!.output).toContain(f.user); expect(records[0]!.exitCode).toBe(0);
    expect(readFileSync(startup, 'utf8')).toBe(source);
  });
  test(`${shell} loads the owner setup without edits, reports commands and non-zero exits, and survives a disconnected reader`, async () => {
    const f = fixture(shell);
    if (shell.endsWith('bash')) writeFileSync(join(f.user, '.bash_profile'), 'export OWNER_SHELL_FILE=loaded\nPROMPT_COMMAND="printf owner-prompt"\n');
    else writeFileSync(join(f.user, '.zshrc'), 'precmd() { printf owner-prompt; return 0; }\n');
    const before = Object.fromEntries(readdirSync(f.user).map(name => [name, readFileSync(join(f.user, name), 'utf8')]));
    const session = await create(f.manager, f.user); await waitFor(() => !f.manager.snapshot(session.id).approximate);
    let output = ''; const reader = f.manager.subscribe(session.id, data => { output += data; }, () => {}); reader.unsubscribe();
    f.manager.input(session.id, "printf 'hello %s\\n' \"$OWNER_SHELL_FILE\"\r");
    await waitFor(() => f.manager.snapshot(session.id).commands.some(row => row.command.includes('OWNER_SHELL_FILE') && row.endedAt !== null));
    expect(f.manager.snapshot(session.id).tail).toContain('hello loaded'); expect(output).toBe('');
    f.manager.input(session.id, 'false\r'); await waitFor(() => f.manager.snapshot(session.id).commands.some(row => row.command === 'false' && row.exitCode === 1));
    f.manager.input(session.id, 'sleep 100\r'); await waitFor(() => f.manager.snapshot(session.id).commands.some(row => row.command === 'sleep 100'));
    f.manager.input(session.id, '\x03'); await waitFor(() => f.manager.snapshot(session.id).commands.some(row => row.command === 'sleep 100' && row.endedAt !== null));
    expect(f.manager.snapshot(session.id).commands.find(row => row.command === 'sleep 100')!.exitCode).not.toBe(0);
    const reconnect = f.manager.subscribe(session.id, () => {}, () => {}); expect(terminalPlain(reconnect.raw)).toContain('hello loaded'); reconnect.unsubscribe();
    f.manager.input(session.id, "printf '%s|%s\\n' \"$JEVELLAN_BRIDGE_TOKEN\" \"$JEVELLAN_TEST_JEV_KEY\"\r");
    await waitFor(() => f.manager.snapshot(session.id).commands.some(row => row.command.includes('JEVELLAN_BRIDGE_TOKEN') && row.endedAt !== null));
    expect(f.manager.snapshot(session.id).commands.at(-1)!.output.trim()).toBe('|');
    expect(Object.fromEntries(readdirSync(f.user).map(name => [name, readFileSync(join(f.user, name), 'utf8')]))).toEqual(before);
    const folder = join(f.user, 'space % # ?'); mkdirSync(folder); f.manager.input(session.id, `cd '${folder}'\r`);
    await waitFor(() => f.manager.session(session.id).cwd === folder);
    await f.manager.stop(session.id); expect(f.manager.snapshot(session.id).tail).toContain('hello loaded'); expect(f.manager.subscribe(session.id, () => {}, () => {}).raw).toContain('hello');
  });
  test(`${shell} delivers a multiline owner command once with its final exit status`, async () => {
    const f = fixture(shell); await f.manager.create({ requestId: 'multiline_result', fingerprint: 'multiline', cwd: f.user, title: 'Multiline', projectId: 'project_terminal',
      command: "printf 'first\\n'\nprintf 'second\\n'\nfalse", source: { coordinator: true } });
    await waitFor(() => f.results.length === 1); expect(f.results[0]!.text).toContain('Exit code: 1'); expect(f.results[0]!.text).toContain('first'); expect(f.results[0]!.text).toContain('second');
  });
}
test('owner command completion is delivered once with its actual result, and an idempotent retry opens no new shell', async () => {
  const f = fixture('/bin/bash'); const input = { requestId: 'owner_result', fingerprint: 'stable', cwd: f.user, title: 'Owner command', projectId: 'project_terminal',
    command: "printf 'owner output\\n'; false", source: { threadId: 'thread_terminal' } };
  const session = await f.manager.create(input); await waitFor(() => f.results.length === 1);
  expect(f.results[0]!.text).toContain('Exit code: 1'); expect(f.results[0]!.text).toContain('owner output'); expect(f.results[0]!.text).toContain(f.user);
  expect((await f.manager.create(input)).id).toBe(session.id); await f.manager.sweep(); expect(f.results).toHaveLength(1); expect(f.manager.list()).toHaveLength(1);
  await expect(f.manager.create({ ...input, fingerprint: 'changed' })).rejects.toThrow('already used');
});
test('delivery races wait for one in-flight result and retry the same receipt after a restart', async () => {
  const f = fixture('/bin/bash'); await f.manager.close();
  let release!: () => void, calls = 0; const blocked = new Promise<void>(resolve => { release = resolve; });
  const manager = new TerminalManager({ homes: f.homes, deviceId: 'dev_terminal', deviceName: 'Fixture', redactor: new SecretRedactor(), env: { SHELL: '/bin/bash', PATH: '/usr/bin:/bin' }, timers: false,
    publish: async () => {}, deliver: async () => { calls++; await blocked; } }); managers.push(manager);
  const session = await manager.create({ requestId: 'result_race', fingerprint: 'race', cwd: f.user, title: 'Owner', projectId: 'project_terminal', command: 'printf result', source: { coordinator: true } });
  try { await waitFor(() => calls === 1); const sweeps = [manager.sweep(), manager.sweep()]; await new Promise(resolve => setTimeout(resolve, 50)); expect(calls).toBe(1); release(); await Promise.all(sweeps); }
  finally { release(); }
  await manager.close(); const delivered: string[] = [], restarted = new TerminalManager({ homes: f.homes, deviceId: 'dev_terminal', deviceName: 'Fixture', redactor: new SecretRedactor(), timers: false,
    publish: async () => {}, deliver: async row => { delivered.push(row.messageId); } }); managers.push(restarted); await restarted.sweep(); expect(delivered).toEqual([]); expect(restarted.session(session.id).status).toBe('closed');
  const interrupted = { ...manager.session(session.id), id: 'term_interrupted', status: 'open' };
  f.homes.ensure('terminals', interrupted.id); writeFileSync(f.homes.at('terminals', interrupted.id, 'session.json'), JSON.stringify({ schema: 'terminal-local-v1', session: interrupted,
    requestId: 'interrupted_command', fingerprint: 'interrupted', source: { coordinator: true }, command: 'long command', commandSent: true, takeover: false }));
  const recovery = new TerminalManager({ homes: f.homes, deviceId: 'dev_terminal', deviceName: 'Fixture', redactor: new SecretRedactor(), timers: false,
    publish: async () => {}, deliver: async row => { delivered.push(row.text); } }); managers.push(recovery); await recovery.sweep(); await recovery.sweep(); expect(delivered).toHaveLength(1); expect(delivered[0]).toContain('Exit code: unknown'); expect(delivered[0]).toContain('restarted before the result');
});
test('owner commands do not report unknown results just because an integrated command is quiet', async () => {
  let now = Date.now(); const f = fixture('/bin/bash', { now: () => now, unknownMs: 100 });
  const session = await f.manager.create({ requestId: 'owner_quiet', fingerprint: 'quiet', cwd: f.user, title: 'Quiet', projectId: 'project_terminal', command: 'sleep 0.5; printf done', source: { coordinator: true } });
  now += 200; await f.manager.sweep(); expect(f.results).toHaveLength(0);
  await waitFor(() => f.results.length === 1); expect(f.results[0]!.text).toContain('Exit code: 0'); expect(f.manager.session(session.id).status).toBe('open');
});
test('eight PTYs per device are enforced, owner close and idle close release their slots, and restart closes stale metadata', async () => {
  let now = Date.now(); const f = fixture('/bin/bash', { now: () => now, idleMs: 1000 });
  const sessions = []; for (let index = 0; index < 8; index++) sessions.push(await create(f.manager, f.user, `terminal_${index}`));
  await expect(create(f.manager, f.user, 'terminal_ninth')).rejects.toThrow('Eight');
  await f.manager.stop(sessions[0]!.id); expect(f.manager.session(sessions[0]!.id).status).toBe('closed');
  await create(f.manager, f.user, 'terminal_replacement'); await new Promise(resolve => setTimeout(resolve, 200)); now += 2000; await f.manager.sweep();
  expect(f.manager.list().filter(row => row.status === 'open')).toHaveLength(0);
  const stale = TerminalSessionSchema.parse({ ...sessions[0], id: 'term_stale', status: 'open' });
  f.homes.ensure('terminals', stale.id);
  writeFileSync(f.homes.at('terminals', stale.id, 'session.json'), JSON.stringify({ schema: 'terminal-local-v1', session: stale, requestId: 'stale_request', fingerprint: 'stale', takeover: false }));
  await f.manager.close(); const second = new TerminalManager({ homes: f.homes, deviceId: 'dev_terminal', deviceName: 'Fixture', redactor: new SecretRedactor(), timers: false,
    publish: async () => {}, deliver: async () => {} }); managers.push(second); expect(second.session(stale.id)).toMatchObject({ status: 'closed', closedReason: 'The device daemon restarted.' });
});

test('the owner terminal is its own terminal: another emulator\'s integration variables do not reach the shell', () => {
  // A daemon started from a VTE, WezTerm, iTerm or VS Code terminal inherits their variables, and system startup files then add a
  // second set of prompt markers that hide each command's exit status (seen on Linux with /etc/profile.d/vte-2.91.sh).
  const root = mkdtempSync(join(tmpdir(), 'jevellan-terminal-env-')); mkdirSync(join(root, 'user'));
  try {
    const homes = new Homes(join(root, 'data'), join(root, 'user'));
    const { env } = terminalShell(homes, 'term_env', { PATH: '/usr/bin:/bin', SHELL: '/bin/bash', VTE_VERSION: '7600', TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.99', WEZTERM_PANE: '3',
      KONSOLE_VERSION: '230800', ITERM_SESSION_ID: 'w0t0p0', LANG: 'C.UTF-8' });
    for (const name of ['VTE_VERSION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'WEZTERM_PANE', 'KONSOLE_VERSION', 'ITERM_SESSION_ID']) expect(env, name).not.toHaveProperty(name);
    expect(env).toMatchObject({ LANG: 'C.UTF-8', TERM: 'xterm-256color', WEZTERM_SHELL_SKIP_ALL: '1' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
