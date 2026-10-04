import { expect, test } from 'vitest';
import { COORDINATOR_TOOLS, ThreadReportSchema, type CoordinatorEvent } from '../packages/core/dist/index.js';
import * as decisions from '../packages/decisions/dist/index.js';
import * as copy from '../packages/projects/dist/copy.js';

// Expected texts are the brief section 9 blocks with the placeholders filled in, pasted literally: the brief itself is
// not part of the repository.
const coordinator = "You are the coordinator of the project \"Shop\" in Jevellan. You do not write code and you do not edit files. You plan, delegate to threads, keep track, and talk with the owner.\n\nHow you work:\n- Threads do the work. Each thread is a full coding session (Claude Code or Codex) that carries one task end to end. Start a thread with jevellan_thread_start. Give it a short title and a complete task: the goal, the relevant context and constraints, what done means, and how to verify it. A thread cannot see this conversation, so put everything it needs in the task.\n- Route each new request: if it continues work an active thread is doing, send it to that thread with jevellan_thread_message; otherwise start a new thread. Split unrelated requests into separate threads. Do not start two threads that would change the same files at the same time; sequence them instead.\n- Jevellan chooses where each thread runs (isolation, model, effort, device). Only pass isolation, modelId, effort or deviceId when the owner explicitly asked for them.\n- Worktree threads end in a pull request that the owner reviews and merges. You cannot merge. Main threads publish directly to main.\n- When a thread reports, decide the next step yourself whenever the answer follows from the owner's instructions, the notebook or the code. Ask the owner with jevellan_ask_user only when the decision is genuinely theirs. Keep questions short, offer 2 to 4 options when possible, and continue other work while waiting.\n- When checks fail or a pull request has conflicts, tell the responsible thread what to fix.\n- When a thread was interrupted by a restart or a failure, resume it with jevellan_thread_message if the work is still wanted.\n- Keep the notebook current with jevellan_notebook_write: the owner's standing instructions and preferences for this project, decisions taken, the current plan and open questions. Keep it concise. The notebook is your memory across sessions.\n\nReplying to the owner: be brief and concrete. Say what you started, routed, asked or concluded, naming threads by title. Never paste long transcripts. Write in the owner's language.";
const worktree = "You are working on one thread of the project \"Shop\", coordinated by Jevellan. A coordinator assigned you this task and may send you follow-up messages.\n\nWorkspace: /w/t\nIsolation: your own git worktree on branch jv/fix-login-abc123, based on main. Other threads work elsewhere. Commit your work on this branch.\n\nRules:\n- Do the whole task: understand the code, implement, and run the relevant tests yourself.\n- Commit with clear messages using the machine's git identity. Never add attribution trailers, AI credits or session links to commits, code or documentation.\n- Do not push and do not open pull requests. When you report done, Jevellan runs npm test, pushes and opens the pull request.\n- If you need a decision that is not yours to make, report needs-decision with a short question and 2 to 4 options, and stop.\n- End every turn by calling jevellan_thread_report exactly once: done when the task is complete and committed, progress when you made progress and will continue when asked, needs-decision when you need an answer, blocked when you cannot continue. Keep the summary short and factual.";
const main = "You are working on one thread of the project \"Shop\", coordinated by Jevellan. A coordinator assigned you this task and may send you follow-up messages.\n\nWorkspace: /p/shop\nIsolation: you work directly on main in the project checkout of Mac mini. Other main threads may work on other devices at the same time. Before editing, reserve the files or folders you will change with jevellan_reserve, check jevellan_mail_inbox at the start of each turn, and tell other threads about changes that affect them with jevellan_mail_send. Release reservations when done.\n\nRules:\n- Do the whole task: understand the code, implement, and run the relevant tests yourself.\n- Commit with clear messages using the machine's git identity. Never add attribution trailers, AI credits or session links to commits, code or documentation.\n- Do not push and do not open pull requests. When you report done, Jevellan runs the checks, pushes.\n- If you need a decision that is not yours to make, report needs-decision with a short question and 2 to 4 options, and stop.\n- End every turn by calling jevellan_thread_report exactly once: done when the task is complete and committed, progress when you made progress and will continue when asked, needs-decision when you need an answer, blocked when you cannot continue. Keep the summary short and factual.";
const verify = "Jevellan ran npm test after your report and it failed (attempt 2 of 3). Fix the cause, run the tests, commit, and report done again.\n\nLast output:\nFAIL login.test.ts";
const conflict = "Main moved while you worked and your commits conflict with it in: src/a.ts, src/b.ts. Run git fetch origin main and git rebase origin/main, resolve the conflicts keeping both intents, run the tests, and report done again.";
const pr = "Fixed the login redirect.\n\nTests: Passed: npm test\n\nThread: Fix login\nPlacement: Codex GPT-5, high effort, Mac mini";

