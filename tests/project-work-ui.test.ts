import { expect, test } from 'vitest';
import {
  COORDINATOR_TOOLS, EffortSchema, NO_CHANGES, PlacementRecordSchema, ProjectDecisionSchema, ProjectWorkListViewSchema, ProjectWorkSettingsRequestSchema,
  SAVED_COMMITS_SENTENCE, ThreadCreateRequestSchema, ThreadIndexSchema, ThreadOverrideRequestSchema, ThreadReportSchema, defaultProjectWorkSettings, idTime, mapEffort, newId,
  type CursorTurn, type Effort, type PlacementRecord, type ProjectDecision, type ProjectLedgerEvent, type ProjectWorkView, type PullRequestEntry, type ThreadIndex,
  type ThreadReport, type ThreadView,
} from '../packages/core/dist/index.js';
import * as server from '../packages/projects/dist/copy.js';
import * as copy from '../apps/web/src/project-work-copy.js';
import {
  alignReports, chatItems, checksBadge, composerBlock, coordinatorChip, coordinatorLabel, decisionSource, defaultTab, deviceBlock, deviceChoices, deviceRefusal, dotClass, effortChoices, fallbackChip,
  lineParts, mainIsolationBlock, mergeBlock, nearestEffort, openPullRequests, outcomeText, overrideForm, overrideOffered, overrideReady, overrideRequest, placementLine, projectDot,
  projectRoute, pullRequestBadges, reportBadge, restartedThread, rowClockMs, sentText, settingsRequest, showSent, sidebarProjects, threadActions, threadCreateRequest,
  threadLiveText, threadMeta, threadPollDelay, threadReason, threadSections, threadStarting, toolIcon, transcriptNotice, whyFields, withdrawals, withoutEchoedSummaries,
  withoutReportCalls, working,
} from '../apps/web/src/project-work-model.js';
import { dateOnly, duration, relativeDuration, shortTime, timeStamp } from '../apps/web/src/time.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const thread = (fields: Partial<ThreadIndex> = {}): ThreadIndex => ThreadIndexSchema.parse({
  schema: 'project-thread-index-v1', revision: 1, id: 'thread_a', projectId: 'shop', title: 'Fix login', state: 'running',
  isolation: 'worktree', ownerDeviceId: 'mac', runtime: 'codex', modelLabel: 'gpt-x', effort: 'high', accountLabel: 'Work',
  turns: 2, createdAt: ago(60), updatedAt: ago(5), ...fields,
});
const pr = (fields: Partial<NonNullable<ThreadIndex['pr']>> = {}): NonNullable<ThreadIndex['pr']> => ({
  number: 42, url: 'https://github.com/o/r/pull/42', state: 'open', headSha: 'abc', checks: 'pending', mergeable: 'clean', updatedAt: ago(1), ...fields,
});
let nextId = 0;
const event = (type: ProjectLedgerEvent['type'], data: unknown, id = ++nextId): ProjectLedgerEvent =>
  ({ schema: 'project-ledger-event-v1', t: ago(1), id, type, data });
const coordinatorEvent = (kind: string, fields: Record<string, unknown>, id: number) =>
  event('coordinator-event', { schema: 'coordinator-event-v1', kind, id: `cev_${id}`, at: ago(2), ...fields }, id);
const turnStart = (turn: number, eventIds: string[], id: number) => event('coordinator-turn-start', { schema: 'coordinator-turn-v1', turn, fresh: false,
  runtime: 'claude', modelLabel: 'Opus', effort: 'high', accountLabel: 'Work', eventIds }, id);
const turnEnd = (turn: number, id: number) => event('coordinator-turn-end', { schema: 'coordinator-turn-end-v1', turn, status: 'completed' }, id);
const coordinator = (state: ProjectWorkView['coordinator']['state']) => ({ coordinator: { state } as ProjectWorkView['coordinator'] });

test('project routes accept only valid project and thread ids and drive the header flag', () => {
  expect(projectRoute('/projects/shop')).toEqual({ projectId: 'shop' });
  expect(projectRoute('/projects/shop?tab=x')).toEqual({ projectId: 'shop' });
  expect(projectRoute('/projects/shop/threads/thread_a')).toEqual({ projectId: 'shop', threadId: 'thread_a' });
  for (const path of ['/', '/projects', '/projects/', '/projects/shop/', '/projects/shop/threads', '/projects/shop/threads/',
    '/projects/shop/threads/a/b', '/projects/-bad', '/projects/shop/thread/a', '/projects/sh%20op', '/conversations/shop', '/settings/projects', 'projects/shop']) {
    expect(projectRoute(path), path).toBeNull();
  }
});

test('the default tab is Waiting only while a question is open', () => {
  const question = { id: 'q1' } as ProjectWorkView['decisions']['open'][number];
  expect(defaultTab({ decisions: { open: [question], answered: [] } })).toBe('waiting');
  expect(defaultTab({ decisions: { open: [], answered: [question] } })).toBe('chat');
});

test('sections: Running holds every live, resting or waiting thread newest first; Concluded the last 14 days by end', () => {
  const threads = [
    thread({ id: 't_old_run', state: 'idle', createdAt: ago(300) }),
    thread({ id: 't_new_run', state: 'waiting-for-you', createdAt: ago(10), updatedAt: ago(500) }),
    thread({ id: 't_queued', state: 'queued', createdAt: ago(100) }),
    thread({ id: 't_attached', state: 'attached', createdAt: ago(200) }),
    thread({ id: 't_review', state: 'in-review', pr: pr() }),
    thread({ id: 't_done', state: 'done', endedAt: ago(60), pr: pr({ state: 'merged' }) }),
    thread({ id: 't_failed', state: 'failed', endedAt: ago(30) }),
    thread({ id: 't_stopped_fallback', state: 'stopped', updatedAt: ago(10) }),
    thread({ id: 't_ancient', state: 'done', endedAt: ago(15 * 24 * 60) }),
  ];
  const sections = threadSections(threads, NOW);
  expect(sections.running.map((row) => row.id)).toEqual(['t_new_run', 't_queued', 't_attached', 't_old_run']);
  expect(sections.concluded.map((row) => row.id)).toEqual(['t_stopped_fallback', 't_failed', 't_done']);
});

test('the page clock ticks every second only while a Running row reads its age in seconds', () => {
  expect(rowClockMs([thread({ createdAt: new Date(NOW - 59_000).toISOString() })], NOW)).toBe(1000);
  expect(rowClockMs([thread({ createdAt: new Date(NOW - 60_000).toISOString() })], NOW)).toBe(30_000);
  // Concluded and in-review threads show no live age (Concluded rows end at their end time; pull requests show none).
  expect(rowClockMs([thread({ state: 'done', createdAt: ago(0), endedAt: ago(0) }), thread({ state: 'in-review', createdAt: ago(0) })], NOW)).toBe(30_000);
  expect(rowClockMs([], NOW)).toBe(30_000);
});

test('dots follow D54 and the sidebar dot pulses only for a working coordinator', () => {
  expect(dotClass('running')).toBe('pw-dot pw-running');
  expect(dotClass('waiting-for-you')).toBe('pw-dot pw-waiting-for-you');
  expect(dotClass('in-review')).toBe('pw-dot pw-in-review');
  const entry = (waiting: number, state: 'idle' | 'running' | 'none') => ({ waiting, coordinator: { deviceId: null, state } });
  expect(projectDot(entry(2, 'running'))).toBe('pw-dot pw-running');
  expect(projectDot(entry(2, 'idle'))).toBe('pw-dot pw-waiting-for-you');
  expect(projectDot(entry(0, 'none'))).toBe('pw-dot pw-idle');
});

test('sidebar rows sort by name without regard to case', () => {
  const row = (projectId: string, name: string) => ({ projectId, name, waiting: 0, running: 0, inReview: 0, coordinator: { deviceId: null, state: 'none' as const } });
  const view = ProjectWorkListViewSchema.parse({ schema: 'project-work-list-view-v1', projects: [row('c', 'zeta'), row('b', 'Alpha'), row('a', 'beta'), row('d', 'alpha')] });
  expect(sidebarProjects(view).map((entry) => entry.projectId)).toEqual(['b', 'd', 'a', 'c']);
  expect(view.projects.map((entry) => entry.projectId)).toEqual(['c', 'b', 'a', 'd']);
});

