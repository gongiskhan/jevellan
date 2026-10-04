import { expect, test } from 'vitest';
import { AccountSchema, CoordinatorEventSchema, type CoordinatorEvent, type ProjectDecision, type ThreadIndex } from '../packages/core/dist/index.js';
import {
  COORDINATOR_SESSION_TURNS, coordinatorEventBlock, coordinatorFreshContext, coordinatorPrompt, keepSession, ownerStartedLine, type CoordinatorPlan, type CoordinatorPromptInput,
} from '../packages/projects/dist/index.js';

// The coordinator's prompt assembly (brief 9.2, 9.3; D32, D35, D36, D93): which threads, questions and recap items are
// listed, and how every event kind reads. The single line formats are also covered by project-copy.test.ts; the expected
// texts here are pasted from the brief layout, not built with the copy helpers.

const at = (time: string) => `2026-10-03T${time}:00.000Z`;
const event = (raw: Record<string, unknown>): CoordinatorEvent => CoordinatorEventSchema.parse({ schema: 'coordinator-event-v1', ...raw });
const report = (fields: Record<string, unknown>) => ({ schema: 'thread-report-v1', turn: 1, changedFiles: [], synthesized: false, ...fields });
const index = (id: string, title: string, state: ThreadIndex['state'], over: Partial<ThreadIndex> = {}): ThreadIndex => ({ schema: 'project-thread-index-v1', revision: 1, id,
  projectId: 'proj_a', title, state, isolation: 'worktree', ownerDeviceId: 'dev_a', runtime: 'codex', modelLabel: 'GPT-5', effort: 'high', accountLabel: 'Work', turns: 1,
  createdAt: at('08:00'), updatedAt: at('08:30'), ...over });
const pr = (number: number, checks: 'pending' | 'passing' | 'failing' | 'none') => ({ number, url: `https://github.com/o/r/pull/${number}`, state: 'open' as const, headSha: 'a'.repeat(40),
  checks, mergeable: 'clean' as const, updatedAt: at('08:30') });
const decision = (id: string, question: string, over: Partial<ProjectDecision> = {}): ProjectDecision => ({ schema: 'project-decision-v1', revision: 1, id, projectId: 'proj_a',
  from: 'coordinator', question, options: [], createdAt: at('08:00'), ...over });

const threads: ThreadIndex[] = [
  index('thread_a', 'Fix login', 'in-review', { pr: pr(42, 'failing'), lastSummary: 'Fixed the\nredirect.' }),
  index('thread_b', 'Store data', 'waiting-for-you', { runtime: 'claude', modelLabel: 'Opus', effort: 'medium', isolation: 'main', ownerDeviceId: 'dev_b' }),
  index('thread_c', 'Docs', 'idle', { runtime: 'fake', modelLabel: 'Fixture', effort: 'low', lastSummary: 'Wrote the outline.' }),
  index('thread_d', 'Old work', 'done', { endedAt: at('07:00') }),
  index('thread_e', 'Dropped work', 'stopped', { endedAt: at('07:00') }),
  index('thread_f', 'Broken work', 'failed', { endedAt: at('07:00') }),
];
const decisions: ProjectDecision[] = [
  decision('pdec_1', 'Which database\nshould Store data use?', { threadId: 'thread_b', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }),
  decision('pdec_2', 'Ship on Friday?', { answer: { optionLabel: 'Yes' }, answeredAt: at('08:10') }),
  decision('pdec_3', 'Keep the old page?', { withdrawnAt: at('08:20') }),
  decision('pdec_4', '"Docs" reached its turn limit of 30 turns. Allow 10 more turns or stop it?', { from: 'thread', threadId: 'thread_c',
    options: [{ label: 'Allow 10 more turns' }, { label: 'Stop the thread' }] }),
];
const names: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', fake: 'Scripted test runtime' };
const devices: Record<string, string> = { dev_a: 'Mac mini', dev_b: 'Studio' };
const input = (events: CoordinatorEvent[], over: Partial<CoordinatorPromptInput> = {}): CoordinatorPromptInput => ({
  events, notebook: 'Prefer SQLite.\nShip small pull requests.\n', threads, decisions,
  history: [
    { from: 'owner', text: 'Fix login and store data.', eventId: 'cev_old' },
    { from: 'coordinator', text: 'Started "Fix login" and "Store data".' },
    { from: 'owner', text: 'Also write docs.', eventId: 'cev_msg' },
  ],
  runtimeName: (runtime) => names[runtime] ?? runtime, deviceName: (deviceId) => devices[deviceId] ?? deviceId, base: 'trunk',
  askedDirectly: new Set(['cev_ask']), clock: (value) => value.slice(11, 16), ...over,
});

