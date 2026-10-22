import {healthHistoryView} from '@jevellan/core';
import {projectHealthHistory} from '../project-health-editor.js';
import { newId, ownerClock, type ProjectDaily, type ProjectJob, type ProjectJobRun } from '@jevellan/core';
import { capLines, projectJobsView } from '@jevellan/projects';
import { OwnerRefusal, type OwnerContext, type OwnerHandler } from '../owner-tools.js';
import { ownerDeployRollback, ownerRoutineSave } from '../project-work-api.js';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const dayNames: Record<string, string> = { mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays', thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays', sun: 'Sundays' };
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');

type Item = { kind: 'daily'; daily: ProjectDaily; job: ProjectJob | null } | { kind: 'job'; job: ProjectJob };
/** Everything the jobs tool reads: the night items, command jobs, runs, the window and deploys of a project. */
async function load(context: OwnerContext) {
  const engine = context.app.projectWork; const projectId = context.project.id;
  const [daily, deploy, view, goals] = await Promise.all([engine.daily.view(projectId), engine.deploys.summary(projectId), engine.view(projectId), engine.goalList(projectId)]);
  return { routines: projectJobsView(daily, view.settings, goals.goals), daily, deploy, settings: view.settings, tz: view.settings.nightlyWindow.timezone };
}
/** A job or night item by name, slug, id, J run id or the words "night"/"review". */
function find(data: Awaited<ReturnType<typeof load>>, token: string): Item {
  const wanted = token.trim().toLowerCase(); const jobs = new Map(data.daily.jobs.map(job => [job.id, job]));
  const dailies = data.daily.dailies.map(daily => ({ kind: 'daily' as const, daily, job: daily.target.kind === 'job' ? jobs.get(daily.target.jobId) ?? null : null }));
  const commands = data.daily.jobs.filter(job => !data.daily.dailies.some(daily => daily.target.kind === 'job' && daily.target.jobId === job.id)).map(job => ({ kind: 'job' as const, job }));
  const all: Item[] = [...dailies, ...commands];
  const name = (item: Item) => item.kind === 'daily' ? item.daily.name : item.job.name; const id = (item: Item) => item.kind === 'daily' ? item.daily.id : item.job.id;
  const exact = all.filter(item => id(item) === token || name(item).toLowerCase() === wanted || slug(name(item)) === slug(wanted) || (item.job && (item.job.id === token || item.job.name.toLowerCase() === wanted || slug(item.job.name) === slug(wanted))));
  if (exact.length === 1) return exact[0]!;
  const partial = all.filter(item => name(item).toLowerCase().includes(wanted) || slug(name(item)).includes(slug(wanted)));
  if (partial.length === 1) return partial[0]!;
  // Deploys are not a job: the switch between approve, nightly and automatic is a setting (bridge eval).
  const hint = exact.length + partial.length === 0 && /^deploy/u.test(wanted) ? ' To deploy, answer the deploy message waiting on you with respond. The deploy switch (approve, nightly, automatic) is a setting: config set, section deploy, key mode. Rollback is jobs rollback.' : '';
  throw new OwnerRefusal(`${exact.length + partial.length > 1 ? `"${token}" matches more than one: ` : `No job or night item matches "${token}". Known: `}${(exact.length + partial.length > 1 ? [...exact, ...partial] : all).map(name).join(', ') || 'none'}.${hint}`, 'job_not_found', 404);
}
const runLine = (context: OwnerContext, run: ProjectJobRun, name: string, tz: string, now: Date) => {
  const id = context.tools.ids.one(context.project.id, 'J', run.id);
  return `${id} ${name} ${run.conclusion ?? 'running'} ${ownerClock(run.endedAt ?? run.startedAt, now, tz)}${run.conclusion && run.commit ? ` on ${run.commit.slice(0, 7)}` : ''}${run.summary ? ` · ${run.summary.split('\n')[0]!.slice(0, 120)}` : ''}`;
};
const itemName = (item: Item) => item.kind === 'daily' ? item.daily.name : item.job.name;

