import { ownerClock, ownerLocal } from '@jevellan/core';
import { capLines } from '@jevellan/projects';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { resolveTask } from './common.js';

/** The instant of a local wall-clock time in a time zone (the offset found by one correction step, exact outside DST jumps). */
export function zonedInstant(day: string, clock: string, timeZone: string): Date {
  const guess = new Date(`${day}T${clock}:00.000Z`);
  const local = ownerLocal(guess, timeZone); const shown = new Date(`${local.day}T${local.clock}:00.000Z`);
  return new Date(guess.getTime() - (shown.getTime() - guess.getTime()));
}
/** `since` (bridge specification, `activity`): ISO, HH:MM (today, or yesterday if still ahead), N minutes, N hours, today, last night. */
export function parseSince(raw: string | undefined, now: Date, timeZone: string, fallbackHours: number): Date {
  if (!raw) return new Date(now.getTime() - fallbackHours * 3600_000);
  const text = raw.trim().toLowerCase(); const today = ownerLocal(now, timeZone).day;
  const yesterday = ownerLocal(new Date(now.getTime() - 24 * 3600_000), timeZone).day;
  let match;
  if ((match = text.match(/^(\d+)\s*(minutes?|min|hours?|h)$/u))) return new Date(now.getTime() - Number(match[1]) * (match[2]!.startsWith('h') ? 3600_000 : 60_000));
  if (text === 'today') return zonedInstant(today, '00:00', timeZone);
  if (text === 'last night' || text === 'overnight') return zonedInstant(yesterday, '20:00', timeZone);
  if ((match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/u))) {
    const clock = `${match[1]!.padStart(2, '0')}:${match[2]}`; const instant = zonedInstant(today, clock, timeZone);
    return instant.getTime() > now.getTime() ? zonedInstant(yesterday, clock, timeZone) : instant;
  }
  const parsed = new Date(raw); if (!Number.isNaN(parsed.getTime())) return parsed;
  throw new OwnerRefusal('since takes an ISO time, HH:MM, "N minutes", "N hours", "today" or "last night".', 'invalid_since');
}

