import { joinToolTurns } from './transcript-groups.js';
import {
  EffortSchema,
  IdSchema,
  NO_CHANGES,
  MANUAL_CHECKOUT_COMPLETED,
  OWNER_STARTED_PREFIX,
  OWNER_STOPPED_THREAD,
  OWNER_WORKED_PREFIX,
  PlacementFieldSchema,
  ProjectLedgerDataSchemas,
  RESTARTED_PREFIX,
  concludedRecently,
  idTime,
  isTerminal,
  liveWork,
  runningSection,
  splitSavedCommits,
  type CoordinatorEvent,
  type CoordinatorView,
  type CursorTurn,
  type Effort,
  type Isolation,
  type PlacementField,
  type PlacementRecord,
  type ProjectDecision,
  type ProjectLedgerData,
  type ProjectLedgerEvent,
  type ProjectLedgerEventType,
  type ProjectWorkListView,
  type ProjectWorkView,
  type PullRequestEntry,
  type PullRequestState,
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

export type ProjectRoute = { projectId: string; threadId?: string };
/** `/projects/<id>` and `/projects/<id>/threads/<tid>` with valid ids; anything else is not a Projects page. */
export function projectRoute(path: string): ProjectRoute | null {
  const parts = path.split(/[?#]/)[0]!.split('/');
  const valid = (value: string | undefined): value is string => value !== undefined && IdSchema.safeParse(value).success;
  if (parts[0] !== '' || parts[1] !== 'projects' || !valid(parts[2])) return null;
  if (parts.length === 5 && parts[3] === 'threads' && valid(parts[4])) return { projectId: parts[2], threadId: parts[4] };
  return parts.length === 3 ? { projectId: parts[2] } : null;
}

export type ProjectTab = 'chat' | 'waiting' | 'threads' | 'pull-requests';
/** The tab below 1180 px: Waiting when a question is open, else Chat. Computed once, after the first view load. */
export function defaultTab(view: Pick<ProjectWorkView, 'decisions'>): ProjectTab {
  return view.decisions.open.length ? 'waiting' : 'chat';
}

/**
 * Running lists every thread that is neither concluded nor in review (display only, D9), newest first so rows keep
 * their place while they update; Concluded lists threads that ended within 14 days, most recently ended first (D52).
 */
export function threadSections(threads: readonly ThreadIndex[], now: number): { running: ThreadIndex[]; concluded: ThreadIndex[] } {
  const newest = (a: string, b: string) => Date.parse(b) - Date.parse(a);
  return {
    running: threads.filter((thread) => runningSection(thread.state)).sort((a, b) => newest(a.createdAt, b.createdAt) || a.id.localeCompare(b.id)),
    concluded: threads.filter((thread) => concludedRecently(thread, now))
      .sort((a, b) => newest(a.endedAt ?? a.updatedAt, b.endedAt ?? b.updatedAt) || a.id.localeCompare(b.id)),
  };
}

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
export function projectDot(entry: Pick<ProjectWorkListView['projects'][number], 'waiting' | 'coordinator'>): string {
  return dotClass(entry.coordinator.state === 'running' ? 'running' : entry.waiting ? 'waiting-for-you' : 'idle');
}

/** Sidebar order: by name, so rows never move while their counts change. */
export function sidebarProjects(view: ProjectWorkListView): ProjectWorkListView['projects'] {
  return [...view.projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.projectId.localeCompare(b.projectId));
}

/** The coordinator chip (12.2); `none` (not assigned yet) reads Idle. */
export function coordinatorLabel(state: CoordinatorView['state']): string {
  return state === 'running' ? copy.COORDINATOR_WORKING_CHIP : state === 'unavailable' ? copy.COORDINATOR_UNAVAILABLE
    : state === 'offline' ? copy.COORDINATOR_OFFLINE : copy.COORDINATOR_IDLE;
}

/**
 * The header chip and its muted session line (12.2, D91): the chat stream can be ahead of the view, so `working` decides
 * the working state; the session is the current one, else the planned one. `runtime` maps a runtime id to its display name.
 */
export function coordinatorChip(view: Pick<ProjectWorkView, 'coordinator'>, events: readonly ProjectLedgerEvent[], runtime: (id: string) => string):
  { label: string; tone: 'idle' | 'running' | 'unavailable' | 'offline'; session: string | null } {
  const busy = working(events, view); const state = view.coordinator.state;
  const shown = view.coordinator.session ?? view.coordinator.planned;
  return { label: busy ? copy.COORDINATOR_WORKING_CHIP : coordinatorLabel(state),
    tone: busy ? 'running' : state === 'unavailable' || state === 'offline' ? state : 'idle',
    session: shown ? copy.coordinatorSession(runtime(shown.runtime), shown.modelLabel, shown.effort) : null };
}

/** Concluded rows: `Merged #42`, `Published to main`, `No changes`, `Stopped` or `Failed`; null while not concluded. */
export function outcomeText(thread: Pick<ThreadIndex, 'state' | 'stateReason' | 'isolation' | 'pr'>): string | null {
  switch (thread.state) {
    case 'done':
      if (thread.pr?.state === 'merged') return copy.mergedOutcome(thread.pr.number);
      // A done worktree thread without a merged pull request concluded without changes (branch-only threads rest idle, D23).
      return thread.stateReason === MANUAL_CHECKOUT_COMPLETED ? copy.CHECKOUT_COMPLETED : thread.isolation === 'main' && thread.stateReason !== NO_CHANGES ? copy.PUBLISHED_TO_MAIN : copy.NO_CHANGES_OUTCOME;
    case 'stopped': return copy.STOPPED;
    case 'failed': return copy.FAILED;
    default: return null;
  }
}

export type BadgeTone = 'ok' | 'danger' | 'warn' | 'muted' | 'jev';
const CHECKS = {
  passing: { text: copy.CHECKS_PASSING, tone: 'ok' }, failing: { text: copy.CHECKS_FAILING, tone: 'danger' },
  pending: { text: copy.CHECKS_RUNNING, tone: 'warn' }, none: { text: copy.NO_CHECKS, tone: 'muted' },
} as const satisfies Record<PullRequestState['checks'], { text: string; tone: BadgeTone }>;
export function checksBadge(pr: Pick<PullRequestState, 'checks'>): { text: string; tone: BadgeTone } {
  return CHECKS[pr.checks];
}
/** Why Merge is disabled (its tooltip): conflicts, else failing checks; pending checks still allow a merge (D75). */
export function mergeBlock(pr: Pick<PullRequestState, 'checks' | 'mergeable'>): string | null {
  return pr.mergeable === 'conflict' ? copy.MERGE_BLOCKED_CONFLICTS : pr.checks === 'failing' ? copy.MERGE_BLOCKED_CHECKS : null;
}

/**
 * The Pull requests section: open pull requests and branch-only threads with their reason (D58). Merged and closed pull
 * requests belong to Concluded, so they leave this list (D222).
 */
export function openPullRequests(entries: readonly PullRequestEntry[]): PullRequestEntry[] {
  return entries.filter((entry) => entry.pr ? entry.pr.state === 'open' : entry.reason !== undefined);
}

/** Why Main cannot be chosen here, or null: the Leave git text wins over the phase text (D88, D221). */
export function mainIsolationBlock(view: Pick<ProjectWorkView, 'project' | 'gates'>): string | null {
  return view.gates.mainIsolation ? null : copy.MAIN_NOT_AVAILABLE;
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

export type ThreadForm = { title: string; task: string; isolation: '' | Isolation; modelId: string; effort: '' | Effort; deviceId: string };
/** `POST /api/projects/:id/threads`: fields left on Automatic are omitted, so placement decides them. */
export function threadCreateRequest(clientRequestId: string, form: ThreadForm) {
  return { schema: 'thread-create-request-v1' as const, clientRequestId, title: form.title.trim(), task: form.task.trim(),
    ...(form.isolation ? { isolation: form.isolation } : {}), ...(form.modelId ? { modelId: form.modelId } : {}),
    ...(form.effort ? { effort: form.effort } : {}), ...(form.deviceId ? { deviceId: form.deviceId } : {}) };
}

export type SettingsForm = { defaultIsolation: Isolation; isolationChanged: boolean; modelId: string; effort: Effort; setupCommand: string;
  maxRunningThreads: number; maxRunningPerDevice: number; threadTurnCap: number };
/**
 * `PUT /api/projects/:id/work-settings`. Reads show a stored `main` default as worktree with a notice (D205); unless the
 * owner picked an isolation, a save keeps the stored `main` instead of silently replacing it (D223).
 */
export function settingsRequest(view: Pick<ProjectWorkView, 'settings' | 'settingsNotice'>, form: SettingsForm) {
  const keptMain = !form.isolationChanged && view.settingsNotice !== undefined;
  return { schema: 'project-work-settings-request-v1' as const, revision: view.settings.revision, settings: {
    defaultIsolation: keptMain ? 'main' as const : form.defaultIsolation,
    coordinator: { modelId: form.modelId || null, effort: form.effort }, setupCommand: form.setupCommand.trim() || null,
    maxRunningThreads: form.maxRunningThreads, maxRunningPerDevice: form.maxRunningPerDevice, threadTurnCap: form.threadTurnCap } };
}

/** The decision card's source line: the coordinator's own questions, or the thread a fallback question came from. */
export function decisionSource(decision: Pick<ProjectDecision, 'from' | 'threadId'>, titles: ThreadTitles): string {
  const title = decision.from === 'thread' && decision.threadId ? titles(decision.threadId) : undefined;
  return decision.from === 'thread' ? copy.fromThread(title ?? copy.UNKNOWN_THREAD_NAME) : copy.FROM_COORDINATOR;
}
/** After answering: the coordinator's questions go to it; a thread's own question goes back to that thread (D224). */
export function sentText(decision: Pick<ProjectDecision, 'from' | 'threadId'>, titles: ThreadTitles): string {
  if (decision.from === 'coordinator') return copy.SENT_TO_COORDINATOR;
  const title = decision.threadId ? titles(decision.threadId) : undefined;
  return title ? copy.sentToThread(title) : copy.SENT_TO_THREAD;
}
/**
 * The section's sent line stays until a question arrives that was not open when the answer was sent (`known`), so it
 * never sits above a question it does not describe; no clock is compared.
 */
export function showSent(sent: { known: readonly string[] } | undefined, open: readonly Pick<ProjectDecision, 'id'>[]): boolean {
  return !!sent && open.every((decision) => sent.known.includes(decision.id));
}

const TOOL_ICONS: Record<string, IconName> = {
  jevellan_threads_list: 'thread', jevellan_thread_start: 'plus', jevellan_thread_message: 'message', jevellan_thread_read: 'search',
  jevellan_thread_stop: 'stop', jevellan_ask_user: 'why', jevellan_withdraw_question: 'close', jevellan_notebook_read: 'file',
  jevellan_notebook_write: 'file', jevellan_pr_status: 'pull-request', jevellan_mail_send: 'message', memory_search: 'search', memory_read: 'file',
};
/** The icon of a chat one-liner, by tool. */
export function toolIcon(tool: string): IconName {
  return TOOL_ICONS[tool] ?? 'tune';
}

const isolationText = (thread: Pick<ThreadIndex, 'isolation' | 'branch'>, branch: boolean) =>
  thread.isolation === 'main' ? copy.MAIN : branch && thread.branch ? copy.worktreeOn(thread.branch) : copy.WORKTREE;
/** Thread row meta (12.2). `runtime` is the runtime's display name (D83), `device` the owner device's name. */
export function threadMeta(thread: ThreadIndex, runtime: string, device: string): string {
  return copy.threadMetaText({ runtime, modelLabel: thread.modelLabel, effort: thread.effort, isolation: isolationText(thread, false), device });
}
/** The thread page placement line (12.3); a worktree thread without a branch yet reads `Worktree`. */
export function placementLine(thread: ThreadIndex, view: Pick<ThreadView, 'deviceName'>, runtime: string = thread.runtime): string {
  return copy.placementLineText({ runtime, modelLabel: thread.modelLabel, effort: thread.effort, accountLabel: thread.accountLabel,
    isolation: isolationText(thread, true), device: view.deviceName });
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
/** The thread header's pull request badges: checks and conflicts while open, else merged or closed. */
export function pullRequestBadges(pr: Pick<PullRequestState, 'state' | 'checks' | 'mergeable'>): Array<{ text: string; tone: BadgeTone }> {
  if (pr.state === 'merged') return [{ text: copy.PR_MERGED, tone: 'ok' }];
  if (pr.state === 'closed') return [{ text: copy.PR_CLOSED, tone: 'muted' }];
  return [checksBadge(pr), ...(pr.mergeable === 'conflict' ? [{ text: copy.CONFLICTS, tone: 'danger' as const }] : [])];
}

// ---------- placement: the fallback chip, Why and Override (12.3, 9.8; D255) ----------
/** The 9.8 chip of a thread placed without Jev, with the recorded reason, or null. */
export function fallbackChip(placement: Pick<PlacementRecord, 'source' | 'error'>): string | null {
  return placement.source === 'fallback' && placement.error ? copy.placedWithoutJev(placement.error.message) : null;
}
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
/** Override is offered while either choice is: the next turn of a thread that has not ended, or a restart the server allows. */
export function overrideOffered(view: Pick<ThreadView, 'canOverride'>): boolean {
  return view.canOverride.nextTurn || view.canOverride.restart;
}

const EFFORTS = EffortSchema.options;
/** The effort a model runs for a requested one: its lowest effort at or above it, else its highest (core `mapEffort`, which is not browser-safe). */
export function nearestEffort(requested: Effort, supported: readonly Effort[]): Effort {
  const offered = [...new Set(supported)].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  return offered.find((effort) => EFFORTS.indexOf(effort) >= EFFORTS.indexOf(requested)) ?? offered.at(-1) ?? requested;
}
/**
 * The Override modal's effort options: the chosen model's efforts plus the thread's requested effort, so a modal left alone
 * changes no effort; an effort the model does not offer says what it runs as. Without a chosen model (Automatic), every effort.
 */
export function effortChoices(supported: readonly Effort[] | undefined, requested: Effort): Array<{ effort: Effort; runsAs?: Effort }> {
  if (!supported) return EFFORTS.map((effort) => ({ effort }));
  return EFFORTS.filter((effort) => supported.includes(effort) || effort === requested)
    .map((effort) => supported.includes(effort) ? { effort } : { effort, runsAs: nearestEffort(effort, supported) });
}

export type OverrideMode = 'next-turn' | 'restart';
export type OverrideForm = { mode: OverrideMode; isolation: '' | Isolation; modelId: string; effort: '' | Effort; deviceId: string; note: string };
/** The modal opens on the thread's current choices (the requested effort), on From the next turn while the thread takes turns. */
export function overrideForm(view: Pick<ThreadView, 'thread' | 'placement' | 'canOverride'>): OverrideForm {
  return { mode: view.canOverride.nextTurn ? 'next-turn' : 'restart', isolation: view.thread.isolation, modelId: view.placement.modelId,
    effort: view.placement.effortRequested, deviceId: view.thread.ownerDeviceId, note: '' };
}
/**
 * `POST .../override` without its client id. From the next turn sends only the model and effort that differ from the thread's (the
 * server records only changes, effort against the requested one); a restart sends every field not left on Automatic, so the new
 * thread keeps what the modal shows (D255).
 */
export function overrideRequest(view: Pick<ThreadView, 'placement'>, form: OverrideForm) {
  const note = form.note.trim();
  const base = { schema: 'thread-override-request-v1' as const, mode: form.mode, ...(note ? { note: note.slice(0, 400) } : {}) };
  if (form.mode === 'next-turn') {
    return { ...base, ...(form.modelId && form.modelId !== view.placement.modelId ? { modelId: form.modelId } : {}),
      ...(form.effort && form.effort !== view.placement.effortRequested ? { effort: form.effort } : {}) };
  }
  return { ...base, ...(form.isolation ? { isolation: form.isolation } : {}), ...(form.modelId ? { modelId: form.modelId } : {}),
    ...(form.effort ? { effort: form.effort } : {}), ...(form.deviceId ? { deviceId: form.deviceId } : {}) };
}
/** Apply needs something to do: From the next turn changes the model or the effort; a restart is allowed by the server. */
export function overrideReady(view: Pick<ThreadView, 'placement' | 'canOverride'>, form: OverrideForm): boolean {
  if (form.mode === 'restart') return view.canOverride.restart;
  const request = overrideRequest(view, form);
  return view.canOverride.nextTurn && ('modelId' in request || 'effort' in request);
}

/** The p-v1 question Jev answers for each placement field (brief 10). */
export const PLACEMENT_QUESTIONS = { isolation: 'isolation', model: 'pick_model', effort: 'effort', device: 'device' } as const satisfies Record<PlacementField, string>;
export type FieldSource = keyof typeof copy.FIELD_SOURCES;
export type WhyField = { field: PlacementField; value: string; source: FieldSource; bars: Array<{ option: string; p: number; chosen: boolean }> };
const fieldValue = (placement: PlacementRecord, field: PlacementField): string =>
  field === 'isolation' ? placement.isolation : field === 'model' ? placement.modelId : field === 'effort' ? placement.effortRequested : placement.deviceId;
/**
 * The Why panel, field by field (12.3, D255): Jev's distribution for each question it answered, highest first, with the value the
 * thread holds now marked. A value that is not Jev's top option was changed by the owner from the next turn (the record keeps
 * Jev's probabilities, D252). Fields Jev was not asked were fixed, the only option left, or the fallback rule's.
 */
export function whyFields(placement: PlacementRecord): WhyField[] {
  return PlacementFieldSchema.options.map((field) => {
    const value = fieldValue(placement, field);
    const answered = placement.probabilities?.[PLACEMENT_QUESTIONS[field]];
    const bars = Object.entries(answered ?? {}).sort((a, b) => b[1] - a[1]).map(([option, p]) => ({ option, p, chosen: option === value }));
    const top = Math.max(...bars.map((bar) => bar.p));
    const source: FieldSource = placement.fixed.includes(field) ? 'fixed'
      : answered ? (answered[value] ?? -1) < top ? 'changed' : 'jev'
      : placement.source === 'fallback' ? 'fallback' : 'only';
    return { field, value, source, bars };
  });
}

function payload<T extends ProjectLedgerEventType>(event: ProjectLedgerEvent, type: T): ProjectLedgerData<T> | undefined {
  if (event.type !== type) return undefined;
  const parsed = ProjectLedgerDataSchemas[type].safeParse(event.data);
  return parsed.success ? parsed.data as ProjectLedgerData<T> : undefined;
}

export type ChatItem =
  | { kind: 'owner'; id: number; text: string; at: string; delivered: boolean }
  | { kind: 'reply'; id: number; text: string }
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
    case 'thread-report': {
      const status = { progress: text.reportProgress, done: text.reportDone, 'needs-decision': text.reportDecision, blocked: text.reportBlocked }[event.report.status];
      return card(status(name(event.threadId)), event.threadId, event.report.summary);
    }
    case 'thread-published': {
      const n = name(event.threadId);
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
  return ordered.flatMap((event): ChatItem[] => {
    const id = event.id;
    switch (event.type) {
      case 'coordinator-text': { const data = payload(event, 'coordinator-text'); return data ? [{ kind: 'reply', id, text: data.text }] : []; }
      case 'coordinator-tool': {
        const data = payload(event, 'coordinator-tool');
        return data ? [{ kind: 'tool', id, tool: data.tool, summary: data.summary, ok: data.ok, ...(data.threadId ? { threadId: data.threadId } : {}) }] : [];
      }
      case 'notice': { const data = payload(event, 'notice'); return data ? [{ kind: 'notice', id, text: data.text, tone: data.kind }] : []; }
      case 'coordinator-event': {
        const data = payload(event, 'coordinator-event');
        if (!data) return [];
        if (data.kind === 'user-message') return [{ kind: 'owner', id, text: data.text, at: data.at, delivered: delivered.has(data.id) }];
        return [{ kind: 'event', id, ...eventCard(data, titles), delivered: delivered.has(data.id) }];
      }
      default: return [];
    }
  });
}

/**
 * The `Coordinator is working…` line: the view says running, or (while the view is idle or not assigned yet) the latest
 * coordinator turn started without ending. An unavailable or offline coordinator never shows it.
 */
export function working(events: readonly ProjectLedgerEvent[], view: Pick<ProjectWorkView, 'coordinator'>): boolean {
  const state = view.coordinator.state;
  if (state === 'running') return true;
  if (state === 'unavailable' || state === 'offline') return false;
  let open: number | undefined;
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const started = payload(event, 'coordinator-turn-start'); if (started) open = started.turn;
    const ended = payload(event, 'coordinator-turn-end'); if (ended && ended.turn === open) open = undefined;
  }
  return open !== undefined;
}

export type TranscriptItem = { kind: 'turn'; turn: CursorTurn } | { kind: 'report'; report: ThreadReport };

export function mergeThreadToolTurns(items: readonly TranscriptItem[]): TranscriptItem[] {
  const result: TranscriptItem[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    const joined = item.kind === 'turn' && previous?.kind === 'turn' ? joinToolTurns(previous.turn, item.turn) : undefined;
    if (joined) result[result.length - 1] = { kind: 'turn', turn: joined }; else result.push(item);
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
export function alignReports(turns: readonly CursorTurn[], reports: readonly ThreadReport[], latest?: number): TranscriptItem[] {
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
  segments.forEach((segment, index) => { for (const turn of segment) items.push({ kind: 'turn', turn }); reportsUpTo(first + index); });
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
    return blocks.length ? [{ kind: 'turn', turn: { ...item.turn, blocks } }] : [];
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
    return blocks.length ? [{ kind: 'turn', turn: { ...item.turn, blocks } }] : [];
  });
}

/**
 * Questions the coordinator withdrew (D84, D200): successful `jevellan_withdraw_question` calls that carry the reason.
 * Events at or below `after` (the view's `lastEventId` when the page opened) and ids already in `seen` are history, so a
 * replayed stream never toasts again; the caller adds the returned ledger ids to `seen`.
 */
export function withdrawals(events: readonly ProjectLedgerEvent[], seen: ReadonlySet<number>, after = 0): Array<{ id: number; decisionId: string; reason: string }> {
  return events.flatMap((event) => {
    if (event.id <= after || seen.has(event.id)) return [];
    const data = payload(event, 'coordinator-tool');
    return data?.tool === 'jevellan_withdraw_question' && data.ok && data.decisionId && data.reason
      ? [{ id: event.id, decisionId: data.decisionId, reason: data.reason }] : [];
  });
}
