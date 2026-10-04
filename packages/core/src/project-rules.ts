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
