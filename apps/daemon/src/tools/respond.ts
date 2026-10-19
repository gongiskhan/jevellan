import { waitingKind } from '@jevellan/projects';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { clientId, matchOption, resolveWaiting } from './common.js';

/**
 * `respond`: answers through the same path as the decision card and the external task mirror, so the item updates everywhere
 * (bridge specification, `respond`).
 */
export const respond: OwnerHandler = async (context) => {
  const { app, project, args } = context; const engine = app.projectWork; const answer = String(args.answer); const note = typeof args.note === 'string' ? args.note : undefined;
  const item = await resolveWaiting(context, String(args.item));
  if (item.held) {
    const option = matchOption(['keep', 'return'], answer); if (!option) throw new OwnerRefusal(`${item.id} takes keep, return.`, 'invalid_answer');
    return { text: await context.tools.takeover.answerIdle(context, item.held, option as 'keep' | 'return') };
  }
  if (item.draft) {
    const option = matchOption(['Start', 'Reject'], answer); if (!option) throw new OwnerRefusal(`${item.id} takes Start or Reject.`, 'invalid_answer');
    await engine.taskAction(project.id, item.draft.id, { schema: 'task-action-request-v1', expectedRevision: item.draft.revision, action: option === 'Start' ? 'approve' : 'reject', ...(note ? { reason: note } : {}) });
    return { text: option === 'Start' ? `Started the proposed task. It is queued now.` : `Rejected the proposed task.` };
  }
  const decision = item.decision!; const options = decision.options.map(option => option.label); const kind = waitingKind(decision);
  if (!options.length) {
    await engine.answerDecision(project.id, decision.id, { schema: 'decision-answer-request-v1', clientRequestId: clientId('owner_answer'), text: answer.slice(0, 4000) });
    return { text: `Sent your answer to ${decision.from === 'coordinator' || !decision.threadId ? 'the coordinator' : (context.tools.ids.shortOf(project.id, decision.threadId) ?? 'the thread')}.` };
  }
  const option = matchOption(options, answer);
  if (!option) throw new OwnerRefusal(`${item.id} takes ${options.join(', ')}.`, 'invalid_answer');
  const paused = await context.tools.deployPaused(project.id);
  if (kind === 'deploy' && option.startsWith('Deploy ') && paused) throw new OwnerRefusal('Deploys are paused. Turn them back on with config deploy.paused.', 'deploys_paused', 409);
  await engine.answerDecision(project.id, decision.id, { schema: 'decision-answer-request-v1', clientRequestId: clientId('owner_answer'), expectedRevision: decision.revision, optionLabel: option, ...(note ? { text: note } : {}) });
  if (kind === 'deploy') {
    if (option === 'Not now') return { text: `Not now. ${item.id} stays open and keeps updating.` };
    const deploy = (await engine.deploys.view(project.id)).records.find(row => row.id === decision.deploy!.deployId);
    const run = deploy?.jobRunId ? await context.tools.runId(project.id, deploy.jobRunId) : undefined;
    return { text: `Deploying ${option.slice('Deploy '.length)} with ${deploy?.threads.length ?? 0} threads${run ? ` (${run})` : ''}. Health checks run 1 and 5 minutes after; the result is pushed.` };
  }
  if (kind === 'deploy_failed') return { text: option === 'Try again' ? 'Trying the deploy again.' : 'Left it.' };
  if (kind === 'rollback_question') {
    const deploy = (await engine.deploys.view(project.id)).records.find(row => row.id === decision.deploy!.deployId);
    return { text: option.startsWith('Roll back to ') ? `Rolling back to ${option.slice('Roll back to '.length)}.` : `Left it. Production stays on ${deploy?.commit.slice(0, 7) ?? 'the deployed commit'}.` };
  }
  return { text: `Answered ${item.id}: ${option}.` };
};
