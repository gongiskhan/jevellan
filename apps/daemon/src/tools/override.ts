import { EffortSchema, newId, ownerClock, type LandingRoute } from '@jevellan/core';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';

/** `override` (bridge specification): undo what followed a decision and redo it the owner's way, or only record the lesson. */
export const override: OwnerHandler = async (context) => {
  const { app, tools, project, args, now } = context; const engine = app.projectWork; const projectId = project.id;
  await tools.status(project);
  const token = String(args.decision).toUpperCase(); const found = tools.ids.resolve(projectId, token);
  if (!found || !found.shortId.startsWith('D')) throw new OwnerRefusal(`${token} is not a decision. See decisions with activity kind decisions.`, 'not_found', 404);
  const mode = args.mode as 'override_undo' | 'override_only'; const choice = String(args.choice); const reason = String(args.reason);
  const view = await engine.view(projectId); const tz = view.settings.nightlyWindow.timezone;
  const routes = (await engine.landings.records(projectId)).filter((row): row is LandingRoute => row.schema === 'landing-route-v1');
  const route = routes.find(row => row.id === found.internalId);
  const threadId = route?.threadId ?? (found.internalId.startsWith('placement-') ? found.internalId.slice('placement-'.length) : undefined);
  const thread = view.threads.find(row => row.id === threadId);
  if (!thread) throw new OwnerRefusal(`${found.shortId} can't be undone (its thread is gone). Use override_only.`, 'not_available', 409);
  const lesson = () => app.ownerJev.addLesson(projectId, { text: reason, about: route ? 'landing' : 'placement', source: `override:${found.shortId}` });
  const t = tools.ids.shortOf(projectId, thread.id) ?? thread.title;
  if (mode === 'override_only') { const recorded = lesson(); return { text: `Recorded override of ${found.shortId}. Nothing was changed. Lesson ${recorded.id} recorded for ${project.name}: "${reason}".` }; }
  if (route) {
    const wanted = (['land', 'verify-then-land', 'ask-owner'] as const).find(name => name === choice.toLowerCase());
    if (!wanted) throw new OwnerRefusal('A landing route override takes land, verify-then-land or ask-owner.', 'invalid_choice');
    if (route.state !== 'landed' && !thread.landing) {
      if (!await engine.landings.ownerRoute(projectId, thread.id, wanted)) throw new OwnerRefusal(`${found.shortId} can't be undone (the route is no longer current). Use override_only.`, 'not_available', 409);
      const recorded = lesson(); return { text: `Overrode ${found.shortId}: ${t} now takes the ${wanted} route. Lesson ${recorded.id} recorded for ${project.name}: "${reason}".` };
    }
    // Landed: a revert lands through the normal flow, and the work comes back as a task with the owner's note.
    const landing = thread.landing!; const merge = landing.method === 'merge-commit';
    await engine.createTask(projectId, { schema: 'task-create-request-v1', clientRequestId: newId('owner_revert'), title: `Revert ${thread.title}`.slice(0, 120), type: 'fix', goalId: null, now: true, after: [], needs: [], fixed: {},
      brief: `Revert the landing commit ${landing.commit} of "${thread.title}" with \`git revert --no-edit ${merge ? '-m 1 ' : ''}${landing.commit}\`, resolve nothing else, and report done. The owner overrode its landing: ${reason}`.slice(0, 20000) });
    await engine.createTask(projectId, { schema: 'task-create-request-v1', clientRequestId: newId('owner_redo'), title: `Redo ${thread.title}`.slice(0, 120), type: 'feature', goalId: null, now: false, after: [], needs: [], fixed: {},
      brief: `Redo "${thread.title}" after its revert lands. The owner's note: ${reason}`.slice(0, 20000) });
    const deployed = (await engine.deploys.view(projectId)).records.some(row => row.state === 'deployed' && row.threads.some(entry => entry.threadId === thread.id));
    const recorded = lesson();
    return { text: `Overrode ${found.shortId}: a revert of ${landing.commit.slice(0, 7)} lands through the normal flow and ${t} is queued again with your note. Lesson ${recorded.id} recorded for ${project.name}: "${reason}".${deployed ? ' The revert reaches production with the next deploy message.' : ''}` };
  }
  // A placement: the thread restarts on the owner's choice from the start of its task.
  const effort = EffortSchema.safeParse(choice.toLowerCase());
  const accounts = await app.accounts.list(); const account = accounts.find(row => row.account.label.toLowerCase() === choice.toLowerCase());
  const menu = (await app.configuration()).configuration['x-jevellan'].menu; const model = menu.find(row => row.id === choice || row.label.toLowerCase() === choice.toLowerCase() || row.model === choice);
  if (!effort.success && !account && !model) throw new OwnerRefusal(`${choice} is not an effort, an account or a model. Efforts: ${EffortSchema.options.join(', ')}.`, 'invalid_choice');
  if (thread.state === 'attached') throw new OwnerRefusal(`${t} is held by you. Hand it back first.`, 'held', 409);
  await engine.overrideThread(projectId, thread.id, { schema: 'thread-override-request-v1', clientRequestId: newId('owner_override'), mode: 'restart',
    ...(effort.success ? { effort: effort.data } : {}), ...(account ? { accountId: account.account.id } : {}), ...(model ? { modelId: model.id } : {}), note: reason.slice(0, 400) });
  const recorded = lesson();
  return { text: `Overrode ${found.shortId}: ${t} restarts on ${choice} from the commit at ${ownerClock(thread.createdAt, now, tz)}. Work after that point is discarded. Lesson ${recorded.id} recorded for ${project.name}: "${reason}".` };
};