const at = new Date(2026, 0, 1, 9, 5).toISOString();
const titles = new Map([['thread_1', 'Fix login'], ['thread_2', 'Docs']]);
const context = { title: (id: string) => titles.get(id), base: 'main' };
const base = { schema: 'coordinator-event-v1' as const, id: 'cev_1', at };
const report = ThreadReportSchema.parse({ schema: 'thread-report-v1', turn: 2, status: 'needs-decision', summary: 'Login works; one choice left.', question: 'Keep the old session table?',
  options: [{ label: 'Keep it' }, { label: 'Drop it', detail: 'Faster' }], testsRun: { command: 'npm test', passed: false, summary: '1 failing' }, synthesized: false });
const line = (event: CoordinatorEvent, extra: Partial<typeof context & { askedDirectly: boolean }> = {}) => copy.eventLine(event, { ...context, ...extra });

test('9.1 coordinator system append is verbatim', () => {
  expect(copy.coordinatorSystemAppend('Shop')).toBe(coordinator);
});

test('9.2 fresh session context follows the brief layout', () => {
  const threads = [
    copy.activeThreadLine({ title: 'Fix login', id: 'thread_1', state: 'in-review', isolation: 'worktree', runtime: 'Codex', modelLabel: 'GPT-5', effort: 'high', deviceName: 'Mac mini', pr: { number: 42, checks: 'failing' }, lastSummary: 'Fixed the\nredirect.' }),
    copy.activeThreadLine({ title: 'Docs', id: 'thread_2', state: 'idle', isolation: 'main', runtime: 'Claude', modelLabel: 'Opus', effort: 'medium', deviceName: 'Studio' }),
  ];
  expect(threads).toEqual([
    '- Fix login (thread_1): in-review, worktree, Codex GPT-5 high on Mac mini, PR #42 failing. Last report: Fixed the redirect.',
    '- Docs (thread_2): idle, main, Claude Opus medium on Studio. Last report: none',
  ]);
  const recent = copy.recentConversation([{ from: 'owner', text: 'Fix login' }, { from: 'coordinator', text: 'Started "Fix login".' }]);
  expect(copy.freshContext({ notebook: 'Use pnpm.\n', threads, questions: [copy.openQuestionLine('Which\ndatabase?')], recent })).toBe(
    `Project notebook:\nUse pnpm.\n\nActive threads:\n${threads.join('\n')}\n\nOpen questions to the owner:\n- Which database?\n\nRecent conversation with the owner:\nOwner: Fix login\n\nYou: Started "Fix login".`);
  expect(copy.freshContext({ notebook: null, threads: [], questions: [], recent: copy.recentConversation([]) })).toBe(
    'Project notebook:\n(empty)\n\nActive threads:\n(none)\n\nOpen questions to the owner:\n(none)\n\nRecent conversation with the owner:\n(none)');
  // Newest first within 8,000 characters, older items dropped first, emitted oldest first; an oversized newest item is cut.
  const items = [{ from: 'owner' as const, text: 'a'.repeat(5000) }, { from: 'coordinator' as const, text: 'b'.repeat(3000) }, { from: 'owner' as const, text: 'c'.repeat(4000) }];
  expect(copy.recentConversation(items)).toBe(`You: ${'b'.repeat(3000)}\n\nOwner: ${'c'.repeat(4000)}`);
  expect(copy.recentConversation([{ from: 'owner', text: 'd'.repeat(9000) }])).toBe(`Owner: ${'d'.repeat(7993)}`);
  expect(copy.recentConversation(items, 20)).toHaveLength(20);
});