test('coordinator chip labels', () => {
  expect(['none', 'idle', 'running', 'unavailable', 'offline'].map((state) => coordinatorLabel(state as 'idle'))).toEqual(['Idle', 'Idle', 'Working…', 'Unavailable', 'Offline']);
});

test('the header chip follows the chat stream and shows the session, else the planned one, with runtime display names (D91)', () => {
  const runtime = (id: string) => ({ codex: 'Codex', claude: 'Claude Code' })[id] ?? id;
  const view = (fields: Partial<ProjectWorkView['coordinator']>) => ({ coordinator: { state: 'idle', unavailableReason: undefined, deviceId: 'mac', deviceName: 'Mac', online: true,
    session: null, planned: null, canMoveHere: false, ...fields } as ProjectWorkView['coordinator'] });
  const planned = { runtime: 'claude', modelLabel: 'Fable', effort: 'high' } as const;
  expect(coordinatorChip(view({ state: 'none', deviceId: null, planned }), [], runtime)).toEqual({ label: 'Idle', tone: 'idle', session: 'Claude Code Fable · high' });
  expect(coordinatorChip(view({ planned, session: { runtime: 'codex', modelLabel: 'gpt-x', effort: 'low', accountLabel: 'Work', turns: 3 } }), [], runtime))
    .toEqual({ label: 'Idle', tone: 'idle', session: 'Codex gpt-x · low' });
  expect(coordinatorChip(view({ planned }), [turnStart(1, [], 1)], runtime)).toMatchObject({ label: 'Working…', tone: 'running' });
  expect(coordinatorChip(view({ state: 'unavailable' }), [turnStart(1, [], 1)], runtime)).toEqual({ label: 'Unavailable', tone: 'unavailable', session: null });
  expect(coordinatorChip(view({ state: 'offline', planned }), [], runtime)).toMatchObject({ label: 'Offline', tone: 'offline' });
});

test('concluded outcomes: merged, published to main, no changes, stopped and failed', () => {
  expect(outcomeText(thread({ state: 'done', pr: pr({ state: 'merged', number: 42 }) }))).toBe('Merged #42');
  expect(outcomeText(thread({ state: 'done', stateReason: NO_CHANGES }))).toBe('No changes');
  expect(outcomeText(thread({ state: 'done' }))).toBe('No changes');
  expect(outcomeText(thread({ state: 'done', isolation: 'main' }))).toBe('Published to main');
  expect(outcomeText(thread({ state: 'done', isolation: 'main', stateReason: NO_CHANGES }))).toBe('No changes');
  expect(outcomeText(thread({ state: 'stopped', pr: pr({ state: 'closed' }) }))).toBe('Stopped');
  expect(outcomeText(thread({ state: 'failed' }))).toBe('Failed');
  for (const state of ['queued', 'running', 'idle', 'in-review', 'waiting-for-you', 'attached'] as const) expect(outcomeText(thread({ state }))).toBeNull();
  expect(NO_CHANGES).toBe(server.NO_CHANGES);
});

test('pull request badges and the merge block', () => {
  expect(checksBadge({ checks: 'passing' })).toEqual({ text: 'Checks passing', tone: 'ok' });
  expect(checksBadge({ checks: 'failing' })).toEqual({ text: 'Checks failing', tone: 'danger' });
  expect(checksBadge({ checks: 'pending' })).toEqual({ text: 'Checks running', tone: 'warn' });
  expect(checksBadge({ checks: 'none' })).toEqual({ text: 'No checks', tone: 'muted' });
  expect(mergeBlock({ checks: 'failing', mergeable: 'conflict' })).toBe(server.MERGE_CONFLICTS);
  expect(mergeBlock({ checks: 'failing', mergeable: 'clean' })).toBe(server.MERGE_CHECKS_FAILING);
  expect(mergeBlock({ checks: 'pending', mergeable: 'unknown' })).toBeNull();
  expect(mergeBlock({ checks: 'passing', mergeable: 'clean' })).toBeNull();
});

test('the Pull requests section keeps open pull requests and pushed branches; merged and closed ones are concluded (D58, D222)', () => {
  const entries: PullRequestEntry[] = [
    { threadId: 'thread_open', title: 'Open', branch: 'jv/open', pr: pr() },
    { threadId: 'thread_merged', title: 'Merged', branch: 'jv/merged', pr: pr({ state: 'merged' }) },
    { threadId: 'thread_closed', title: 'Closed', pr: pr({ state: 'closed' }) },
    { threadId: 'thread_branch', title: 'Branch only', branch: 'jv/branch', reason: server.BRANCH_PUSHED_NO_TOKEN },
    { threadId: 'thread_bare', title: 'Nothing' },
  ];
  expect(openPullRequests(entries).map((entry) => entry.threadId)).toEqual(['thread_open', 'thread_branch']);
});

test('placement gates disable Main and other devices with the sentences placement refuses with (D88, D221)', () => {
  const view = (branchPolicy: 'main' | 'external', mainIsolation: boolean, remoteDevices = false) =>
    ({ project: { id: 'shop', name: 'Shop', branchPolicy, baseBranch: 'main' }, gates: { mainIsolation, remoteDevices } });
  expect(mainIsolationBlock(view('main', false))).toBe(server.MAIN_NOT_AVAILABLE);
  expect(mainIsolationBlock(view('external', false))).toBe(server.LEAVE_GIT_SETTING);
  expect(mainIsolationBlock(view('external', true))).toBe(server.LEAVE_GIT_SETTING);
  expect(mainIsolationBlock(view('main', true))).toBeNull();
  expect(deviceBlock(view('main', false), 'mac', 'mac')).toBeNull();
  expect(deviceBlock(view('main', false), 'mini', 'mac')).toBe(server.REMOTE_NOT_AVAILABLE);
  expect(deviceBlock(view('main', false, true), 'mini', 'mac')).toBeNull();
  expect([copy.MAIN_NOT_AVAILABLE, copy.REMOTE_NOT_AVAILABLE]).toEqual([server.MAIN_NOT_AVAILABLE, server.REMOTE_NOT_AVAILABLE]);
});

test('device choices: every device of the work view, disabled with the reason a thread cannot run there, keeping the current choice (D281)', () => {
  const row = (id: string, name: string, status: 'online' | 'stale' | 'offline' = 'online', revoked = false) => ({ device: { id, name }, status, revoked });
  const roster = [row('mac', 'Mac'), row('mini', 'Mini'), row('lab', 'Lab', 'offline'), row('old', 'Old', 'online', true)];
  const setup = (deviceId: string, name: string, reason?: string) => ({ schema: 'project-device-setup-v1' as const, deviceId, name, ...(reason ? { reason } : {}) });
  const open = { mainIsolation: false, remoteDevices: true };
  const view = { gates: open, devices: [setup('mac', 'Mac'), setup('mini', 'Mini', 'not set up for this project'), setup('lab', 'Lab', 'offline')] };
  expect(deviceChoices(view, roster, 'mac')).toEqual([{ id: 'mac', label: 'Mac', disabled: false }, { id: 'mini', label: 'Mini: not set up for this project', disabled: true },
    { id: 'lab', label: 'Lab: offline', disabled: true }]);
  expect(copy.deviceUnavailable('Mini', 'offline')).toBe('Mini: offline');
  // The phase gate still disables other devices; a device chosen before that the view no longer lists stays listed, disabled.
  expect(deviceChoices({ ...view, gates: { ...open, remoteDevices: false } }, roster, 'mac').map((choice) => choice.disabled)).toEqual([false, true, true]);
  expect(deviceChoices(view, roster, 'mac', 'old').at(-1)).toEqual({ id: 'old', label: 'Old', disabled: true });
  expect(deviceChoices(view, roster, 'mac', 'mini')).toHaveLength(3);
  // A view without the setup (an older device) offers the roster's available devices as before; no view yet disables them all.
  expect(deviceChoices({ gates: open }, roster, 'mac')).toEqual([{ id: 'mac', label: 'Mac', disabled: false }, { id: 'mini', label: 'Mini', disabled: false }]);
  expect(deviceChoices(undefined, roster, 'mac').map((choice) => choice.disabled)).toEqual([true, true]);
});

