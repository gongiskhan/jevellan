import { joinToolTurns } from './transcript-groups.js';
import {
  EffortSchema,
  IdSchema,
  OWNER_STARTED_PREFIX,
  OWNER_STOPPED_THREAD,
  OWNER_WORKED_PREFIX,
  ProjectLedgerDataSchemas,
  RESTARTED_PREFIX,
  idTime,
  isTerminal,
  liveWork,
  runningSection,
  splitSavedCommits,
  type CoordinatorEvent,
  type CursorTurn,
  type Effort,
  type Isolation,
  type ProjectLedgerData,
  type ProjectLedgerEvent,
  type ProjectLedgerEventType,
  type ProjectWorkListView,
  type ProjectWorkView,
  type ThreadIndex,
  type ThreadReport,
  type ThreadState,
  type ThreadView,
} from '@jevellan/core/client';
import type { IconName } from './icons.js';
import * as copy from './project-work-copy.js';

// Pure, DOM-free logic of the Projects pages (design 2.11), unit tested in tests/project-work-ui.test.ts.

/** Window event every Projects mutation dispatches so the sidebar refreshes at once (like `jevellan-conversation-updated`). */
export const PROJECT_WORK_UPDATED = 'jevellan-project-work-updated';

export type ProjectRoute = { projectId: string; threadId?: string; taskId?: string; settings?: true };
/** `/projects/<id>` and `/projects/<id>/threads/<tid>` with valid ids; anything else is not a Projects page. */
export function projectRoute(path: string): ProjectRoute | null {
  const parts = path.split(/[?#]/)[0]!.split('/');
  const valid = (value: string | undefined): value is string => value !== undefined && IdSchema.safeParse(value).success;
  if (parts[0] !== '' || parts[1] !== 'projects' || !valid(parts[2])) return null;
  if (parts.length === 4 && parts[3] === 'settings') return { projectId: parts[2], settings: true };
  if (parts.length === 5 && parts[3] === 'tasks' && valid(parts[4])) return { projectId: parts[2], taskId: parts[4] };
  if (parts.length === 5 && parts[3] === 'threads' && valid(parts[4])) return { projectId: parts[2], threadId: parts[4] };
  return parts.length === 3 ? { projectId: parts[2] } : null;
}

export type ProjectTab = 'chat' | 'queue' | 'waiting' | 'threads' | 'pull-requests' | 'terminal' | 'overview' | 'routines';
/**
 * How often the project page's clock ticks (D243): every second while a Running row is under a minute old, because its
 * age then reads in seconds (`relativeDuration`), else every 30 s, as minutes are all the rows show after that.
 */
export function rowClockMs(threads: readonly Pick<ThreadIndex, 'state' | 'createdAt'>[], now: number): number {
  return threads.some((thread) => runningSection(thread.state) && now - Date.parse(thread.createdAt) < 60_000) ? 1000 : 30_000;
}

/** Thread state dot classes (D54); the colors live in project-work.css. */
export function dotClass(state: ThreadState): string {
  return `pw-dot pw-${state}`;
}

/** The sidebar row dot: a working coordinator pulses, open questions show solid magenta, else a muted outline. */
export function projectDot(entry: Pick<ProjectWorkListView['projects'][number], 'waiting' | 'coordinator' | 'attention'>): string {
  return dotClass(entry.attention ?? (entry.coordinator.state === 'running' ? 'running' : entry.waiting ? 'waiting-for-you' : 'idle'));
}

/** Sidebar order: by name, so rows never move while their counts change. */
export function sidebarProjects(view: ProjectWorkListView): ProjectWorkListView['projects'] {
  // The engine sends rows in sidebar order (bridge phase 2).
  return view.projects;
}

export type BadgeTone = 'ok' | 'danger' | 'warn' | 'muted' | 'jev';

/** Why Main cannot be chosen here, or null: the Leave git text wins over the phase text (D88, D221). */
export function mainIsolationBlock(view: Pick<ProjectWorkView, 'project' | 'gates'> & Partial<Pick<ProjectWorkView, 'settings'>>): string | null {
  void view; return copy.MAIN_NOT_AVAILABLE;
}
/** Why another device cannot be chosen yet, or null (D88, D221). */
export function deviceBlock(view: Pick<ProjectWorkView, 'gates'>, deviceId: string, currentDeviceId: string): string | null {
  return deviceId === currentDeviceId || view.gates.remoteDevices ? null : copy.REMOTE_NOT_AVAILABLE;
}

/** One Device option of New thread and Override restart. */
export type DeviceChoice = { id: string; label: string; disabled: boolean };
type RosterRow = { device: { id: string; name: string }; status: 'online' | 'stale' | 'offline'; revoked: boolean };
/**
 * The Device options (D281): every device of the work view's setup in roster order, disabled with the reason placement would refuse
 * it, and by the phase gate (D88). A device chosen before and no longer listed stays listed, disabled, so the field shows the choice.
 * A view without the setup (an older device) offers the roster's available devices; before any view every option is disabled.
 */
export function deviceChoices(view: Pick<ProjectWorkView, 'gates' | 'devices'> | undefined, roster: readonly RosterRow[], currentDeviceId: string, selected = ''): DeviceChoice[] {
  const name = (id: string) => roster.find((row) => row.device.id === id)?.device.name ?? id;
  const choices: DeviceChoice[] = view?.devices
    ? view.devices.map((entry) => ({ id: entry.deviceId, label: entry.reason ? copy.deviceUnavailable(entry.name, entry.reason) : entry.name,
      disabled: !!entry.reason || deviceBlock(view, entry.deviceId, currentDeviceId) !== null }))
    : roster.filter((row) => !row.revoked && (row.device.id === currentDeviceId || row.status !== 'offline'))
      .map((row) => ({ id: row.device.id, label: row.device.name, disabled: !view || deviceBlock(view, row.device.id, currentDeviceId) !== null }));
  return selected && !choices.some((choice) => choice.id === selected) ? [...choices, { id: selected, label: name(selected), disabled: true }] : choices;
}

const EFFORTS = EffortSchema.options;
/** The effort a model runs for a requested one: its lowest effort at or above it, else its highest (core `mapEffort`, which is not browser-safe). */
export function nearestEffort(requested: Effort, supported: readonly Effort[]): Effort {
  const offered = [...new Set(supported)].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  return offered.find((effort) => EFFORTS.indexOf(effort) >= EFFORTS.indexOf(requested)) ?? offered.at(-1) ?? requested;
}
export type ThreadForm = { title: string; task: string; isolation: '' | Isolation; modelId: string; effort: '' | Effort; deviceId: string };
/** `POST /api/projects/:id/threads`: fields left on Automatic are omitted, so placement decides them. */
export function threadCreateRequest(clientRequestId: string, form: ThreadForm) {
  return { schema: 'thread-create-request-v1' as const, clientRequestId, title: form.title.trim(), task: form.task.trim(),
    ...(form.isolation ? { isolation: form.isolation } : {}), ...(form.modelId ? { modelId: form.modelId } : {}),
    ...(form.effort ? { effort: form.effort } : {}), ...(form.deviceId ? { deviceId: form.deviceId } : {}) };
}

export type SettingsForm = { defaultIsolation: Isolation; isolationChanged: boolean; modelId: string; effort: Effort; setupCommand: string;
  refill?: ProjectWorkView['settings']['refill']; nightlyWindow?: ProjectWorkView['settings']['nightlyWindow']; autoLand?: boolean; riskyAreas?: string; requiredChecks?: string[]; instructions?: string; allowMainIsolation?: boolean;
  sessionCheckpoints?: ProjectWorkView['settings']['sessionCheckpoints']; compactAtPercent?: number; maxRunningThreads: number; maxRunningPerDevice: number; perDeviceLimits?: Record<string, number>; threadTurnCap: number };
/**
 * `PUT /api/projects/:id/work-settings`. Reads show a stored `main` default as worktree with a notice (D205); unless the
 * owner picked an isolation, a save keeps the stored `main` instead of silently replacing it (D223).
 */
export function settingsRequest(view: Pick<ProjectWorkView, 'settings' | 'settingsNotice'>, form: SettingsForm) {
  const { schema: _schema, projectId: _project, revision: _revision, ...settings } = view.settings; void _schema; void _project; void _revision;
  return { schema: 'project-work-settings-request-v1' as const, revision: view.settings.revision, settings: {
    ...settings, refill: form.refill ?? view.settings.refill, nightlyWindow: form.nightlyWindow ?? view.settings.nightlyWindow,
    coordinator: { ...view.settings.coordinator, modelId: form.modelId || null, effort: form.effort }, setupCommand: form.setupCommand.trim() || null,
    autoLand: form.autoLand ?? view.settings.autoLand, riskyAreas: form.riskyAreas ?? view.settings.riskyAreas, instructions: form.instructions ?? view.settings.instructions,
    sessionCheckpoints: form.sessionCheckpoints ?? view.settings.sessionCheckpoints,
    compactAtPercent: form.compactAtPercent ?? view.settings.compactAtPercent,
    perDeviceLimits: form.perDeviceLimits ?? view.settings.perDeviceLimits,
    maxRunningThreads: form.maxRunningThreads, maxRunningPerDevice: form.maxRunningPerDevice, threadTurnCap: form.threadTurnCap } };
}

const TOOL_ICONS: Record<string, IconName> = {
  jevellan_setup_propose: 'settings', jevellan_library_list: 'search', jevellan_library_get: 'file',
  jevellan_settings_update: 'settings', jevellan_tasks_start: 'plus', jevellan_review_followup: 'pull-request', jevellan_handoff_write: 'file',
  jevellan_jobs_list: 'search', jevellan_job_runs: 'search', jevellan_daily_list: 'search', jevellan_job_run: 'plus', jevellan_goals_list: 'search', jevellan_tasks_list: 'thread', jevellan_task_create: 'plus', jevellan_task_update: 'settings', jevellan_task_cancel: 'stop', jevellan_threads_list: 'thread', jevellan_thread_start: 'plus', jevellan_thread_message: 'message', jevellan_thread_read: 'search',
  jevellan_thread_stop: 'stop', jevellan_ask_user: 'why', jevellan_answer_question: 'check', jevellan_github: 'search', jevellan_terminal_read: 'file', jevellan_withdraw_question: 'close', jevellan_notebook_read: 'file',
  jevellan_notebook_write: 'file', jevellan_pr_status: 'pull-request', jevellan_pr_diff: 'file', jevellan_mail_send: 'message', memory_search: 'search', memory_read: 'file',
};
/** The icon of a chat one-liner, by tool. */
export function toolIcon(tool: string): IconName {
  return TOOL_ICONS[tool] ?? 'tune';
}



/**
 * A ` · ` separated line (the placement line, a Jev call) in the parts it wraps by: each part but the last keeps its
 * separator, so a wrapped line ends in `·` and the parts joined with single spaces read as the line itself.
 */
export function lineParts(line: string): string[] {
  const parts = line.split(' · ');
  return parts.map((part, index) => index < parts.length - 1 ? `${part} ·` : part);
}

/**
 * The words one part of a ` · ` line wraps by: a part wider than the line breaks between its words, and its separator stays
 * with the word before it (the page keeps the two on one line), so a separator never starts a line or stands alone on one.
 */
export function partWords(part: string): string[] {
  const words = part.split(' ');
  if (words.length > 1 && words.at(-1) === '·') words.splice(-2, 2, `${words.at(-2)} ·`);
  return words;
}

/** How often the thread page reads its view (D79): 1.5 s while live work runs, else 10 s. */
export const THREAD_POLL_LIVE_MS = 1500;
export const THREAD_POLL_REST_MS = 10_000;
/** How long the page keeps reading every 1.5 s after the owner acted, so the turn the action starts shows at once (D230). */
export const THREAD_POLL_AFTER_ACTION_MS = 6000;
/**
 * A thread page that finds no thread yet keeps loading while the thread is this young (D274): one placed on another device
 * exists there, and in the hub index, only once that device has read its start from the hub.
 */
export const THREAD_START_WAIT_MS = 120_000;
export function threadStarting(threadId: string, now: number): boolean {
  const at = idTime(threadId); return at !== null && Math.abs(now - at) < THREAD_START_WAIT_MS;
}
/**
 * A thread view read that the thread's device could not answer before any view showed (D276): 409 when the device is offline
 * or left the mesh, a wait the page shows as a notice; 502 when it could not be reached, an error. The page then names the
 * thread from the project's index meanwhile. Other failures are no device's.
 */
export function deviceRefusal(status: number): 'notice' | 'error' | undefined {
  return status === 409 ? 'notice' : status === 502 ? 'error' : undefined;
}
export function threadPollDelay(state: ThreadState | undefined, now: number, fastUntil = 0): number {
  return (state !== undefined && liveWork(state)) || now < fastUntil ? THREAD_POLL_LIVE_MS : THREAD_POLL_REST_MS;
}
/**
 * The thread header buttons (12.3): Stop while the thread is not concluded, Discard when the owner may discard it (the
 * server decides), Allow 10 more turns at the turn limit of a thread that has not concluded.
 */
/** `stopRefusal`: Stop shows disabled with the server's reason (an attached thread, phase 8). */
export function threadActions(view: Pick<ThreadView, 'thread' | 'canDiscard' | 'atTurnLimit' | 'stopRefusal'>): { stop: boolean; stopRefusal: string | null; discard: boolean; allowTurns: boolean } {
  const ended = isTerminal(view.thread.state);
  return { stop: !ended, stopRefusal: ended ? null : view.stopRefusal ?? null, discard: view.canDiscard, allowTurns: view.atTurnLimit && !ended };
}
/** Why the thread composer takes no message (D81), or null: attached in a terminal, else concluded. */
export function composerBlock(view: Pick<ThreadView, 'canMessage' | 'thread' | 'deviceName'>): string | null {
  if (view.canMessage) return null;
  return view.thread.state === 'attached' ? copy.attachedNotice(view.deviceName) : copy.THREAD_ENDED;
}
/** The composer's live line: the running turn (turns count finished ones), the preparation or the publication. */
export function threadLiveText(thread: Pick<ThreadIndex, 'state' | 'turns'>): string | null {
  return thread.state === 'running' ? copy.turnRunning(thread.turns + 1) : thread.state === 'preparing' ? copy.PREPARING
    : thread.state === 'publishing' ? copy.PUBLISHING : null;
}
/** Show the latest tool's stated purpose while its result is pending, without inferring process health. */
export function threadActivity(view: Pick<ThreadView, 'thread' | 'transcript'>): string | null {
  if (view.thread.state !== 'running') return null;
  const turn = view.transcript?.turns.at(-1);
  if (turn?.role !== 'assistant') return null;
  const block = turn.blocks.at(-1);
  if (block?.type !== 'tool' || block.output !== undefined || !['running', 'unknown'].includes(block.state)) return null;
  let purpose = block.name;
  try {
    const input: unknown = JSON.parse(block.input);
    if (input && typeof input === 'object' && 'description' in input && typeof input.description === 'string') purpose = input.description;
  } catch { /* Partial tool input still has its tool name. */ }
  return `Waiting for tool result: ${purpose.slice(0, 180)}`;
}
/** The note above a thread transcript: none yet, unreadable (reports still show) or only its most recent part. */
export function transcriptNotice(view: Pick<ThreadView, 'transcript' | 'reports' | 'thread'>): string | null {
  if (!view.transcript) return view.reports.length || view.thread.turns ? copy.TRANSCRIPT_UNAVAILABLE : copy.NO_TRANSCRIPT_YET;
  if (!view.transcript.turns.length && !view.reports.length) return copy.NO_TRANSCRIPT_YET;
  return view.transcript.truncated ? copy.TRANSCRIPT_TRUNCATED : null;
}
const REPORT_TONES = { progress: 'muted', done: 'ok', 'needs-decision': 'jev', blocked: 'warn' } as const satisfies Record<ThreadReport['status'], BadgeTone>;
/** A report card's status chip: progress muted, done ok, a decision magenta like Waiting for you, blocked warn. */
export function reportBadge(status: ThreadReport['status']): { text: string; tone: BadgeTone } {
  return { text: copy.REPORT_STATUS[status], tone: REPORT_TONES[status] };
}


// ---------- placement: the fallback chip, Why and Override (12.3, 9.8; D255) ----------
/** The new thread's id in a restarted thread's reason (`Restarted as {newId}.`, brief 10), so the page can link it; else null. */
export function restartedThread(reason: string | undefined): string | null {
  if (!reason?.startsWith(RESTARTED_PREFIX) || !reason.endsWith('.')) return null;
  const id = reason.slice(RESTARTED_PREFIX.length, -1);
  return IdSchema.safeParse(id).success ? id : null;
}
/**
 * A thread's reason in parts (D295): the free text the header clamps, the restarted thread it links, and the ref a main thread's
 * unpublished commits were saved at, which the header shows whole on its own line (the owner needs it to recover them).
 */
export function threadReason(reason: string | undefined): { text: string; restartedAs: string | null; savedRef: string | null } | null {
  if (!reason) return null;
  const { text, ref } = splitSavedCommits(reason);
  return { text, restartedAs: restartedThread(text), savedRef: ref };
}

function payload<T extends ProjectLedgerEventType>(event: ProjectLedgerEvent, type: T): ProjectLedgerData<T> | undefined {
  if (event.type !== type) return undefined;
  const parsed = ProjectLedgerDataSchemas[type].safeParse(event.data);
  return parsed.success ? parsed.data as ProjectLedgerData<T> : undefined;
}

export type ChatItem =
  | { kind: 'owner'; id: number; text: string; at: string; via?: string; delivered: boolean }
  | { kind: 'reply'; id: number; text: string }
  | { kind: 'routed'; id: number; turn?: number; taskIds?: string[]; threadId?: string; message: boolean }
  | { kind: 'setup'; id: number; proposalId: string }
  | { kind: 'settings'; id: number; change: import('@jevellan/core/client').ProjectSettingsChange }
  | { kind: 'tool'; id: number; tool: string; summary: string; ok: boolean; threadId?: string }
  | { kind: 'event'; id: number; text: string; detail?: string; threadId?: string; delivered: boolean }
  | { kind: 'notice'; id: number; text: string; tone: 'info' | 'error' };
/** Thread titles by id, from the project view; unknown threads read `a thread`. */
export type ThreadTitles = (threadId: string) => string | undefined;

const firstLine = (text: string) => text.trim().split('\n')[0]!.trim();
type EventCard = { text: string; detail?: string; threadId?: string };
const card = (text: string, threadId: string | undefined, detail?: string): EventCard =>
  ({ text, ...(threadId ? { threadId } : {}), ...(detail?.trim() ? { detail: detail.trim() } : {}) });
function eventCard(event: Exclude<CoordinatorEvent, { kind: 'user-message' }>, titles: ThreadTitles): EventCard {
  const name = (threadId: string) => { const title = titles(threadId); return title ? copy.quotedTitle(title) : copy.UNKNOWN_THREAD_NAME; };
  const text = copy.eventCopy;
  switch (event.kind) {
    case 'handoff-requested': return card('Coordinator saved its work', undefined, 'Saving what is in flight before the next session.');
    case 'setup-requested': return card(copy.SETUP_REQUESTED_EVENT, undefined);
    case 'settings-changed': return card(copy.SETTINGS_CHANGED_EVENT, undefined, event.changes.map(change => `${copy.settingFieldLabel(change.field)}: ${change.from} → ${change.to}`).join('; '));
    case 'thread-resolved': return card(copy.threadResolved(titles(event.threadId) ?? copy.UNKNOWN_THREAD_NAME), event.threadId);
    case 'thread-placement-changed': return card(event.summary, event.threadId);
    case 'thread-auto-fix': return card(copy.automaticFixEvent(event.prNumber, event.outcome), event.threadId);
    case 'memory-dreamed': return card('Memory dream completed', undefined, event.summary);
    case 'deploy': return card(event.outcome === 'deployed' ? `Deployed ${event.commit.slice(0, 7)} with ${event.threads} threads` : `Deploy ${event.commit.slice(0, 7)} ${event.outcome}`, undefined, event.summary);
    case 'job-finished': return card(`Job "${event.name}" ${event.conclusion}`, undefined, `${event.commit.slice(0, 7)} · ${event.summary}`);
    case 'project-reviewed': return card('Nightly review completed', undefined, event.report.summary);
    case 'window-opened': return card('Nightly window opened', undefined, `${event.pending} nightly tasks pending. Merges are held.`);
    case 'window-finished': return card('Nightly window finished', undefined, event.outcome);
    case 'goal-refill': return card('Goals need work', undefined, event.goals.map(goal => `${goal.name}: ${goal.refillsToday} refilled today of ${goal.cap}`).join('\n'));
    case 'thread-report': {
      const status = { progress: text.reportProgress, done: text.reportDone, 'needs-decision': text.reportDecision, blocked: text.reportBlocked }[event.report.status];
      return card(status(name(event.threadId)), event.threadId, event.report.summary);
    }
    case 'thread-published': {
      const n = name(event.threadId);
      if (event.result === 'landed') return card(`${n} landed as ${(event.commit ?? '').slice(0, 7)}`, event.threadId);
      return card(event.result === 'pr-opened' ? text.prOpened(n, event.prNumber) : event.result === 'pr-updated' ? text.prUpdated(n, event.prNumber)
        : event.result === 'main-published' ? text.mainPublished(n) : event.result === 'checkout-completed' ? text.checkoutCompleted(n) : text.noChanges(n), event.threadId);
    }
    case 'thread-verification-failed': return card(text.testsFailed(name(event.threadId), event.attempts), event.threadId);
    case 'thread-interrupted': {
      // The owner's own stop says so in their voice; its message is written for the coordinator (D316).
      if (event.reason === 'stopped' && event.message === OWNER_STOPPED_THREAD) return card(text.ownerStopped(name(event.threadId)), event.threadId);
      const reason = { restart: text.interruptedRestart, timeout: text.interruptedTimeout, failed: text.interruptedFailed, stopped: text.interruptedStopped }[event.reason];
      return card(reason(name(event.threadId)), event.threadId, event.message);
    }
    case 'decision-answer': return card(text.answered(firstLine(event.question)), event.threadId, text.answer(event.answer.optionLabel, event.answer.text));
    case 'pr-ready-for-review': return card(`Pull request #${event.prNumber} is ready for the coordinator's review`, event.threadId, `Commit ${event.commit}`);
    case 'merge-gate': return card(`Pull request #${event.prNumber}: ${event.outcome.replaceAll('-', ' ')}`, event.threadId, event.summary);
    case 'task-reviewed': return card(`You ${event.outcome} "${event.title}"`, undefined);
    case 'task-not-started': return card(`"${event.title}" could not start`, undefined, event.reason);
    case 'pr-update': {
      const change = { 'checks-failed': text.checksFailed, 'checks-passed': text.checksPassed, merged: text.prMerged, closed: text.prClosed, conflict: text.prConflict }[event.change];
      return card(change(name(event.threadId), event.prNumber), event.threadId);
    }
    case 'mail': return card(text.mail(name(event.fromThreadId), event.subject), event.fromThreadId, event.body);
    case 'thread-user-message': {
      // Owner starts and terminal work arrive preformatted (D35); the card says what happened and keeps the task as detail.
      if (event.text.startsWith(OWNER_WORKED_PREFIX)) return card(text.ownerWorked(name(event.threadId)), event.threadId);
      if (event.text.startsWith(OWNER_STARTED_PREFIX)) {
        const marker = `(${event.threadId})] `; const at = event.text.indexOf(marker);
        return card(text.ownerStarted(name(event.threadId)), event.threadId, at < 0 ? undefined : event.text.slice(at + marker.length));
      }
      return card(text.ownerWrote(name(event.threadId)), event.threadId, event.text);
    }
    case 'placement-override': return card(text.overridden(name(event.threadId)), event.threadId, event.summary);
  }
}

/**
 * The coordinator chat from its ledger, in ledger order: owner messages, replies, tool one-liners, event cards and notices.
 * Owner messages and event cards are delivered once a coordinator turn lists their event id (D2a). Records that do not
 * parse are skipped, so one bad record never blanks the chat.
 */
export function chatItems(events: readonly ProjectLedgerEvent[], titles: ThreadTitles = () => undefined): ChatItem[] {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const delivered = new Set(ordered.flatMap((event) => payload(event, 'coordinator-turn-start')?.eventIds ?? []));
  const taskCards = new Map<number, Set<string>>(), settingCards = new Set<string>();
  const items = ordered.flatMap((event): ChatItem[] => {
    const id = event.id;
    switch (event.type) {
      case 'coordinator-text': { const data = payload(event, 'coordinator-text'); return data ? [{ kind: 'reply', id, text: data.text }] : []; }
      case 'coordinator-tool': {
        const data = payload(event, 'coordinator-tool');
        if (data?.ok && data.setupProposalId) return [{ kind: 'setup', id, proposalId: data.setupProposalId }];
        if (data?.ok && data.settingsChange) {
          if (settingCards.has(data.settingsChange.id)) return [];
          settingCards.add(data.settingsChange.id); return [{ kind: 'settings', id, change: data.settingsChange }];
        }
        if (data?.ok && (data.taskIds?.length || data.tool === 'jevellan_thread_message' && data.threadId)) {
          let taskIds = data.taskIds;
          if (taskIds && event.turn) {
            const seen = taskCards.get(event.turn) ?? new Set<string>(); taskCards.set(event.turn, seen);
            taskIds = taskIds.filter(taskId => !seen.has(taskId)); taskIds.forEach(taskId => seen.add(taskId));
            if (!taskIds.length) return [];
          }
          return [{ kind: 'routed', id, ...(event.turn ? { turn: event.turn } : {}), ...(taskIds ? { taskIds } : {}), ...(data.threadId ? { threadId: data.threadId } : {}), message: data.tool === 'jevellan_thread_message' }];
        }
        return data ? [{ kind: 'tool', id, tool: data.tool, summary: data.summary, ok: data.ok, ...(data.threadId ? { threadId: data.threadId } : {}) }] : [];
      }
      case 'notice': { const data = payload(event, 'notice'); return data ? [{ kind: 'notice', id, text: data.text, tone: data.kind }] : []; }
      case 'coordinator-event': {
        const data = payload(event, 'coordinator-event');
        if (!data) return [];
        if (data.kind === 'user-message') return [{ kind: 'owner', id, text: data.text, at: data.at, ...(data.via ? { via: data.via } : {}), delivered: delivered.has(data.id) }];
        return [{ kind: 'event', id, ...eventCard(data, titles), delivered: delivered.has(data.id) }];
      }
      default: return [];
    }
  });
  const turns = new Map(ordered.map(event => [event.id, event.turn]));
  const reply = new Map<number, number>();
  for (const item of items) { const turn = turns.get(item.id); if (item.kind === 'reply' && turn) reply.set(turn, item.id); }
  const moved = new Set<number>(), cardsByReply = new Map<number, ChatItem[]>();
  for (const item of items) if (item.kind === 'routed' && item.turn && reply.has(item.turn)) {
    const replyId = reply.get(item.turn)!, cards = cardsByReply.get(replyId) ?? []; cards.push(item); cardsByReply.set(replyId, cards); moved.add(item.id);
  }
  return items.filter(item => !moved.has(item.id)).flatMap(item => [item, ...(cardsByReply.get(item.id) ?? [])]);
}

export type TranscriptItem = { kind: 'turn'; turn: CursorTurn; fix?: import('@jevellan/core/client').ThreadFix } | { kind: 'report'; report: ThreadReport };

export function mergeThreadToolTurns(items: readonly TranscriptItem[]): TranscriptItem[] {
  const result: TranscriptItem[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    const joined = item.kind === 'turn' && previous?.kind === 'turn' ? joinToolTurns(previous.turn, item.turn) : undefined;
    if (joined) result[result.length - 1] = { ...previous, kind: 'turn', turn: joined }; else result.push(item);
  }
  return result;
}

const REPORT_TOOL = 'jevellan_thread_report';
const isPrompt = (turn: CursorTurn) => turn.role === 'user' && !turn.automated;
/** The summary a `jevellan_thread_report` call carries, if the block is one. */
function reportSummary(block: CursorTurn['blocks'][number]): string | undefined {
  if (block.type !== 'tool' || block.name.split('__').at(-1) !== REPORT_TOOL) return undefined;
  try {
    const input: unknown = JSON.parse(block.input);
    const summary = input && typeof input === 'object' ? (input as Record<string, unknown>).summary : undefined;
    return typeof summary === 'string' ? summary : undefined;
  } catch { return undefined; }
}
function reportedSummaries(segment: readonly CursorTurn[]): string[] {
  return segment.flatMap((turn) => turn.blocks.flatMap((block) => { const summary = reportSummary(block); return summary === undefined ? [] : [summary]; }));
}
/**
 * Report cards placed after the turn they report (D56). The transcript splits into one segment per Jevellan turn prompt
 * (a non-automated user turn); segments take turn numbers from the end. The anchor is the latest segment whose
 * `jevellan_thread_report` call carries the summary of a recorded report; without one, the last segment is turn `latest`
 * (the caller passes `turns + 1` while a turn runs), else the last report's turn. Reports older than the transcript come
 * first, reports newer than it last; with no transcript they are simply in order.
 */
export function alignReports(turns: readonly CursorTurn[], reports: readonly ThreadReport[], latest?: number, fixes: readonly { turn: number; fix: import('@jevellan/core/client').ThreadFix }[] = []): TranscriptItem[] {
  const prefix: CursorTurn[] = []; const segments: CursorTurn[][] = [];
  for (const turn of turns) {
    if (isPrompt(turn)) segments.push([turn]);
    else (segments.at(-1) ?? prefix).push(turn);
  }
  const ordered = [...reports].sort((a, b) => a.turn - b.turn);
  const recorded = ordered.filter((report) => !report.synthesized).reverse();
  let first: number | undefined;
  for (let index = segments.length - 1; index >= 0 && first === undefined; index--) {
    const summaries = reportedSummaries(segments[index]!);
    const report = summaries.length ? recorded.find((candidate) => summaries.includes(candidate.summary)) : undefined;
    if (report) first = report.turn - index;
  }
  first ??= (latest ?? ordered.at(-1)?.turn ?? segments.length) - segments.length + 1;
  const items: TranscriptItem[] = []; let next = 0;
  const reportsUpTo = (turn: number) => { while (next < ordered.length && ordered[next]!.turn <= turn) items.push({ kind: 'report', report: ordered[next++]! }); };
  reportsUpTo(first - 2);
  for (const turn of prefix) items.push({ kind: 'turn', turn });
  reportsUpTo(first - 1);
  segments.forEach((segment, index) => { const fix = fixes.find(row => row.turn === first + index)?.fix; for (const turn of segment) items.push({ kind: 'turn', turn, ...(isPrompt(turn) && fix ? { fix } : {}) }); reportsUpTo(first + index); });
  reportsUpTo(Infinity);
  return items;
}
/**
 * The transcript as the thread page shows it (D245): a completed `jevellan_thread_report` call whose summary is a recorded
 * report is left out, because that report's card follows the turn (the raw call read as an internal tool name above every
 * card). A running, failed or refused call stays (a refusal can read as completed: Codex results carry no error flag). A
 * turn left without blocks is dropped. Run it after `alignReports`, which anchors on those calls.
 */
export function withoutReportCalls(items: readonly TranscriptItem[], reports: readonly ThreadReport[]): TranscriptItem[] {
  const recorded = new Set(reports.filter((report) => !report.synthesized).map((report) => report.summary));
  const shown = (block: CursorTurn['blocks'][number]) => {
    const summary = block.type === 'tool' && block.state === 'completed' ? reportSummary(block) : undefined;
    return summary === undefined || !recorded.has(summary);
  };
  return items.flatMap((item): TranscriptItem[] => {
    if (item.kind !== 'turn') return [item];
    const blocks = item.turn.blocks.filter(shown);
    if (blocks.length === item.turn.blocks.length) return [item];
    return blocks.length ? [{ ...item, turn: { ...item.turn, blocks } }] : [];
  });
}
/**
 * The thread page shows a turn's closing words once: when the last block of the agent turn right before a report card is
 * text that reads the same as the report's summary (both trimmed), the card carries it and the text is left out; a turn
 * left without blocks is dropped. Any other text, a prompt, or text followed by another block stays. Run it after
 * `withoutReportCalls`, so a report call removed there no longer sits between the text and its card.
 */
export function withoutEchoedSummaries(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.flatMap((item, index): TranscriptItem[] => {
    const next = items[index + 1];
    if (item.kind !== 'turn' || item.turn.role !== 'assistant' || next?.kind !== 'report') return [item];
    const last = item.turn.blocks.at(-1);
    if (last?.type !== 'text' || last.text.trim() !== next.report.summary.trim()) return [item];
    const blocks = item.turn.blocks.slice(0, -1);
    return blocks.length ? [{ ...item, turn: { ...item.turn, blocks } }] : [];
  });
}



/** Index proposal groups once for a live view, so a long chat never rescans its history for every card. */
export function chatProposalGroups(items: readonly ChatItem[], tasks: readonly Pick<import('@jevellan/core/client').ProjectWorkTask, 'id' | 'state'>[]): Map<number, string[]> {
  const groups = new Map<number, { last: number; ids: Set<string> }>(), drafts = new Set(tasks.filter(task => task.state === 'draft').map(task => task.id));
  for (const item of items) if (item.kind === 'routed' && item.turn) {
    const group = groups.get(item.turn) ?? { last: item.id, ids: new Set<string>() };
    group.last = item.id; for (const id of item.taskIds ?? []) group.ids.add(id); groups.set(item.turn, group);
  }
  return new Map([...groups.values()].filter(group => group.ids.size >= 2).map(group => [group.last, [...group.ids].filter(id => drafts.has(id))]));
}
/** Keep Start all available for the remaining proposal after Start was used on its sibling. */
export function chatProposalIds(items: readonly ChatItem[], item: ChatItem, tasks: readonly Pick<import('@jevellan/core/client').ProjectWorkTask, 'id' | 'state'>[]): string[] {
  return chatProposalGroups(items, tasks).get(item.id) ?? [];
}