test('9.3 event block and every event line', () => {
  expect(copy.clockTime(new Date(2026, 0, 1, 21, 7))).toBe('21:07');
  expect(copy.eventBlock(['[owner 09:05] Hi', 'line two'])).toBe('Events since your last turn:\n[owner 09:05] Hi\nline two');
  expect(line({ ...base, kind: 'user-message', text: 'Fix login, please.', clientMessageId: 'msg_1' })).toBe('[owner 09:05] Fix login, please.');
  expect(line({ ...base, kind: 'thread-report', threadId: 'thread_1', report })).toBe(
    '[thread "Fix login" (thread_1) reported needs-decision] Login works; one choice left.\nQuestion: Keep the old session table?\nOptions: Keep it; Drop it\nTests: failed (npm test) 1 failing');
  const synthesized = ThreadReportSchema.parse({ schema: 'thread-report-v1', turn: 1, status: 'progress', summary: 'Halfway.', synthesized: true });
  expect(line({ ...base, kind: 'thread-report', threadId: 'thread_1', report: synthesized })).toBe('[thread "Fix login" (thread_1) reported progress] Halfway. (Jevellan wrote this report because the thread did not.)');
  expect(line({ ...base, kind: 'thread-report', threadId: 'thread_1', report: synthesized }, { askedDirectly: true })).toBe(
    '[thread "Fix login" (thread_1) reported progress] Halfway. (Jevellan wrote this report because the thread did not.) (Jevellan asked the owner directly.)');
  expect(line({ ...base, kind: 'thread-published', threadId: 'thread_1', result: 'pr-opened', prNumber: 42 })).toBe('[thread "Fix login" (thread_1)] Pull request #42 opened.');
  expect(line({ ...base, kind: 'thread-published', threadId: 'thread_1', result: 'pr-updated', prNumber: 42 })).toBe('[thread "Fix login" (thread_1)] Pull request #42 updated.');
  expect(line({ ...base, kind: 'thread-published', threadId: 'thread_2', result: 'main-published', commit: 'abcdef0123456789' })).toBe('[thread "Docs" (thread_2)] Published to main as abcdef0.');
  expect(line({ ...base, kind: 'thread-published', threadId: 'thread_2', result: 'no-changes' })).toBe('[thread "Docs" (thread_2)] Concluded without changes.');
  expect(line({ ...base, kind: 'thread-verification-failed', threadId: 'thread_1', attempts: 3, tail: 'FAIL a\nFAIL b' })).toBe('[thread "Fix login" (thread_1)] Tests failed 3 times. Last output:\nFAIL a\nFAIL b');
  expect(line({ ...base, kind: 'thread-interrupted', threadId: 'thread_1', reason: 'restart', message: 'Jevellan restarted during this step.' })).toBe(
    '[thread "Fix login" (thread_1) interrupted: restart] Jevellan restarted during this step.');
  const answer = { ...base, kind: 'decision-answer' as const, decisionId: 'pdec_1', question: 'Which database?' };
  expect(line({ ...answer, answer: { optionLabel: 'Postgres' } })).toBe('[owner answered] "Which database?" → Postgres');
  expect(line({ ...answer, answer: { optionLabel: 'Postgres', text: 'version 16' } })).toBe('[owner answered] "Which database?" → Postgres. Note: version 16');
  expect(line({ ...answer, answer: { text: 'Use SQLite for now' } })).toBe('[owner answered] "Which database?" → Use SQLite for now');
  const update = { ...base, kind: 'pr-update' as const, threadId: 'thread_1', prNumber: 42 };
  expect(['checks-failed', 'checks-passed', 'merged', 'closed', 'conflict'].map((change) => line({ ...update, change: change as 'merged' }, { base: 'trunk' }))).toEqual([
    '[PR #42 "Fix login"] checks failing', '[PR #42 "Fix login"] checks passing', '[PR #42 "Fix login"] merged', '[PR #42 "Fix login"] closed without merging', '[PR #42 "Fix login"] has conflicts with trunk']);
  expect(line({ ...base, kind: 'mail', mailId: 'mail_1', fromThreadId: 'thread_2', subject: 'Heads up', body: 'I renamed src/db.ts.' })).toBe('[mail from "Docs" (thread_2)] Heads up\nI renamed src/db.ts.');
  expect(line({ ...base, kind: 'thread-user-message', threadId: 'thread_1', text: 'Use the new API.' })).toBe('[owner wrote directly to thread "Fix login" (thread_1)] Use the new API.');
  expect(line({ ...base, kind: 'placement-override', threadId: 'thread_1', summary: 'Effort changed from high to max.' })).toBe('[owner changed thread "Fix login" (thread_1)] Effort changed from high to max.');
  // Preformatted owner lines (D35) and unknown titles.
  const started = copy.ownerStartedLine('Fix login', 'thread_1', 'x'.repeat(500));
  expect(started).toBe(`[owner started thread "Fix login" (thread_1)] ${'x'.repeat(400)}`);
  expect(line({ ...base, kind: 'thread-user-message', threadId: 'thread_1', text: started })).toBe(started);
  expect(copy.ownerWorkedLine('Fix login')).toBe('[owner worked on thread "Fix login" in a terminal]');
  expect(line({ ...base, kind: 'thread-user-message', threadId: 'thread_1', text: copy.ownerWorkedLine('Fix login') })).toBe('[owner worked on thread "Fix login" in a terminal]');
  expect(line({ ...base, kind: 'thread-interrupted', threadId: 'thread_9', reason: 'failed', message: 'Boom' })).toBe('[thread "(unknown thread)" (thread_9) interrupted: failed] Boom');
});

