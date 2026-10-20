import { openPullRequests, checksBadge, mergeBlock, mergeHeld, mergeConfirmation, threadCardView, taskCardView, type CardPresentationOptions } from './card-views.js';
import { createHash } from 'node:crypto';
import { coordinatorPresentation, type CoordinatorPresentationOptions } from './coordinator-view.js';
import { ProjectPageViewSchema, stableJson, concludedRecently, runningSection, type ThreadIndex, type ProjectOverview, type ProjectPageView, type OverviewPullRequest, type PullRequestEntry } from '@jevellan/core';

const labels = { review: 'Ready for review', working: 'Working', landing: 'Landing', landed: 'Landed, waiting for deploy', idle: 'Idle', resolved: 'Resolved' } as const;
const empty = { review: 'No pull requests waiting for review.', working: 'Nothing running.', landing: 'Nothing landing.', landed: 'Nothing waiting for deploy.', idle: 'No idle threads.', resolved: 'Nothing resolved in the last 14 days.' } as const;

/** Overview decisions for every caller, independent of DOM or local browser time. */
export function projectPageView(input: Pick<ProjectPageView, 'work' | 'tasks' | 'goals' | 'daily'>, resolvedDays = 14, now = Date.now(), options: CoordinatorPresentationOptions & CardPresentationOptions = {}): ProjectPageView {
  const { work, tasks, goals, daily } = input;
  const board = work.board ?? { waiting: [], review: [], working: [], landing: [], landed: [], idle: [], resolved: [] };
  const draftIds = tasks.filter(task => task.state === 'draft').map(task => task.id);
  const waitingCount = work.decisions.open.length + draftIds.length + board.waiting.length;
  const row = (entry: PullRequestEntry): OverviewPullRequest => {
    const pr = entry.pr, held = daily.mergesHeld && !daily.mergeAllowedThreads.includes(entry.threadId);
    const taskId = tasks.find(task => task.threadId === entry.threadId)?.id, badge = pr ? checksBadge(pr) : null;
    return { entry, ...(taskId ? { taskId } : {}), shadow: !work.settings.autoLand, held, conflicts: pr?.mergeable === 'conflict', checks: badge,
      badges: !pr ? [] : pr.state === 'merged' ? [{ text: 'Merged', tone: 'ok' }] : pr.state === 'closed' ? [{ text: 'Closed', tone: 'muted' }]
        : [...(badge ? [badge] : []), ...(pr.mergeable === 'conflict' ? [{ text: 'Conflicts', tone: 'danger' as const }] : [])],
      mergeRefusal: held ? mergeHeld : pr ? mergeBlock(pr) : null,
      showMerge: pr?.state === 'open', mergeConfirmation: pr ? mergeConfirmation(entry.title, pr.number, work.project.baseBranch) : null };

  };
  const overview: ProjectOverview = {
    defaultSurface: waitingCount ? 'overview' : 'chat',
    waiting: { label: work.settings.delivery === 'land' ? 'Waiting on you' : 'Waiting for you', emptyText: 'Nothing needs you.', count: waitingCount,
      isEmpty: waitingCount === 0, draftIds, threadIds: board.waiting.map(thread => thread.id) },
    sections: (Object.keys(labels) as Array<keyof typeof labels>).map(id => ({ id, label: labels[id], emptyText: empty[id],
      visible: (id !== 'review' || work.settings.delivery === 'pull-request') && (id !== 'landed' || work.settings.delivery === 'land' || board.landed.length > 0),
      threadIds: board[id].filter(thread => id !== 'resolved' || now - Date.parse(thread.at) <= resolvedDays * 86_400_000).map(thread => thread.id), showOlder: id === 'resolved' })),
    queueCount: tasks.filter(task => ['draft', 'queued', 'active', 'in-review'].includes(task.state)).length,
    goalCount: goals.filter(entry => entry.goal.state !== 'done').length, nightlyCount: daily.dailies.filter(item => item.enabled).length,
    showPullRequestsTab: work.threads.some(thread => thread.delivery === 'pull-request'),
    pullRequests: openPullRequests(work.pullRequests).map(row),
    recentlyMerged: work.pullRequests.filter(entry => entry.pr?.state === 'merged' && Date.parse(entry.pr.updatedAt) >= now - 7 * 86_400_000).map(row),
  };
  const positions = new Map(tasks.filter(task => task.state === 'queued').map((task, index) => [task.id, index + 1]));
  const cards = [...work.threads.map(thread => threadCardView(thread, { ...options, held: daily.mergesHeld && !daily.mergeAllowedThreads.includes(thread.id), baseBranch: work.project.baseBranch })),
    ...tasks.map(task => taskCardView(task, positions.get(task.id)))];
  const body = { work, tasks, goals, daily, overview, header: coordinatorPresentation(work, { ...options, now }), cards };
  return ProjectPageViewSchema.parse({ schema: 'project-page-view-v1', at: new Date(now).toISOString(),
    changeToken: createHash('sha256').update(stableJson(body)).digest('hex'), ...body });
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

