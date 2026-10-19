import { newId, type ProjectDecision, type ProjectGoal, type ProjectWorkTask, type ThreadIndex } from '@jevellan/core';
import { OwnerRefusal, type OwnerContext } from '../owner-tools.js';

export const clientId = (prefix: string) => newId(prefix);

/** A task, its thread and display id from `T31` or an internal task or thread id. */
export async function resolveTask(context: OwnerContext, token: string): Promise<{ id: string; task: ProjectWorkTask | null; thread: ThreadIndex | null }> {
  const { app, tools, project } = context; const projectId = project.id;
  const [tasks, view] = await Promise.all([app.projectWork.taskList(projectId), app.projectWork.view(projectId)]);
  await tools.status(project); // assigns display ids to everything current
  const found = tools.ids.resolve(projectId, token);
  const internal = found?.internalId ?? token;
  const task = tasks.tasks.find(row => row.id === internal || row.threadId === internal) ?? null;
  const thread = view.threads.find(row => row.id === (task?.threadId ?? internal)) ?? null;
  if (!task && !thread) throw new OwnerRefusal(`${token} is not a task or thread of ${project.name}.`, 'not_found', 404);
  const id = found?.shortId ?? tools.ids.shortOf(projectId, task?.id ?? thread!.id) ?? token;
  return { id, task, thread };
}

export async function resolveGoal(context: OwnerContext, token: string): Promise<{ id: string; goal: ProjectGoal; revision: number }> {
  const { app, tools, project } = context; const goals = (await app.projectWork.goalList(project.id)).goals.map(row => row.goal);
  await tools.status(project);
  const wanted = token.trim().toLowerCase(); const byShort = tools.ids.resolve(project.id, token);
  const goal = goals.find(row => row.id === (byShort?.internalId ?? token)) ?? goals.find(row => row.name.toLowerCase() === wanted) ?? goals.find(row => row.name.toLowerCase().includes(wanted));
  if (!goal) throw new OwnerRefusal(`No goal matches "${token}". Goals: ${goals.map(row => `${tools.ids.shortOf(project.id, row.id)} ${row.name}`).join(', ') || 'none'}.`, 'goal_not_found', 404);
  return { id: tools.ids.shortOf(project.id, goal.id)!, goal, revision: goal.revision };
}

export async function resolveWaiting(context: OwnerContext, token: string): Promise<{ id: string; decision: ProjectDecision | null; draft: ProjectWorkTask | null }> {
  const { app, tools, project } = context; await tools.status(project);
  const found = tools.ids.resolve(project.id, token);
  if (!found) throw new OwnerRefusal(`${token} is not waiting on you. ${await waitingList(context)}`, 'not_found', 404);
  if (found.internalId.startsWith('draft-')) {
    const task = (await app.projectWork.taskList(project.id)).tasks.find(row => `draft-${row.id}`.slice(0, 128) === found.internalId) ?? null;
    if (!task || task.state !== 'draft') throw new OwnerRefusal(`${found.shortId} is no longer waiting on you.`, 'not_open', 409);
    return { id: found.shortId, decision: null, draft: task };
  }
  const decision = (await app.projectWork.view(project.id)).decisions.open.find(row => row.id === found.internalId) ?? null;
  if (!decision) throw new OwnerRefusal(`${found.shortId} is no longer waiting on you.`, 'not_open', 409);
  return { id: found.shortId, decision, draft: null };
}
async function waitingList(context: OwnerContext): Promise<string> {
  const view = await context.tools.status(context.project);
  return view.waiting.length ? `Waiting: ${view.waiting.map(item => item.id).join(', ')}.` : 'Nothing is waiting on you.';
}

/** The option an answer names: exact, or a unique case-insensitive prefix (bridge specification, `respond`). */
export function matchOption(options: readonly string[], answer: string): string | null {
  const wanted = answer.trim().toLowerCase();
  const exact = options.find(option => option.toLowerCase() === wanted); if (exact) return exact;
  const prefixed = options.filter(option => option.toLowerCase().startsWith(wanted));
  return prefixed.length === 1 ? prefixed[0]! : null;
}