test('9.4 thread system append and turn prompts', () => {
  expect(copy.threadSystemAppend({ projectName: 'Shop', cwd: '/w/t', isolation: 'worktree', branch: 'jv/fix-login-abc123', baseBranch: 'main', deviceName: 'Mac mini', testCommand: 'npm test' })).toBe(worktree);
  expect(copy.threadSystemAppend({ projectName: 'Shop', cwd: '/p/shop', isolation: 'main', baseBranch: 'main', deviceName: 'Mac mini' })).toBe(main);
  expect(copy.taskPrompt('Fix login', 'The redirect loops.')).toBe('Task: Fix login\n\nThe redirect loops.');
  expect(copy.messagesPrompt([{ from: 'owner', text: 'Also log it.' }])).toBe('Also log it.');
  expect(copy.messagesPrompt([{ from: 'coordinator', text: 'Use the new API.' }, { from: 'owner', text: 'Also log it.' }])).toBe('From the coordinator:\nUse the new API.\n\n---\n\nFrom the owner:\nAlso log it.');
  expect(() => copy.messagesPrompt([])).toThrow();
  const thread = { title: 'Fix login', task: 'The redirect loops.' };
  expect(copy.threadPrompt(thread, 'Task: Fix login\n\nThe redirect loops.', false, 'task')).toBe('Task: Fix login\n\nThe redirect loops.');
  expect(copy.threadPrompt(thread, 'Also log it.', true, 'messages')).toBe('Also log it.');
  expect(copy.threadPrompt(thread, 'Also log it.', false, 'messages')).toBe('Task: Fix login\n\nThe redirect loops.\n\n---\n\nAlso log it.');
  expect(copy.threadPrompt(thread, 'Fix it.', false, 'verification')).toBe('Task: Fix login\n\nThe redirect loops.\n\n---\n\nFix it.');
});

