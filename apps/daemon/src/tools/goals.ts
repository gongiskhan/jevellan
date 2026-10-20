import { newId, ownerClock, ownerDuration, ownerLocal } from '@jevellan/core';
import { capLines } from '@jevellan/projects';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { resolveGoal } from './common.js';
import { ownerGoalSave, ownerGoalEditorSave } from '../project-work-api.js';

/** `goals` (bridge specification): list, show, create, edit, pause, resume, done; changes use the revision-checked goal updates. */
export const goals: OwnerHandler = async (context) => {
  const { app, tools, project, args, now } = context; const engine = app.projectWork; const projectId = project.id;
  const update = async (goalId: string, revision: number, patch: Record<string, unknown>) => ownerGoalSave(app, projectId, goalId, { schema: 'goal-update-request-v1', expectedRevision: revision, ...patch });
  switch (context.action) {
    case 'editor': { const view = await engine.goalEditor(projectId, typeof args.id === 'string' ? args.id : undefined); return { text: view.title, data: view }; }
    case 'save': { const view = await ownerGoalEditorSave(app, projectId, typeof args.id === 'string' ? args.id : undefined, args.request); return { text: `Saved ${view.goal.name}.`, data: view }; }
    case 'list': {
      const view = await tools.status(project); const all = (await engine.goalList(projectId)).goals.map(row => row.goal);
      const lines = view.goals.map(goal => `${goal.id} ${goal.title} · ${goal.state} · ${[goal.counts.running ? `${goal.counts.running} running` : '', goal.counts.queued ? `${goal.counts.queued} queued` : '', goal.counts.waiting ? `${goal.counts.waiting} waiting` : '', goal.counts.landedToday ? `${goal.counts.landedToday} landed today` : ''].filter(Boolean).join(', ') || 'nothing running'}${goal.due.length ? ` · due: ${goal.due.map(entry => entry.text).join(', ')}` : ''}`);
      const done = all.filter(goal => goal.state === 'done');
      if (done.length) lines.push(`Done: ${done.map(goal => `${tools.ids.one(projectId, 'G', goal.id)} ${goal.name}`).join(', ')}`);
      return { text: capLines(lines.length ? lines : ['No goals yet.']), data: await engine.goalViews(projectId) };
    }
    case 'show': {
      const { goal } = await resolveGoal(context, String(args.goal)); const id = tools.ids.one(projectId, 'G', goal.id);
      const view = await tools.status(project, goal.id); const line = view.goals[0];
      const tz = view.timeZone; const today = ownerLocal(now, tz).day;
      const daily = await engine.daily.view(projectId); const threads = (await engine.view(projectId)).threads; const tasks = (await engine.taskList(projectId)).tasks.filter(task => task.goalId === goal.id);
      const todays = tasks.flatMap(task => { const thread = threads.find(row => row.id === task.threadId); if (!thread) return [];
        const ended = thread.landing?.at ?? thread.endedAt; if (!ended || ownerLocal(ended, tz).day !== today) return [];
        return [`${tools.ids.shortOf(projectId, task.id) ?? ''} ${thread.landing ? 'landed' : thread.state}`.trim()]; });
      const decisions = engine.coordinatorLedger(projectId).events().filter(event => event.type === 'coordinator-tool').slice(-40).flatMap(event => {
        const data = engine.coordinatorLedger(projectId).data(event) as { taskIds?: string[]; summary?: string } | undefined;
        return data?.taskIds?.some(taskId => tasks.some(task => task.id === taskId)) ? [`${data.summary ?? 'changed a task'} (${ownerClock(event.t, now, tz)})`] : [];
      }).slice(-3);
      const lines = [`${id} ${goal.name} · ${goal.state}`, goal.motivation, `Health: ${goal.health || 'not set'}`,
        `Due: ${line?.due.length ? line.due.map(entry => entry.text).join(', ') : 'nothing'}`,
        `Running: ${view.running.length ? view.running.map(run => `${run.id} ${run.title}${run.startedAt ? ` (${ownerDuration(now.getTime() - Date.parse(run.startedAt))})` : ''}`).join(' · ') : 'none'}`,
        `Queued: ${view.queued.length ? view.queued.map((run, index) => `${run.id} ${run.title} (position ${run.position ?? index + 1})`).join(' · ') : 'none'}`,
        `Waiting on you: ${view.waiting.length ? view.waiting.map(item => item.id).join(', ') : 'none'}`,
        `Today: ${todays.join(' · ') || 'nothing yet'}`,
        `Night items: ${daily.dailies.filter(row => row.goalId === goal.id).map(row => row.name).join(', ') || 'none'}`,
        `Recent coordinator decisions: ${decisions.join(' · ') || 'none'}`];
      return { text: capLines(lines) };
    }
    case 'create': {
      const created = await ownerGoalSave(app, projectId, undefined, { schema: 'goal-create-request-v1', clientRequestId: newId('owner_goal'), name: String(args.title), motivation: String(args.motivation),
        ...(typeof args.health === 'string' ? { health: args.health } : {}) });
      return { text: `Created ${tools.ids.one(projectId, 'G', created.goal.id)} "${created.goal.name}". The coordinator plans its first tasks at its next turn.` };
    }
    case 'edit': {
      const { goal, id } = await resolveGoal(context, String(args.goal));
      const patch = { ...(typeof args.title === 'string' ? { name: args.title } : {}), ...(typeof args.motivation === 'string' ? { motivation: args.motivation } : {}), ...(typeof args.health === 'string' ? { health: args.health } : {}) };
      if (!Object.keys(patch).length) throw new OwnerRefusal('goals edit takes title, motivation or health.', 'nothing_to_change');
      await update(goal.id, goal.revision, patch);
      return { text: `Updated ${id}: ${Object.keys(patch).map(key => key === 'name' ? 'title' : key).join(', ')}.` };
    }
    case 'pause': case 'resume': {
      const { goal, id } = await resolveGoal(context, String(args.goal));
      if (goal.state === 'done') throw new OwnerRefusal(`${id} is done. Create a new goal instead.`, 'goal_done', 409);
      await update(goal.id, goal.revision, { state: context.action === 'pause' ? 'paused' : 'active' });
      if (context.action === 'pause') return { text: `Paused ${id}. Running tasks finish; queued ones wait until you resume it.` };
      const queued = (await engine.taskList(projectId)).tasks.filter(task => task.goalId === goal.id && task.state === 'queued').length;
      return { text: `Resumed ${id}. ${queued} queued task${queued === 1 ? '' : 's'} can start again.` };
    }
    case 'done': {
      const { goal, id } = await resolveGoal(context, String(args.goal));
      const result = await update(goal.id, goal.revision, { state: 'done' });
      return { text: `Marked ${id} done. Cancelled ${result.goal.doneCleanup?.cancelledCount ?? 0} queued tasks; ${result.counts.active} running tasks will finish. Its history stays.` };
    }
  }
  throw new OwnerRefusal('goals takes list, show, create, edit, pause, resume, done.', 'unknown_action');
};
