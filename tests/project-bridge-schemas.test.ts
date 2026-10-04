import { expect, test } from 'vitest';
import {
  ASK_USER_OPTIONS, AskUserInputSchema, AskUserResultSchema, BridgeRequestSchema, BridgeToolNameSchema, BridgeToolSchemas, COORDINATOR_TOOLS,
  MailInboxResultSchema, MailSendInputSchema, MailSendResultSchema, MemoryNoteSchema, MemorySearchSchema, NEEDS_DECISION_QUESTION,
  NotebookReadInputSchema, NotebookReadResultSchema, NotebookWriteInputSchema, NotebookWriteResultSchema, PrStatusResultSchema,
  ProjectToolResultSchemas, ReleaseInputSchema, ReleaseResultSchema, ReserveInputSchema, ReserveResultSchema, ThreadMessageInputSchema,
  ThreadMessageResultSchema, ThreadReadInputSchema, ThreadReadResultSchema, ThreadReportInputSchema, ThreadReportResultSchema,
  ThreadStartInputSchema, ThreadStartResultSchema, ThreadStopInputSchema, ThreadStopResultSchema, ThreadsListInputSchema,
  ThreadsListResultSchema, WithdrawQuestionInputSchema, WithdrawQuestionResultSchema, bridgeTools, projectToolNames, threadTools,
  type BridgeTool,
} from '../packages/core/dist/index.js';
import * as client from '../packages/core/dist/client.js';

const at = '2026-10-03T10:00:00.000Z';
const threadId = 'thread_01K6NV2QZ8XKW3P7Q2K9M';
const decisionId = 'decision_01K6NV2QZ8XKW3P7Q2K9M';
const stretchTools: BridgeTool[] = ['jevellan_finding', 'jevellan_handoff', 'jevellan_conversation_search', 'jevellan_conversation_read', 'jevellan_integrate',
  'memory_search', 'memory_read', 'memory_write', 'memory_edit', 'memory_propose'];
const mainTools = ['jevellan_mail_send', 'jevellan_mail_inbox', 'jevellan_reserve', 'jevellan_release'];
const projectTools = [...new Set([...COORDINATOR_TOOLS, ...threadTools('main')])];
const pr = { number: 7, url: 'https://github.com/owner/repo/pull/7', state: 'open', headSha: 'a'.repeat(40), checks: 'pending', mergeable: 'clean', updatedAt: at };
const report = { schema: 'thread-report-v1', turn: 1, status: 'done', summary: 'Added the page.', changedFiles: ['a.txt'], synthesized: false };
const issues = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) => result.error?.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

test('phase 1 scope lists hold back mail and reservations while the full lists keep them', () => {
  expect(projectToolNames({ kind: 'thread', isolation: 'worktree' })).toEqual(['jevellan_thread_report', 'memory_search', 'memory_read']);
  expect(projectToolNames({ kind: 'thread', isolation: 'main' })).toEqual(['jevellan_thread_report', 'memory_search', 'memory_read']);
  expect(projectToolNames({ kind: 'coordinator' })).toEqual(COORDINATOR_TOOLS.filter((name) => name !== 'jevellan_mail_send'));
  expect(COORDINATOR_TOOLS).toContain('jevellan_mail_send');
  expect(threadTools('worktree')).toEqual(['jevellan_thread_report', 'memory_search', 'memory_read']);
  expect(threadTools('main')).toEqual(['jevellan_thread_report', 'memory_search', 'memory_read', ...mainTools]);
  // Each call returns a fresh array, so a caller cannot change another scope's list.
  const list = projectToolNames({ kind: 'coordinator' }); list.push('jevellan_handoff');
  expect(projectToolNames({ kind: 'coordinator' })).not.toContain('jevellan_handoff');
  expect(COORDINATOR_TOOLS).not.toContain('jevellan_thread_report');
  // Project and stretch scopes share only the read-only memory tools.
  expect(projectTools.filter((name) => stretchTools.includes(name))).toEqual(['memory_search', 'memory_read']);
});

