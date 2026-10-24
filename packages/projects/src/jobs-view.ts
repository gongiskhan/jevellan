import { ProjectJobsViewSchema, type ProjectDailyListViewSchema, type ProjectJob, type ProjectWorkSettings, type GoalViewSchema } from '@jevellan/core';
import type { z } from 'zod';
import { PROJECT_PAUSED } from './copy.js';

export const JOB_PAUSED = 'This job is paused. Resume it before running it.';
export function jobRunRefusal(settings: ProjectWorkSettings, job: ProjectJob): string | null {
  if (job.id === settings.deploy.jobId || job.id === settings.deploy.desktopJobId) return 'Deploy jobs run only from the owner’s deploy message.';
  if (settings.status !== 'active') return PROJECT_PAUSED;
  if (!job.enabled) return 'This job is unavailable or disabled.';
  if (job.paused) return job.pauseReason ? `This job is paused: ${job.pauseReason} Resume it before running it.` : JOB_PAUSED;
  if (job.run.kind === 'github-workflow') return 'GitHub workflow jobs retired on 19 October. Use a command job.';
  return null;
}
export function projectJobsView(raw: z.infer<typeof ProjectDailyListViewSchema>, settings: ProjectWorkSettings, goals: readonly z.infer<typeof GoalViewSchema>[]) {
  const projectId = raw.projectId, timezone = settings.nightlyWindow.timezone, window = raw.window;
  const displayDay = window?.state === 'open' ? window.closingProjectDay : raw.projectDay;
  const clock = (at: string) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
  const jobs = new Map(raw.jobs.map(job => [job.id, job]));
  const running = (jobId: string) => raw.tasks.some(task => task.jobId === jobId && ['queued', 'active'].includes(task.state));
  const jobKind = (job?: ProjectJob) => job?.run.kind === 'command' ? 'Command' : 'GitHub workflow (retired 19 October)';
  const runAction = (path: string, refusal: string | null) => ({ path, enabled: refusal === null, refusal });
  const dailies = raw.dailies.map(item => {
    const nightly = raw.tasks.filter(task => task.dailyId === item.id && window?.taskIds.includes(task.id));
    const matching = raw.tasks.filter(task => task.dailyId === item.id && task.projectDay === displayDay), tasks = nightly.length ? nightly : matching;
    const completed = tasks.find(task => task.state === 'done'), pending = tasks.find(task => ['queued', 'active'].includes(task.state)), failed = tasks.find(task => task.state === 'failed');
    const receipt = raw.runs.find(run => tasks.some(task => task.id === run.taskId)), end = (completed ?? failed)?.endedAt, time = end ? ` at ${clock(end)}` : '';
    const state = !item.enabled ? 'disabled' : completed ? 'done' : pending?.state === 'active' ? 'running' : pending ? 'queued' : failed ? 'failed' : 'not-run';
    const stateLabel = state === 'disabled' ? item.pauseReason ? `Paused: ${item.pauseReason}` : 'Disabled' : state === 'done' ? `Done today${time}` : state === 'running' ? 'Running' : state === 'queued' ? 'Queued' : state === 'failed' ? `Failed${time}` : 'Not run today';
    const target = item.target, job = target.kind === 'job' ? jobs.get(target.jobId) : undefined;
    const pendingAnywhere = raw.tasks.some(task => task.dailyId === item.id && ['queued', 'active'].includes(task.state));
    const refusal = !item.enabled ? item.pauseReason ? `This nightly item is paused: ${item.pauseReason}` : 'This daily item is unavailable or disabled.' : settings.status !== 'active' ? PROJECT_PAUSED
      : pendingAnywhere ? 'This nightly item is already queued or running.' : target.kind === 'job' ? job ? jobRunRefusal(settings, job) : 'This job is unavailable or disabled.' : null;
    return { definition: item, state, stateLabel, kindLabel: target.kind === 'memory-dream' ? 'Memory dream · before command jobs' : target.kind === 'review-since-last' ? 'Review since last' : target.kind === 'session' ? 'Thread' : jobKind(job),
      daysLabel: item.days ? item.days.map(day => day[0]!.toUpperCase() + day.slice(1)).join(', ') : null,
      goalLabel: item.goalId ? goals.find(entry => entry.goal.id === item.goalId)?.goal.name ?? 'Goal' : null,
      tonight: { taskId: (completed ?? pending ?? failed)?.id ?? null, endedAt: end ?? null },
      lastRun: receipt ? { summary: receipt.summary || 'Job running', commitLabel: receipt.commit.slice(0, 7), logTail: receipt.logTail || 'No output recorded.', href: receipt.url ?? null } : null,
      failure: failed && !receipt ? failed.endNote ?? '' : null, runNow: runAction(`/api/projects/${projectId}/dailies/${item.id}/run`, refusal),
      toggle: { path: `/api/projects/${projectId}/dailies/${item.id}/enabled`, body: { schema: 'daily-enabled-request-v1', expectedRevision: item.revision, enabled: !item.enabled } } };
  });
  const last = window?.state === 'finished' ? { windowId: window.id, text: `Last night: ${raw.tasks.filter(task => window.taskIds.includes(task.id) && task.state === 'done').length} of ${window.taskIds.length} nightly tasks passed.` } : null;
  return ProjectJobsViewSchema.parse({ schema: 'project-jobs-view-v1', projectId, timezone,
    counts: { nightly: raw.dailies.filter(item => item.enabled).length, goals: goals.filter(entry => entry.goal.state !== 'done').length },
    displayDay: { date: displayDay, label: window?.state === 'open' ? 'Closing project day' : 'Project day' },
    mergeHold: { held: raw.mergesHeld, allowedThreadIds: raw.mergeAllowedThreads, banner: raw.mergesHeld ? 'Nightly window · merges held until the nightly tasks finish' : null, notice: raw.mergesHeld ? 'Merges are held while the nightly window runs.' : null },
    banner: last, dailies, jobs: raw.jobs.map(job => ({ definition: job, kindLabel: jobKind(job), stateLabel: job.paused ? job.pauseReason ? `Paused: ${job.pauseReason}` : 'Paused' : job.enabled ? 'Enabled' : 'Disabled',
      gateLabel: job.gate ? `Gate: ${jobs.get(job.gate.jobId)?.name ?? 'Job'}` : null,
      scheduleLine: job.interval ? `Every ${job.interval.everyMinutes} minutes, ${job.interval.start} to ${job.interval.end}` : null,
      runNow: runAction(`/api/projects/${projectId}/jobs/${job.id}/run`, jobRunRefusal(settings, job) ?? (running(job.id) ? 'This job is already queued or running.' : null)),
      pause: job.run.kind === 'command' ? { path: `/api/projects/${projectId}/jobs/${job.id}/paused`, label: job.paused ? 'Resume' : 'Pause', body: { schema: 'job-paused-request-v1', expectedRevision: job.revision, paused: !job.paused } } : null })),
    lastWindowOutcome: window?.state === 'finished' ? window.outcome ?? '' : null,
    review: raw.lastReview ? { commitLabel: raw.lastReview.commit.slice(0, 7), summary: raw.lastReview.summary,
      findings: raw.lastReview.findings.map(finding => ({ what: finding.what, detail: finding.detail, filesLabel: finding.files.join(', ') })), emptyText: raw.lastReview.findings.length ? null : 'No findings.' } : null });
}