test('request bodies: Automatic placement fields are omitted and a stored main default survives a save (D205, D223)', () => {
  const automatic = threadCreateRequest('thread_req_1', { title: ' Fix login ', task: 'Fix it.\n', isolation: '', modelId: '', effort: '', deviceId: '' });
  expect(ThreadCreateRequestSchema.parse(automatic)).toEqual({ schema: 'thread-create-request-v1', clientRequestId: 'thread_req_1', title: 'Fix login', task: 'Fix it.' });
  expect(ThreadCreateRequestSchema.parse(threadCreateRequest('thread_req_2', { title: 'A', task: 'B', isolation: 'worktree', modelId: 'deep', effort: 'high', deviceId: 'mac' })))
    .toMatchObject({ isolation: 'worktree', modelId: 'deep', effort: 'high', deviceId: 'mac' });
  const settings = { ...defaultProjectWorkSettings('shop'), revision: 4 };
  const form = { defaultIsolation: 'worktree' as const, isolationChanged: false, modelId: '', effort: 'high' as const, setupCommand: '  ',
    maxRunningThreads: 3, maxRunningPerDevice: 2, threadTurnCap: 40 };
  const plain = ProjectWorkSettingsRequestSchema.parse(settingsRequest({ settings }, form));
  expect(plain).toEqual({ schema: 'project-work-settings-request-v1', revision: 4, settings: { defaultIsolation: 'worktree', coordinator: { modelId: null, effort: 'high' },
    setupCommand: null, maxRunningThreads: 3, maxRunningPerDevice: 2, threadTurnCap: 40 } });
  expect(settingsRequest({ settings, settingsNotice: server.MAIN_NOT_AVAILABLE }, form).settings.defaultIsolation).toBe('main');
  expect(settingsRequest({ settings, settingsNotice: server.MAIN_NOT_AVAILABLE }, { ...form, isolationChanged: true }).settings.defaultIsolation).toBe('worktree');
  expect(settingsRequest({ settings }, { ...form, modelId: 'deep', setupCommand: ' npm ci ' }).settings).toMatchObject({ coordinator: { modelId: 'deep' }, setupCommand: 'npm ci' });
});

test('decision cards: the source line, where an answer went and how long the sent line stays (D224)', () => {
  const decision = (fields: Partial<ProjectDecision>): ProjectDecision => ProjectDecisionSchema.parse({ schema: 'project-decision-v1', revision: 0, id: 'pdec_1',
    projectId: 'shop', from: 'coordinator', question: 'Which greeting?', createdAt: ago(3), ...fields });
  const titles = (id: string) => id === 'thread_a' ? 'Fix login' : undefined;
  expect(decisionSource(decision({ threadId: 'thread_a' }), titles)).toBe('From the coordinator');
  expect(decisionSource(decision({ from: 'thread', threadId: 'thread_a' }), titles)).toBe('From "Fix login"');
  expect(decisionSource(decision({ from: 'thread', threadId: 'thread_gone' }), titles)).toBe('From "a thread"');
  expect(sentText(decision({ threadId: 'thread_a' }), titles)).toBe('Sent to the coordinator.');
  expect(sentText(decision({ from: 'thread', threadId: 'thread_a' }), titles)).toBe('Sent to "Fix login".');
  expect(sentText(decision({ from: 'thread', threadId: 'thread_gone' }), titles)).toBe('Sent to the thread.');
  expect(showSent(undefined, [])).toBe(false);
  expect(showSent({ known: ['pdec_2'] }, [])).toBe(true);
  expect(showSent({ known: ['pdec_2'] }, [decision({ id: 'pdec_2' })])).toBe(true);
  expect(showSent({ known: ['pdec_2'] }, [decision({ id: 'pdec_2' }), decision({ id: 'pdec_3' })])).toBe(false);
});

test('every coordinator tool has its own one-liner icon', () => {
  for (const tool of COORDINATOR_TOOLS) expect(toolIcon(tool), tool).not.toBe('tune');
  expect(toolIcon('jevellan_something_new')).toBe('tune');
});

test('row meta and the placement line use the runtime display name, the branch and the device', () => {
  expect(threadMeta(thread({ branch: 'jv/fix-login-abc123' }), 'Codex', 'Mac mini')).toBe('Codex · gpt-x · high · Worktree · Mac mini');
  expect(threadMeta(thread({ isolation: 'main' }), 'Codex', 'Mac mini')).toBe('Codex · gpt-x · high · Main · Mac mini');
  expect(placementLine(thread({ branch: 'jv/fix-login-abc123' }), { deviceName: 'Mac mini' }, 'Codex'))
    .toBe('Codex · gpt-x · high effort · Work · Worktree on jv/fix-login-abc123 · Mac mini');
  expect(placementLine(thread(), { deviceName: 'Mac mini' }, 'Codex')).toBe('Codex · gpt-x · high effort · Work · Worktree · Mac mini');
  expect(placementLine(thread({ isolation: 'main', branch: 'main' }), { deviceName: 'Mac mini' })).toBe('codex · gpt-x · high effort · Work · Main · Mac mini');
  // The page wraps the line between its parts: each keeps its separator, and the parts joined by spaces read as the line.
  const line = placementLine(thread({ branch: 'jv/fix-login-abc123' }), { deviceName: 'Mac mini' }, 'Codex');
  expect(lineParts(line)).toEqual(['Codex ·', 'gpt-x ·', 'high effort ·', 'Work ·', 'Worktree on jv/fix-login-abc123 ·', 'Mac mini']);
  expect(lineParts(line).join(' ')).toBe(line);
  expect(lineParts('Placement · model-x · 60 tokens · 7 ms')).toEqual(['Placement ·', 'model-x ·', '60 tokens ·', '7 ms']);
  expect(lineParts('Mac mini')).toEqual(['Mac mini']);
});

