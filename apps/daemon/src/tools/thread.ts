import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { clientId, resolveTask } from './common.js';

/** `thread`: steer a running thread (bridge specification, "Threads: say, takeover, hold rules"). */
export const thread: OwnerHandler = async (context) => {
  const { app, tools, project, args } = context; const engine = app.projectWork;
  const token = String(args.thread);
  if (token.toUpperCase() === 'C') throw new OwnerRefusal("The coordinator can't be taken over. Ask it something or tell it what to do instead.", 'coordinator', 409);
  const target = await resolveTask(context, token); const id = target.id; const row = target.thread;
  switch (context.action) {
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
  throw new OwnerRefusal('thread takes say, open, return, stop.', 'unknown_action');
};
