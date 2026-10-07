import type { DeviceView } from './mesh-schemas.js';
import type { FileReservation, ProjectCoordinatorStatus, ProjectDecision, ProjectMail, ThreadIndex, ThreadState } from './project-schemas.js';
import type { Stored } from './store.js';

// Pure rules shared by the hub, the owner device and the browser.

/** Reservation overlap (brief 5.11): equal, or one is a directory prefix ending in '/' that the other starts with. No globbing. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
}
/** A reservation holds its paths until it is released or its time ends, by the hub clock. */
export function reservationActive(reservation: Pick<FileReservation, 'releasedAt' | 'expiresAt'>, now: number): boolean {
  return !reservation.releasedAt && Date.parse(reservation.expiresAt) > now;
}
/**
 * Whether mail reaches a thread (brief 5.11, 7.2; D286): it is addressed to the thread, or to all and the thread is a main thread
 * other than the sender that existed when the mail was sent (by the hub's time on the mail), so a later thread never inherits old broadcasts.
 */
export function mailReaches(mail: Pick<ProjectMail, 'from' | 'to' | 'at'>, thread: Pick<ThreadIndex, 'id' | 'isolation' | 'createdAt'>): boolean {
  if (mail.from === thread.id) return false;
  return mail.to === thread.id || (mail.to === 'all' && thread.isolation === 'main' && Date.parse(thread.createdAt) <= Date.parse(mail.at));
}

export const liveWorkStates = ['preparing', 'running', 'publishing'] as const satisfies readonly ThreadState[];
export const concludedStates = ['done', 'stopped', 'failed'] as const satisfies readonly ThreadState[];
/** States with an agent process or a git step in flight: the only ones counted against running limits (D9). */
export function liveWork(state: ThreadState): boolean { return (liveWorkStates as readonly ThreadState[]).includes(state); }
export function isTerminal(state: ThreadState): boolean { return (concludedStates as readonly ThreadState[]).includes(state); }
/** The UI Running section: every thread that is neither concluded nor in review (display only, not the limit count). */
export function runningSection(state: ThreadState): boolean { return !isTerminal(state) && state !== 'in-review'; }
/**
 * Sidebar counts (brief 12.1, D257): open questions, threads with live work (an idle or waiting thread is never called running)
 * and threads in review. The hub computes them for the members' project list in one request (D267), the views for the hub's.
 */
export function workCounts(threads: readonly Pick<ThreadIndex, 'state'>[], decisions: readonly Pick<ProjectDecision, 'answer' | 'withdrawnAt'>[]): { waiting: number; running: number; inReview: number } {
  return { waiting: decisions.filter((decision) => !decision.answer && !decision.withdrawnAt).length, running: threads.filter((thread) => liveWork(thread.state)).length,
    inReview: threads.filter((thread) => thread.state === 'in-review').length };
}
/** Concluded threads stay listed for 14 days after they end (brief 7.1 `include: 'all'`, 12.2 Concluded). */
export const CONCLUDED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** A concluded thread that ended (by `endedAt`, else its last update) within the last 14 days. */
export function concludedRecently(thread: { state: ThreadState; endedAt?: string | undefined; updatedAt: string }, now: number): boolean {
  return isTerminal(thread.state) && now - Date.parse(thread.endedAt ?? thread.updatedAt) <= CONCLUDED_WINDOW_MS;
}

