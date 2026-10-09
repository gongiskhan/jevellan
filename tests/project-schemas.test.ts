import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CoordinatorEventSchema, CoordinatorLocalSchema, CoordinatorMessageReceiptSchema, CoordinatorMessageRequestSchema, ThreadMessageReceiptSchema, CoordinatorStateSchema,
  CoordinatorViewSchema, DecisionAnswerRequestSchema, DecisionAnswerSchema, DecisionAnsweredViewSchema, FileReservationSchema, GitHubTokenStateSchema,
  Homes, InboxSeenSchema, JevCallSchema, MergeResultViewSchema, NotebookRequestSchema, OutboxEntrySchema, OutboxSeqSchema, PlacementOverrideSchema, PlacementRecordSchema,
  ProjectCoordinatorSchema, ProjectCoordinatorStatusSchema, ProjectDecisionSchema, ProjectEnvelopeSchema, ProjectEventFrameSchema,
  ProjectHubCollectionSchema, ProjectHubRequestSchema, ProjectHubResultSchema, ProjectLedgerDataSchemas, ProjectLedgerEventSchema,
  ProjectLedgerEventTypeSchema, ProjectMailSchema, ProjectNotebookSchema, ProjectNotebookViewSchema, ProjectWorkListViewSchema,
  ProjectWorkSettingsRequestSchema, ProjectWorkSettingsSchema, ProjectWorkSettingsViewSchema, ProjectWorkViewSchema, PullRequestEntrySchema,
  PullRequestStateSchema, QueuedMessageSchema, SecretVault, ThreadAttachRequestSchema, ThreadAttachViewSchema, ThreadCommandSchema,
  ThreadCreateRequestSchema, ThreadCreatedViewSchema, ThreadDetachRequestSchema, ThreadDetachViewSchema, ThreadIndexCursorSchema,
  ThreadIndexSchema, ThreadLocalSchema, ThreadMessageRequestSchema, ThreadOverrideRequestSchema, ThreadOverrideViewSchema,
  ThreadReportFieldsSchema, ThreadReportSchema, ThreadSchema, ThreadStartReceiptSchema, ThreadStateSchema, ThreadStopRequestSchema,
  ThreadViewSchema, checkHubRevision, collectionOf, concludedStates, defaultProjectWorkSettings, isProjectHubRead, isTerminal, liveWork, minimalEnvironment,
  parseProjectLedgerData, pathsOverlap, runningSection, slugify, threadBranch, withHubRevision,
  type ProjectHubOperation, type ProjectHubResultOf, type ProjectWorkSettings, type Stored, type ThreadState,
} from '../packages/core/dist/index.js';
import * as client from '../packages/core/dist/client.js';

const at = '2026-10-03T10:00:00.000Z';
const later = '2026-10-03T11:00:00.000Z';
const threadId = 'thread_01K6NV2QZ8XKW3P7Q2K9M';
const jevCall = { schema: 'jev-call-v1', kind: 'placement', requestedModel: 'jev-model', returnedModel: 'jev-model', usage: { input_tokens: 10, output_tokens: 2 }, latencyMs: 40 };
const settings = defaultProjectWorkSettings('project');
const option = { label: 'Keep it', detail: 'Leave the current behavior.' };
const report = { schema: 'thread-report-v1', turn: 1, status: 'progress', summary: 'Added the login form.', changedFiles: ['src/login.ts'], synthesized: false };
const pr = { number: 7, url: 'https://github.com/owner/repo/pull/7', state: 'open', headSha: 'a'.repeat(40), checks: 'pending', mergeable: 'unknown', updatedAt: at };
const placement = { schema: 'placement-v1', questionSet: 'p-v1', source: 'fallback', fixed: ['effort'], isolation: 'worktree', runtime: 'claude', modelId: 'deep', model: 'claude-opus',
  effortRequested: 'high', effortEffective: 'high', deviceId: 'dev_a', accountId: 'acc_a', eligibleModels: ['deep'], excludedModels: [{ modelId: 'fast', reason: 'disabled' }],
  eligibleDevices: ['dev_a'], excludedDevices: [], error: { kind: 'not-enabled', message: 'Jev placement is not enabled yet.' }, jevCalls: [jevCall], decidedAt: at };
const message = { id: 'tmsg_1', from: 'owner', text: 'Also cover logout.', at, interrupt: false };
const event = { schema: 'coordinator-event-v1', kind: 'user-message', id: 'cev_1', at, text: 'Fix the login page.', clientMessageId: 'msg_1' };
const thread = { schema: 'project-thread-v1', id: threadId, projectId: 'project', title: 'Fix login', task: 'Fix the login page.', createdAt: at, createdBy: 'owner',
  state: 'running', isolation: 'worktree', placement, ownerDeviceId: 'dev_a', coordinatorDeviceId: 'dev_a', cwd: '/tmp/worktree', branch: 'jv/fix-login-q2k9m',
  baseBranch: 'main', baseCommit: 'b'.repeat(40), turns: 1, turnAllowance: 30, nativeSessionId: 'native-1', queuedMessages: [message], lastReport: report,
  verificationAttempts: 0, pr };
const index = { schema: 'project-thread-index-v1', revision: 1, id: threadId, projectId: 'project', title: 'Fix login', state: 'running', isolation: 'worktree',
  ownerDeviceId: 'dev_a', runtime: 'claude', modelLabel: 'Claude Opus', effort: 'high', accountLabel: 'Work', branch: 'jv/fix-login-q2k9m', pr,
  lastSummary: 'Added the login form.', turns: 1, createdAt: at, updatedAt: at };
const decision = { schema: 'project-decision-v1', revision: 1, id: 'pdec_1', projectId: 'project', threadId, from: 'coordinator', question: 'Keep the old form?',
  options: [option, { label: 'Replace it' }], createdAt: at };
const notebook = { schema: 'project-notebook-v1', projectId: 'project', revision: 2, content: '# Plan\n', updatedAt: at, updatedBy: 'owner' };
const override = { schema: 'placement-override-v1', id: 'povr_1', projectId: 'project', threadId, mode: 'next-turn', changes: [{ field: 'effort', from: 'high', to: 'max' }], at };
const status = { schema: 'project-coordinator-status-v1', revision: 1, projectId: 'project', deviceId: 'dev_a', state: 'idle', failedTurnsInARow: 0,
  session: { runtime: 'claude', modelLabel: 'Claude Opus', effort: 'medium', accountLabel: 'Work', turns: 3 }, updatedAt: at };
