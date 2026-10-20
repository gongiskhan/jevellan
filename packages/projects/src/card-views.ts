import { MANUAL_CHECKOUT_COMPLETED, NO_CHANGES, ProjectThreadActionsViewSchema, ProjectWorkCardSchema, boardGroup,
  type MergeConfirmationSchema, type ProjectThreadActionsView, type ProjectWorkCard, type ProjectWorkTask, type PullRequestEntry,
  type PullRequestState, type ThreadActionItem, type ThreadIndex, type ThreadView } from '@jevellan/core';
import type { z } from 'zod';

const boardLabels = { waiting: 'Waiting for you', review: 'Ready for review', working: 'Working', landing: 'Landing', landed: 'Landed, waiting for deploy', idle: 'Idle', resolved: 'Resolved' } as const;
const stateLabels = { queued: 'Queued', preparing: 'Preparing', running: 'Running', idle: 'Idle', publishing: 'Publishing', 'in-review': 'In review',
  'waiting-for-you': 'Waiting for you', attached: 'Attached', done: 'Done', stopped: 'Stopped', failed: 'Failed' } as const;
const landingLabels = { verifying: 'Verifying', merging: 'Merging', held: 'Held for the nightly window' } as const;
const checks = { passing: { text: 'Checks passing', tone: 'ok' }, failing: { text: 'Checks failing', tone: 'danger' },
  pending: { text: 'Checks running', tone: 'warn' }, none: { text: 'No checks', tone: 'muted' } } as const;
const cardChecks = { passing: 'Checks pass', failing: 'Checks fail', pending: 'Checks pending', none: 'No checks' } as const;
export const mergeHeld = 'Merges are held while the nightly window runs.';
export function checksBadge(pr: Pick<PullRequestState, 'checks'>) { return checks[pr.checks]; }
export function mergeBlock(pr: Pick<PullRequestState, 'checks' | 'mergeable'>): string | null {
  return pr.mergeable === 'conflict' ? 'This pull request has conflicts. Ask the thread to resolve them first.' : pr.checks === 'failing' ? 'Checks are failing. Ask the thread to fix them first.' : null;
}
export function openPullRequests(entries: readonly PullRequestEntry[]): PullRequestEntry[] { return entries.filter(entry => entry.pr ? entry.pr.state === 'open' : entry.reason !== undefined); }
export function pullRequestBadges(pr: Pick<PullRequestState, 'state' | 'checks' | 'mergeable'>) {
  if (pr.state === 'merged') return [{ text: 'Merged', tone: 'ok' as const }];
  if (pr.state === 'closed') return [{ text: 'Closed', tone: 'muted' as const }];
  return [checksBadge(pr), ...(pr.mergeable === 'conflict' ? [{ text: 'Conflicts', tone: 'danger' as const }] : [])];
}
export function outcomeText(thread: Pick<ThreadIndex, 'state' | 'stateReason' | 'isolation' | 'pr'>): string | null {
  if (thread.state === 'done') {
    if (thread.pr?.state === 'merged') return `Merged #${thread.pr.number}`;
    return thread.stateReason === MANUAL_CHECKOUT_COMPLETED ? 'Completed' : thread.isolation === 'main' && thread.stateReason !== NO_CHANGES ? 'Published to main' : 'No changes';
  }
  return thread.state === 'stopped' ? 'Stopped' : thread.state === 'failed' ? 'Failed' : null;
}
const isolationText = (thread: Pick<ThreadIndex, 'isolation' | 'branch'>, branch: boolean) => thread.isolation === 'main' ? 'Main' : branch && thread.branch ? `Worktree on ${thread.branch}` : 'Worktree';
export function threadMeta(thread: ThreadIndex, runtime: string, device: string): string { return `${runtime} · ${thread.modelLabel} · ${thread.effort} · ${isolationText(thread, false)} · ${device}`; }
export function placementLine(thread: ThreadIndex, view: Pick<ThreadView, 'deviceName'>, runtime = thread.runtime): string {
  return `${runtime} · ${thread.modelLabel} · ${thread.effort} effort · ${thread.accountLabel} · ${isolationText(thread, true)} · ${view.deviceName}`;
}
export function mergeConfirmation(title: string, number: number, baseBranch: string | null): z.infer<typeof MergeConfirmationSchema> {
  return { title: `Squash and merge #${number}?`, actionLabel: 'Merge', body: `${title} will be squashed into ${baseBranch ?? 'its base branch'}. The thread's worktree is removed afterwards.` };
}