test('chat items: owner messages, replies, one-liners, event cards and notices in ledger order, delivered by event id (D2a)', () => {
  const titles = (id: string) => ({ thread_a: 'Fix login', thread_b: 'Add search' })[id];
  const report = ThreadReportSchema.parse({ schema: 'thread-report-v1', turn: 1, status: 'needs-decision', summary: 'Two options.', question: 'Which database?',
    options: [{ label: 'SQLite' }, { label: 'Postgres' }], synthesized: false });
  const events = [
    turnStart(1, ['cev_1'], 3),
    coordinatorEvent('user-message', { text: 'add A and fix B', clientMessageId: 'message_1' }, 1),
    event('coordinator-text', { schema: 'coordinator-text-v1', text: 'Starting **two** threads.' }, 4),
    event('coordinator-tool', { schema: 'coordinator-tool-v1', tool: 'jevellan_thread_start', ok: true, summary: 'Started "Fix login" · Codex gpt-x · high · Worktree · Mac mini', threadId: 'thread_a' }, 5),
    event('coordinator-tool', { schema: 'coordinator-tool-v1', tool: 'jevellan_notebook_write', ok: false, summary: 'Could not update the notebook: It changed.' }, 6),
    turnEnd(1, 7),
    coordinatorEvent('thread-report', { threadId: 'thread_a', report }, 8),
    coordinatorEvent('thread-published', { threadId: 'thread_b', result: 'pr-opened', prNumber: 7 }, 9),
    coordinatorEvent('thread-published', { threadId: 'thread_gone', result: 'no-changes' }, 10),
    coordinatorEvent('thread-interrupted', { threadId: 'thread_gone', reason: 'restart', message: 'Jevellan restarted during this step.' }, 11),
    coordinatorEvent('thread-verification-failed', { threadId: 'thread_a', attempts: 2, tail: 'FAIL' }, 12),
    coordinatorEvent('decision-answer', { decisionId: 'q1', threadId: 'thread_a', question: 'Which database?\nPick one.', answer: { optionLabel: 'SQLite', text: 'Keep it small' } }, 13),
    coordinatorEvent('pr-update', { threadId: 'thread_b', prNumber: 7, change: 'conflict' }, 14),
    coordinatorEvent('thread-user-message', { threadId: 'thread_b', text: server.ownerStartedLine('Add search', 'thread_b', 'Add a search box.') }, 15),
    coordinatorEvent('thread-user-message', { threadId: 'thread_b', text: server.ownerWorkedLine('Add search') }, 16),
    coordinatorEvent('thread-user-message', { threadId: 'thread_a', text: 'Use SQLite.' }, 17),
    coordinatorEvent('placement-override', { threadId: 'thread_a', summary: 'Effort changed from high to max.' }, 18),
    event('notice', { schema: 'project-notice-v1', text: 'The coordinator cannot run: no account.', kind: 'error' }, 19),
    event('coordinator-event', { schema: 'coordinator-event-v1', kind: 'user-message' }, 20),
    event('coordinator-text', { schema: 'coordinator-text-v1', text: '' }, 21),
    event('thread-state', { schema: 'thread-state-v1', from: null, to: 'running', changed: [] }, 22),
    turnStart(2, ['cev_8', 'cev_9'], 23),
  ];
  const items = chatItems(events, titles);
  expect(items.map((item) => item.id)).toEqual([1, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  expect(items[0]).toEqual({ kind: 'owner', id: 1, text: 'add A and fix B', at: ago(2), delivered: true });
  expect(items[1]).toEqual({ kind: 'reply', id: 4, text: 'Starting **two** threads.' });
  expect(items[2]).toEqual({ kind: 'tool', id: 5, tool: 'jevellan_thread_start', ok: true, threadId: 'thread_a', summary: 'Started "Fix login" · Codex gpt-x · high · Worktree · Mac mini' });
  expect(items[3]).toEqual({ kind: 'tool', id: 6, tool: 'jevellan_notebook_write', ok: false, summary: 'Could not update the notebook: It changed.' });
  expect(items.slice(4, 15)).toEqual([
    { kind: 'event', id: 8, text: '"Fix login" needs a decision', detail: 'Two options.', threadId: 'thread_a', delivered: true },
    { kind: 'event', id: 9, text: '"Add search" opened pull request #7', threadId: 'thread_b', delivered: true },
    { kind: 'event', id: 10, text: 'A thread concluded without changes', threadId: 'thread_gone', delivered: false },
    { kind: 'event', id: 11, text: 'A thread was interrupted by a restart', detail: 'Jevellan restarted during this step.', threadId: 'thread_gone', delivered: false },
    { kind: 'event', id: 12, text: 'Tests failed 2 times in "Fix login"', threadId: 'thread_a', delivered: false },
    { kind: 'event', id: 13, text: 'You answered: Which database?', detail: 'SQLite. Keep it small', threadId: 'thread_a', delivered: false },
    { kind: 'event', id: 14, text: 'Pull request #7 of "Add search" has conflicts', threadId: 'thread_b', delivered: false },
    { kind: 'event', id: 15, text: 'You started "Add search"', detail: 'Add a search box.', threadId: 'thread_b', delivered: false },
    { kind: 'event', id: 16, text: 'You worked on "Add search" in a terminal', threadId: 'thread_b', delivered: false },
    { kind: 'event', id: 17, text: 'You wrote to "Fix login"', detail: 'Use SQLite.', threadId: 'thread_a', delivered: false },
    { kind: 'event', id: 18, text: 'You changed "Fix login"', detail: 'Effort changed from high to max.', threadId: 'thread_a', delivered: false },
  ]);
  expect(items[15]).toEqual({ kind: 'notice', id: 19, text: 'The coordinator cannot run: no account.', tone: 'error' });
  // Delivery joins on the coordinator event id (`cev_30`), never on the ledger id (30).
  expect(chatItems([coordinatorEvent('user-message', { text: 'hi', clientMessageId: 'message_2' }, 30), turnStart(3, ['cev_1', '30'], 31)])[0])
    .toMatchObject({ kind: 'owner', delivered: false });
  // Without titles every thread reads `a thread`; a single failure reads `once`.
  expect(chatItems([coordinatorEvent('thread-verification-failed', { threadId: 'thread_a', attempts: 1, tail: '' }, 40),
    coordinatorEvent('pr-update', { threadId: 'thread_a', prNumber: 3, change: 'merged' }, 41), coordinatorEvent('mail', { mailId: 'mail_1', fromThreadId: 'thread_a', subject: 'API moved', body: '' }, 42)])
    .map((item) => item.kind === 'event' && item.text)).toEqual(['Tests failed once in a thread', 'Pull request #3 of a thread was merged', 'Mail from a thread: API moved']);
  // A mail's body is the card's detail, as a report's summary is.
  expect(chatItems([coordinatorEvent('mail', { mailId: 'mail_2', fromThreadId: 'thread_a', subject: 'API moved', body: 'Use /v2 now.\nThe old path is gone.' }, 43)])[0])
    .toEqual({ kind: 'event', id: 43, text: 'Mail from a thread: API moved', detail: 'Use /v2 now.\nThe old path is gone.', threadId: 'thread_a', delivered: false });
  // The owner's own stop reads in the owner's voice, with no coordinator-facing detail; the coordinator's event block keeps its text.
  const stopped = { threadId: 'thread_a', reason: 'stopped' as const, message: server.OWNER_STOPPED_THREAD };
  expect(chatItems([coordinatorEvent('thread-interrupted', stopped, 44)], titles)[0]).toEqual({ kind: 'event', id: 44, text: 'You stopped "Fix login"', threadId: 'thread_a', delivered: false });
  expect(server.eventLine({ schema: 'coordinator-event-v1', id: 'cev_44', at: ago(1), kind: 'thread-interrupted', ...stopped }, { title: titles, base: 'main' }))
    .toBe('[thread "Fix login" (thread_a) interrupted: stopped] The owner stopped this thread.');
  // Any other stopped message still shows as the detail of the neutral card.
  expect(chatItems([coordinatorEvent('thread-interrupted', { ...stopped, message: 'Stopped for a reason.' }, 45), coordinatorEvent('thread-interrupted', stopped, 46)])
    .map((item) => item.kind === 'event' && [item.text, item.detail])).toEqual([['A thread was stopped', 'Stopped for a reason.'], ['You stopped a thread', undefined]]);
});

test('working: the view decides when running, unavailable or offline; otherwise an unclosed coordinator turn', () => {
  const open = [turnStart(1, [], 1), turnEnd(1, 2), turnStart(2, [], 3)];
  const closed = [turnStart(1, [], 1), turnEnd(1, 2)];
  expect(working([], coordinator('running'))).toBe(true);
  expect(working(open, coordinator('idle'))).toBe(true);
  expect(working(open, coordinator('none'))).toBe(true);
  expect(working(closed, coordinator('idle'))).toBe(false);
  expect(working([...closed].reverse(), coordinator('idle'))).toBe(false);
  expect(working(open, coordinator('unavailable'))).toBe(false);
  expect(working(open, coordinator('offline'))).toBe(false);
});

const text = (id: string, role: CursorTurn['role'], value: string, automated = false): CursorTurn =>
  ({ id, role, blocks: [{ type: 'text', text: value }], ...(automated ? { automated } : {}) });
const reporting = (id: string, summary: string): CursorTurn => ({ id, role: 'assistant', blocks: [
  { type: 'text', text: 'Done here.' },
  { type: 'tool', id: `tool_${id}`, name: 'mcp__jevellan__jevellan_thread_report', input: JSON.stringify({ status: 'done', summary }), output: 'ok', state: 'completed' }] });
const reportOf = (turn: number, summary: string, synthesized = false): ThreadReport =>
  ThreadReportSchema.parse({ schema: 'thread-report-v1', turn, status: synthesized ? 'progress' : 'done', summary, synthesized });
const shape = (items: ReturnType<typeof alignReports>) => items.map((item) => item.kind === 'turn' ? item.turn.id : `report ${item.report.turn}`);

test('report cards follow their turn, anchored on the report call and counted from the end (D56)', () => {
  const r1 = reportOf(1, 'First pass.'); const r2 = reportOf(2, 'Second pass.');
  // A running second turn: its prompt is the last segment and has no report yet.
  expect(shape(alignReports([text('p1', 'user', 'Task'), reporting('a1', 'First pass.'), text('p2', 'user', 'More'), text('a2', 'assistant', 'Working')], [r1], 3)))
    .toEqual(['p1', 'a1', 'report 1', 'p2', 'a2']);
  // The view says running but the new prompt is not in the transcript yet: the anchor keeps report 1 after its turn.
  expect(shape(alignReports([text('p1', 'user', 'Task'), reporting('a1', 'First pass.')], [r1], 2))).toEqual(['p1', 'a1', 'report 1']);
  // The running turn already called the report tool, before the report is recorded.
  expect(shape(alignReports([text('p1', 'user', 'Task'), reporting('a1', 'First pass.'), text('p2', 'user', 'More'), reporting('a2', 'Second pass.')], [r1], 2)))
    .toEqual(['p1', 'a1', 'report 1', 'p2', 'a2']);
  // A steered first turn has no report; the second turn's report anchors the numbering.
  expect(shape(alignReports([text('p1', 'user', 'Task'), text('a1', 'assistant', 'Hm'), text('p2', 'user', 'Steer'), reporting('a2', 'Second pass.')], [r2])))
    .toEqual(['p1', 'a1', 'p2', 'a2', 'report 2']);
  // A synthesized report has no tool call: it lands by turn number next to the anchored one.
  expect(shape(alignReports([text('p1', 'user', 'Task'), reporting('a1', 'First pass.'), text('p2', 'user', 'More'), text('a2', 'assistant', 'Bye')],
    [r1, reportOf(2, 'The turn ended without a report.', true)], 2))).toEqual(['p1', 'a1', 'report 1', 'p2', 'a2', 'report 2']);
  // Automated user turns do not start a segment.
  expect(shape(alignReports([text('p1', 'user', 'Task'), text('hook', 'user', 'hook output', true), reporting('a1', 'First pass.')], [r1])))
    .toEqual(['p1', 'hook', 'a1', 'report 1']);
  // A truncated transcript (or a fresh session after an account move): older reports come first, the prefix keeps its own.
  const r3 = reportOf(3, 'Third pass.'); const r4 = reportOf(4, 'Fourth pass.');
  expect(shape(alignReports([text('a3', 'assistant', 'tail of turn 3'), text('p4', 'user', 'Next'), reporting('a4', 'Fourth pass.')], [r4, r2, r3, r1])))
    .toEqual(['report 1', 'report 2', 'a3', 'report 3', 'p4', 'a4', 'report 4']);
  // No anchor (only synthesized reports): the last segment is `latest`, else the last report's turn.
  const synthesized = [reportOf(1, 'One.', true), reportOf(2, 'Two.', true)];
  expect(shape(alignReports([text('p1', 'user', 'Task'), text('p2', 'user', 'More')], synthesized))).toEqual(['p1', 'report 1', 'p2', 'report 2']);
  expect(shape(alignReports([text('p2', 'user', 'More'), text('p3', 'user', 'Again')], synthesized, 3))).toEqual(['report 1', 'p2', 'report 2', 'p3']);
  // No transcript (it stays on another device): reports in order.
  expect(shape(alignReports([], [r2, r1]))).toEqual(['report 1', 'report 2']);
  expect(shape(alignReports([text('p1', 'user', 'Task')], []))).toEqual(['p1']);
});

test('the thread page leaves out completed report calls whose report it shows, after aligning on them (D245)', () => {
  const r1 = reportOf(1, 'First pass.');
  const call = (id: string, state: 'running' | 'completed' | 'failed', summary = 'First pass.'): CursorTurn => ({ id, role: 'assistant', blocks: [
    { type: 'tool', id: `tool_${id}`, name: 'mcp__jevellan__jevellan_thread_report', input: JSON.stringify({ status: 'done', summary }), state }] });
  const items = withoutReportCalls(alignReports([text('p1', 'user', 'Task'), reporting('a1', 'First pass.'), call('only', 'completed')], [r1], 1), [r1]);
  // The turn keeps its text without the call; a turn that only made the call is dropped; the card still follows its turn.
  expect(shape(items)).toEqual(['p1', 'a1', 'report 1']);
  const kept = items.find((item) => item.kind === 'turn' && item.turn.id === 'a1');
  expect(kept?.kind === 'turn' && kept.turn.blocks).toEqual([{ type: 'text', text: 'Done here.' }]);
  // A call still running, failed, refused (completed, but no recorded report carries its summary) or only matching a
  // synthesized report stays; other tools and turns are untouched (the same objects).
  const plain = text('a2', 'assistant', 'Reading');
  const rest = withoutReportCalls([{ kind: 'turn', turn: call('r', 'running') }, { kind: 'turn', turn: call('f', 'failed') },
    { kind: 'turn', turn: call('refused', 'completed', 'A second, different report.') }, { kind: 'turn', turn: plain }], [r1]);
  expect(shape(rest)).toEqual(['r', 'f', 'refused', 'a2']);
  expect(rest[3]!.kind === 'turn' && rest[3]!.turn).toBe(plain);
  expect(shape(withoutReportCalls([{ kind: 'turn', turn: call('s', 'completed', 'One.') }], [reportOf(1, 'One.', true)]))).toEqual(['s']);
});

test("the thread page shows a turn's closing words once when its report card right after them repeats them", () => {
  const r1 = reportOf(1, 'Done for now.'); const r2 = reportOf(2, 'Second pass.');
  const blocks = (item: ReturnType<typeof alignReports>[number] | undefined) => item?.kind === 'turn' ? item.turn.blocks : undefined;
  const reportCall = (id: string, summary: string) => ({ type: 'tool' as const, id: `tool_${id}`, name: 'mcp__jevellan__jevellan_thread_report',
    input: JSON.stringify({ status: 'done', summary }), output: 'ok', state: 'completed' as const });
  // The fixture's shape: the agent reads, says its summary and reports it; with the report call left out, the summary ends the turn.
  const said = (id: string, words: string, summary: string): CursorTurn => ({ id, role: 'assistant', blocks: [
    { type: 'tool', id: `read_${id}`, name: 'Read', input: '{}', output: 'ok', state: 'completed' }, { type: 'text', text: words }, reportCall(id, summary)] });
  const page = (turns: CursorTurn[], reports: ThreadReport[], latest?: number) =>
    withoutEchoedSummaries(withoutReportCalls(alignReports(turns, reports, latest), reports));
  const items = page([text('p1', 'user', 'Task'), said('a1', 'Done for now.', 'Done for now.'), text('p2', 'user', 'More'),
    said('a2', '\nSecond pass.  ', 'Second pass.')], [r1, r2], 2);
  expect(shape(items)).toEqual(['p1', 'a1', 'report 1', 'p2', 'a2', 'report 2']);
  // Equal after trimming: the text goes, the turn keeps its other blocks and the card keeps the words.
  expect(blocks(items[1])?.map((block) => block.type)).toEqual(['tool']);
  expect(blocks(items[4])?.map((block) => block.type)).toEqual(['tool']);
  expect(shape(withoutEchoedSummaries([{ kind: 'turn', turn: text('a1', 'assistant', 'Done for now.') }, { kind: 'report', report: reportOf(1, ' Done for now.\n') }])))
    .toEqual(['report 1']);
  // A turn left with nothing else is dropped; the turns before it (several per turn, as after a restart) are untouched objects.
  const before = text('a0', 'assistant', 'Reading the files.');
  const only = page([text('p1', 'user', 'Task'), before, text('a1', 'assistant', ' Done for now. '),
    { id: 'c1', role: 'assistant', blocks: [reportCall('c1', 'Done for now.')] }], [r1], 1);
  expect(shape(only)).toEqual(['p1', 'a0', 'report 1']);
  expect(blocks(only[1])).toBe(before.blocks);
  // Different words, text followed by another block, a prompt that reads like the summary and a card not right after the text stay.
  const different = text('a1', 'assistant', 'Done for now, more tomorrow.');
  expect(page([text('p1', 'user', 'Task'), different], [r1], 1)[1]).toEqual({ kind: 'turn', turn: different });
  const then: CursorTurn = { id: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'Done for now.' }, { type: 'thinking', text: 'Next?' }] };
  const thought = page([text('p1', 'user', 'Task'), then], [r1], 1);
  expect(shape(thought)).toEqual(['p1', 'a1', 'report 1']);
  expect(blocks(thought[1])).toBe(then.blocks);
  expect(shape(withoutEchoedSummaries([{ kind: 'turn', turn: text('p1', 'user', 'Done for now.') }, { kind: 'report', report: r1 }]))).toEqual(['p1', 'report 1']);
  expect(shape(withoutEchoedSummaries([{ kind: 'turn', turn: text('a1', 'assistant', 'Done for now.') }, { kind: 'turn', turn: text('a2', 'assistant', 'Still here.') },
    { kind: 'report', report: r1 }]))).toEqual(['a1', 'a2', 'report 1']);
  // A synthesized report that took the closing words repeats them too, so they show once there as well.
  expect(shape(page([text('p1', 'user', 'Task'), text('a1', 'assistant', 'Stopped at the tests.')], [reportOf(1, 'Stopped at the tests.', true)], 1)))
    .toEqual(['p1', 'report 1']);
});