// Texts both the owner device writes and the browser reads back (D214): one source, re-exported by the projects copy module.
/** The `done` reason of a thread that concluded without commits (brief 8.4); the interface shows it as `No changes`. */
export const NO_CHANGES = 'Concluded without changes.';
export const MANUAL_CHECKOUT_COMPLETED = 'Completed in the project checkout. Git is left to you.';
/** Preformatted `thread-user-message` texts (brief 9.5, phase 7 detach; D35) start with these. */
export const OWNER_STARTED_PREFIX = '[owner started thread "';
export const OWNER_WORKED_PREFIX = '[owner worked on thread "';
/** The coordinator's `thread-interrupted` message for a thread the owner stopped; the chat shows the owner's own stop in their voice (D316). */
export const OWNER_STOPPED_THREAD = 'The owner stopped this thread.';
/** A restarted thread's reason reads `Restarted as {newId}.` (brief 10); the interface links the new thread. */
export const RESTARTED_PREFIX = 'Restarted as ';
/** A stopped main thread's reason ends `Its unpublished commits were saved at {ref}.` (D29); the interface shows the ref on its own line (D295). */
export const SAVED_COMMITS_SENTENCE = 'Its unpublished commits were saved at ';
/** A reason without its closing saved-commits sentence, and the ref that sentence names (null when the reason has none). */
export function splitSavedCommits(reason: string): { text: string; ref: string | null } {
  const at = reason.lastIndexOf(SAVED_COMMITS_SENTENCE);
  const ref = at < 0 || (at > 0 && reason[at - 1] !== ' ') ? undefined
    : /^(refs\/jevellan\/discard\/\S+\/\d+)\.$/.exec(reason.slice(at + SAVED_COMMITS_SENTENCE.length))?.[1];
  return ref ? { text: reason.slice(0, at).trimEnd(), ref } : { text: reason, ref: null };
}

/** ASCII branch slug: lowercase, non-alphanumerics collapsed to '-', trimmed, at most 40 characters, 'thread' when empty (D25). */
export function slugify(title: string): string {
  const slug = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'thread';
}
/** Worktree thread branch `jv/<slug>-<last 6 id characters, lowercased>` (D25). */
export function threadBranch(title: string, threadId: string): string {
  return `jv/${slugify(title)}-${threadId.slice(-6).toLowerCase()}`;
}

const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The creation time (ms) that `newId` encodes in the 26 characters after the prefix, or null for any other id. */
export function idTime(id: string): number | null {
  const encoded = /^[A-Za-z0-9-]+_([0-9A-HJKMNP-TV-Z]{26})$/.exec(id)?.[1]; if (!encoded) return null;
  let value = 0n; for (const character of encoded) value = (value << 5n) | BigInt(ID_ALPHABET.indexOf(character));
  return Number(value >> 80n);
}

/** Relay order (2.6.15): by source device, then project, then the source's sequence, comparing ids by code point. */
export function compareEnvelopes(a: { sourceDeviceId: string; projectId: string; seq: number }, b: { sourceDeviceId: string; projectId: string; seq: number }): number {
  const text = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
  return text(a.sourceDeviceId, b.sourceDeviceId) || text(a.projectId, b.projectId) || a.seq - b.seq;
}

/** D3: a hub document's embedded revision equals its row revision. Adapters set it just before a compare-and-swap put. */
export function withHubRevision<T extends { revision: number }>(document: T, expectedRevision: number): T {
  return { ...document, revision: expectedRevision + 1 };
}
/** D3: refuse a stored row whose document revision disagrees with the row. */
export function checkHubRevision<T extends { revision: number }>(stored: Stored<T>): Stored<T> {
  if (stored.document.revision !== stored.revision) throw new Error('A project record does not match its hub revision.');
  return stored;
}

/**
 * The roster no longer counts on a device (D80): it left the mesh, is revoked, or sent no heartbeat for 10 minutes. A stale device
 * keeps its state. The coordinator moves away from such a device whatever it published, and its project's threads ask the owner
 * directly while their coordinator lives there (decision 7, D280).
 */
export function deviceAway(row: Pick<DeviceView, 'status' | 'revoked'> | undefined): boolean {
  return !row || row.revoked || row.status === 'offline';
}
/**
 * Whether the coordinator may move away from `deviceId` (brief phase 5, D269): that device is away, or the status it published says it
 * runs no turn. A device that published nothing yet, like a status a former coordinator device left, reads as idle, as the chip shows
 * it. The work view's `canMoveHere`, the move route and the hub's assignment (in the same transaction as the move, D283) use this rule.
 */
export function coordinatorMovable(deviceId: string, row: Pick<DeviceView, 'status' | 'revoked'> | undefined,
  status: Pick<ProjectCoordinatorStatus, 'deviceId' | 'state'> | null | undefined): boolean {
  if (deviceAway(row)) return true;
  return status?.deviceId !== deviceId || status.state !== 'running';
}
/** The refusal of a move while the coordinator runs a turn on a device that is online (3.5.3); the Projects copy module re-exports it. */
export const coordinatorWorking = (deviceName: string): string => `The coordinator is working on ${deviceName}. Try again when it is idle.`;