const envelope = { schema: 'project-envelope-v1', revision: 1, id: 'env_1', projectId: 'project', sourceDeviceId: 'dev_a', targetDeviceId: 'dev_b', seq: 1, createdAt: at,
  body: { kind: 'thread-command', threadId, commandId: 'cmd_1', command: { type: 'message', message } } };
const without = (value: object, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const coordinatorView = { state: 'idle', deviceId: 'dev_a', deviceName: 'Laptop', online: true, session: null, planned: { runtime: 'claude', modelLabel: 'Claude Opus', effort: 'high' }, canMoveHere: false };

// Every Projects document, valid as given. Each must refuse an unknown key.
const documents: Array<[string, { safeParse(value: unknown): { success: boolean } }, Record<string, unknown>]> = [
  ['settings', ProjectWorkSettingsSchema, settings],
  ['coordinator assignment', ProjectCoordinatorSchema, { schema: 'project-coordinator-v1', projectId: 'project', revision: 1, deviceId: 'dev_a', assignedAt: at }],
  ['report', ThreadReportSchema, { ...report, status: 'needs-decision', question: 'Which one?', options: [option, option], testsRun: { command: 'npm test', passed: true, summary: 'ok' } }],
  ['answer', DecisionAnswerSchema, { optionLabel: 'Keep it', text: 'and log it' }],
  ['coordinator event', CoordinatorEventSchema, event],
  ['coordinator state', CoordinatorStateSchema, { schema: 'coordinator-state-v1', projectId: 'project', state: 'running', session: { runtime: 'claude', modelId: 'deep', model: 'claude-opus', effort: 'medium', accountId: 'acc_a', nativeSessionId: 'n1', startedAt: at, turns: 2 }, queue: [event], failedTurnsInARow: 0, lastTurnAt: at }],
  ['pull request', PullRequestStateSchema, pr],
  ['placement', PlacementRecordSchema, placement],
  ['queued message', QueuedMessageSchema, message],
  ['thread', ThreadSchema, thread],
  ['thread index', ThreadIndexSchema, index],
  ['decision', ProjectDecisionSchema, { ...decision, answeredAt: later, answer: { optionLabel: 'Keep it' } }],
  ['notebook', ProjectNotebookSchema, notebook],
  ['mail', ProjectMailSchema, { schema: 'project-mail-v1', revision: 1, id: 'mail_1', projectId: 'project', from: threadId, to: 'all', subject: 'Heads up', body: 'I am editing src/.', at, readBy: [] }],
  ['reservation', FileReservationSchema, { schema: 'file-reservation-v1', revision: 1, id: 'resv_1', projectId: 'project', threadId, deviceId: 'dev_a', paths: ['src/'], reason: 'refactor', createdAt: at, expiresAt: later }],
  ['override', PlacementOverrideSchema, override],
  ['thread sidecar', ThreadLocalSchema, { schema: 'thread-local-v1', process: { turn: 1, pid: 400, pgid: 400, startIdentity: 'start', startedAt: at }, pushedCommit: 'c'.repeat(40), gitIdentity: { name: 'Owner', email: 'owner@example.com' }, prNotified: { headSha: 'a'.repeat(40), checks: 'failing', conflict: false }, seenCommands: ['cmd_1'], seenMessages: [{ id: 'msg_1', digest: 'b'.repeat(64) }], labels: { modelLabel: 'Codex GPT-5', accountLabel: 'Work' } }],
  ['coordinator sidecar', CoordinatorLocalSchema, { schema: 'coordinator-local-v1', deliveredTurn: 2, fallbackEventIds: ['cev_1'] }],
  ['coordinator sidecar after a handover', CoordinatorLocalSchema, { schema: 'coordinator-local-v1', deliveredTurn: 2, fallbackEventIds: [], forwardedEventIds: ['cev_2'] }],
  ['coordinator status', ProjectCoordinatorStatusSchema, status],
  ['coordinator status with its last event id', ProjectCoordinatorStatusSchema, { ...status, lastEventId: 42 }],
  ['thread cursor', ThreadIndexCursorSchema, { schema: 'project-thread-cursor-v1', threadId, deviceId: 'dev_a', eventId: 4, digest: 'f'.repeat(64) }],
  ['start receipt', ThreadStartReceiptSchema, { schema: 'thread-start-receipt-v1', clientRequestId: 'req_1', digest: 'd', threadId, at }],
  ['remote start receipt', ThreadStartReceiptSchema, { schema: 'thread-start-receipt-v1', clientRequestId: 'req_1', digest: 'd', threadId, at,
    started: { state: 'queued', stateReason: 'Queued: Studio is at its limit of 2 running threads.', placement: 'Codex Swift · medium · Worktree · Studio' } }],
  ['thread command', ThreadCommandSchema, { type: 'override-next-turn', override }],
  ['owner stop command', ThreadCommandSchema, { type: 'stop', reason: 'Stopped by you at the turn limit.', notify: true }],
  ['envelope', ProjectEnvelopeSchema, envelope],
  ['outbox entry', OutboxEntrySchema, { schema: 'project-outbox-entry-v1', target: 'coordinator', envelope: { schema: 'project-envelope-v1', id: 'env_2', projectId: 'project', sourceDeviceId: 'dev_a', seq: 2, createdAt: at, body: { kind: 'coordinator-event', event } } }],
  ['outbox sequence', OutboxSeqSchema, { schema: 'project-outbox-seq-v1', seq: 3 }],
  ['inbox seen', InboxSeenSchema, { schema: 'project-inbox-seen-v1', ids: ['env_1', 'env_2'] }],
  ['ledger event', ProjectLedgerEventSchema, { schema: 'project-ledger-event-v1', t: at, id: 1, type: 'notice', turn: 1, data: { schema: 'project-notice-v1', text: 'Saved.', kind: 'info' } }],
  ['event frame', ProjectEventFrameSchema, { schema: 'project-event-v1', event: { schema: 'project-ledger-event-v1', t: at, id: 2, type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Started two threads.' } } }],
  ['list view', ProjectWorkListViewSchema, { schema: 'project-work-list-view-v1', projects: [{ projectId: 'project', name: 'Site', waiting: 1, running: 2, inReview: 0, coordinator: { deviceId: null, state: 'none' } }] }],
  ['coordinator view', CoordinatorViewSchema, coordinatorView],
  ['pull request entry', PullRequestEntrySchema, { threadId, title: 'Fix login', branch: 'jv/fix-login-q2k9m', reason: 'No GitHub token is saved.' }],
  ['project view', ProjectWorkViewSchema, { schema: 'project-work-view-v1', project: { id: 'project', name: 'Site', branchPolicy: 'main', baseBranch: 'main' }, settings, coordinator: coordinatorView, threads: [index], decisions: { open: [decision], answered: [] }, pullRequests: [{ threadId, title: 'Fix login', pr }], notebookRevision: 2, lastEventId: 9, gates: { mainIsolation: false, remoteDevices: false } }],
  ['thread view', ThreadViewSchema, { schema: 'project-thread-view-v1', thread: index, placement, reports: [report], transcript: null, queuedMessages: [message], canMessage: true, turnAllowance: 30, deviceName: 'Laptop', baseBranch: 'main', attachCommand: `jevellan thread attach ${threadId}`, canOverride: { nextTurn: true, restart: false, restartReason: 'Stop the thread first.' }, canDiscard: false, atTurnLimit: false }],
  ['coordinator message request', CoordinatorMessageRequestSchema, { schema: 'coordinator-message-request-v1', clientMessageId: 'msg_1', text: 'Go.' }],
  ['thread create request', ThreadCreateRequestSchema, { schema: 'thread-create-request-v1', clientRequestId: 'req_1', title: 'Fix login', task: 'Fix it.', isolation: 'worktree', modelId: 'deep', effort: 'high', deviceId: 'dev_a' }],
  ['restart create request', ThreadCreateRequestSchema, { schema: 'thread-create-request-v1', clientRequestId: 'req_1', title: 'Fix login', task: 'Fix it.', modelId: 'deep', note: 'Cheaper.' }],
  ['thread message request', ThreadMessageRequestSchema, { schema: 'thread-message-request-v1', clientMessageId: 'msg_2', text: 'Also logout.', interrupt: true }],
  ['thread stop request', ThreadStopRequestSchema, { schema: 'thread-stop-request-v1', reason: 'Not needed.' }],
  ['override request', ThreadOverrideRequestSchema, { schema: 'thread-override-request-v1', clientRequestId: 'req_2', mode: 'restart', modelId: 'fast', note: 'Cheaper.' }],
  ['answer request', DecisionAnswerRequestSchema, { schema: 'decision-answer-request-v1', clientRequestId: 'req_3', text: 'Keep it.' }],
  ['settings request', ProjectWorkSettingsRequestSchema, { schema: 'project-work-settings-request-v1', revision: 1, clientRequestId: 'req_4', settings: { defaultIsolation: 'worktree', coordinator: { modelId: 'deep', effort: 'high' }, setupCommand: 'npm ci', maxRunningThreads: 3, maxRunningPerDevice: 2, threadTurnCap: 40 } }],
  ['notebook request', NotebookRequestSchema, { schema: 'notebook-request-v1', expectedRevision: 2, content: 'New plan.' }],
  ['notebook view', ProjectNotebookViewSchema, { schema: 'project-notebook-view-v1', notebook: null, revision: 0 }],
  ['created view', ThreadCreatedViewSchema, { schema: 'thread-created-view-v1', threadId, state: 'preparing', placement: 'Worktree on Laptop with Claude Opus, high effort.' }],
  ['merge view', MergeResultViewSchema, { schema: 'pull-request-merge-view-v1', merged: true }],
  ['settings view', ProjectWorkSettingsViewSchema, { schema: 'project-work-settings-view-v1', settings, notice: 'This project is set to Leave git to me.' }],
  ['message receipt', CoordinatorMessageReceiptSchema, { schema: 'coordinator-message-receipt-v1', repeated: false }],
  ['thread message receipt', ThreadMessageReceiptSchema, { schema: 'thread-message-receipt-v1', repeated: true }],
  ['override view', ThreadOverrideViewSchema, { schema: 'thread-override-view-v1', newThreadId: threadId }],
  ['answered view', DecisionAnsweredViewSchema, { schema: 'decision-answered-view-v1', repeated: true }],
  ['attach request', ThreadAttachRequestSchema, { schema: 'thread-attach-request-v1' }],
  ['attach view', ThreadAttachViewSchema, { schema: 'thread-attach-v1', cwd: '/tmp/worktree', runtime: 'codex', nativeSessionId: 'native-1', model: 'gpt-5', effort: 'high', env: { CODEX_HOME: '/tmp/home' }, deviceName: 'Laptop' }],
  ['detach request', ThreadDetachRequestSchema, { schema: 'thread-detach-request-v1', exitCode: null }],
  ['detach view', ThreadDetachViewSchema, { schema: 'thread-detach-v1', adopted: true, state: 'idle' }],
  ['GitHub token', GitHubTokenStateSchema, { schema: 'github-token-summary-v1', id: 'github', saved: true, lastFour: 'abcd', updatedAt: at }],
  ['hub request', ProjectHubRequestSchema, { schema: 'project-hub-request-v1', operation: 'thread-publish', index, eventId: 3 }],
  ['hub result', ProjectHubResultSchema, { schema: 'project-hub-result-v1', operation: 'decision-answer', record: { revision: 2, document: { ...decision, revision: 2, answeredAt: later, answer: { text: 'Yes' } } }, repeated: false }],
];

test.each(documents)('%s parses and refuses unknown keys', (_name, schema, value) => {
  expect(schema.safeParse(value).success).toBe(true);
  expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
});

test('nested documents are strict too', () => {
  expect(ThreadSchema.safeParse({ ...thread, placement: { ...placement, extra: 1 } }).success).toBe(false);
  expect(ThreadSchema.safeParse({ ...thread, queuedMessages: [{ ...message, extra: 1 }] }).success).toBe(false);
  expect(ProjectWorkSettingsSchema.safeParse({ ...settings, coordinator: { ...settings.coordinator, runtime: 'claude' } }).success).toBe(false);
  expect(CoordinatorEventSchema.safeParse({ ...event, kind: 'thread-user-message' }).success).toBe(false);
  expect(CoordinatorEventSchema.safeParse({ ...event, schema: 'coordinator-event-v2' }).success).toBe(false);
  expect(ProjectEnvelopeSchema.safeParse({ ...envelope, body: { kind: 'thread-command', threadId, commandId: 'cmd_1', command: { type: 'reboot' } } }).success).toBe(false);
  expect(OutboxEntrySchema.safeParse({ schema: 'project-outbox-entry-v1', target: 'dev_b', envelope }).success).toBe(false);
  expect(InboxSeenSchema.safeParse({ schema: 'project-inbox-seen-v1', ids: Array.from({ length: 2001 }, (_, n) => `env_${n}`) }).success).toBe(false);
  expect(OutboxSeqSchema.safeParse({ schema: 'project-outbox-seq-v1', seq: -1 }).success).toBe(false);
  expect(PlacementRecordSchema.safeParse({ ...placement, jevCalls: [{ ...jevCall, kind: 'unknown' }] }).success).toBe(false);
  expect(ThreadViewSchema.safeParse({ ...documents.find(([name]) => name === 'thread view')![2], thread: { ...index, nativeSessionId: 'native-1' } }).success).toBe(false);
});

test('defaults match the brief and fill optional collections', () => {
  expect(settings).toEqual({ schema: 'project-work-settings-v1', projectId: 'project', revision: 0, defaultIsolation: 'worktree', coordinator: { modelId: null, effort: 'medium' }, setupCommand: null, maxRunningThreads: 6, maxRunningPerDevice: 4, threadTurnCap: 30 });
  expect(() => defaultProjectWorkSettings('../escape')).toThrow();
  expect(ThreadReportSchema.parse(without(report, 'changedFiles')).changedFiles).toEqual([]);
  expect(ProjectDecisionSchema.parse(without(decision, 'options')).options).toEqual([]);
  expect(CoordinatorLocalSchema.parse({ schema: 'coordinator-local-v1' })).toEqual({ schema: 'coordinator-local-v1', deliveredTurn: 0, fallbackEventIds: [] });
  expect(CoordinatorLocalSchema.safeParse({ schema: 'coordinator-local-v1', forwardedEventIds: Array.from({ length: 501 }, (_, n) => `cev_${n}`) }).success).toBe(false);
  expect(ThreadLocalSchema.parse({ schema: 'thread-local-v1' })).toEqual({ schema: 'thread-local-v1' });
});

test('settings, notebook, reservation and override bounds are enforced', () => {
  for (const [field, value] of [['maxRunningThreads', 0], ['maxRunningThreads', 21], ['maxRunningPerDevice', 11], ['threadTurnCap', 4], ['threadTurnCap', 201], ['setupCommand', 'x'.repeat(501)], ['defaultIsolation', 'branch']] as const)
    expect(ProjectWorkSettingsSchema.safeParse({ ...settings, [field]: value }).success, `${field}=${String(value).slice(0, 10)}`).toBe(false);
  expect(ProjectWorkSettingsSchema.safeParse({ ...settings, maxRunningThreads: 20, maxRunningPerDevice: 10, threadTurnCap: 200, setupCommand: 'x'.repeat(500) }).success).toBe(true);
  expect(ProjectNotebookSchema.safeParse({ ...notebook, content: 'x'.repeat(65536) }).success).toBe(true);
  expect(ProjectNotebookSchema.safeParse({ ...notebook, content: 'x'.repeat(65537) }).success).toBe(false);
  const reservation = documents.find(([name]) => name === 'reservation')![2];
  expect(FileReservationSchema.safeParse({ ...reservation, paths: [] }).success).toBe(false);
  expect(FileReservationSchema.safeParse({ ...reservation, paths: Array.from({ length: 51 }, (_, n) => `f${n}`) }).success).toBe(false);
  expect(FileReservationSchema.safeParse({ ...reservation, paths: [''] }).success).toBe(false);
  expect(PlacementOverrideSchema.safeParse({ ...override, changes: [] }).success).toBe(false);
  expect(PlacementOverrideSchema.safeParse({ ...override, changes: [{ field: 'account', from: 'a', to: 'b' }] }).success).toBe(true);
  expect(PlacementOverrideSchema.safeParse({ ...override, changes: [{ field: 'runtime', from: 'claude', to: 'codex' }] }).success).toBe(true);
  expect(PlacementOverrideSchema.safeParse({ ...override, changes: [{ field: 'temperature', from: 'a', to: 'b' }] }).success).toBe(false);
  expect(ThreadSchema.safeParse({ ...thread, title: 'x'.repeat(121) }).success).toBe(false);
  expect(ThreadIndexSchema.safeParse({ ...index, lastSummary: 'x'.repeat(401) }).success).toBe(false);
  expect(PullRequestStateSchema.safeParse({ ...pr, url: 'not a url' }).success).toBe(false);
  expect(ThreadLocalSchema.safeParse({ schema: 'thread-local-v1', pushedCommit: 'main' }).success).toBe(false);
  expect(ThreadLocalSchema.safeParse({ schema: 'thread-local-v1', process: { turn: 1, pid: 1, pgid: 1, startedAt: at } }).success).toBe(false);
});

test('a needs-decision report needs a question and options come in twos to fours', () => {
  const needs = { ...report, status: 'needs-decision' };
  const missing = ThreadReportSchema.safeParse(needs);
  expect(missing.success).toBe(false);
  expect(missing.error?.issues[0]).toMatchObject({ message: 'A needs-decision report needs a question.', path: ['question'] });
  expect(ThreadReportSchema.safeParse({ ...needs, question: '' }).success).toBe(false);
  expect(ThreadReportSchema.safeParse({ ...needs, question: 'Which one?' }).success).toBe(true);
  expect(ThreadReportSchema.safeParse({ ...report, status: 'blocked' }).success).toBe(true);
  expect(ThreadReportSchema.safeParse({ ...report, status: 'finished' }).success).toBe(false);
  for (const options of [[option], [option, option, option, option, option]]) expect(ThreadReportSchema.safeParse({ ...needs, question: 'Which one?', options }).success).toBe(false);
  for (const options of [[option, option], [option, option, option, option]]) expect(ThreadReportSchema.safeParse({ ...needs, question: 'Which one?', options }).success).toBe(true);
  expect(ThreadReportSchema.safeParse({ ...needs, question: 'Which one?', options: [{ label: '' }, option] }).success).toBe(false);
  expect(ThreadReportSchema.safeParse({ ...needs, question: 'Which one?', options: [{ label: 'x'.repeat(121) }, option] }).success).toBe(false);
  expect(ThreadReportSchema.safeParse({ ...report, summary: '' }).success).toBe(false);
  expect(ThreadReportSchema.safeParse({ ...report, summary: 'x'.repeat(1201) }).success).toBe(false);
  expect(ThreadReportSchema.safeParse({ ...report, changedFiles: Array.from({ length: 201 }, (_, n) => `f${n}`) }).success).toBe(false);
  // The unrefined fields stay derivable for tool inputs, and the refined report still guards events and threads.
  expect(Object.keys(ThreadReportFieldsSchema.omit({ schema: true, turn: true, synthesized: true }).shape).sort()).toEqual(['changedFiles', 'options', 'question', 'status', 'summary', 'testsRun']);
  expect(CoordinatorEventSchema.safeParse({ schema: 'coordinator-event-v1', kind: 'thread-report', id: 'cev_2', at, threadId, report: needs }).success).toBe(false);
  expect(ThreadSchema.safeParse({ ...thread, lastReport: needs }).success).toBe(false);
});

test('a decision answer needs an option label or text', () => {
  for (const answer of [{}, { optionLabel: '' }, { text: '' }, { optionLabel: '', text: '' }]) {
    const result = DecisionAnswerSchema.safeParse(answer);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Choose an option or write an answer.');
  }
  expect(DecisionAnswerSchema.safeParse({ optionLabel: 'Keep it' }).success).toBe(true);
  expect(DecisionAnswerSchema.safeParse({ text: 'Neither.' }).success).toBe(true);
  expect(DecisionAnswerSchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
  expect(DecisionAnswerRequestSchema.safeParse({ schema: 'decision-answer-request-v1', clientRequestId: 'req_1' }).success).toBe(false);
  expect(DecisionAnswerRequestSchema.safeParse({ schema: 'decision-answer-request-v1', clientRequestId: 'req_1', optionLabel: 'Keep it' }).success).toBe(true);
  expect(ProjectDecisionSchema.safeParse({ ...decision, answer: {} }).success).toBe(false);
  expect(ProjectDecisionSchema.safeParse({ ...decision, options: [option, option, option, option, option] }).success).toBe(false);
  expect(CoordinatorEventSchema.safeParse({ schema: 'coordinator-event-v1', kind: 'decision-answer', id: 'cev_3', at, decisionId: 'pdec_1', question: 'Keep?', answer: {} }).success).toBe(false);
  expect(CoordinatorEventSchema.safeParse({ schema: 'coordinator-event-v1', kind: 'decision-answer', id: 'cev_3', at, decisionId: 'pdec_1', question: 'Keep?', answer: { text: 'Yes' } }).success).toBe(true);
});

test('every coordinator event kind parses with its own fields', () => {
  const base = { schema: 'coordinator-event-v1', at };
  const events = [
    event,
    { ...base, kind: 'thread-report', id: 'cev_2', threadId, report },
    { ...base, kind: 'thread-published', id: 'cev_3', threadId, result: 'pr-opened', prNumber: 7, commit: 'a'.repeat(40) },
    { ...base, kind: 'thread-verification-failed', id: 'cev_4', threadId, attempts: 2, tail: 'FAIL' },
    { ...base, kind: 'thread-interrupted', id: 'cev_5', threadId, reason: 'restart', message: 'Jevellan restarted.' },
    { ...base, kind: 'decision-answer', id: 'cev_6', decisionId: 'pdec_1', threadId, question: 'Keep?', answer: { optionLabel: 'Keep it' } },
    { ...base, kind: 'pr-update', id: 'cev_7', threadId, prNumber: 7, change: 'checks-failed' },
    { ...base, kind: 'mail', id: 'cev_8', mailId: 'mail_1', fromThreadId: threadId, subject: 'Heads up', body: 'Done with src/.' },
    { ...base, kind: 'thread-user-message', id: 'cev_9', threadId, text: 'Owner: also logout.' },
    { ...base, kind: 'placement-override', id: 'cev_10', threadId, summary: 'Effort changed from high to max.' },
  ];
  expect(events.map((value) => CoordinatorEventSchema.parse(value).kind)).toEqual(['user-message', 'thread-report', 'thread-published', 'thread-verification-failed', 'thread-interrupted', 'decision-answer', 'pr-update', 'mail', 'thread-user-message', 'placement-override']);
  expect(CoordinatorEventSchema.safeParse({ ...events[2], result: 'branch-pushed' }).success).toBe(false);
  expect(CoordinatorEventSchema.safeParse({ ...events[3], tail: 'x'.repeat(4001) }).success).toBe(false);
  expect(CoordinatorEventSchema.safeParse({ ...events[0], text: '' }).success).toBe(false);
  expect(CoordinatorEventSchema.safeParse({ ...events[0], at: 'yesterday' }).success).toBe(false);
});

test('JevCall kinds keep their old values and add placement', () => {
  for (const kind of ['action', 'model', 'memory', 'placement']) expect(JevCallSchema.safeParse({ ...jevCall, kind }).success).toBe(true);
  expect(JevCallSchema.safeParse({ ...jevCall, kind: 'route' }).success).toBe(false);
});

test('ledger envelopes are separate from conversation ledgers and payloads are validated per type', () => {
  const envelope = { schema: 'project-ledger-event-v1', t: at, id: 1, type: 'thread-state', data: {} };
  expect(ProjectLedgerEventSchema.safeParse(envelope).success).toBe(true);
  expect(ProjectLedgerEventSchema.safeParse({ ...envelope, schema: 'ledger-event-v1' }).success).toBe(false);
  for (const type of ['stretch-start', 'user-message', 'handoff']) expect(ProjectLedgerEventSchema.safeParse({ ...envelope, type }).success).toBe(false);
  expect(ProjectLedgerEventSchema.safeParse({ ...envelope, data: { schema: 'blob-ref-v1', ref: `blobs/${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 70000 } }).success).toBe(true);
  expect(Object.keys(ProjectLedgerDataSchemas).sort()).toEqual([...ProjectLedgerEventTypeSchema.options].sort());
  const payloads: Record<string, unknown> = {
    'coordinator-turn-start': { schema: 'coordinator-turn-v1', turn: 1, fresh: true, runtime: 'claude', modelLabel: 'Claude Opus', effort: 'medium', accountLabel: 'Work', eventIds: ['cev_1'] },
    'coordinator-text': { schema: 'coordinator-text-v1', text: 'Started two threads.' },
    'coordinator-tool': { schema: 'coordinator-tool-v1', tool: 'jevellan_withdraw_question', ok: true, summary: 'Withdrew a question.', decisionId: 'pdec_1', reason: 'The thread solved it.' },
    'coordinator-turn-end': { schema: 'coordinator-turn-end-v1', turn: 1, status: 'dropped' },
    'coordinator-event': event,
    'thread-turn-start': { schema: 'thread-turn-v1', turn: 2, resumed: true, runtime: 'codex', modelId: 'fast', model: 'gpt-5', effort: 'low', accountId: 'acc_b' },
    'thread-turn-end': { schema: 'thread-turn-end-v1', turn: 2, status: 'steered' },
    'thread-report': report,
    'thread-placement': placement,
    'thread-state': { schema: 'thread-state-v1', from: null, to: 'queued', reason: 'Queued: the project is at its limit of 6 running threads.', changed: ['state'] },
    'thread-verification': { schema: 'thread-verification-v1', attempt: 1, command: null, status: 'skipped', timedOut: false, commit: 'a'.repeat(40), tail: '' },
    'thread-publication': { schema: 'thread-publication-v1', result: 'pr-opened', prNumber: 7, branch: 'jv/fix-login-q2k9m', pr, files: ['src/login.ts'] },
    notice: { schema: 'project-notice-v1', text: 'Saved.', kind: 'error' },
  };
  for (const type of ProjectLedgerEventTypeSchema.options) {
    expect(parseProjectLedgerData(type, payloads[type]), type).toMatchObject(payloads[type] as object);
    expect(() => parseProjectLedgerData(type, { ...(payloads[type] as object), unexpected: 1 }), type).toThrow();
  }
  expect(() => parseProjectLedgerData('notice', payloads['coordinator-text'])).toThrow();
  expect(() => parseProjectLedgerData('thread-report', { ...report, status: 'needs-decision' })).toThrow('needs a question');
  expect(() => parseProjectLedgerData('stretch-start' as 'notice', {})).toThrow();
  expect(() => parseProjectLedgerData('coordinator-turn-end', { schema: 'coordinator-turn-end-v1', turn: 1, status: 'completed', error: 'x'.repeat(1001) })).toThrow();
  expect(() => parseProjectLedgerData('thread-verification', { ...(payloads['thread-verification'] as object), tail: 'x'.repeat(4001) })).toThrow();
});

test('hub requests map to one collection each and results carry matching revisions', () => {
  const requests: Record<ProjectHubOperation, Record<string, unknown>> = {
    'settings-get': { projectId: 'project' }, 'settings-put': { settings: { ...settings, revision: 1 }, expectedRevision: 0, clientRequestId: 'req_1' },
    'coordinator-get': { projectId: 'project' }, 'coordinator-assign': { projectId: 'project', deviceId: 'dev_a', expectedRevision: 0 },
    'coordinator-status-get': { projectId: 'project' }, 'coordinator-status-put': { status },
    'threads-list': { projectId: 'project', after: threadId }, 'thread-get': { threadId }, 'thread-publish': { index, eventId: 1 },
    'decisions-list': { projectId: 'project' }, 'decision-get': { id: 'pdec_1' }, 'decision-create': { decision },
    'decision-withdraw': { id: 'pdec_1', at }, 'decision-answer': { id: 'pdec_1', answer: { optionLabel: 'Keep it' }, at, clientRequestId: 'req_2' },
    'notebook-get': { projectId: 'project' }, 'notebook-put': { notebook, expectedRevision: 1 },
    'override-add': { override }, 'overrides-recent': { projectId: 'project', limit: 8 },
    'envelope-put': { envelope }, 'envelopes-pending': { targetDeviceId: 'dev_b' }, 'envelope-ack': { id: 'env_1' },
    'work-summaries': { after: 'project' },
    'mail-send': { mail: { schema: 'project-mail-v1', revision: 0, id: 'mail_1', projectId: 'project', from: threadId, to: 'all', subject: 'Heads up', body: 'I am editing src/.', at, readBy: [] } },
    'mail-inbox': { projectId: 'project', threadId }, 'mail-read': { projectId: 'project', threadId, ids: ['mail_1'] },
    'reserve': { reservation: { id: 'resv_1', projectId: 'project', threadId, paths: ['src/'], reason: 'Edit the app', minutes: 60 } },
    'release': { projectId: 'project', threadId, id: 'resv_1' }, 'reservations-list': { projectId: 'project' },
    'checkouts-held': { projectId: 'project' },
  };
  const expected = { settings: ['settings-get', 'settings-put'], coordinators: ['coordinator-get', 'coordinator-assign', 'coordinator-status-get', 'coordinator-status-put'],
    threads: ['threads-list', 'thread-get', 'thread-publish'], decisions: ['decisions-list', 'decision-get', 'decision-create', 'decision-withdraw', 'decision-answer'], notebooks: ['notebook-get', 'notebook-put'],
    overrides: ['override-add', 'overrides-recent'], envelopes: ['envelope-put', 'envelopes-pending', 'envelope-ack'], work: ['work-summaries'],
    mail: ['mail-send', 'mail-inbox', 'mail-read'], reservations: ['reserve', 'release', 'reservations-list'], checkouts: ['checkouts-held'] };
  for (const [operation, fields] of Object.entries(requests) as Array<[ProjectHubOperation, Record<string, unknown>]>) {
    const request = { schema: 'project-hub-request-v1', operation, ...fields };
    expect(ProjectHubRequestSchema.parse(request).operation).toBe(operation);
    expect(ProjectHubRequestSchema.safeParse({ ...request, extra: 1 }).success).toBe(false);
    expect(ProjectHubCollectionSchema.options).toContain(collectionOf(operation));
    expect((expected as Record<string, string[]>)[collectionOf(operation)]).toContain(operation);
  }
  expect(ProjectHubCollectionSchema.options).toEqual(['settings', 'coordinators', 'threads', 'decisions', 'notebooks', 'overrides', 'envelopes', 'work', 'mail', 'reservations', 'checkouts']);
  // The Projects list in one read (D267): pages of at most 100 summaries; a coordinator carries its device's presence or null.
  expect(isProjectHubRead('work-summaries')).toBe(true);
  const summary = { schema: 'project-work-summary-v1', projectId: 'project', name: 'Site', waiting: 1, running: 2, inReview: 0,
    coordinator: { deviceId: 'dev_a', device: { name: 'Mac mini', status: 'online', revoked: false }, state: 'idle' } };
  const summaries = { schema: 'project-hub-result-v1', operation: 'work-summaries', next: null };
  expect(ProjectHubResultSchema.safeParse({ ...summaries, records: [summary, { ...summary, projectId: 'other', coordinator: null }, { ...summary, coordinator: { deviceId: 'dev_b', device: null, state: null } }] }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ ...summaries, records: Array.from({ length: 101 }, () => summary) }).success).toBe(false);
  expect(ProjectHubResultSchema.safeParse({ ...summaries, records: [{ ...summary, coordinator: { ...summary.coordinator, state: 'offline' } }] }).success).toBe(false);
  expect(ProjectHubResultSchema.safeParse({ ...summaries, records: [{ ...summary, running: -1 }] }).success).toBe(false);
  expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'mail-send', projectId: 'project' }).success).toBe(false);
  // Mail and reservations (D285): reading the inbox is a read and marking is a write; at most 100 ids are marked at once; 1 to 120 minutes.
  expect(['mail-inbox', 'reservations-list'].every((operation) => isProjectHubRead(operation as ProjectHubOperation))).toBe(true);
  expect(['mail-send', 'mail-read', 'reserve', 'release'].some((operation) => isProjectHubRead(operation as ProjectHubOperation))).toBe(false);
  expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'mail-read', projectId: 'project', threadId, ids: [] }).success).toBe(false);
  expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'mail-read', projectId: 'project', threadId, ids: Array.from({ length: 101 }, (_, n) => `mail_${n}`) }).success).toBe(false);
  const reservation = { id: 'resv_1', projectId: 'project', threadId, paths: ['src/'], reason: '', minutes: 60 };
  for (const minutes of [0, 121, 1.5]) expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'reserve', reservation: { ...reservation, minutes } }).success).toBe(false);
  expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'reserve', reservation: { ...reservation, paths: [] } }).success).toBe(false);
  expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'reserve', reservation: { ...reservation, deviceId: 'dev_a' } }).success).toBe(false);
  // Held checkouts (D288): a read, one entry per device with the holder's id and a title of at most 200 characters.
  expect(isProjectHubRead('checkouts-held')).toBe(true);
  const checkouts = { schema: 'project-hub-result-v1', operation: 'checkouts-held' };
  const entry = { deviceId: 'dev_a', ownerId: threadId, title: 'Fix login' };
  expect(ProjectHubResultSchema.safeParse({ ...checkouts, records: [entry, { ...entry, deviceId: 'dev_b', ownerId: 'conv_1' }] }).success).toBe(true);
  for (const bad of [{ ...entry, title: '' }, { ...entry, title: 'x'.repeat(201) }, { ...entry, kind: 'claim' }, { deviceId: 'dev_a', title: 'Fix login' }]) {
    expect(ProjectHubResultSchema.safeParse({ ...checkouts, records: [bad] }).success).toBe(false);
  }
  expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'checkouts-held' }).success).toBe(false);
  const held = { schema: 'file-reservation-v1', revision: 1, id: 'resv_1', projectId: 'project', threadId, deviceId: 'dev_a', paths: ['src/'], reason: '', createdAt: at, expiresAt: at };
  const reserve = { schema: 'project-hub-result-v1', operation: 'reserve' };
  expect(ProjectHubResultSchema.safeParse({ ...reserve, reservation: { revision: 1, document: held }, conflicts: [] }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ ...reserve, reservation: null, conflicts: [{ threadId, threadTitle: null, paths: ['src/'], expiresAt: at }] }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ ...reserve, reservation: { revision: 2, document: held }, conflicts: [] }).success).toBe(false);
  const inbox = { schema: 'project-hub-result-v1', operation: 'mail-inbox', more: false };
  const mail = { schema: 'project-mail-v1', revision: 1, id: 'mail_1', projectId: 'project', from: threadId, to: 'all', subject: 'Heads up', body: '', at, readBy: [] };
  expect(ProjectHubResultSchema.safeParse({ ...inbox, records: Array.from({ length: 100 }, () => mail) }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ ...inbox, records: Array.from({ length: 101 }, () => mail) }).success).toBe(false);
  expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'decision-answer', id: 'pdec_1', answer: {}, at, clientRequestId: 'req_2' }).success).toBe(false);
  expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'settings-put', settings, expectedRevision: -1 }).success).toBe(false);
  for (const limit of [0, 101, 1.5]) expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'overrides-recent', projectId: 'project', limit }).success).toBe(false);
  // Overrides carry no revision: the collection is append-only.
  expect(ProjectHubResultSchema.safeParse({ schema: 'project-hub-result-v1', operation: 'override-add', override }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ schema: 'project-hub-result-v1', operation: 'overrides-recent', records: Array.from({ length: 101 }, () => override) }).success).toBe(false);
  // Envelopes: pages of at most 100 with a `more` flag; puts and acknowledgements name their envelope.
  const pending = { schema: 'project-hub-result-v1', operation: 'envelopes-pending', more: true };
  expect(ProjectHubResultSchema.safeParse({ ...pending, records: Array.from({ length: 100 }, () => envelope) }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ ...pending, records: Array.from({ length: 101 }, () => envelope) }).success).toBe(false);
  expect(ProjectHubResultSchema.safeParse({ ...pending, more: undefined, records: [] }).success).toBe(false);
  expect(ProjectHubResultSchema.safeParse({ schema: 'project-hub-result-v1', operation: 'envelope-put', id: 'env_1', stored: false }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ schema: 'project-hub-result-v1', operation: 'envelope-ack', id: 'env_1', deleted: true }).success).toBe(true);
  expect(ProjectHubRequestSchema.safeParse({ schema: 'project-hub-request-v1', operation: 'envelope-ack', id: 'env_1', at }).success).toBe(false);

  const result = { schema: 'project-hub-result-v1', operation: 'notebook-get' };
  expect(ProjectHubResultSchema.safeParse({ ...result, record: { revision: 2, document: notebook } }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ ...result, record: null }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ ...result, record: { revision: 3, document: notebook } }).success).toBe(false);
  expect(ProjectHubResultSchema.safeParse({ ...result, record: { revision: 0, document: { ...notebook, revision: 0 } } }).success).toBe(false);
  expect(ProjectHubResultSchema.safeParse({ ...result, record: { revision: 2, document: notebook, extra: 1 } }).success).toBe(false);
  const list = { schema: 'project-hub-result-v1', operation: 'threads-list', next: null };
  expect(ProjectHubResultSchema.safeParse({ ...list, records: Array.from({ length: 100 }, () => index) }).success).toBe(true);
  expect(ProjectHubResultSchema.safeParse({ ...list, records: Array.from({ length: 101 }, () => index) }).success).toBe(false);
  const parsed = ProjectHubResultSchema.parse({ schema: 'project-hub-result-v1', operation: 'settings-get', record: { revision: 1, document: { ...settings, revision: 1 } } });
  const typed: ProjectHubResultOf<'settings-get'>['record'] = parsed.operation === 'settings-get' ? parsed.record : null;
  const stored: Stored<ProjectWorkSettings> | null = typed;
  expect(stored?.document.maxRunningThreads).toBe(6);
});

test('hub revision helpers keep the embedded revision equal to the row', () => {
  const next = withHubRevision(notebook, 2);
  expect(next).toEqual({ ...notebook, revision: 3 });
  expect(notebook.revision).toBe(2);
  expect(checkHubRevision({ revision: 3, document: next })).toEqual({ revision: 3, document: next });
  expect(() => checkHubRevision({ revision: 4, document: next })).toThrow('does not match its hub revision');
});

test('reservation paths overlap only when equal or under a directory prefix', () => {
  const cases: Array<[string, string, boolean]> = [
    ['src/a.ts', 'src/a.ts', true], ['src/', 'src/x.ts', true], ['src/x.ts', 'src/', true], ['src/', 'src/deep/y.ts', true], ['src/', 'src/', true],
    ['src', 'src/x.ts', false], ['src/', 'srcx/', false], ['src/', 'srcx/a.ts', false], ['src/a.ts', 'src/b.ts', false], ['src/*', 'src/a.ts', false], ['lib/', 'src/lib/', false],
  ];
  for (const [a, b, overlap] of cases) {
    expect(pathsOverlap(a, b), `${a} vs ${b}`).toBe(overlap);
    expect(pathsOverlap(b, a), `${b} vs ${a}`).toBe(overlap);
  }
});

test('thread states partition into live work, the Running section, review and concluded', () => {
  const states = ThreadStateSchema.options as readonly ThreadState[];
  expect(states.filter(liveWork)).toEqual(['preparing', 'running', 'publishing']);
  expect(states.filter(runningSection)).toEqual(['queued', 'preparing', 'running', 'idle', 'publishing', 'waiting-for-you', 'attached']);
  expect(states.filter(isTerminal)).toEqual(['done', 'stopped', 'failed']);
  expect([...concludedStates]).toEqual(['done', 'stopped', 'failed']);
  expect(states.filter((state) => !runningSection(state) && !isTerminal(state))).toEqual(['in-review']);
  for (const state of states) if (liveWork(state)) expect(runningSection(state)).toBe(true);
});

test('thread branches are jv/<slug>-<six lowercase id characters> and valid git branch names', () => {
  expect(threadBranch('Fix the login bug!', threadId)).toBe('jv/fix-the-login-bug-7q2k9m');
  expect(threadBranch('Fix login', 'thread_01K6NV2QZ8XKW3P7Q2K9MA')).toBe('jv/fix-login-q2k9ma');
  expect(slugify('')).toBe('thread');
  expect(slugify('!!! ??? ...')).toBe('thread');
  expect(slugify('日本語')).toBe('thread');
  expect(threadBranch('---', 'thread_01K6NV2QZ8XKW3P7Q2K9MA')).toBe('jv/thread-q2k9ma');
  expect(slugify('  Café  Menü: Add   Items ')).toBe('cafe-menu-add-items');
  expect(slugify('A'.repeat(39) + ' tail words')).toBe('a'.repeat(39));
  expect(slugify('x'.repeat(60))).toBe('x'.repeat(40));
  expect(slugify('Refs/heads..lock @{weird} ~^:?*[\\')).toBe('refs-heads-lock-weird');
  for (const title of ['Fix the login bug!', '', 'A'.repeat(39) + ' tail', 'feature/x..y.lock', 'Café']) {
    const branch = threadBranch(title, threadId);
    expect(branch).toMatch(/^jv\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{6}$/);
    expect(branch.length).toBeLessThanOrEqual(3 + 40 + 7);
    expect(execFileSync('git', ['check-ref-format', '--branch', branch], { encoding: 'utf8' }).trim()).toBe(branch);
  }
});

test('turn launches may carry the git identity but never inherit it from the daemon environment', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/owner', GIT_AUTHOR_NAME: 'Ambient', GIT_COMMITTER_EMAIL: 'ambient@example.com' };
  const identity = { GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' };
  expect(minimalEnvironment('claude', '/isolated', {}, identity, base)).toEqual({ PATH: '/usr/bin', HOME: '/isolated', CLAUDE_CONFIG_DIR: '/isolated', ...identity });
  expect(minimalEnvironment('codex', '/isolated', {}, {}, base)).toEqual({ PATH: '/usr/bin', HOME: '/isolated', CODEX_HOME: '/isolated' });
  expect(() => minimalEnvironment('codex', '/isolated', {}, { GIT_DIR: '/elsewhere' }, base)).toThrow('Unsupported launch environment variable.');
});

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
test('vault details expose only the last four characters and the save time', () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-project-schemas-')); mkdirSync(join(root, 'user'));
  const db = new DatabaseSync(join(root, 'vault.db'));
  try {
    const vault = new SecretVault(db, new Homes(join(root, 'home'), join(root, 'user')));
    const token = `ghp_${'x'.repeat(32)}9z7Q`;
    const before = Date.now();
    expect(vault.put('github', token)).toEqual({ schema: 'secret-summary-v1', id: 'github', saved: true, lastFour: '9z7Q' });
    const details = vault.details('github');
    expect(details).toEqual({ lastFour: '9z7Q', updatedAt: expect.any(String) });
    expect(Date.parse(details.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(JSON.stringify(details)).not.toContain(token.slice(0, 8));
    expect(vault.summary('github')).toEqual({ schema: 'secret-summary-v1', id: 'github', saved: true, lastFour: '9z7Q' });
    expect(GitHubTokenStateSchema.parse({ schema: 'github-token-summary-v1', id: 'github', saved: true, ...details }).saved).toBe(true);
    expect(() => vault.details('missing')).toThrow('Saved secret is unavailable.');
  } finally { db.close(); }
});

test('GitHub token views accept only the github summary or an unsaved state', () => {
  expect(GitHubTokenStateSchema.safeParse({ schema: 'secret-state-v1', id: 'github', saved: false }).success).toBe(true);
  expect(GitHubTokenStateSchema.safeParse({ schema: 'github-token-summary-v1', id: 'jev', saved: true, lastFour: 'abcd', updatedAt: at }).success).toBe(false);
  expect(GitHubTokenStateSchema.safeParse({ schema: 'github-token-summary-v1', id: 'github', saved: true, lastFour: 'abcde', updatedAt: at }).success).toBe(false);
  expect(GitHubTokenStateSchema.safeParse({ schema: 'github-token-summary-v1', id: 'github', saved: true, lastFour: 'abcd' }).success).toBe(false);
  expect(GitHubTokenStateSchema.safeParse({ schema: 'github-token-summary-v1', id: 'github', saved: true, lastFour: 'abcd', updatedAt: at, value: 'ghp_secret' }).success).toBe(false);
});

test('the browser entry exports the Projects schemas, hub protocol and rules', () => {
  for (const name of ['ProjectWorkViewSchema', 'ThreadViewSchema', 'ProjectEventFrameSchema', 'ProjectLedgerDataSchemas', 'parseProjectLedgerData', 'CoordinatorEventSchema',
    'ProjectHubRequestSchema', 'ProjectHubResultSchema', 'collectionOf', 'pathsOverlap', 'liveWork', 'runningSection', 'isTerminal', 'concludedStates', 'threadBranch',
    'slugify', 'GitHubTokenStateSchema', 'ThreadAttachViewSchema'])
    expect(client, name).toHaveProperty(name);
  expect(client.ThreadReportSchema).toBe(ThreadReportSchema);
});