test('the thread page polls every 1.5 s while live work runs or just after an action, else every 10 s (D79, D230)', () => {
  for (const state of ['preparing', 'running', 'publishing'] as const) expect(threadPollDelay(state, NOW)).toBe(1500);
  for (const state of ['queued', 'idle', 'in-review', 'waiting-for-you', 'attached', 'done', 'stopped', 'failed'] as const) expect(threadPollDelay(state, NOW)).toBe(10_000);
  expect(threadPollDelay(undefined, NOW)).toBe(10_000);
  expect(threadPollDelay('idle', NOW, NOW + 1)).toBe(1500);
  expect(threadPollDelay('idle', NOW, NOW)).toBe(10_000);
});

test('a thread page that finds no thread yet keeps loading while the thread is under two minutes old (D274)', () => {
  // The creation time newId encodes, read back to the millisecond; other ids carry none.
  for (const at of [0, NOW, NOW + 123_456_789]) expect(idTime(newId('thread', at))).toBe(at);
  for (const id of ['thread', 'thread_short', 'project', `thread_${'I'.repeat(26)}`]) expect(idTime(id)).toBeNull();
  expect(threadStarting(newId('thread', NOW - 119_000), NOW)).toBe(true);
  expect(threadStarting(newId('thread', NOW + 5_000), NOW)).toBe(true);
  expect(threadStarting(newId('thread', NOW - 120_000), NOW)).toBe(false);
  expect(threadStarting('fixture_thread', NOW)).toBe(false);
});