/** Presentation eligibility; the existing mutation services independently enforce every guard at execution. */
export function threadActionView(thread: ThreadIndex, held: boolean, baseBranch: string | null): ProjectThreadActionsView {
  const items: ThreadActionItem[] = [], pr = thread.pr, open = pr?.state === 'open';
  const resting = !['queued', 'preparing', 'running', 'publishing', 'attached'].includes(thread.state);
  const block = held ? mergeHeld : pr ? mergeBlock(pr) : null;
  const base = { enabled: true, refusal: null, secondary: true, help: null };
  const confirmation = pr ? mergeConfirmation(thread.title, pr.number, baseBranch) : null;
  if (resting && thread.fixable?.checks) items.push({ ...base, kind: 'mutation', id: 'fix-checks', label: 'Fix checks', confirmation: null });
  if (resting && thread.fixable?.conflicts) items.push({ ...base, kind: 'mutation', id: 'resolve-conflicts', label: 'Resolve conflicts', confirmation: null });
  if (resting && thread.fixable?.comments) items.push({ ...base, kind: 'mutation', id: 'address-comments', label: `Address comments (${thread.fixable.comments})`, confirmation: null });
  if (thread.delivery === 'land' && resting && !thread.landing && !thread.resolution) items.push({ ...base, kind: 'mutation', id: 'land-now', label: 'Land now', secondary: false, enabled: !held, confirmation: null });
  if (open && thread.delivery === 'pull-request') items.push({ ...base, kind: 'mutation', id: 'land-instead', label: 'Land instead', enabled: resting && !held, confirmation: null });
  if (open) items.push({ ...base, kind: 'merge', id: 'merge', label: 'Merge', secondary: false, enabled: resting && !block, refusal: block, confirmation: confirmation! });
  if (pr) items.push({ ...base, kind: 'link', id: 'open-pr', label: 'Open on GitHub', href: pr.url });
  if (thread.fixable?.publish) items.push({ ...base, kind: 'mutation', id: 'publish', label: 'Publish', help: 'Run the tests, push the branch and open a pull request.', confirmation: null });
  if (!open && ['idle', 'waiting-for-you', 'failed'].includes(thread.state) && !thread.resolution) items.push({ ...base, kind: 'mutation', id: 'resolve', label: 'Resolve',
    confirmation: thread.fixable?.publish ? { title: 'Resolve', actionLabel: 'Resolve', body: 'This thread has commits that are not in a pull request. Resolve it anyway? The branch and worktree stay.' } : null });
  if (thread.resolution && ['idle', 'failed'].includes(thread.state)) items.push({ ...base, kind: 'mutation', id: 'reopen', label: 'Reopen', confirmation: null });
  return ProjectThreadActionsViewSchema.parse({ schema: 'project-thread-actions-view-v1', projectId: thread.projectId, threadId: thread.id, items, mergeConfirmation: confirmation });
}

export type CardPresentationOptions = { deviceName?(id: string): string; runtimeName?(id: string): string; held?: boolean; baseBranch?: string | null };
export function threadCardView(thread: ThreadIndex, options: CardPresentationOptions = {}): ProjectWorkCard {
  const device = options.deviceName?.(thread.ownerDeviceId) ?? thread.ownerDeviceId, runtime = options.runtimeName?.(thread.runtime) ?? thread.runtime;
  const group = boardGroup(thread), landingLabel = thread.landing ? `Landed as ${thread.landing.commit.slice(0, 7)}` : null;
  const chips: ProjectWorkCard['chips'] = [];
  if (thread.state === 'attached') chips.push({ text: 'In a terminal', tone: 'plain' });
  if (thread.landingStage) chips.push({ text: landingLabels[thread.landingStage], tone: 'plain' });
  if (landingLabel) chips.push({ text: landingLabel, tone: 'ok' });
  return ProjectWorkCardSchema.parse({ schema: 'project-work-card-v1', id: thread.id, kind: 'thread', title: thread.title, href: `/projects/${thread.projectId}/threads/${thread.id}`,
    group, label: boardLabels[group], meta: `${thread.modelLabel} · ${thread.effort} · ${thread.accountLabel} · ${device}`,
    stateLabel: thread.resolution ? boardLabels.resolved : stateLabels[thread.state], outcome: outcomeText(thread), threadMeta: threadMeta(thread, runtime, device), placementLine: placementLine(thread, { deviceName: device }, runtime),
    chips, headerBadges: thread.pr ? pullRequestBadges(thread.pr) : [], landingLabel, showLandingWhy: thread.delivery === 'land',
    pr: thread.pr ? { number: thread.pr.number, url: thread.pr.url, checks: { text: cardChecks[thread.pr.checks], tone: thread.pr.checks === 'passing' ? 'ok' : thread.pr.checks === 'failing' ? 'danger' : 'muted' }, conflicts: thread.pr.mergeable === 'conflict' } : null,
    mergedOutcome: thread.pr?.state === 'merged' ? `Merged #${thread.pr.number}` : null,
    threadActions: threadActionView(thread, options.held ?? thread.landingStage === 'held', options.baseBranch ?? null), taskStart: null, taskDismiss: null });
}
export function taskCardView(task: ProjectWorkTask, position?: number): ProjectWorkCard {
  const draft = task.state === 'draft', start = draft ? { path: `/api/projects/${task.projectId}/tasks/${task.id}/action`, body: { schema: 'task-action-request-v1' as const, expectedRevision: task.revision, action: 'approve' as const } }
    : task.held ? { path: `/api/projects/${task.projectId}/tasks/${task.id}/edit`, body: { schema: 'task-update-request-v1' as const, expectedRevision: task.revision, held: false as const } } : null;
  return ProjectWorkCardSchema.parse({ schema: 'project-work-card-v1', id: task.id, kind: 'task', title: task.title, href: `/projects/${task.projectId}/tasks/${task.id}`,
    group: null, label: draft ? 'Proposed' : task.held ? 'Held' : 'Queued', meta: task.state === 'queued' && position ? `#${position} in queue` : null,
    stateLabel: null, outcome: null, threadMeta: null, placementLine: null, chips: [], headerBadges: [], landingLabel: null, showLandingWhy: false, pr: null, mergedOutcome: null, threadActions: null, taskStart: start,
    taskDismiss: draft ? { path: `/api/projects/${task.projectId}/tasks/${task.id}/action`, body: { schema: 'task-action-request-v1', expectedRevision: task.revision, action: 'reject', reason: 'Dismissed from the chat.' } } : null });
}