/** `activity`: what happened (bridge specification, `activity`). */
export const activity: OwnerHandler = async (context) => {
  const { app, tools, project, args, now } = context; const engine = app.projectWork; const projectId = project.id;
  const status = await tools.status(project); const timeZone = status.timeZone;
  const kind = (args.kind as 'digest' | 'events' | 'decisions' | undefined) ?? 'digest';
  const since = parseSince(typeof args.since === 'string' ? args.since : undefined, now, timeZone, kind === 'digest' ? 12 : 24 * 30);
  const sinceIso = since.toISOString(); const clock = (at: string) => ownerClock(at, now, timeZone);
  const target = typeof args.target === 'string' && args.target.toLowerCase() !== 'all' ? args.target.toUpperCase() : 'ALL';
  const limit = typeof args.limit === 'number' ? args.limit : 20; const detail = args.detail === true;
  if (kind === 'events') {
    const events = app.ownerEvents.since(0, projectId).filter(event => event.at >= sinceIso && (target === 'ALL' || event.source === target)).slice(-limit);
    const head = target === 'ALL' ? `${project.name} · last ${events.length} events` : `${target} ${target === 'C' ? 'coordinator' : [...status.running, ...status.landed, ...status.finished].find(run => run.id === target)?.title ?? ''} · last ${events.length} events`;
    const cut = (text: string) => detail || text.length <= 200 ? text : `${text.slice(0, 197)}...`;
    return { text: capLines([head, ...events.map(event => `${new Date(event.at).toLocaleTimeString('en-GB', { timeZone, hour12: false })} ${event.kind === 'think' ? 'thinking' : event.kind}: ${cut(event.text)}`)], detail), data: events };
  }
  if (kind === 'decisions') {
    const lines = [target === 'ALL' ? `Decisions for ${project.name}` : `Decisions for ${target}`];
    const view = await engine.view(projectId);
    const threads = target === 'ALL' ? view.threads : [(await resolveTask(context, target)).thread].flatMap(row => row ? [row] : []);
    const recent = threads.filter(row => row.createdAt >= sinceIso || target !== 'ALL').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit);
    const ids = tools.ids.assign(projectId, 'D', recent.map(row => `placement-${row.id}`.slice(0, 128)));
    const routes = (await engine.landings.records(projectId)).filter((row): row is import('@jevellan/core').LandingRoute => row.schema === 'landing-route-v1' && recent.some(thread => thread.id === row.threadId));
    const rows = [...recent.map(row => ({ at: row.createdAt, line: `${ids.get(`placement-${row.id}`.slice(0, 128))} ${clock(row.createdAt)} Jev · ${tools.ids.shortOf(projectId, row.id) ?? row.title} on ${row.modelLabel} ${row.effort}, account ${row.accountLabel} · can override: undo, only` })),
      ...routes.map(route => ({ at: route.at, line: `${tools.ids.one(projectId, 'D', route.id)} ${clock(route.at)} ${route.source === 'jev' ? 'Jev' : route.source === 'owner' ? 'You' : 'Jevellan'} · landing route ${route.route}${route.rulesApplied?.length ? ` (Jev said ${route.rawChoice})` : ''} · ${(route.reason ?? '').slice(0, 160)} · can override: ${route.state === 'landed' ? 'undo (revert), only' : 'undo, only'}` }))]
      .sort((a, b) => a.at.localeCompare(b.at));
    for (const row of rows) lines.push(row.line);
    if (lines.length === 1) lines.push('No decisions in this period.');
    return { text: capLines(lines, detail) };
  }
  const view = await engine.view(projectId); const deploys = (await engine.deploys.view(projectId)).records; const daily = await engine.daily.view(projectId);
  const landed = view.threads.filter(row => row.landing && row.landing.at >= sinceIso).sort((a, b) => a.landing!.at.localeCompare(b.landing!.at));
  const failed = view.threads.filter(row => row.state === 'failed' && (row.endedAt ?? row.updatedAt) >= sinceIso);
  const deployed = deploys.filter(row => row.state === 'deployed' && (row.deployedAt ?? '') >= sinceIso);
  const rolled = deploys.filter(row => row.rollback && row.rollback.at >= sinceIso);
  const dailyByJob = new Map(daily.dailies.flatMap(row => row.target.kind === 'job' ? [[row.target.jobId, row.name] as const] : []));
  const night = daily.runs.filter(run => run.startedAt >= sinceIso && dailyByJob.has(run.jobId)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const created = [...view.decisions.open, ...view.decisions.answered].filter(row => row.createdAt >= sinceIso);
  const placements = view.threads.filter(row => row.createdAt >= sinceIso).length;
  const coordinatorTools = engine.coordinatorLedger(projectId).events().filter(event => event.type === 'coordinator-tool' && event.t >= sinceIso).length;
  const openDeploy = view.decisions.open.find(row => row.deploy);
  const handoff = await tools.latestHandoff(projectId);
  const id = (internal: string) => tools.ids.shortOf(projectId, internal) ?? '';
  const lines = [`${project.name} since ${clock(sinceIso)}`,
    `Landed: ${landed.length ? landed.map(row => `${id(row.id)} ${row.title} (${row.landing!.method === 'merge-commit' ? 'merge commit ' : ''}${row.landing!.commit.slice(0, 7)}, ${clock(row.landing!.at)})`.trim()).join(', ') : 'nothing'}`,
    `Deployed: ${deployed.length ? deployed.map(row => `${row.commit.slice(0, 7)} with ${row.threads.length} threads (${clock(row.deployedAt!)})`).join(', ') : `nothing${openDeploy ? ` (deploys wait for approval; ${tools.ids.shortOf(projectId, openDeploy.id) ?? 'the deploy message'} is open)` : ''}`}`,
    `Rolled back: ${rolled.length ? rolled.map(row => `${row.commit.slice(0, 7)} to ${row.rollback!.toCommit.slice(0, 7)} (${row.rollback!.reason}, ${clock(row.rollback!.at)})`).join(', ') : 'nothing'}`,
    `Night: ${night.length ? night.map(run => `${dailyByJob.get(run.jobId)} ${run.conclusion ?? 'running'}${run.endedAt ? ` ${clock(run.endedAt)}` : ''}`).join(', ') : 'nothing ran'}`,
    `Failed: ${failed.length ? failed.map(row => `${id(row.id)} ${row.title}${row.stateReason ? ` (${row.stateReason})` : ''}`.trim()).join(', ') : 'nothing'}`,
    `Missed: ${await tools.missedSince(projectId, sinceIso)}`,
    `Decisions: ${placements} by Jev, ${coordinatorTools} by the coordinator, ${await tools.overridesSince(projectId, sinceIso)} overridden`,
    `New waiting items: ${created.length ? created.map(row => tools.ids.shortOf(projectId, row.id) ?? '').filter(Boolean).join(', ') || created.length : 'none'}`];
  if (handoff) lines.push(`Coordinator handoff (${clock(handoff.at)}): ${handoff.text.slice(0, 600)}`);
  return { text: capLines(lines, detail) };
};