test('a thread whose device cannot answer before any view: offline or gone is a wait, unreachable an error, others not the device (D276)', () => {
  expect(deviceRefusal(409)).toBe('notice');
  expect(deviceRefusal(502)).toBe('error');
  for (const status of [400, 401, 403, 404, 500, 503]) expect(deviceRefusal(status)).toBeUndefined();
});

test('thread header buttons: Stop until concluded (disabled with the server reason while attached), Discard as the server allows, Allow 10 more turns only at the limit of a live thread', () => {
  const view = (state: ThreadIndex['state'], fields: { canDiscard?: boolean; atTurnLimit?: boolean; stopRefusal?: string } = {}) =>
    ({ thread: thread({ state }), canDiscard: fields.canDiscard ?? false, atTurnLimit: fields.atTurnLimit ?? false, ...(fields.stopRefusal ? { stopRefusal: fields.stopRefusal } : {}) });
  expect(threadActions(view('running'))).toEqual({ stop: true, stopRefusal: null, discard: false, allowTurns: false });
  expect(threadActions(view('in-review'))).toEqual({ stop: true, stopRefusal: null, discard: false, allowTurns: false });
  expect(threadActions(view('waiting-for-you', { atTurnLimit: true }))).toEqual({ stop: true, stopRefusal: null, discard: false, allowTurns: true });
  expect(threadActions(view('stopped', { canDiscard: true }))).toEqual({ stop: false, stopRefusal: null, discard: true, allowTurns: false });
  expect(threadActions(view('done', { atTurnLimit: true }))).toEqual({ stop: false, stopRefusal: null, discard: false, allowTurns: false });
  // An attached thread shows Stop disabled with the server's sentence, never a sentence of the interface's own.
  const sentence = 'This thread is attached in a terminal: exit that terminal session first, or run jevellan thread detach thread_a.';
  expect(threadActions(view('attached', { stopRefusal: sentence }))).toEqual({ stop: true, stopRefusal: sentence, discard: false, allowTurns: false });
});

test('the thread composer: the live line, and why it takes no message when attached or concluded (D81)', () => {
  expect(threadLiveText(thread({ state: 'running', turns: 2 }))).toBe('Working on turn 3…');
  expect(threadLiveText(thread({ state: 'preparing' }))).toBe(copy.PREPARING);
  expect(threadLiveText(thread({ state: 'publishing' }))).toBe(copy.PUBLISHING);
  expect(threadLiveText(thread({ state: 'idle' }))).toBeNull();
  const view = (state: ThreadIndex['state'], canMessage: boolean) => ({ thread: thread({ state }), canMessage, deviceName: 'Mac mini' });
  expect(composerBlock(view('running', true))).toBeNull();
  expect(composerBlock(view('attached', false))).toBe('Attached in a terminal on Mac mini. Messages wait until you exit.');
  for (const state of ['done', 'stopped', 'failed'] as const) expect(composerBlock(view(state, false))).toBe(server.THREAD_ENDED);
});

test('thread transcript notes, report badges and the header pull request badges', () => {
  const transcript = (turns: CursorTurn[], truncated = false) => ({ turns, truncated }) as unknown as NonNullable<Parameters<typeof transcriptNotice>[0]['transcript']>;
  const r1 = reportOf(1, 'First pass.');
  expect(transcriptNotice({ transcript: null, reports: [], thread: thread({ turns: 0 }) })).toBe(copy.NO_TRANSCRIPT_YET);
  expect(transcriptNotice({ transcript: null, reports: [r1], thread: thread({ turns: 1 }) })).toBe(copy.TRANSCRIPT_UNAVAILABLE);
  expect(transcriptNotice({ transcript: null, reports: [], thread: thread({ turns: 2 }) })).toBe(copy.TRANSCRIPT_UNAVAILABLE);
  expect(transcriptNotice({ transcript: transcript([]), reports: [], thread: thread() })).toBe(copy.NO_TRANSCRIPT_YET);
  expect(transcriptNotice({ transcript: transcript([text('p1', 'user', 'Task')]), reports: [], thread: thread() })).toBeNull();
  expect(transcriptNotice({ transcript: transcript([text('p1', 'user', 'Task')], true), reports: [r1], thread: thread() })).toBe(copy.TRANSCRIPT_TRUNCATED);
  expect(['progress', 'done', 'needs-decision', 'blocked'].map((status) => reportBadge(status as ThreadReport['status']))).toEqual([
    { text: 'Progress', tone: 'muted' }, { text: 'Done', tone: 'ok' }, { text: 'Needs a decision', tone: 'jev' }, { text: 'Blocked', tone: 'warn' }]);
  expect(pullRequestBadges(pr({ checks: 'failing', mergeable: 'conflict' }))).toEqual([{ text: 'Checks failing', tone: 'danger' }, { text: 'Conflicts', tone: 'danger' }]);
  expect(pullRequestBadges(pr({ checks: 'pending' }))).toEqual([{ text: 'Checks running', tone: 'warn' }]);
  expect(pullRequestBadges(pr({ state: 'merged', checks: 'passing' }))).toEqual([{ text: 'Merged', tone: 'ok' }]);
  expect(pullRequestBadges(pr({ state: 'closed', mergeable: 'conflict' }))).toEqual([{ text: 'Closed', tone: 'muted' }]);
});

