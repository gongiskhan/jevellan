import { prepareTaskEditorSave } from '@jevellan/core';
import { ownerCreateTask, ownerTaskCommand, ownerProjectChatView, ownerProjectChatCardView, ownerProjectCoordinatorCommand } from '../project-work-api.js';
import { ownerClock, ownerDuration } from '@jevellan/core';
import { capLines, runLabel } from '@jevellan/projects';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { clientId, resolveGoal, resolveTask } from './common.js';

/** `work`: the task queue (bridge specification, `work`). */
export const work: OwnerHandler = async (context) => {
  const { app, tools, project, args, now } = context; const projectId = project.id; const engine = app.projectWork;
  switch (context.action) {
    case 'notebook_view': return { text: 'Notebook.', data: await engine.notebookEditor(projectId) };
    case 'notebook_command': return { text: 'Notebook saved.', data: await engine.notebookCommand(projectId, args.request) };
    case 'coordinator_composer': return { text: 'Coordinator composer.', data: await engine.coordinatorComposer(projectId) };
    case 'coordinator_command': return { text: 'Coordinator updated.', data: await ownerProjectCoordinatorCommand(app, projectId, args.request) };
    case 'chat_card_view': return { text: 'Work cards.', data: await ownerProjectChatCardView(app, projectId, args.request) };
    case 'chat_view': return { text: 'Recorded project chat.', data: await ownerProjectChatView(app, projectId, args.request) };
    case 'task_page_view': return { text: 'Task.', data: await engine.taskPageView(projectId, String(args.task)) };
    case 'queue_view': return { text: 'Task queue.', data: await engine.taskQueueInteraction(projectId, args.request) };
    case 'task_edit_view': return { text: 'Edit task.', data: await engine.taskEditView(projectId, String(args.task)) };
    case 'task_draft': return { text: 'Task preparation.', data: await engine.taskDraft(projectId, String(args.task), args.request) };
    case 'task_command': return { text: 'Task updated.', data: await ownerTaskCommand(app, projectId, String(args.task), args.request) };
    case 'editor': return { text: 'New task.', data: await engine.taskEditor(projectId, context.request.deviceId ?? app.device.deviceId) };
    case 'preview': return { text: 'New task.', data: await engine.taskEditor(projectId, context.request.deviceId ?? app.device.deviceId, args.request) };
    case 'save': return { text: 'Task queued.', data: await ownerCreateTask(app, projectId, prepareTaskEditorSave(args.request)) };

    case 'list': {
      let view = await tools.status(project);
      if (typeof args.goal === 'string') view = await tools.status(project, args.goal);
      if (!view.queued.length) return { text: 'Nothing queued.', data: view.queued };
      return { text: capLines(view.queued.map((run, index) => `${index + 1} ${run.id} ${runLabel(run)} · ${run.title}${run.priority === 'urgent' ? ' · urgent' : ''}${run.detail ? ` · ${run.detail}` : ''}`)), data: view.queued };
    }
    case 'add': {
      const goal = typeof args.goal === 'string' ? await resolveGoal(context, args.goal) : null;
      const urgent = args.priority === 'urgent' || args.position === 'next';
      const title = String(args.title); const brief = typeof args.description === 'string' ? args.description : `${title}.`;
      const created = await ownerCreateTask(app, projectId, { schema: 'task-create-request-v1', clientRequestId: clientId('owner_task'), title, brief, type: 'feature', goalId: goal?.goal.id ?? null, now: urgent, after: [], needs: [], fixed: {},
        ...(typeof args.fromBranch === 'string' ? { fromBranch: args.fromBranch } : {}) });
      let view = await tools.status(project);
      const id = tools.ids.shortOf(projectId, created.taskId) ?? created.taskId;
      if (urgent) return { text: `Added ${id} as urgent. It starts next.`, data: created };
      if (typeof args.position === 'string' && /^\d+$/u.test(args.position)) {
        await moveTo(context, created.taskId, Number(args.position)); view = await tools.status(project);
      }
      const position = view.queued.findIndex(run => run.internalId === created.taskId) + 1;
      const settings = (await engine.view(projectId)).settings; const running = view.running.filter(run => run.kind === 'thread').length;
      return { text: `Added ${id} "${title}" (${goal ? goal.goal.name : 'manual'}) at position ${position || view.queued.length} of ${view.queued.length}. It starts when a slot is free (${running} of ${settings.maxRunningThreads} running.)`, data: created };
    }
    case 'reorder': {
      const target = await resolveTask(context, String(args.task));
      if (!target.task || target.task.state !== 'queued' || target.task.threadId) throw new OwnerRefusal(`${target.id} is not queued. Only queued tasks move.`, 'not_queued', 409);
      const before = (await tools.status(project)).queued.findIndex(run => run.internalId === target.task!.id) + 1;
      const wanted = args.position === 'next' ? 1 : args.position === 'last' ? Number.MAX_SAFE_INTEGER : Number(args.position);
      const after = await moveTo(context, target.task.id, wanted);
      return { text: `Moved ${target.id} to position ${after} (was ${before}).` };
    }
    case 'cancel': {
      const target = await resolveTask(context, String(args.task)); const reason = typeof args.reason === 'string' ? args.reason : undefined;
      const thread = target.thread;
      if (thread?.state === 'attached') throw new OwnerRefusal(`${target.id} is held by you. Hand it back or stop it first.`, 'held', 409);
      if (thread && (thread.state === 'publishing' || thread.landingStage)) throw new OwnerRefusal(`${target.id} is landing. Cancel it after it lands or fails.`, 'landing', 409);
      if (thread && ['queued', 'preparing', 'running', 'idle', 'waiting-for-you'].includes(thread.state)) {
        await engine.stopThread(projectId, thread.id, { schema: 'thread-stop-request-v1', ...(reason ? { reason } : {}) });
        if (target.task && ['queued', 'active'].includes(target.task.state)) await engine.taskAction(projectId, target.task.id, { schema: 'task-action-request-v1', expectedRevision: (await engine.taskView(projectId, target.task.id)).task.revision, action: 'cancel', ...(reason ? { reason } : {}) }).catch(() => undefined);
        return { text: `Stopping ${target.id} at the next safe point and cancelling it. Its worktree is kept until cleanup removes it.` };
      }
      if (!target.task || !['queued', 'draft'].includes(target.task.state)) throw new OwnerRefusal(`${target.id} has already ended.`, 'ended', 409);
      await engine.taskAction(projectId, target.task.id, { schema: 'task-action-request-v1', expectedRevision: target.task.revision, action: target.task.state === 'draft' ? 'reject' : 'cancel', ...(reason ? { reason } : {}) });
      return { text: `Cancelled ${target.id} (it was queued).` };
    }
    case 'inspect': {
      const target = await resolveTask(context, String(args.task)); const view = await tools.status(project);
      const run = [...view.running, ...view.queued, ...view.landed, ...view.finished].find(row => row.id === target.id);
      const task = target.task; const thread = target.thread;
      const goal = task?.goalId ? (await engine.goalList(projectId)).goals.find(row => row.goal.id === task.goalId)?.goal : undefined;
      const lines = [`${target.id} ${thread?.title ?? task!.title}`,
        [goal ? `Goal: ${tools.ids.shortOf(projectId, goal.id)} ${goal.name}` : 'Goal: manual', task ? `origin: ${task.source}` : '', task?.now ? 'priority urgent' : 'priority normal', `delivery ${thread?.delivery ?? 'land'}`].filter(Boolean).join(' · ')];
      if (thread) {
        const since = ownerDuration(now.getTime() - new Date(thread.createdAt).getTime());
        lines.push(`State: ${run?.state ?? thread.state}${run?.state === 'running' ? ` for ${since}` : ''} · ${thread.modelLabel} ${thread.effort} · ${thread.accountLabel} · ${run?.device ?? thread.ownerDeviceId}${thread.branch ? ` · worktree on ${thread.branch}` : ''}`);
        if (thread.stateReason) lines.push(`Reason: ${thread.stateReason}`);
      } else lines.push(`State: ${task!.state}${task!.held ? ' (held until you start it)' : ''}`);
      lines.push(`Description: ${(task?.brief ?? '').slice(0, 500)}`);
      if (thread?.usage) lines.push(`Usage so far: ${Math.round(thread.usage.inputTokens / 1000)}k input (${Math.round(thread.usage.cacheReadTokens / 1000)}k cached), ${Math.round(thread.usage.outputTokens / 1000)}k output${thread.usage.costUnknownTurns ? '' : `, about $${thread.usage.costUsd.toFixed(2)}`}`);
      if (thread?.landing) lines.push(`Landed as ${thread.landing.commit.slice(0, 7)} at ${ownerClock(thread.landing.at, now, view.timeZone)} (${thread.landing.method})`);
      return { text: capLines(lines), data: { task, thread } };
    }
  }
  throw new OwnerRefusal(`work takes list, add, reorder, cancel, inspect, editor, preview, save.`, 'unknown_action');
};

/** Moves a queued task to a 1-based position among the queued tasks; returns where it ended. */
async function moveTo(context: Parameters<OwnerHandler>[0], taskId: string, position: number): Promise<number> {
  const { app, tools, project } = context; const engine = app.projectWork;
  const queued = (await tools.status(project)).queued.filter(run => run.internalId !== taskId);
  const task = (await engine.taskView(project.id, taskId)).task;
  const index = Math.max(0, Math.min(queued.length, position - 1));
  const placement = index >= queued.length ? 'bottom' as const : index === 0 ? 'top' as const : { before: queued[index]!.internalId };
  await engine.updateTask(project.id, taskId, { schema: 'task-update-request-v1', expectedRevision: task.revision, position: placement, ...(index === 0 ? {} : { now: false }) });
  return (await tools.status(project)).queued.findIndex(run => run.internalId === taskId) + 1;
}
