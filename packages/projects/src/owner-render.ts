import { ownerClock, ownerDuration, type ProjectStatusView, type RunView, type WaitingItemView } from '@jevellan/core';

/** Output limits of the owner tools (bridge specification, "Conventions for all output"). */
export const OWNER_TEXT_LIMIT = 3000;
export const OWNER_DETAIL_LIMIT = 12000;

/** Cuts text to whole lines within the limit; when cut, the last line says how many lines were left out. */
export function capLines(lines: readonly string[], detail = false): string {
  const limit = detail ? OWNER_DETAIL_LIMIT : OWNER_TEXT_LIMIT; const kept: string[] = []; let size = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!; const rest = lines.length - index; const footer = `${rest} more not shown.`;
    if (size + line.length + 1 + (index === lines.length - 1 ? 0 : footer.length + 1) > limit) {
      while (kept.length && size + footer.length + 1 > limit) { size -= kept.pop()!.length + 1; }
      return [...kept, `${lines.length - kept.length} more not shown.`].join('\n');
    }
    kept.push(line); size += line.length + 1;
  }
  return kept.join('\n');
}

const oneLine = (text: string, max = 300) => { const first = text.replace(/\s+/gu, ' ').trim(); return first.length > max ? `${first.slice(0, max - 3)}...` : first; };
export const runLabel = (run: Pick<RunView, 'label'>) => run.label.type === 'job' ? `job: ${run.label.name}` : run.label.name;
const modelEffort = (run: RunView) => [run.model, run.effort].filter(Boolean).join(' ');

export function waitingLine(item: WaitingItemView): string {
  if (item.freeText) return `${item.id} ${item.from} asks: ${oneLine(item.text)}`;
  return `${item.id} ${oneLine(item.text)} Options: ${item.options.join(', ')}`;
}

export function runningLine(run: RunView, view: Pick<ProjectStatusView, 'at'>): string {
  const since = (at: string | null | undefined) => at ? ownerDuration(new Date(view.at).getTime() - new Date(at).getTime()) : '';
  if (run.kind === 'job') return [`${run.id} ${runLabel(run)}`, run.device, since(run.startedAt)].filter(Boolean).join(' · ');
  const head = `${run.id} ${runLabel(run)} · ${run.title}`;
  if (run.state === 'landing') return `${head} · ${run.detail ?? 'landing'}`;
  if (run.state === 'held') return `${head} · ${[modelEffort(run), run.account].filter(Boolean).join(' · ')} · held by you for ${since(run.held?.since)}`;
  return [head, modelEffort(run), run.account, run.device, since(run.startedAt)].filter(Boolean).join(' · ');
}

export function queuedLine(run: RunView, index: number): string {
  return `${run.id} ${runLabel(run)} · ${run.title}${index === 0 ? ' · next' : run.priority === 'urgent' ? ' · urgent' : ''}${run.detail ? ` · ${run.detail}` : ''}`;
}

export function finishedLine(run: RunView, view: Pick<ProjectStatusView, 'at' | 'timeZone'>): string {
  const at = run.endedAt ? ownerClock(run.endedAt, view.at, view.timeZone) : '';
  if (run.kind === 'job') {
    const [conclusion, ...rest] = (run.detail ?? run.state).split(': ');
    return `${run.id} ${runLabel(run)} · ${conclusion} ${at}${rest.length ? ` · ${oneLine(rest.join(': '), 200)}` : ''}`;
  }
  const state = run.state === 'idle' ? 'finished' : run.state;
  return `${run.id} ${runLabel(run)} · ${run.title} · ${state} ${at}${run.detail && run.state !== 'deployed' ? ` (${oneLine(run.detail, 200)})` : ''}`;
}