test('every project tool joins the closed name enum after the unchanged stretch tools and serializes to an object schema', () => {
  expect(BridgeToolNameSchema.options.slice(0, stretchTools.length)).toEqual(stretchTools);
  expect(BridgeToolNameSchema.options).toHaveLength(stretchTools.length + 15);
  expect(Object.keys(BridgeToolSchemas)).toEqual(BridgeToolNameSchema.options);
  for (const scope of [{ kind: 'coordinator' }, { kind: 'thread', isolation: 'worktree' }, { kind: 'thread', isolation: 'main' }] as const) {
    expect(bridgeTools(projectToolNames(scope)).tools.map((tool) => tool.name)).toEqual(projectToolNames(scope));
  }
  const tools = bridgeTools(projectTools).tools;
  expect(tools.map((tool) => tool.name)).toEqual(projectTools);
  for (const tool of tools) {
    expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool.description.length).toBeGreaterThan(20);
    // Agents in a project never read the conversation vocabulary.
    expect(tool.description).not.toMatch(/conversation|stretch|handoff/i);
  }
  expect(tools.find((tool) => tool.name === 'jevellan_thread_report')!.inputSchema).toMatchObject({ required: ['status', 'summary'] });
  expect(Object.keys(tools.find((tool) => tool.name === 'jevellan_thread_report')!.inputSchema.properties as object)).toEqual(['status', 'summary', 'question', 'options', 'testsRun', 'changedFiles']);
  // The stretch tool descriptions and schemas are untouched.
  expect(bridgeTools(['jevellan_handoff', 'memory_search']).tools.map((tool) => tool.description)).toEqual([
    'Finish this stretch exactly once with an honest handoff. Supply the full plan or other result as result.content; the daemon stores its blob. Identical retries return the original receipt.',
    'Search this project’s memory notes.',
  ]);
  expect(BridgeRequestSchema.parse({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_thread_report', arguments: { status: 'done', summary: 'Done.' } })).toMatchObject({ name: 'jevellan_thread_report' });
  expect(client.projectToolNames({ kind: 'coordinator' })).toEqual(projectToolNames({ kind: 'coordinator' }));
  expect(client.ThreadReportInputSchema).toBe(client.BridgeToolSchemas.jevellan_thread_report);
});

test('tool inputs are strict, bounded and fill their defaults', () => {
  expect(ThreadsListInputSchema.parse({})).toEqual({ include: 'active' });
  expect(ThreadsListInputSchema.safeParse({ include: 'concluded' }).success).toBe(false);
  const start = { title: 'Add a greeting', task: 'Put a greeting on the home page.' };
  expect(ThreadStartInputSchema.parse(start)).toEqual(start);
  expect(ThreadStartInputSchema.parse({ ...start, isolation: 'main', modelId: 'claude-opus', effort: 'high', deviceId: 'device_a', note: 'The owner asked for main.' })).toMatchObject({ isolation: 'main', effort: 'high' });
  for (const invalid of [{ ...start, title: '' }, { ...start, title: 'x'.repeat(121) }, { ...start, task: 'x'.repeat(20001) }, { ...start, note: 'x'.repeat(601) },
    { ...start, isolation: 'branch' }, { ...start, effort: 'extreme' }, { ...start, deviceId: '../device' }, { ...start, projectId: 'other' }]) {
    expect(ThreadStartInputSchema.safeParse(invalid).success).toBe(false);
  }
  expect(ThreadStartInputSchema.safeParse({ ...start, title: 'x'.repeat(120), task: 'x'.repeat(20000), note: 'x'.repeat(600) }).success).toBe(true);
  expect(ThreadMessageInputSchema.parse({ threadId, message: 'Carry on.' })).toEqual({ threadId, message: 'Carry on.', interrupt: false });
  expect(ThreadMessageInputSchema.safeParse({ threadId, message: '' }).success).toBe(false);
  expect(ThreadReadInputSchema.parse({ threadId })).toEqual({ threadId, detail: 'summary' });
  expect(ThreadStopInputSchema.safeParse({ threadId, reason: 'x'.repeat(401) }).success).toBe(false);
  expect(ThreadStopInputSchema.safeParse({ threadId }).success).toBe(false);
  expect(WithdrawQuestionInputSchema.safeParse({ decisionId, reason: 'The thread solved it.' }).success).toBe(true);
  expect(NotebookReadInputSchema.safeParse({ extra: true }).success).toBe(false);
  expect(NotebookWriteInputSchema.safeParse({ content: 'x'.repeat(65536), expectedRevision: 0 }).success).toBe(true);
  expect(NotebookWriteInputSchema.safeParse({ content: 'x'.repeat(65537), expectedRevision: 0 }).success).toBe(false);
  expect(NotebookWriteInputSchema.safeParse({ content: '', expectedRevision: -1 }).success).toBe(false);
  expect(MailSendInputSchema.safeParse({ to: 'all', subject: 'Heads up', body: '' }).success).toBe(true);
  expect(MailSendInputSchema.safeParse({ to: 'x'.repeat(129), subject: 'Heads up', body: '' }).success).toBe(false);
  expect(MailSendInputSchema.safeParse({ to: 'all', subject: 'x'.repeat(201), body: '' }).success).toBe(false);
  expect(ReserveInputSchema.parse({ paths: ['src/'], reason: 'Edit the app' })).toEqual({ paths: ['src/'], reason: 'Edit the app', minutes: 60 });
  expect(ReserveInputSchema.parse({ paths: ['src/app.txt'] })).toEqual({ paths: ['src/app.txt'], reason: '', minutes: 60 });
  for (const invalid of [{ paths: [], reason: '' }, { paths: Array(51).fill('a'), reason: '' }, { paths: [''], reason: '' }, { paths: ['x'.repeat(301)], reason: '' },
    { paths: ['a'], reason: '', minutes: 0 }, { paths: ['a'], reason: '', minutes: 121 }, { paths: ['a'], reason: 'x'.repeat(301) }]) {
    expect(ReserveInputSchema.safeParse(invalid).success).toBe(false);
  }
  expect(ReleaseInputSchema.parse({})).toEqual({});
});

test('a report input needs a question for needs-decision and leaves turn and synthesis to the daemon', () => {
  expect(ThreadReportInputSchema.parse({ status: 'done', summary: 'Added the page.' })).toEqual({ status: 'done', summary: 'Added the page.', changedFiles: [] });
  expect(issues(ThreadReportInputSchema.safeParse({ status: 'needs-decision', summary: 'Which database?' }))).toEqual([{ path: 'question', message: NEEDS_DECISION_QUESTION }]);
  expect(ThreadReportInputSchema.safeParse({ status: 'needs-decision', summary: 'Which database?', question: 'SQLite or Postgres?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }).success).toBe(true);
  for (const key of ['schema', 'turn', 'synthesized']) expect(ThreadReportInputSchema.safeParse({ status: 'done', summary: 'Done.', [key]: report[key as keyof typeof report] }).success).toBe(false);
  expect(ThreadReportInputSchema.safeParse({ status: 'done', summary: 'Done.', options: [{ label: 'Only one' }] }).success).toBe(false);
  expect(ThreadReportInputSchema.safeParse({ status: 'done', summary: 'x'.repeat(1201) }).success).toBe(false);
  expect(ThreadReportInputSchema.safeParse({ status: 'done', summary: 'Done.', changedFiles: Array(201).fill('a') }).success).toBe(false);
});

test('asking the owner takes no options or two to four', () => {
  const ask = (count: number) => AskUserInputSchema.safeParse({ question: 'Which greeting?', options: Array.from({ length: count }, (_, i) => ({ label: `Option ${i}` })) });
  for (const count of [0, 2, 3, 4]) expect(ask(count).success).toBe(true);
  for (const count of [1, 5]) expect(issues(ask(count))).toEqual([{ path: 'options', message: ASK_USER_OPTIONS }]);
  expect(AskUserInputSchema.parse({ question: 'Which greeting?', threadId })).toEqual({ question: 'Which greeting?', threadId });
  expect(AskUserInputSchema.safeParse({ question: '' }).success).toBe(false);
  expect(AskUserInputSchema.safeParse({ question: 'x'.repeat(2001) }).success).toBe(false);
});

test('tool results are versioned documents and every project tool names its result schema', () => {
  expect(Object.keys(ProjectToolResultSchemas).sort()).toEqual([...projectTools].sort());
  expect(ProjectToolResultSchemas.memory_search).toBe(MemorySearchSchema); expect(ProjectToolResultSchemas.memory_read).toBe(MemoryNoteSchema);
  const thread = { id: threadId, title: 'Add a greeting', state: 'in-review', isolation: 'worktree', device: 'Studio', runtime: 'claude', modelLabel: 'Opus', effort: 'high', turns: 2 };
  expect(ThreadsListResultSchema.parse({ schema: 'threads-list-result-v1', threads: [thread, { ...thread, branch: 'jv/add-a-greeting-ABCDEF', pr: { number: 7, state: 'open', checks: 'passing' }, lastSummary: 'Added it.' }] }).threads).toHaveLength(2);
  expect(ThreadsListResultSchema.safeParse({ schema: 'threads-list-result-v1', threads: [{ ...thread, pr }] }).success).toBe(false);
  expect(ThreadStartResultSchema.parse({ schema: 'thread-start-result-v1', threadId, state: 'queued', stateReason: 'Queued: the project is at its limit of 3 running threads.', placement: 'Claude Opus · high · Worktree · Studio' })).toMatchObject({ state: 'queued' });
  expect(ThreadMessageResultSchema.safeParse({ schema: 'thread-message-result-v1', threadId, state: 'running', delivery: 'interrupting' }).success).toBe(true);
  expect(ThreadMessageResultSchema.safeParse({ schema: 'thread-message-result-v1', threadId, state: 'running', delivery: 'sent' }).success).toBe(false);
  const read = { schema: 'thread-read-result-v1', threadId, state: 'idle', reports: [report, report, report] };
  expect(ThreadReadResultSchema.safeParse({ ...read, pr, transcript: 'Last words.' }).success).toBe(true);
  expect(ThreadReadResultSchema.safeParse({ ...read, transcript: null, transcriptNote: 'The transcript stays on Studio.' }).success).toBe(true);
  expect(ThreadReadResultSchema.safeParse({ ...read, reports: [report, report, report, report] }).success).toBe(false);
  expect(ThreadReadResultSchema.safeParse({ ...read, transcript: 'x'.repeat(8001) }).success).toBe(false);
  expect(ThreadStopResultSchema.safeParse({ schema: 'thread-stop-result-v1', threadId, state: 'stopped' }).success).toBe(true);
  expect(AskUserResultSchema.safeParse({ schema: 'ask-user-result-v1', decisionId }).success).toBe(true);
  expect(WithdrawQuestionResultSchema.safeParse({ schema: 'withdraw-question-result-v1', decisionId, withdrawn: false }).success).toBe(true);
  expect(NotebookReadResultSchema.safeParse({ schema: 'notebook-read-result-v1', content: '', revision: 0 }).success).toBe(true);
  expect(NotebookWriteResultSchema.safeParse({ schema: 'notebook-write-result-v1', revision: 2 }).success).toBe(true);
  expect(PrStatusResultSchema.safeParse({ schema: 'pr-status-result-v1', threadId, pr: null, reason: 'No GitHub token is saved.' }).success).toBe(true);
  expect(PrStatusResultSchema.safeParse({ schema: 'pr-status-result-v1', threadId, pr }).success).toBe(true);
  expect(MailSendResultSchema.safeParse({ schema: 'mail-send-result-v1', mailId: 'mail_1' }).success).toBe(true);
  expect(MailInboxResultSchema.safeParse({ schema: 'mail-inbox-result-v1', mail: [{ id: 'mail_1', from: threadId, fromTitle: 'T1 title', subject: 'Heads up', body: 'I am changing src/app.txt.', at }] }).success).toBe(true);
  expect(ReserveResultSchema.parse({ schema: 'reserve-result-v1', granted: true, id: 'reservation_1' })).toMatchObject({ granted: true });
  expect(ReserveResultSchema.parse({ schema: 'reserve-result-v1', granted: false, conflicts: [{ threadTitle: 'T1 title', paths: ['src/'], expiresAt: at }] })).toMatchObject({ granted: false });
  expect(ReserveResultSchema.safeParse({ schema: 'reserve-result-v1', granted: true, conflicts: [{ threadTitle: 'T1 title', paths: ['src/'], expiresAt: at }] }).success).toBe(false);
  expect(ReserveResultSchema.safeParse({ schema: 'reserve-result-v1', granted: false, conflicts: [] }).success).toBe(false);
  expect(ReleaseResultSchema.safeParse({ schema: 'release-result-v1', released: 0 }).success).toBe(true);
  expect(ThreadReportResultSchema.safeParse({ schema: 'thread-report-result-v1', turn: 1, status: 'done', accepted: true, repeated: true }).success).toBe(true);
  expect(ThreadReportResultSchema.safeParse({ schema: 'thread-report-result-v1', turn: 1, status: 'done', accepted: false, repeated: false }).success).toBe(false);
});