const placement = (fields: Partial<PlacementRecord> = {}): PlacementRecord => PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'jev',
  fixed: [], isolation: 'worktree', runtime: 'claude', modelId: 'fable', model: 'claude-fable-5-1', effortRequested: 'high', effortEffective: 'high', deviceId: 'mac',
  accountId: 'acc_work', probabilities: { pick_model: { fable: 0.7, opus: 0.2, gpt: 0.1 }, effort: { low: 0.1, medium: 0.1, high: 0.6, xhigh: 0.1, max: 0.1 } },
  eligibleModels: ['fable', 'opus', 'gpt'], excludedModels: [{ modelId: 'sonnet', reason: 'disabled in Settings' }], eligibleDevices: ['mac'],
  excludedDevices: [{ deviceId: 'mini', reason: 'offline' }], jevCalls: [], decidedAt: ago(5), ...fields });
const overrideView = (fields: { placement?: Partial<PlacementRecord>; nextTurn?: boolean; restart?: boolean; restartReason?: string } = {}) => ({
  thread: thread({ runtime: 'claude', modelLabel: 'Fable', ownerDeviceId: 'mac' }), placement: placement(fields.placement),
  canOverride: { nextTurn: fields.nextTurn ?? true, restart: fields.restart ?? true, ...(fields.restartReason ? { restartReason: fields.restartReason } : {}) } });

test('the Why panel reads the placement field by field: Jev bars with the current value, fixed, only option, fallback and owner changes (D255)', () => {
  const fields = whyFields(placement());
  expect(fields.map((field) => [field.field, field.value, field.source])).toEqual([['isolation', 'worktree', 'only'], ['model', 'fable', 'jev'], ['effort', 'high', 'jev'], ['device', 'mac', 'only']]);
  expect(fields[1]!.bars).toEqual([{ option: 'fable', p: 0.7, chosen: true }, { option: 'opus', p: 0.2, chosen: false }, { option: 'gpt', p: 0.1, chosen: false }]);
  expect(fields[2]!.bars.map((bar) => bar.option)).toEqual(['high', 'low', 'medium', 'xhigh', 'max']);
  // A next-turn override keeps Jev's probabilities (D252): the bars mark what runs now and the field reads as the owner's change.
  const changed = whyFields(placement({ modelId: 'opus', effortRequested: 'low', effortEffective: 'low' }));
  expect(changed.slice(1, 3).map((field) => [field.source, field.bars.find((bar) => bar.chosen)?.option])).toEqual([['changed', 'opus'], ['changed', 'low']]);
  // An exact tie with the top option is still Jev's answer.
  expect(whyFields(placement({ probabilities: { pick_model: { fable: 0.5, opus: 0.5 } }, modelId: 'opus' }))[1]!.source).toBe('jev');
  expect(whyFields(placement({ source: 'fixed', fixed: ['model', 'effort'], probabilities: undefined })).map((field) => field.source)).toEqual(['only', 'fixed', 'fixed', 'only']);
  const fallback = placement({ source: 'fallback', probabilities: undefined, effortRequested: 'medium', error: { kind: 'auth', message: 'authentication failed' } });
  expect(whyFields(fallback).map((field) => [field.source, field.value, field.bars.length])).toEqual([['fallback', 'worktree', 0], ['fallback', 'fable', 0], ['fallback', 'medium', 0], ['fallback', 'mac', 0]]);
  expect(whyFields(placement({ fixed: ['device'], probabilities: { device: { mac: 0.9, mini: 0.1 } } }))[3]!.source).toBe('fixed');
  // The 9.8 chip only for a fallback with its recorded reason.
  expect(fallbackChip(fallback)).toBe('Placed without Jev: authentication failed');
  expect(fallbackChip(fallback)).toBe(server.placedWithoutJev('authentication failed'));
  expect(fallbackChip(placement())).toBeNull();
  expect(fallbackChip(placement({ source: 'fixed', probabilities: undefined }))).toBeNull();
});

test("override efforts: the model's own plus the requested one with what it runs as, mapped like the server (D255)", () => {
  for (const requested of EffortSchema.options) {
    for (const supported of [['low', 'high'], ['high', 'max'], ['medium'], ['low', 'medium', 'high', 'xhigh', 'max']] as Effort[][]) {
      expect(nearestEffort(requested, supported), `${requested} ${supported.join()}`).toBe(mapEffort(requested, supported));
    }
  }
  expect(effortChoices(['low', 'high'], 'medium')).toEqual([{ effort: 'low' }, { effort: 'medium', runsAs: 'high' }, { effort: 'high' }]);
  expect(effortChoices(['low', 'high'], 'high')).toEqual([{ effort: 'low' }, { effort: 'high' }]);
  expect(effortChoices(['high', 'max'], 'low')).toEqual([{ effort: 'low', runsAs: 'high' }, { effort: 'high' }, { effort: 'max' }]);
  expect(effortChoices(undefined, 'medium').map((choice) => choice.effort)).toEqual(EffortSchema.options);
  expect(copy.effortRunsAs('medium', 'high')).toBe('medium (runs as high)');
});

test('override requests: the next turn sends only what changed, a restart every field not on Automatic, and Apply needs something to do (D255)', () => {
  const view = overrideView({ placement: { effortRequested: 'medium', effortEffective: 'high' } });
  const form = overrideForm(view);
  expect(form).toEqual({ mode: 'next-turn', isolation: 'worktree', modelId: 'fable', effort: 'medium', deviceId: 'mac', note: '' });
  // Left alone, nothing changes: the requested effort is the default, so the mapped one never reads as a change.
  expect(overrideRequest(view, form)).toEqual({ schema: 'thread-override-request-v1', mode: 'next-turn' });
  expect(overrideReady(view, form)).toBe(false);
  expect(overrideReady(view, { ...form, note: 'Only a note.' })).toBe(false);
  const next = overrideRequest(view, { ...form, modelId: 'opus', effort: 'low', note: '  Cheaper for this part.  ' });
  expect(ThreadOverrideRequestSchema.parse({ ...next, clientRequestId: 'override_1' })).toEqual({ schema: 'thread-override-request-v1', clientRequestId: 'override_1',
    mode: 'next-turn', modelId: 'opus', effort: 'low', note: 'Cheaper for this part.' });
  expect(overrideRequest(view, { ...form, effort: 'medium', modelId: 'opus' })).toEqual({ schema: 'thread-override-request-v1', mode: 'next-turn', modelId: 'opus' });
  expect(overrideReady(view, { ...form, effort: 'low' })).toBe(true);
  // A restart keeps what the modal shows: every field not on Automatic is fixed for the new thread.
  const restart = { ...form, mode: 'restart' as const };
  expect(ThreadOverrideRequestSchema.parse({ ...overrideRequest(view, restart), clientRequestId: 'override_2' })).toEqual({ schema: 'thread-override-request-v1',
    clientRequestId: 'override_2', mode: 'restart', isolation: 'worktree', modelId: 'fable', effort: 'medium', deviceId: 'mac' });
  expect(overrideRequest(view, { ...restart, isolation: '', modelId: '', effort: '', deviceId: '' })).toEqual({ schema: 'thread-override-request-v1', mode: 'restart' });
  expect(overrideReady(view, restart)).toBe(true);
  // The server's refusals decide what is offered; the modal opens on Restart for a thread that takes no more turns.
  const refused = overrideView({ restart: false, restartReason: server.RESTART_OPEN_PULL_REQUEST });
  expect(overrideReady(refused, { ...overrideForm(refused), mode: 'restart' })).toBe(false);
  expect(overrideForm(overrideView({ nextTurn: false })).mode).toBe('restart');
  expect([overrideOffered(refused), overrideOffered(overrideView({ nextTurn: false })), overrideOffered(overrideView({ nextTurn: false, restart: false }))]).toEqual([true, true, false]);
  expect(copy.OPEN_PULL_REQUEST_BLOCKS_RESTART).toBe(server.RESTART_OPEN_PULL_REQUEST);
  void (view satisfies Pick<ThreadView, 'thread' | 'placement' | 'canOverride'>);
});