/** `jobs` (bridge specification, "Jobs and nights, deploy switch, intake, goals"). */
export const jobs: OwnerHandler = async (context) => {
  const { app, tools, project, args, now } = context; const engine = app.projectWork; const projectId = project.id;
  if (context.action === 'health_view') return { text: 'Health check results.', data: await projectHealthHistory(app, projectId) };
  const data = await load(context); const { daily, settings, tz } = data;
  const nameOfRun = (run: ProjectJobRun) => daily.dailies.find(row => row.target.kind === 'job' && row.target.jobId === run.jobId)?.name ?? daily.jobs.find(job => job.id === run.jobId)?.name ?? 'job';
  const nightOrder = () => [...daily.dailies].filter(row => row.enabled).sort((a, b) => a.order - b.order).map(row => row.name);
  switch (context.action) {
    case 'editor': {
      const view = await engine.routineEditor(projectId, args.kind as 'job' | 'daily', typeof args.id === 'string' ? args.id : undefined);
      return { text: view.title, data: view };
    }
    case 'save': {
      const result = await ownerRoutineSave(app, projectId, typeof args.id === 'string' ? args.id : undefined, args.request);
      return { text: `Saved ${result.name}.`, data: result };
    }
    case 'list': {
      const lastWindow = daily.window;
      const weekly = daily.dailies.filter(row => row.days && row.days.length < 7);
      const nightly = daily.dailies.filter(row => !row.days || row.days.length === 7);
      const commands = daily.jobs.filter(job => !daily.dailies.some(row => row.target.kind === 'job' && row.target.jobId === job.id));
      const runs = [...daily.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 3);
      const missed = await tools.missedNights(projectId, 7);
      const paused = [...daily.dailies.filter(row => !row.enabled).map(row => row.name), ...daily.jobs.filter(job => job.paused).map(job => job.name)];
      const lines = [`Jobs for ${project.name} (${tz === 'Europe/Lisbon' ? 'Lisbon' : tz} time)`,
        `Night window: ${settings.nightlyWindow.enabled ? settings.nightlyWindow.time : 'off'} · order: ${nightly.filter(row => row.enabled).sort((a, b) => a.order - b.order).map(row => row.name).join(', ') || 'none'}${lastWindow ? ` · last night ${lastWindow.state === 'finished' ? `complete at ${ownerClock(lastWindow.finishedAt ?? lastWindow.openedAt, now, tz)}` : 'running'}` : ''}`,
        ...(weekly.length ? [`Weekly: ${weekly.map(row => `${row.name} (${row.days!.map(day => dayNames[day]).join(', ')}${row.enabled ? '' : ', disabled'})`).join(' · ')}`] : []),
        `Command jobs: ${commands.map(job => `${slug(job.name)}${job.run.kind === 'command' && job.run.needs.length ? ` (needs ${job.run.needs.join(', ')})` : ''}${job.interval ? ` (every ${job.interval.everyMinutes} min, ${job.interval.start} to ${job.interval.end})` : ''}`).join(' · ') || 'none'}`,
        `Last runs: ${runs.map(run => runLine(context, run, nameOfRun(run), tz, now)).join(' · ') || 'none'}`,
        `Missed in the last 7 days: ${missed.length ? missed.join('; ') : 'none'}`,
        `Paused: ${paused.join(', ') || 'none'}`];
      return { text: capLines(lines), data: data.routines };
    }
    case 'show': case 'history': {
      const item = find(data, String(args.job)); const job = item.job;
      const runs = daily.runs.filter(run => job && run.jobId === job.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, context.action === 'history' ? Number(args.limit ?? 10) : 5);
      const roster = await app.roster(); const device = (id: string) => roster.devices.find(row => row.device.id === id)?.device.name ?? id;
      if (context.action === 'history') return { text: capLines([`${itemName(item)} · last ${runs.length} runs`, ...runs.map(run => `${runLine(context, run, itemName(item), tz, now)} · ${device(run.deviceId)}`)]) };
      const definition = item.kind === 'daily' ? `night item #${item.daily.order} (${item.daily.target.kind})${item.daily.days ? ` on ${item.daily.days.join(', ')}` : ''}${item.daily.enabled ? '' : ', disabled'}` : 'command job';
      const command = job?.run.kind === 'command' ? `Command: ${job.run.command} · needs ${job.run.needs.join(', ') || 'any device'} · timeout ${job.run.timeoutMinutes} min` : job ? `Retired GitHub workflow ${job.run.workflow}` : '';
      const next = item.kind === 'daily' ? (settings.nightlyWindow.enabled && item.daily.enabled ? `tonight at ${settings.nightlyWindow.time}` : 'not scheduled') : job?.paused ? 'paused' : job?.interval ? `every ${job.interval.everyMinutes} min between ${job.interval.start} and ${job.interval.end}` : 'when run';
      return { text: capLines([`${itemName(item)} · ${definition}`, ...(command ? [command] : []), `Next run: ${next}`, 'Last runs:', ...(runs.length ? runs.map(run => runLine(context, run, itemName(item), tz, now)) : ['none'])]) };
    }
    case 'night': {
      const items = [...daily.dailies].sort((a, b) => a.order - b.order);
      const last = (row: ProjectDaily) => { const job = row.target.kind === 'job' ? row.target.jobId : null; const run = job ? [...daily.runs].filter(entry => entry.jobId === job).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] : undefined; return run ? `${run.conclusion ?? 'running'} ${ownerClock(run.endedAt ?? run.startedAt, now, tz)}` : 'no run yet'; };
      return { text: capLines([`Night window: ${settings.nightlyWindow.enabled ? `${settings.nightlyWindow.time} (${tz})` : 'off'}${daily.window ? ` · last window ${daily.window.state}${daily.window.outcome ? `: ${daily.window.outcome.split('\n')[0]!.slice(0, 160)}` : ''}` : ''}`,
        `Tonight's order: ${nightOrder().join(', ') || 'none'}`, ...items.map(row => `${row.order}. ${row.name}${row.enabled ? '' : ' (disabled)'}${row.days ? ` (${row.days.join(', ')})` : ''} · last: ${last(row)}`)]), data: data.routines };
    }
    case 'deploy': {
      const open = (await engine.view(projectId)).decisions.open.find(row => row.deploy);
      const lines = open ? [`${tools.ids.one(projectId, 'W', open.id)} ${open.question}`, `Options: ${open.options.map(option => option.label).join(', ')} · answer it with respond ${tools.ids.one(projectId, 'W', open.id)}`] : ['No deploy message is open.'];
      if (data.deploy.toolLine) lines.push(data.deploy.toolLine, ...(data.deploy.desktopLine ? [data.deploy.desktopLine] : []));
      lines.push(`Mode: ${settings.deploy.mode}${tools.projectSettings(projectId).deploy.paused ? ' (paused)' : ''}`);
      return { text: capLines(lines), data: data.deploy };
    }
    case 'health': {
      const view = await app.projectHealthRequest({ schema: 'project-health-request-v1', project: projectId, operation: 'list' });
      if (!settings.healthChecks.length) return { text: 'No health checks are configured.' };
      return { text: capLines(settings.healthChecks.map(check => {
        const run = view.runs.filter(row => row.checkId === check.id).sort((a, b) => b.at.localeCompare(a.at))[0];
        const id = tools.ids.one(projectId, 'H', check.id);
        return run ? `${id} ${check.name}: ${run.passed ? 'passed' : 'failed'} ${ownerClock(run.at, now, tz)} (${run.trigger}) · ${run.steps.map(step => `${step.name} ${step.passed ? 'ok' : `failed${step.reason ? `: ${step.reason}` : ''}`}`).join(', ')}` : `${id} ${check.name}: not run yet`;
      })) };
    }
    case 'run': {
      const item = find(data, String(args.job)); const clientRequestId = newId('owner_run');
      const receipt = item.kind === 'daily' ? await engine.daily.runDaily(projectId, item.daily.id, { schema: 'project-run-request-v1', clientRequestId }) : await engine.daily.runJob(projectId, item.job.id, { schema: 'project-run-request-v1', clientRequestId });
      const taskId = (receipt as { taskId?: string }).taskId;
      for (let attempt = 0; attempt < 20 && taskId; attempt++) {
        const run = (await engine.daily.view(projectId)).runs.find(row => row.taskId === taskId);
        if (run) { const device = (await app.roster()).devices.find(row => row.device.id === run.deviceId)?.device.name ?? run.deviceId; return { text: `Started ${itemName(item)} now (${tools.ids.one(projectId, 'J', run.id)}) on ${device}. Failures are pushed; the result shows in status.` }; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { text: `Started ${itemName(item)} now. It runs on an eligible device as soon as one is free. Failures are pushed; the result shows in status.` };
    }
    case 'pause': case 'resume': {
      const item = find(data, String(args.job)); const pause = context.action === 'pause';
      if (item.kind === 'daily') {
        const fresh = (await engine.daily.view(projectId)).dailies.find(row => row.id === item.daily.id)!;
        await engine.daily.setEnabled(projectId, fresh.id, { schema: 'daily-enabled-request-v1', expectedRevision: fresh.revision, enabled: !pause });
      } else {
        const fresh = (await engine.daily.jobs(projectId)).find(row => row.id === item.job.id)!;
        await engine.daily.setPaused(projectId, fresh.id, { schema: 'job-paused-request-v1', expectedRevision: fresh.revision, paused: pause });
      }
      if (pause) return { text: `Paused ${itemName(item)}. It won't run until you resume it.` };
      const next = item.kind === 'daily' ? `tonight at ${settings.nightlyWindow.time}` : item.job.interval ? `within ${item.job.interval.everyMinutes} minutes, between ${item.job.interval.start} and ${item.job.interval.end}` : 'when you run it';
      return { text: `Resumed ${itemName(item)}. Next run: ${next}.` };
    }
    case 'schedule': {
      if (typeof args.windowStart === 'string') {
        const view = await engine.settingsView(projectId);
        await engine.putSettings(projectId, { schema: 'project-work-settings-request-v1', revision: view.settings.revision, settings: { ...withoutIdentity(view.settings), nightlyWindow: { ...view.settings.nightlyWindow, time: args.windowStart, enabled: true } } } as never);
        return { text: `The night window now starts at ${args.windowStart}. Tonight's order: ${nightOrder().join(', ') || 'none'}.` };
      }
      if (Array.isArray(args.order)) {
        const names = (args.order as string[]).map(token => find(data, token)).filter((item): item is Extract<Item, { kind: 'daily' }> => item.kind === 'daily');
        if (names.length !== args.order.length) throw new OwnerRefusal(`order takes night items only: ${daily.dailies.map(row => row.name).join(', ')}.`, 'invalid_order');
        const rest = [...daily.dailies].filter(row => !names.some(item => item.daily.id === row.id)).sort((a, b) => a.order - b.order);
        const ordered = [...names.map(item => item.daily), ...rest];
        for (const [index, row] of ordered.entries()) if (row.order !== index) { const fresh = (await engine.daily.view(projectId)).dailies.find(entry => entry.id === row.id)!; await engine.daily.updateDaily(projectId, row.id, dailyUpdate(fresh, { order: index })); }
        return { text: `Tonight's order: ${ordered.filter(row => row.enabled).map(row => row.name).join(', ')}.` };
      }
      const item = find(data, String(args.job));
      if (Array.isArray(args.days)) {
        if (item.kind !== 'daily') throw new OwnerRefusal('days applies to night items. Command jobs take everyMinutes and between.', 'invalid_schedule');
        const days = DAYS.filter(day => (args.days as string[]).includes(day));
        const fresh = (await engine.daily.view(projectId)).dailies.find(row => row.id === item.daily.id)!;
        await engine.daily.updateDaily(projectId, fresh.id, dailyUpdate(fresh, { days: days.length === 7 ? undefined : days }));
        return { text: `${item.daily.name} now runs on ${days.length === 7 ? 'every night' : days.map(day => dayNames[day]).join(', ')}.` };
      }
      if (typeof args.everyMinutes === 'number') {
        if (item.kind !== 'job') throw new OwnerRefusal('everyMinutes applies to command jobs, not night items.', 'invalid_schedule');
        const [start, end] = typeof args.between === 'string' ? args.between.split('-') as [string, string] : ['00:00', '23:59'];
        const fresh = (await engine.daily.jobs(projectId)).find(row => row.id === item.job.id)!;
        await engine.daily.updateJob(projectId, fresh.id, jobUpdate(fresh, { interval: { everyMinutes: args.everyMinutes, start, end } }));
        return { text: `${item.job.name} now runs every ${args.everyMinutes} minutes between ${start} and ${end}. Next: ${tools.nextInterval({ everyMinutes: args.everyMinutes, start, end }, null, tz)}.` };
      }
      throw new OwnerRefusal('schedule takes windowStart (HH:MM), order (night items), days (mon to sun) or everyMinutes with between (HH:MM-HH:MM).', 'invalid_schedule');
    }
    case 'health_run': {
      const view = await app.projectHealthRequest({ schema: 'project-health-request-v1', project: projectId, operation: 'run', ...(typeof args.check === 'string' ? { check: args.check } : {}), ...(args.definition ? { definition: args.definition as Parameters<typeof app.projectHealthRequest>[0]['definition'] } : {}) });
      return { text: capLines(view.runs.map(run => `${settings.healthChecks.find(check => check.id === run.checkId)?.name ?? run.checkId}: ${run.passed ? 'passed' : 'failed'} · ${run.steps.map(step => `${step.name} ${step.passed ? 'ok' : `failed${step.reason ? `: ${step.reason}` : ''}`}${step.ms ? ` (${Math.round(step.ms)} ms)` : ''}`).join(', ')}`)), data: healthHistoryView(view) };
    }
    case 'rollback': {
      if (context.request.caller.startsWith('remote:')) throw new OwnerRefusal('Deploys and rollbacks are not available remotely.', 'remote_refused', 403);
      const plan = data.deploy.rollback;
      if (!plan) throw new OwnerRefusal(data.deploy.current ? 'Rollback not available: no current deployment has an available rollback record.' : 'Rollback not available: nothing was deployed through Jevellan yet.', 'rollback_unavailable', 409);
      if (!plan.enabled && !(args.confirm === true && plan.pending)) throw new OwnerRefusal(`Rollback not available: ${plan.refusal}`, 'rollback_unavailable', 409);
      if (args.confirm !== true) return { text: plan.detail };
      const row = await ownerDeployRollback(app, projectId, plan.deployId, plan.body);
      const run = row.rollbackPending?.taskId ? undefined : row.rollback?.jobRunId;
      return { text: `Rolling back to ${row.previousCommit!.slice(0, 7)}${run ? ` (${tools.ids.one(projectId, 'J', run)})` : ''}. Health checks run after; the result is pushed.` };
    }
  }
  throw new OwnerRefusal('jobs takes list, show, history, night, deploy, health, run, pause, resume, schedule, health_run, rollback.', 'unknown_action');
};

const withoutIdentity = <T extends { schema?: unknown; projectId?: unknown; revision?: unknown }>(value: T) => { const { schema: _s, projectId: _p, revision: _r, ...rest } = value; void _s; void _p; void _r; return rest; };
function dailyUpdate(row: ProjectDaily, change: Partial<Pick<ProjectDaily, 'enabled' | 'order' | 'days'>>) {
  const { schema: _s, id: _i, projectId: _p, revision, createdAt: _c, updatedAt: _u, requestDigest: _d, reviewFromVersion: _v, reviewFromOwner: _o, enabledSince: _e, ...fields } = row; void _s; void _i; void _p; void _c; void _u; void _d; void _v; void _o; void _e;
  const next = { ...fields, ...change }; if ('days' in change && change.days === undefined) delete (next as { days?: unknown }).days;
  return { schema: 'daily-update-request-v1', expectedRevision: revision, ...next };
}
function jobUpdate(row: ProjectJob, change: Partial<Pick<ProjectJob, 'paused' | 'interval'>>) {
  const { schema: _s, id: _i, projectId: _p, revision, createdAt: _c, updatedAt: _u, requestDigest: _d, ...fields } = row; void _s; void _i; void _p; void _c; void _u; void _d;
  return { schema: 'job-update-request-v1', expectedRevision: revision, ...fields, ...change };
}
