import type { ThreadState } from './project-schemas.js';
import type { Stored } from './store.js';

// Pure rules shared by the hub, the owner device and the browser.

/** Reservation overlap (brief 5.11): equal, or one is a directory prefix ending in '/' that the other starts with. No globbing. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
}

export const liveWorkStates = ['preparing', 'running', 'publishing'] as const satisfies readonly ThreadState[];
export const concludedStates = ['done', 'stopped', 'failed'] as const satisfies readonly ThreadState[];
/** States with an agent process or a git step in flight: the only ones counted against running limits (D9). */
export function liveWork(state: ThreadState): boolean { return (liveWorkStates as readonly ThreadState[]).includes(state); }
export function isTerminal(state: ThreadState): boolean { return (concludedStates as readonly ThreadState[]).includes(state); }
/** The UI Running section: every thread that is neither concluded nor in review (display only, not the limit count). */
export function runningSection(state: ThreadState): boolean { return !isTerminal(state) && state !== 'in-review'; }
/** Concluded threads stay listed for 14 days after they end (brief 7.1 `include: 'all'`, 12.2 Concluded). */
export const CONCLUDED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** A concluded thread that ended (by `endedAt`, else its last update) within the last 14 days. */
export function concludedRecently(thread: { state: ThreadState; endedAt?: string | undefined; updatedAt: string }, now: number): boolean {
  return isTerminal(thread.state) && now - Date.parse(thread.endedAt ?? thread.updatedAt) <= CONCLUDED_WINDOW_MS;
}

// Texts both the owner device writes and the browser reads back (D214): one source, re-exported by the projects copy module.
/** The `done` reason of a thread that concluded without commits (brief 8.4); the interface shows it as `No changes`. */
export const NO_CHANGES = 'Concluded without changes.';
/** Preformatted `thread-user-message` texts (brief 9.5, phase 7 detach; D35) start with these. */
export const OWNER_STARTED_PREFIX = '[owner started thread "';
export const OWNER_WORKED_PREFIX = '[owner worked on thread "';
/** A restarted thread's reason reads `Restarted as {newId}.` (brief 10); the interface links the new thread. */
export const RESTARTED_PREFIX = 'Restarted as ';

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

/** D3: a hub document's embedded revision equals its row revision. Adapters set it just before a compare-and-swap put. */
export function withHubRevision<T extends { revision: number }>(document: T, expectedRevision: number): T {
  return { ...document, revision: expectedRevision + 1 };
}
/** D3: refuse a stored row whose document revision disagrees with the row. */
export function checkHubRevision<T extends { revision: number }>(stored: Stored<T>): Stored<T> {
  if (stored.document.revision !== stored.revision) throw new Error('A project record does not match its hub revision.');
  return stored;
}