test("a restarted thread links the new one from its reason, read with the server's own words (brief 10)", () => {
  expect(restartedThread(server.restartedReason('thread_new'))).toBe('thread_new');
  expect(restartedThread('Restarted as thread_new.')).toBe('thread_new');
  expect(restartedThread('Stopped by you.')).toBeNull();
  expect(restartedThread(undefined)).toBeNull();
  expect(restartedThread('Restarted as not an id.')).toBeNull();
  expect(server.isRestarted(server.restartedReason('thread_new'))).toBe(true);
});

test("a main thread's saved-commits ref is split off its reason, so a restart still links and the ref shows whole (D295)", () => {
  const ref = 'refs/jevellan/discard/thread_old/1759656000000';
  expect(threadReason(server.commitsSavedReason('Stopped by you.', ref))).toEqual({ text: 'Stopped by you.', restartedAs: null, savedRef: ref });
  expect(threadReason(server.commitsSavedReason(server.restartedReason('thread_new'), ref)))
    .toEqual({ text: 'Restarted as thread_new.', restartedAs: 'thread_new', savedRef: ref });
  expect(threadReason(server.restartedReason('thread_new'))).toEqual({ text: 'Restarted as thread_new.', restartedAs: 'thread_new', savedRef: null });
  expect(threadReason(server.MAIN_LEASE_BUSY)).toEqual({ text: server.MAIN_LEASE_BUSY, restartedAs: null, savedRef: null });
  // A reason cut to fit 400 characters keeps its ref whole; the server reads back the same ref.
  const long = threadReason(server.commitsSavedReason('x'.repeat(400), ref));
  expect(long?.savedRef).toBe(ref); expect(long?.text).toMatch(/^x+$/);
  expect(server.savedCommitsRef(server.commitsSavedReason('Stopped by you.', ref))).toBe(ref);
  // The sentence inside other words, or naming no saved ref, stays part of the text.
  for (const reason of [`Stopped.${SAVED_COMMITS_SENTENCE}${ref}.`, `Stopped. ${SAVED_COMMITS_SENTENCE}refs/heads/main.`, `Stopped. ${SAVED_COMMITS_SENTENCE}${ref}. Later.`]) {
    expect(threadReason(reason)).toEqual({ text: reason, restartedAs: null, savedRef: null });
  }
  expect(threadReason(undefined)).toBeNull(); expect(threadReason('')).toBeNull();
});

test('withdrawn questions need a successful call with its reason, once per ledger id and never for history (D84, D200)', () => {
  const tool = (id: number, fields: Record<string, unknown>) => event('coordinator-tool', { schema: 'coordinator-tool-v1', tool: 'jevellan_withdraw_question',
    ok: true, summary: 'Withdrew a question: Solved', decisionId: 'q1', reason: 'Solved', ...fields }, id);
  const events = [
    tool(1, {}), tool(2, { reason: undefined, summary: 'The owner already answered that question' }), tool(3, { ok: false, decisionId: undefined, reason: undefined, summary: 'Could not withdraw a question: x' }),
    tool(4, { tool: 'jevellan_ask_user' }), tool(5, { decisionId: 'q2', reason: 'Not needed any more' }), tool(6, { decisionId: 'q3', reason: 'Answered in the notebook' }),
  ];
  expect(withdrawals(events, new Set())).toEqual([{ id: 1, decisionId: 'q1', reason: 'Solved' }, { id: 5, decisionId: 'q2', reason: 'Not needed any more' },
    { id: 6, decisionId: 'q3', reason: 'Answered in the notebook' }]);
  expect(withdrawals(events, new Set([5]), 1)).toEqual([{ id: 6, decisionId: 'q3', reason: 'Answered in the notebook' }]);
  expect(copy.questionWithdrawn('Solved')).toBe('A question was withdrawn: Solved');
});

test('time helpers', () => {
  expect(shortTime(ago(0), NOW)).toBe('now');
  expect(shortTime(ago(5), NOW)).toBe('5m');
  expect(shortTime(ago(180), NOW)).toBe('3h');
  expect(duration(45)).toBe('45s');
  expect(duration(200)).toBe('3m 20s');
  expect(duration(7500)).toBe('2h 5m 0s');
  expect(relativeDuration(ago(0.5), NOW)).toBe('30s');
  expect(relativeDuration(ago(12), NOW)).toBe('12m');
  expect(relativeDuration(ago(120), NOW)).toBe('2h');
  expect(relativeDuration(ago(125), new Date(NOW).toISOString())).toBe('2h 5m');
  expect(relativeDuration(ago(3 * 1440 + 240), NOW)).toBe('3d 4h');
  expect(relativeDuration(ago(-5), NOW)).toBe('0s');
  expect(dateOnly('2026-10-04T12:00:00.000Z')).toMatch(/2026/);
  expect(timeStamp('not a time')).toBeNull();
  expect(timeStamp(ago(1))).toMatchObject({ label: expect.any(String), title: expect.any(String) });
});

test('interface copy: brief-verbatim texts, shared server texts and no conversation vocabulary', () => {
  expect(copy.EMPTY_CHAT).toBe('Describe what you want done. The coordinator splits it into threads, runs them on your devices and accounts, and brings back what needs you.');
  expect(copy.coordinatorSession('Codex', 'gpt-x', 'high')).toBe('Codex gpt-x · high');
  expect(copy.mergeTitle(42)).toBe('Squash and merge #42?');
  expect(copy.mergeBody('Fix login', 'main')).toBe("Fix login will be squashed into main. The thread's worktree is removed afterwards.");
  expect(copy.takeOverLine('Mac mini', server.attachCommand('thread_a'))).toBe('Take over in a terminal on Mac mini: jevellan thread attach thread_a');
  expect(`${copy.takeOverLead('Mac mini')} ${server.attachCommand('thread_a')}`).toBe(copy.takeOverLine('Mac mini', server.attachCommand('thread_a')));
  expect(copy.savedUpdated('Oct 4, 2026')).toBe('Saved · updated Oct 4, 2026');
  expect([copy.NOTEBOOK_CHANGED, copy.LEAVE_GIT_SETTING, copy.ALLOW_MORE_TURNS, copy.MERGE_BLOCKED_CONFLICTS, copy.MERGE_BLOCKED_CHECKS, copy.THREAD_ENDED,
    copy.WORKTREE_DISCARDED]).toEqual([server.NOTEBOOK_CHANGED, server.LEAVE_GIT_SETTING, server.ALLOW_MORE_TURNS, server.MERGE_CONFLICTS,
    server.MERGE_CHECKS_FAILING, server.THREAD_ENDED, server.WORKTREE_DISCARDED.trim()]);
  expect(copy.discardQuestion('jv/fix-login-abc123')).toBe('Remove the worktree and local branch jv/fix-login-abc123?');
  expect(copy.GITHUB_TOKEN_HELP).toBe('Used only to open, read and merge pull requests for Jevellan threads. A fine-grained token with Pull requests read and write, Contents read and write, Checks read and Commit statuses read on your repositories is enough.');
  expect([copy.NOT_SET, copy.REPLACE, copy.REMOVE, copy.INTERRUPT_TURN, copy.THREAD_PLACEHOLDER]).toEqual(['Not set', 'Replace', 'Remove', 'Interrupt current turn', 'Message this thread']);
  expect([copy.coordinatorUnavailableNotice('x'), copy.coordinatorOfflineNotice('Mac mini'), copy.placedWithoutJev('timeout')])
    .toEqual([server.coordinatorUnavailableNotice('x'), server.coordinatorOfflineNotice('Mac mini'), server.placedWithoutJev('timeout')]);
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') texts.push(value);
    else if (typeof value === 'function') collect((value as (...args: unknown[]) => unknown)('Sample', 3, 'Sample', 'Sample'));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  Object.values(copy).forEach(collect);
  expect(texts.length).toBeGreaterThan(120);
  for (const value of texts) {
    expect(value, value).not.toMatch(/conversation|stretch|handoff/i);
    expect(value, value).not.toContain(String.fromCharCode(0x2014));
  }
});