/** The `status` tool's text (bridge specification, `status`): the fixed order, empty sections left out except waiting. */
export function renderStatus(view: ProjectStatusView, options: { section?: 'waiting' | 'running' | 'queued' | 'landed' | 'finished'; detail?: boolean } = {}): string {
  const lines: string[] = [];
  const landing = view.running.filter(run => run.state === 'landing').length;
  const runningCount = view.running.filter(run => run.state !== 'landing').length;
  if (view.goalFilter) lines.push(`${view.goalFilter.id} ${view.goalFilter.title} · ${view.goalFilter.state}${view.goalFilter.priority ? ` · priority ${view.goalFilter.priority}` : ''}`);
  else {
    const coordinator = view.coordinator.model ? `${view.coordinator.state} (${[view.coordinator.model, view.coordinator.effort].filter(Boolean).join(' ')}${view.coordinator.account ? `, ${view.coordinator.account}` : ''})` : view.coordinator.state;
    lines.push(`${view.project} · coordinator ${coordinator} · ${runningCount} running · ${landing} landing · ${view.queued.length} queued · ${view.waiting.length} waiting on you`);
    if (view.budgets.length) lines.push(`Budgets: ${view.budgets.map(budget => `${budget.label} ${budget.usedPercent === null ? '?' : Math.round(budget.usedPercent)}% of ${budget.budgetPercent}%`).join(' · ')}`);
    if (view.deploy) {
      const parts = [view.deploy.mode + (view.deploy.paused ? ' (paused)' : ''), view.deploy.undeployed ? `${view.deploy.undeployed} landed thread${view.deploy.undeployed === 1 ? '' : 's'} not deployed${view.deploy.message ? ` (${view.deploy.message})` : ''}` : 'nothing waiting to deploy'];
      if (view.deploy.health) parts.push(`health: ${view.deploy.health}`);
      lines.push(`Deploy: ${parts.join(' · ')}`);
    }
    if (view.night) lines.push(`Night: ${view.night}`);
    if (view.quietHours) lines.push(`Quiet hours: on, ${view.quietHours.start} to ${view.quietHours.end}`);
  }
  const section = (name: NonNullable<typeof options.section>) => !options.section || options.section === name;
  if (!view.goalFilter && !options.section && view.goals.length) {
    lines.push('', 'Goals');
    for (const goal of view.goals) {
      const counts = goal.state === 'paused' ? 'paused' : [goal.counts.running ? `${goal.counts.running} running` : '', goal.counts.queued ? `${goal.counts.queued} queued` : '', goal.counts.waiting ? `${goal.counts.waiting} waiting` : ''].filter(Boolean).join(', ') || 'nothing running';
      const due = goal.due.filter(entry => entry.type === 'daily_item').map(entry => entry.text.replace(/ \(not run last night\)$/u, ''));
      lines.push(`${goal.id} ${goal.title}: ${counts}${due.length ? ` · due: ${due.join(', ')}` : ''}`);
    }
  }
  if (section('waiting')) {
    lines.push('', 'Waiting on you');
    if (!view.waiting.length) lines.push('Nothing waiting on you.');
    for (const item of view.waiting) lines.push(waitingLine(item));
  }
  if (section('running') && view.running.length) { lines.push('', 'Running'); for (const run of view.running) lines.push(runningLine(run, view)); }
  if (section('queued') && view.queued.length) {
    lines.push('', 'Queued');
    const shown = options.section === 'queued' || options.detail ? view.queued : view.queued.slice(0, 8);
    shown.forEach((run, index) => lines.push(queuedLine(run, index)));
    if (shown.length < view.queued.length) lines.push(`${view.queued.length - shown.length} more queued.`);
  }
  if (section('landed') && view.landed.length) {
    lines.push('', 'Landed, not deployed');
    for (const run of view.landed) lines.push(`${run.id} ${run.title} · landed as ${run.landing!.commit} at ${ownerClock(run.landing!.at, view.at, view.timeZone)}`);
  }
  if (section('finished') && view.finished.length) {
    lines.push('', 'Finished in the last 12 hours');
    const shown = options.section === 'finished' || options.detail ? view.finished : view.finished.slice(0, 8);
    for (const run of shown) lines.push(finishedLine(run, view));
    if (shown.length < view.finished.length) lines.push(`${view.finished.length - shown.length} more finished.`);
  }
  return capLines(lines, options.detail);
}

/** The status line (bridge specification, "Status line"). */
export function renderStatusLine(view: ProjectStatusView): string {
  const main = view.budgets[0];
  return [`Jevellan ${view.project}`, `${view.running.length} running`, `${view.queued.length} queued`, `${view.waiting.length} waiting`,
    ...(main ? [`${main.label} ${main.usedPercent === null ? '?' : Math.round(main.usedPercent)}/${main.budgetPercent}%`] : [])].join(' · ');
}