test('9.6 and 9.7 generated thread messages and the pull request body', () => {
  expect(copy.verificationFailurePrompt('npm test', 2, 'FAIL login.test.ts')).toBe(verify);
  expect(copy.verificationFailurePrompt('npm test', 1, `${'x'.repeat(10)}${'y'.repeat(4000)}`).endsWith(`Last output:\n${'y'.repeat(4000)}`)).toBe(true);
  expect(copy.mainConflictPrompt(['src/a.ts', 'src/b.ts'])).toBe(conflict);
  expect(copy.pullRequestBody({ summary: 'Fixed the login redirect.', testCommand: 'npm test', title: 'Fix login', runtime: 'Codex', modelLabel: 'GPT-5', effort: 'high', deviceName: 'Mac mini' })).toBe(pr);
  expect(copy.pullRequestBody({ summary: 'Fixed the login redirect.', testCommand: null, title: 'Fix login', runtime: 'Codex', modelLabel: 'GPT-5', effort: 'high', deviceName: 'Mac mini' }))
    .toBe('Fixed the login redirect.\n\nTests: Not run: no test command\n\nThread: Fix login\nPlacement: Codex GPT-5, high effort, Mac mini');
});

test('verbatim notices, state reasons and turn-limit options', () => {
  expect(copy.coordinatorUnavailableNotice('No account can run the coordinator model on Mac mini.')).toBe('The coordinator cannot run: No account can run the coordinator model on Mac mini.');
  expect(copy.noCoordinatorAccount('Mac mini')).toBe('No account can run the coordinator model on Mac mini.');
  expect(copy.coordinatorOfflineNotice('Mac mini')).toBe('The coordinator lives on Mac mini, which is offline.');
  expect(copy.placedWithoutJev('authentication failed')).toBe('Placed without Jev: authentication failed');
  expect(copy.coordinatorFailedTwiceNotice('Rate limited')).toBe('The coordinator failed twice: Rate limited. Send a message to try again.');
  // An error with its own final period keeps one period (D193).
  expect(copy.coordinatorFailedTwiceNotice('No scripted turn remains. ')).toBe('The coordinator failed twice: No scripted turn remains. Send a message to try again.');
  expect(copy.coordinatorTurnTimedOut(1_200_000)).toBe('The coordinator turn timed out after 20 minutes.');
  expect(copy.coordinatorAccountMovedNotice('Work')).toBe('The coordinator moved to account Work; a fresh session started.');
  expect(copy.commandTimedOut(1_800_000)).toBe('the command timed out after 30 minutes.'); expect(copy.commandTimedOut(1000)).toBe('the command timed out after 1 second.');
  expect([copy.NO_CHANGES, copy.TESTS_FAILED_THREE_TIMES, copy.NO_REMOTE, copy.BRANCH_PUSHED_NO_TOKEN, copy.NOT_GITHUB, copy.TURN_LIMIT_REACHED, copy.RESTARTED, copy.TURN_WITHOUT_REPORT]).toEqual([
    'Concluded without changes.', 'Tests failed three times.', 'This project has no remote; the branch stays local.',
    'Branch pushed. Add a GitHub token in Settings → Git to open pull requests.', 'The remote is not on GitHub.', 'This thread reached its turn limit.',
    'Jevellan restarted during this step.', 'The turn ended without a report.']);
  expect(copy.worktreeSetupFailed('npm ERR! missing script: ci')).toBe('Worktree setup failed: npm ERR! missing script: ci');
  expect(copy.worktreeSetupFailed('x'.repeat(500))).toHaveLength(400);
  expect(copy.worktreeSetupFailed(copy.commandTimedOut(900_000))).toBe('Worktree setup failed: the command timed out after 15 minutes.');
  expect([copy.ALLOW_MORE_TURNS, copy.STOP_THE_THREAD]).toEqual(['Allow 10 more turns', 'Stop the thread']);
  expect(copy.queuedReason(6, null)).toBe('Queued: the project is at its limit of 6 running threads.');
  expect(copy.queuedReason(4, 'Mac mini')).toBe('Queued: Mac mini is at its limit of 4 running threads.');
  expect(copy.waitingForSlotReason(6, null)).toBe('Waiting for a free slot: the project is at its limit of 6 running threads.');
  expect(copy.placementSummary({ runtime: 'Codex', modelLabel: 'GPT-5', effort: 'high', isolation: 'worktree', deviceName: 'Mac mini', fallback: 'Jev placement is not enabled yet.' }))
    .toBe('Codex GPT-5 · high · Worktree · Mac mini · placed without Jev: Jev placement is not enabled yet.');
  // Placement copy is re-exported from decisions, never retyped (D135).
  for (const name of ['NO_PLACEMENT', 'NO_THREAD_MODEL', 'LEAVE_GIT_MAIN', 'MAIN_NOT_AVAILABLE', 'REMOTE_NOT_AVAILABLE', 'UNKNOWN_PLACEMENT_MODEL', 'UNKNOWN_PLACEMENT_DEVICE', 'PLACEMENT_NOT_ENABLED'] as const) {
    expect(copy[name]).toBe(decisions[name]);
  }
});

