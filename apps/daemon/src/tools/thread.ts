import {ProjectThreadReadRequestSchema} from '@jevellan/core';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { clientId, resolveTask } from './common.js';
import { ProjectThreadActionsViewSchema, ThreadActionRequestSchema, ThreadViewSchema } from '@jevellan/core';
import { ownerThreadOperation, ownerThreadReadView } from '../project-work-api.js';

/** `thread`: steer a running thread (bridge specification, "Threads: say, takeover, hold rules"). */
export const thread: OwnerHandler = async (context) => {
  const { app, tools, project, args } = context; const engine = app.projectWork;
  if (context.action === 'read_view') { const input = ProjectThreadReadRequestSchema.parse(args.request); return { text: 'Thread read state.', data: await ownerThreadReadView(app, project.id, input.threadId, input) }; }
  const token = String(args.thread);
  if (token.toUpperCase() === 'C') throw new OwnerRefusal("The coordinator can't be taken over. Ask it something or tell it what to do instead.", 'coordinator', 409);
  const target = await resolveTask(context, token); const id = target.id; const row = target.thread;
  switch (context.action) {
    case 'view': {
      if (!row) throw new OwnerRefusal(`${id} has no thread yet.`, 'not_running', 409);
      const view = ThreadViewSchema.parse(await ownerThreadOperation(app, project.id, row.id, 'view'));
      return { text: `${id}: ${view.card?.stateLabel ?? view.thread.state}.`, data: view };
    }
    case 'actions': {
      if (!row) throw new OwnerRefusal(`${id} has no thread yet.`, 'not_running', 409);
      const view = ProjectThreadActionsViewSchema.parse(await ownerThreadOperation(app, project.id, row.id, 'actions'));
      return { text: view.items.map(item => `${item.label}${item.enabled ? '' : ` (unavailable${item.refusal ? `: ${item.refusal}` : ''})`}${item.kind === 'link' ? `: ${item.href}` : item.confirmation ? ` — ${item.confirmation.body}` : ''}`).join('\n') || 'No actions are available.', data: view };
    }
    case 'act': {
      if (!row) throw new OwnerRefusal(`${id} has no thread yet.`, 'not_running', 409);
      const input = ThreadActionRequestSchema.parse({ schema: 'thread-action-request-v1', action: args.operation, clientRequestId: args.clientRequestId });
      const view = ProjectThreadActionsViewSchema.parse(await ownerThreadOperation(app, project.id, row.id, 'actions'));
      const item = view.items.find(item => item.kind === 'mutation' && item.id === input.action);
      if (item?.kind === 'mutation' && item.confirmation && args.confirm !== true) throw new OwnerRefusal(`${item.confirmation.body} Call again with confirm: true to continue.`, 'confirmation_required', 409);
      // The canonical writer checks current resources and its durable retry receipt, even if the action disappeared after success.
      return { text: `${id}: ${item?.label ?? input.action}.`, data: await ownerThreadOperation(app, project.id, row.id, 'act', input) };
    }
    case 'merge': {
      if (!row) throw new OwnerRefusal(`${id} has no thread yet.`, 'not_running', 409);
      const view = ProjectThreadActionsViewSchema.parse(await ownerThreadOperation(app, project.id, row.id, 'actions'));
      if (args.confirm !== true) throw new OwnerRefusal(`${view.mergeConfirmation?.body ?? 'Merge this thread’s pull request?'} Call again with confirm: true to continue.`, 'confirmation_required', 409);
      return { text: `Merged ${id}.`, data: await ownerThreadOperation(app, project.id, row.id, 'merge') };
    }
    case 'say': {
      const text = String(args.text); const now = args.now === true;
      const fresh = !row && target.task ? (await engine.taskView(project.id, target.task.id)).task : null;
      if (!row) {
        if (!fresh || fresh.state !== 'queued' || fresh.threadId) throw new OwnerRefusal(`${id} has no running thread yet. Try again in a moment.`, 'not_running', 409);
        await engine.updateTask(project.id, fresh.id, { schema: 'task-update-request-v1', expectedRevision: fresh.revision, brief: `${fresh.brief}\n\nThe owner says: ${text}`.slice(0, 20000) });
        tools.steering(project.id, { thread: id, threadId: fresh.id, kind: 'say', text, by: tools.steeringBy(context.request.caller) });
        return { text: `${id} has not started. Your message is attached to its task and it sees it when it starts.` };
      }
      if (row.state === 'attached') throw new OwnerRefusal(`${id} is held by you. Write to it in its session.`, 'held', 409);
      if (row.state === 'publishing' || row.landingStage) throw new OwnerRefusal(`${id} is landing. Your message reaches it if landing sends it back to work; otherwise create a follow-up task.`, 'landing', 409);
      await engine.threadMessage(project.id, row.id, { schema: 'thread-message-request-v1', clientMessageId: clientId('owner_say'), text: `[Jevellan] The owner says: ${text}`, interrupt: now });
      tools.steering(project.id, { thread: id, threadId: row.id, kind: 'say', text, by: tools.steeringBy(context.request.caller) });
      return { text: now ? `Interrupting ${id} at the next safe point to give it your message.` : `${id} will see your message at its next turn.` };
    }
    case 'stop': {
      if (!row) throw new OwnerRefusal(`${id} has no running thread. Cancel the task with work cancel.`, 'not_running', 409);
      if (['done', 'stopped', 'failed'].includes(row.state)) throw new OwnerRefusal(`${id} has already ended.`, 'ended', 409);
      if (row.state === 'attached') return tools.takeover.stop(context, id, row, typeof args.reason === 'string' ? args.reason : undefined);
      await engine.stopThread(project.id, row.id, { schema: 'thread-stop-request-v1', ...(typeof args.reason === 'string' ? { reason: args.reason } : {}) });
      tools.steering(project.id, { thread: id, threadId: row.id, kind: 'stop', ...(typeof args.reason === 'string' ? { text: args.reason } : {}), by: tools.steeringBy(context.request.caller) });
      return { text: `Stopped ${id}. Its worktree stays until it is resolved.` };
    }
    case 'open': return tools.takeover.open(context, id, row);
    case 'return': return tools.takeover.return(context, id, row, (args.as as 'resume' | 'done' | 'stop' | undefined) ?? 'resume', typeof args.note === 'string' ? args.note : undefined);
  }
  throw new OwnerRefusal('thread takes say, open, return, stop, actions, act, merge, view, read_view.', 'unknown_action');
};
