// PJ7 (brief 13, phase 7; design 5.2.17, 3.7; D46, D47, D81, D297-D303): terminal takeover as the owner does it. The installed command
// (`bin/jevellan.mjs`) runs as a process against a daemon that wrote its installation control file, with simulated `claude` and `codex`
// CLIs (`tests/fixtures/agent-cli.mjs`) first on PATH; git, the worktree, the thread runner, the control routes and the native session
// files are real. The command's refusals, Codex, signals, restarts and the routes' own rules are covered by `thread-attach-cli.test.ts`
// and `project-attach-routes.test.ts`; the coordinator's bridge refusal by `project-coordinator-tools.test.ts`.
import { afterEach, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { ProjectWorkViewSchema, ThreadMessageReceiptSchema, ThreadViewSchema, type ProjectLedgerData, type ProjectLedgerEvent } from '../packages/core/dist/index.js';
import { FakeRuntime, fakeNativeSessionFile, forThread } from '../packages/runtime-contract/dist/index.js';
import { THREAD_ATTACHED, THREAD_WORKING, attachCommand, ownerWorkedLine } from '../packages/projects/dist/index.js';
import { composerBlock } from '../apps/web/src/project-work-model.js';
import { attachedNotice } from '../apps/web/src/project-work-copy.js';
import { expectNoLeaks, holdStep, projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';
import { ATTACH_MENU, BACK_ADOPTED, CANARY, agents, claudeAccount, finished, jevellan, named, rest, start, stopCommands, worked } from './helpers/attach-cli.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { stopCommands(); await fixture?.close(); fixture = undefined; });

/** The thread's state changes in its ledger, oldest first. */
function states(f: ProjectFixture, threadId: string): string[] {
  const ledger = f.app.projectWork.ledgers.thread('project', threadId);
  return ledger.events().filter((event) => event.type === 'thread-state').map((event) => (ledger.payload(event as ProjectLedgerEvent & { type: 'thread-state' }) as ProjectLedgerData<'thread-state'>).to);
}

test('PJ7 terminal takeover adopts the new session and delivers waiting messages', { timeout: 120_000 }, async () => {
  const claude = named('claude');
  const f = fixture = await projectFixture({ control: true, menu: ATTACH_MENU, runtimes: { fake: new FakeRuntime(), claude } });
  const { secret, home } = await claudeAccount(f); const cli = agents(f); const path = `${cli.bin}:/usr/bin:/bin`;
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  claude.enqueueTurn(holdStep(held), forThread());
  const threadId = await start(f, 'Rename button', 'Rename the save button.', 'claude_fixture');
  const thread = `/api/projects/project/threads/${threadId}`;

  // 1. Attach is refused while the thread works: the daemon's sentence, exit 1, no native CLI, and the turn goes on.
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'running');
  expect(await finished(jevellan(f, ['thread', 'attach', threadId], { path }))).toEqual({ code: 1, output: '', errors: `${THREAD_WORKING}\n` });
  expect(cli.records()).toEqual([]); expect(f.thread(threadId).state).toBe('running');
  release(); await rest(f, threadId);
  const stored = f.thread(threadId).nativeSessionId!; expect(stored).toBeTruthy();

  // 2. At rest attach succeeds: `claude` resumes the stored session in the thread's worktree with the account home and its token, and
  // nothing of the command's own environment or a secret reaches its arguments.
  const command = jevellan(f, ['thread', 'attach', threadId], { path });
  const run = await cli.started(1);
  // The flag settings keep the account home's transcripts past the CLI's 30-day retention (P8 review R-T1).
  expect(run.argv).toEqual(['--resume', stored, '--model', 'scripted-model', '--effort', 'high', '--settings', '{"cleanupPeriodDays":36500}']);
  expect(run.cwd).toBe(realpathSync(f.thread(threadId).cwd));
  expect(run.envKeys).toEqual(expect.arrayContaining(['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'PATH']));
  expect(run.envKeys).not.toContain('JEVELLAN_STRETCH_TOKEN'); expect(run.envKeys).not.toContain('OPENAI_API_KEY');
  expect(run.authDigest).toBe(createHash('sha256').update(secret).digest('hex'));
  expect(run.argv!.some((arg) => arg.includes(secret) || arg.includes(CANARY))).toBe(false);
  // The simulated CLI forks the session on resume, as a real one may: its new session file is in the account home.
  expect(run.sessionId).not.toBe(stored); expect(fakeNativeSessionFile('claude', home, run.sessionId!)).toBeTruthy();

  // 3. The thread views show the attached state; the composer takes no message and says why.
  const attached = await f.json(thread, ThreadViewSchema);
  expect(attached.thread.state).toBe('attached'); expect(attached.canMessage).toBe(false);
  expect(Date.parse(attached.attach!.startedAt)).toBeLessThanOrEqual(Date.now());
  expect(attached.attachCommand).toBe(attachCommand(threadId)); expect(attached.deviceName).toBe(f.deviceName);
  expect(composerBlock(attached)).toBe(attachedNotice(f.deviceName));
  expect((await f.json('/api/projects/project/work', ProjectWorkViewSchema)).threads.find((row) => row.id === threadId)?.state).toBe('attached');
  expect((await f.index(threadId))?.state).toBe('attached');

  // 4. The owner's message waits for the terminal; the coordinator's is refused and queues nothing (brief 7.1, D81). A pulse starts no turn.
  const sent = await f.request(`${thread}/messages`, 'POST',
    { schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text: 'Also rename the cancel button.', interrupt: false });
  expect(sent.status).toBe(202); expect(ThreadMessageReceiptSchema.parse(await sent.json()).repeated).toBe(false);
  await expect(f.app.projectWork.threads.message('project', threadId, 'coordinator', 'Hurry up.', false)).rejects.toMatchObject({ status: 409, message: THREAD_ATTACHED });
  await f.app.projectWork.pulse(); await f.app.projectWork.idle('project');
  expect((await f.json(thread, ThreadViewSchema)).queuedMessages.map((queued) => [queued.from, queued.text])).toEqual([['owner', 'Also rename the cancel button.']]);
  expect(claude.turnStarts).toHaveLength(1); expect(f.thread(threadId).state).toBe('attached');

  // 5. The owner exits the native CLI: the command detaches and Jevellan adopts the terminal's session.
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Renamed the cancel button.' }), forThread());
  command.send('exit 0\n');
  const result = await finished(command);
  expect(result.code).toBe(0); expect(result.output.endsWith(`${BACK_ADOPTED}\n`)).toBe(true); expect(result.errors).toBe('');
  expect(f.thread(threadId).nativeSessionId).toBe(run.sessionId); expect(f.thread(threadId).attach).toBeUndefined();
  expect(worked(f, threadId).map((event) => event.kind === 'thread-user-message' && event.text)).toEqual([ownerWorkedLine('Rename button')]);

  // 6. The waiting message is the next turn, on the adopted session, and the thread is back to taking messages.
  await f.waitFor(() => claude.turnStarts.length, (count) => count === 2); await rest(f, threadId);
  expect(claude.turnStarts[1]!.resume).toEqual({ sessionId: run.sessionId }); expect(claude.turnStarts[1]!.prompt).toBe('Also rename the cancel button.');
  const after = await f.json(thread, ThreadViewSchema);
  expect(after).toMatchObject({ canMessage: true, queuedMessages: [], thread: { state: 'idle', turns: 2 } }); expect(after.attach).toBeUndefined();
  expect(composerBlock(after)).toBeNull();
  // The transcript now reads the adopted session: the terminal's work, then the turn that continued it.
  const transcript = JSON.stringify(after.transcript);
  expect(transcript).toContain('Done in the terminal.'); expect(transcript.indexOf('Done in the terminal.')).toBeLessThan(transcript.indexOf('Also rename the cancel button.'));
  expect(after.reports.map((report) => report.summary)).toContain('Renamed the cancel button.');
  expect(states(f, threadId).slice(-4)).toEqual(['attached', 'idle', 'running', 'idle']);
  expect(`${result.output}${result.errors}`).not.toContain(secret); expect(`${result.output}${result.errors}`).not.toContain(CANARY);
  await expectNoLeaks(f);
});
