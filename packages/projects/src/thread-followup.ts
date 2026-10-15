import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ThreadMessageRouteSchema, readDocument, writeDocument, type Configuration, type Project, type ProjectWorkSettings, type Thread, type ThreadMessageRoute } from '@jevellan/core';
import { decideProjectOutcome, type DecisionClient, type PlacementFixed } from '@jevellan/decisions';
import type { Placement } from './placement.js';
import type { ProjectPaths } from './paths.js';

/** Owner follow-ups use the same intent and resource decisions as new work, without moving their workspace. */
export class ThreadFollowups {
  constructor(private readonly o: { paths: ProjectPaths; placement: Pick<Placement, 'place'>;
    settings(): Promise<Configuration['x-jevellan']>; project(id: string): Promise<Project>; workSettings(id: string): Promise<ProjectWorkSettings>;
    client?: (() => Promise<DecisionClient>) | undefined }) {}

  async route(thread: Thread, body: string, messageIds: string[], signal: AbortSignal): Promise<ThreadMessageRoute> {
    const digest = createHash('sha256').update(JSON.stringify([messageIds, body])).digest('hex');
    const file = join(this.o.paths.thread(thread.projectId, thread.id), 'message-routes', `${digest}.json`);
    if (existsSync(file)) return readDocument(file, ThreadMessageRouteSchema);
    const history = `Original task: ${thread.title}\n${thread.task}\nLast report: ${thread.lastReport?.summary ?? '(none)'}`;
    const outcome = await decideProjectOutcome(this.o.client, { projectId: thread.projectId, eventId: messageIds[0]!, request: body,
      history, model: (await this.o.settings()).decisions.model }, signal);
    const current = thread.placement;
    const fixed: PlacementFixed = { isolation: thread.isolation, deviceId: thread.ownerDeviceId,
      ...(current.fixed.includes('runtime') ? { runtimeId: current.runtime } : {}),
      ...(current.fixed.includes('model') ? { modelId: current.modelId } : {}),
      ...(current.fixed.includes('effort') ? { effort: current.effortRequested } : {}),
      ...(current.fixed.includes('account') ? { accountId: current.accountId } : {}) };
    const chosen = await this.o.placement.place({ project: await this.o.project(thread.projectId), workSettings: await this.o.workSettings(thread.projectId),
      title: thread.title, task: `${body}\n\nPrevious work:\n${history}`.slice(0, 32768), taskContext: thread.taskContext,
      note: `Continue this thread in its existing workspace. Choose automatic provider, model, effort and saved account for the new request. Current session: ${current.runtime}, ${current.model}, ${current.effortEffective}, account ${current.accountId}. Prefer its continuity when suitable; changing provider, model or account starts a fresh session with the thread history.`,
      fixed, coordinatorDeviceId: thread.coordinatorDeviceId, ignoreRunningLimit: true, exclude: thread.id, signal });
    if (chosen.kind === 'refused') throw new Error(chosen.message);
    // With every field fixed Jev is asked nothing: when that lands on the same placement, the recorded one (with Jev's original
    // probabilities and the owner's changes) stays, so the Why panel keeps explaining it.
    const next = chosen.record;
    const unchanged = next.source === 'fixed' && next.runtime === current.runtime && next.modelId === current.modelId && next.model === current.model
      && next.effortRequested === current.effortRequested && next.effortEffective === current.effortEffective && next.accountId === current.accountId
      && next.deviceId === current.deviceId && next.isolation === current.isolation;
    return writeDocument(file, ThreadMessageRouteSchema, { schema: 'thread-message-route-v1', projectId: thread.projectId, threadId: thread.id,
      messageIds, digest, outcome, placement: unchanged ? current : next, modelLabel: chosen.labels.modelLabel });
  }
}