test('every event kind reads as brief 9.3, with titles from the indexes, the fallback suffix and the checkout base branch', () => {
  const events = [
    event({ kind: 'user-message', id: 'cev_msg', at: at('09:05'), text: 'Also write docs.', clientMessageId: 'msg_1' }),
    event({ kind: 'thread-report', id: 'cev_ask', at: at('09:06'), threadId: 'thread_b', report: report({ status: 'needs-decision', summary: 'Need a database choice.',
      question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres', detail: 'Server' }] }) }),
    event({ kind: 'thread-report', id: 'cev_rep', at: at('09:07'), threadId: 'thread_a', report: report({ status: 'progress', summary: 'Half done.', synthesized: true,
      testsRun: { command: 'npm test', passed: false, summary: '2 failing' } }) }),
    event({ kind: 'thread-report', id: 'cev_rep2', at: at('09:07'), threadId: 'thread_a', report: report({ status: 'blocked', summary: 'Needs a token.' }) }),
    event({ kind: 'thread-published', id: 'cev_p1', at: at('09:08'), threadId: 'thread_a', result: 'pr-opened', prNumber: 42 }),
    event({ kind: 'thread-published', id: 'cev_p2', at: at('09:08'), threadId: 'thread_a', result: 'pr-updated', prNumber: 42 }),
    event({ kind: 'thread-published', id: 'cev_p3', at: at('09:08'), threadId: 'thread_b', result: 'main-published', commit: '0123456789abcdef0123456789abcdef01234567' }),
    event({ kind: 'thread-published', id: 'cev_p4', at: at('09:08'), threadId: 'thread_c', result: 'no-changes' }),
    event({ kind: 'thread-verification-failed', id: 'cev_v', at: at('09:09'), threadId: 'thread_a', attempts: 3, tail: 'FAIL login.test.ts\n1 failed' }),
    event({ kind: 'thread-interrupted', id: 'cev_i', at: at('09:10'), threadId: 'thread_c', reason: 'restart', message: 'Jevellan restarted during this step.' }),
    event({ kind: 'decision-answer', id: 'cev_a1', at: at('09:11'), decisionId: 'pdec_1', threadId: 'thread_b', question: 'Which database should Store data use?',
      answer: { optionLabel: 'SQLite', text: 'Keep it small.' } }),
    event({ kind: 'decision-answer', id: 'cev_a2', at: at('09:11'), decisionId: 'pdec_5', question: 'Anything else?', answer: { text: 'No, thanks.' } }),
    event({ kind: 'pr-update', id: 'cev_u1', at: at('09:12'), threadId: 'thread_a', prNumber: 42, change: 'checks-failed' }),
    event({ kind: 'pr-update', id: 'cev_u2', at: at('09:12'), threadId: 'thread_a', prNumber: 42, change: 'checks-passed' }),
    event({ kind: 'pr-update', id: 'cev_u3', at: at('09:12'), threadId: 'thread_a', prNumber: 42, change: 'merged' }),
    event({ kind: 'pr-update', id: 'cev_u4', at: at('09:12'), threadId: 'thread_a', prNumber: 42, change: 'closed' }),
    event({ kind: 'pr-update', id: 'cev_u5', at: at('09:12'), threadId: 'thread_a', prNumber: 42, change: 'conflict' }),
    event({ kind: 'mail', id: 'cev_m', at: at('09:13'), mailId: 'mail_1', fromThreadId: 'thread_c', subject: 'Heads up', body: 'I moved the docs.\nPlease rebase.' }),
    event({ kind: 'thread-user-message', id: 'cev_t1', at: at('09:14'), threadId: 'thread_a', text: 'Use the new API.' }),
    event({ kind: 'thread-user-message', id: 'cev_t2', at: at('09:14'), threadId: 'thread_g', text: ownerStartedLine('Add search', 'thread_g', 'Add a search box.') }),
    event({ kind: 'thread-user-message', id: 'cev_t3', at: at('09:14'), threadId: 'thread_a', text: '[owner worked on thread "Fix login" in a terminal]' }),
    event({ kind: 'placement-override', id: 'cev_o', at: at('09:15'), threadId: 'thread_a', summary: 'Model changed from GPT-5 to Opus.' }),
    event({ kind: 'thread-interrupted', id: 'cev_x', at: at('09:16'), threadId: 'thread_zzz', reason: 'failed', message: 'This step failed: boom' }),
  ];
  expect(coordinatorEventBlock(input(events))).toBe(`Events since your last turn:
[owner 09:05] Also write docs.
[thread "Store data" (thread_b) reported needs-decision] Need a database choice.
Question: Which database?
Options: SQLite; Postgres (Jevellan asked the owner directly.)
[thread "Fix login" (thread_a) reported progress] Half done.
Tests: failed (npm test) 2 failing (Jevellan wrote this report because the thread did not.)
[thread "Fix login" (thread_a) reported blocked] Needs a token.
[thread "Fix login" (thread_a)] Pull request #42 opened.
[thread "Fix login" (thread_a)] Pull request #42 updated.
[thread "Store data" (thread_b)] Published to main as 0123456.
[thread "Docs" (thread_c)] Concluded without changes.
[thread "Fix login" (thread_a)] Tests failed 3 times. Last output:
FAIL login.test.ts
1 failed
[thread "Docs" (thread_c) interrupted: restart] Jevellan restarted during this step.
[owner answered] "Which database should Store data use?" → SQLite. Note: Keep it small.
[owner answered] "Anything else?" → No, thanks.
[PR #42 "Fix login"] checks failing
[PR #42 "Fix login"] checks passing
[PR #42 "Fix login"] merged
[PR #42 "Fix login"] closed without merging
[PR #42 "Fix login"] has conflicts with trunk
[mail from "Docs" (thread_c)] Heads up
I moved the docs.
Please rebase.
[owner wrote directly to thread "Fix login" (thread_a)] Use the new API.
[owner started thread "Add search" (thread_g)] Add a search box.
[owner worked on thread "Fix login" in a terminal]
[owner changed thread "Fix login" (thread_a)] Model changed from GPT-5 to Opus.
[thread "(unknown thread)" (thread_zzz) interrupted: failed] This step failed: boom`);
  // A resumed session reads only the event block.
  expect(coordinatorPrompt(input(events), true)).toBe(coordinatorEventBlock(input(events)));
});

test('the fresh context lists active threads, open questions and the recap without the batch being delivered (9.2, D36)', () => {
  const events = [event({ kind: 'user-message', id: 'cev_msg', at: at('09:05'), text: 'Also write docs.', clientMessageId: 'msg_1' }),
    event({ kind: 'pr-update', id: 'cev_u', at: at('09:06'), threadId: 'thread_a', prNumber: 42, change: 'checks-failed' })];
  const context = `Project notebook:
Prefer SQLite.
Ship small pull requests.

Active threads:
- Fix login (thread_a): in-review, worktree, Codex GPT-5 high on Mac mini, PR #42 failing. Last report: Fixed the redirect.
- Store data (thread_b): waiting-for-you, main, Claude Code Opus medium on Studio. Last report: none
- Docs (thread_c): idle, worktree, Scripted test runtime Fixture low on Mac mini. Last report: Wrote the outline.

Open questions to the owner:
- Which database should Store data use?
- "Docs" reached its turn limit of 30 turns. Allow 10 more turns or stop it?

Recent conversation with the owner:
Owner: Fix login and store data.

You: Started "Fix login" and "Store data".`;
  expect(coordinatorFreshContext(input(events))).toBe(context);
  expect(coordinatorPrompt(input(events), false)).toBe(`${context}

Events since your last turn:
[owner 09:05] Also write docs.
[PR #42 "Fix login"] checks failing`);
  // Once delivered, the same owner message is part of the next fresh session's recap.
  expect(coordinatorFreshContext(input([]))).toContain('You: Started "Fix login" and "Store data".\n\nOwner: Also write docs.');
});

test('a first turn with nothing known yet reads (empty) and (none), the PJ2 opening prompt', () => {
  const events = [event({ kind: 'user-message', id: 'cev_1', at: at('09:05'), text: 'add A and fix B', clientMessageId: 'msg_pj2' })];
  const first = input(events, { notebook: null, threads: [], decisions: [], history: [{ from: 'owner', text: 'add A and fix B', eventId: 'cev_1' }] });
  expect(coordinatorPrompt(first, false)).toBe('Project notebook:\n(empty)\n\nActive threads:\n(none)\n\nOpen questions to the owner:\n(none)\n\nRecent conversation with the owner:\n(none)\n\nEvents since your last turn:\n[owner 09:05] add A and fix B');
  // Only concluded threads and settled questions: still (none); a blank notebook is (empty).
  expect(coordinatorFreshContext(input([], { notebook: '  \n', threads: threads.slice(3), decisions: decisions.slice(1, 3), history: [] })))
    .toBe('Project notebook:\n(empty)\n\nActive threads:\n(none)\n\nOpen questions to the owner:\n(none)\n\nRecent conversation with the owner:\n(none)');
  // Without an injected clock the time is the coordinator device's local 24-hour time (D36).
  const local = new Date(2026, 9, 3, 7, 4); const plain = coordinatorEventBlock(input([event({ kind: 'user-message', id: 'cev_2', at: local.toISOString(), text: 'Hi', clientMessageId: 'msg_2' })], { clock: undefined }));
  expect(plain).toBe('Events since your last turn:\n[owner 07:04] Hi');
});

test('the recap keeps the newest 8,000 characters, oldest first, and drops older items whole', () => {
  const history = [
    { from: 'owner' as const, text: 'a'.repeat(3000), eventId: 'cev_1' }, { from: 'coordinator' as const, text: 'b'.repeat(3000) },
    { from: 'owner' as const, text: 'c'.repeat(4000), eventId: 'cev_2' }, { from: 'owner' as const, text: 'pending', eventId: 'cev_3' },
  ];
  const events = [event({ kind: 'user-message', id: 'cev_3', at: at('09:05'), text: 'pending', clientMessageId: 'msg_3' })];
  const recap = coordinatorFreshContext(input(events, { history })).split('Recent conversation with the owner:\n')[1];
  expect(recap).toBe(`You: ${'b'.repeat(3000)}\n\nOwner: ${'c'.repeat(4000)}`);
  expect(recap!.length).toBeLessThanOrEqual(8000);
});

test('sessions rotate at 40 turns, on a pinned model change, an effort change or a session model that cannot run here (brief 8.1, D77)', () => {
  const session = { runtime: 'codex', modelId: 'gpt', model: 'gpt-5', effort: 'high' as const, accountId: 'acc_a', startedAt: at('08:00'), turns: COORDINATOR_SESSION_TURNS - 1 };
  const model = { id: 'gpt', runtime: 'codex', model: 'gpt-5', label: 'GPT-5', description: 'd', efforts: ['medium' as const, 'high' as const], enabled: true };
  const account = AccountSchema.parse({ schema: 'account-v1', id: 'acc_b', runtime: 'codex', label: 'Other', kind: 'subscription', enabled: true, credential: 'per-device' });
  const ready: Extract<CoordinatorPlan, { kind: 'ready' }> = { kind: 'ready', model, effort: 'high', account };
  expect(COORDINATOR_SESSION_TURNS).toBe(40);
  // 39 turns keep the session (another eligible account is the launcher's concern, D16); 40 rotate.
  expect(keepSession(session, null, ready)).toBe(true);
  expect(keepSession({ ...session, turns: 40 }, null, ready)).toBe(false);
  expect(keepSession(session, 'gpt', ready)).toBe(true);
  expect(keepSession(session, 'opus', ready)).toBe(false);
  expect(keepSession(session, null, { ...ready, effort: 'medium' })).toBe(false);
  expect(keepSession(session, null, { kind: 'unavailable', reason: 'No account can run the coordinator model on Mac mini.' })).toBe(false);
  expect(keepSession(session, null, { ...ready, model: { ...model, model: 'gpt-6' } })).toBe(false);
  expect(keepSession(session, null, { ...ready, model: { ...model, runtime: 'claude' } })).toBe(false);
});
