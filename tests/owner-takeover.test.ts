import { afterEach, expect, test } from 'vitest';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRuntime, forThread } from '../packages/runtime-contract/dist/index.js';
import { OwnerTakeover } from '../apps/daemon/dist/owner-takeover.js';
import { holdStep, projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';
import { ATTACH_MENU, claudeAccount, named, rest, start } from './helpers/attach-cli.js';

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const call = async (name: string, args: Record<string, unknown>) => { const result = await f!.app.ownerTools.call(name, { schema: 'owner-tool-request-v1', caller: 'bridge:project', args }); return result.ok ? result.text : `ERROR ${result.error.code}: ${result.error.text}`; };

/** A terminal stand-in: starting the session runs the attach the installed command would run, and /exit hands the thread back. */
function fakeTmux(fixture: ProjectFixture) {
  const sessions = new Map<string, string>(); const keys: string[][] = [];
  const tmux = (args: string[]) => {
    const name = (args[args.indexOf('-t') + 1] ?? '').replace(/^=/u, '').replace(/:$/u, '');
    if (args[0] === 'new-session') { const session = args[args.indexOf('-s') + 1]!; const threadId = args.at(-1)!.match(/thread attach (\S+)/u)![1]!; sessions.set(session, threadId); void fixture.app.projectWork.attach(threadId); return { status: 0, stdout: '' }; }
    if (args[0] === 'has-session') return { status: sessions.has(name) ? 0 : 1, stdout: '' };
    if (args[0] === 'send-keys') { keys.push(args); if (args.includes('/exit')) { const threadId = sessions.get(name)!; sessions.delete(name); void fixture.app.projectWork.detach(threadId); } return { status: 0, stdout: '' }; }
    if (args[0] === 'kill-session') { const threadId = sessions.get(name); sessions.delete(name); if (threadId) void fixture.app.projectWork.detach(threadId); return { status: 0, stdout: '' }; }
    return { status: 0, stdout: '' };
  };
  return { tmux, sessions, keys };
}

test('thread open holds a working thread at its safe point, return resumes it with the steering line, and the coordinator cannot be taken over', { timeout: 120_000 }, async () => {
  const claude = named('claude');
  f = await projectFixture({ control: true, menu: ATTACH_MENU, runtimes: { fake: new FakeRuntime(), claude } });
  await claudeAccount(f);
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  claude.enqueueTurn(holdStep(held), forThread());
  const threadId = await start(f, 'Rename button', 'Rename the save button.', 'claude_fixture');
  await f.waitFor(() => f!.thread(threadId).state, (state) => state === 'running');
  const terminal = fakeTmux(f); const now = { value: Date.now() };
  const takeover = new OwnerTakeover(f.app, terminal.tmux, () => now.value, 20_000);
  Object.defineProperty(f.app.ownerTools, 'takeover', { value: takeover });
  // A named installation runs as its own command, and the copy names that command.
  const command = join(f.root, 'jevellan-playground'); writeFileSync(command, '#!/bin/sh\n', { mode: 0o700 });
  writeFileSync(join(f.homes.root, 'install.json'), JSON.stringify({ command: { definition: { path: command } } }));
  const opened = await call('thread', { action: 'open', thread: 'T1' });
  release();
  expect(opened).toMatch(/^T1 is yours in the terminal on .+: jevellan-playground attach T1 \(tmux session jv-T1\)\. Remote control is not available: account .+ has no interactive Claude login/u);
  expect(f.thread(threadId).state).toBe('attached');
  expect(await call('status', {})).toMatch(/T1 manual · Rename button · .* · held by you for 0 min/u);
  expect(await call('thread', { action: 'say', thread: 'T1', text: 'hello' })).toBe('ERROR held: T1 is held by you. Write to it in its session.');
  expect(await call('work', { action: 'cancel', task: 'T1' })).toBe('ERROR held: T1 is held by you. Hand it back or stop it first.');
  claude.enqueueTurn(reportStep({ status: 'done', summary: 'Continued.' }), forThread());
  expect(await call('thread', { action: 'return', thread: 'T1' })).toBe('T1 is back with the coordinator and continues from where you left it.');
  await f.waitFor(() => claude.turnStarts.length >= 2);
  expect(claude.turnStarts.at(-1)!.prompt).toMatch(/\[Jevellan\] The owner steered this thread directly from \d\d:\d\d to \d\d:\d\d\. Continue from where the conversation is now/u);
  expect(f.app.ownerTools.steeringRecords('project').map(row => row.kind)).toEqual(['takeover', 'return']);
  expect(await call('thread', { action: 'return', thread: 'T1' })).toBe('ERROR not_held: T1 is not held.');
});

test('a held thread idle for two hours gets a warning item, keep restarts the timer, and fifteen minutes later it goes back on its own', { timeout: 120_000 }, async () => {
  const claude = named('claude');
  f = await projectFixture({ control: true, menu: ATTACH_MENU, runtimes: { fake: new FakeRuntime(), claude } });
  const { home } = await claudeAccount(f);
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Half done.' }), forThread());
  const threadId = await start(f, 'Rename button', 'Rename the save button.', 'claude_fixture');
  await rest(f, threadId);
  const terminal = fakeTmux(f); const now = { value: Date.now() };
  const takeover = new OwnerTakeover(f.app, terminal.tmux, () => now.value, 20_000);
  Object.defineProperty(f.app.ownerTools, 'takeover', { value: takeover });
  expect(await call('thread', { action: 'open', thread: 'T1' })).toMatch(/^T1 is yours/u);
  const sessions = `${home}/projects/${f.thread(threadId).cwd.replace(/[^A-Za-z0-9]/gu, '-')}`; mkdirSync(sessions, { recursive: true }); writeFileSync(`${sessions}/s.jsonl`, '{}\n'); for (const name of readdirSync(sessions)) utimesSync(`${sessions}/${name}`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  now.value += 2 * 3600_000 + 60_000; await takeover.sweep();
  const status = await call('status', {});
  expect(status).toMatch(/W\d+ T1 has been held with no activity since .+ Options: keep, return/u);
  const w = status.match(/(W\d+) T1 has been held/u)![1]!;
  expect((await f.app.ownerPushes.messages('project')).map(message => message.text).join('\n')).toMatch(/T1 has been held for 2 h \d+ min with no activity\. It goes back to the coordinator at \d\d:\d\d unless you use it\. Answer keep on W\d+ to hold it longer\./u);
  expect(await call('respond', { item: w, answer: 'keep' })).toBe('Keeping T1 for you. The idle timer restarted.');
  now.value += 2 * 3600_000 + 60_000; await takeover.sweep();
  now.value += 16 * 60_000; await takeover.sweep();
  await f.waitFor(() => f!.thread(threadId).state !== 'attached');
  expect(takeover.holds()).toEqual([]);
  expect(f.app.ownerPushes.describe('project').join('\n')).toMatch(/held_auto_return Handed T1 back to the coordinator after/u);
});
