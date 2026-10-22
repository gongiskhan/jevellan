import {
  IdSchema,
  runningSection,
  type ProjectWorkListView,
  type ThreadIndex,
  type ThreadState,
} from '@jevellan/core/client';
import type { IconName } from './icons.js';

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

export { mainIsolationBlock, deviceBlock, deviceChoices, type DeviceChoice } from '@jevellan/core/client';

export { threadCreateRequest, type ThreadForm } from '@jevellan/core/client';

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

export {chatItems,chatProposalGroups,chatProposalIds,type ChatItem,type ThreadTitles} from '@jevellan/core/client';