test('Projects copy outside the brief texts never uses conversation vocabulary or em dashes', () => {
  const samples = (Object.values(copy) as unknown[]).filter((value): value is string => typeof value === 'string');
  samples.push(copy.worktreeSetupFailed('x'), copy.contextLinkSkipped('CLAUDE.md'), copy.contextUnreadable('broken'), copy.turnLimitQuestion('Fix login', 30),
    copy.accountMovedNotice('Work'), copy.coordinatorAccountMovedNotice('Work'), copy.coordinatorTurnTimedOut(1_200_000), copy.cannotRunHere('Codex'), copy.noTurnAccount('GPT-5', 'Mac mini', 'Codex needs login'), copy.notebookConflict(3, 'Plan'),
    copy.githubRefused('Validation Failed'), copy.noCoordinatorModel('Mac mini'), copy.threadSystemAppend({ projectName: 'Shop', cwd: '/w', isolation: 'main', baseBranch: 'main', deviceName: 'Mac mini' }),
    copy.pullRequestBody({ summary: 'S', testCommand: null, title: 'T', runtime: 'R', modelLabel: 'M', effort: 'E', deviceName: 'D' }), copy.transcriptStaysOn('Mac mini'));
  // Every coordinator chat line, done and refused.
  for (const tool of COORDINATOR_TOOLS) {
    const input = { title: 'Fix login', question: 'Which database?', reason: 'Solved.', to: 'all', subject: 'Heads up' };
    samples.push(copy.coordinatorToolSummary(tool, input, { ok: true, result: { state: 'running', placement: 'Codex gpt-x · high · Worktree · Mac mini', delivery: 'interrupting', withdrawn: true, pr: { number: 4 } } }, 'Fix login'),
      copy.coordinatorToolSummary(tool, input, { ok: false, error: 'This thread was not found.' }, 'Fix login'));
  }
  for (const text of samples) {
    expect(text).not.toMatch(/conversation|stretch|handoff/i);
    expect(text).not.toContain(String.fromCharCode(0x2014));
  }
  // The coordinator append and the fresh context are brief-verbatim and do say "conversation".
  expect(copy.coordinatorSystemAppend('Shop')).toContain('cannot see this conversation');
});
