import type { ThreadState } from './project-schemas.js';

export const THREAD_STATE_LABELS = {
  queued: 'Queued', preparing: 'Preparing', running: 'Running', idle: 'Idle', publishing: 'Publishing', 'in-review': 'In review',
  'waiting-for-you': 'Waiting for you', attached: 'Attached', done: 'Done', stopped: 'Stopped', failed: 'Failed',
} as const satisfies Record<ThreadState, string>;

/** Locale formatting stays with the caller; usage totals are supplied by the engine. */
export const formatThreadUsage = (tokens: number, cost: number) => `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)} tokens · $${cost.toFixed(2)}`;
