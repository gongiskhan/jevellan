import { createHash } from 'node:crypto';
import { OwnerPushMessageSchema, OwnerPushSchema, ProjectDecisionSchema, ProjectNotificationSchema, ProjectSchema, StoredProjectWorkSettingsSchema, defaultProjectNotifications, ownerClock,
  type OwnerPush, type OwnerPushMessage, type PushKind } from '@jevellan/core';
import { waitingKind } from '@jevellan/projects';
import type { Application } from './application.js';
import { insideQuietHours } from './notifications.js';
import { coordinatorReply } from './tools/ask-coordinator.js';

const NAMESPACE = 'owner-pushes';
const DAY = 24 * 3600_000;
const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 40);
const line = (text: string, max = 600) => { const one = text.replace(/\s+/gu, ' ').trim(); return one.length > max ? `${one.slice(0, max - 3)}...` : one; };

/**
 * The bridge's push queue (bridge specification, "Push"). It is fed by the same pipeline as web push and the external task mirror:
 * open decision items and the hub's notification documents (deploys, rollbacks, coordinator outages), plus replies to the bridge's
 * own messages. Only items waiting on the owner and Jevellan's system events push; quiet hours hold all but urgent ones; more than
 * three at once go out as one message; the forwarder acks what it sent and gets everything unacked again when it reconnects.
 */
export class OwnerPushes {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #lastHeavy = 0;
  constructor(private readonly app: Application, private readonly now: () => number = Date.now) {}
  start(): void { if (!this.#timer) { this.#timer = setInterval(() => { void this.sweep().catch(() => undefined); }, 2000); this.#timer.unref(); } }
  close(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  #enabled(projectId: string, kind: PushKind): boolean { return this.app.ownerTools.projectSettings(projectId).push.kinds[kind] !== false; }

  /** Adds a push once (its id is derived from what it is about). */
  add(input: { projectId: string; kind: PushKind; text: string; urgent?: boolean; key: string; ref?: string; at?: string }): OwnerPush | null {
    if (!this.#enabled(input.projectId, input.kind)) return null;
    const id = `push_${hash(input.projectId, input.kind, input.key)}`; const hub = this.app.hub;
    const existing = hub.get(NAMESPACE, id, OwnerPushSchema); if (existing) return existing.document;
    const document = OwnerPushSchema.parse({ schema: 'owner-push-v1', id, projectId: input.projectId, kind: input.kind, text: line(this.app.redactor.text(input.text), 4000), urgent: input.urgent === true,
      ...(input.ref ? { ref: input.ref } : {}), createdAt: input.at ?? new Date(this.now()).toISOString() });
    hub.put(NAMESPACE, id, OwnerPushSchema, document, 0);
    this.app.ownerEvents.publish({ projectId: input.projectId, source: 'jevellan', kind: 'push', text: document.text });
    return document;
  }

  sweep(): Promise<void> {
    if (this.#running) return this.#running;
    const task = this.#sweep().finally(() => { this.#running = undefined; }); this.#running = task; return task;
  }
  async #sweep(): Promise<void> {
    const hub = this.app.hub; const now = this.now(); const cutoff = now - DAY;
    // Items waiting on the owner.
    for (const { document: decision } of hub.list('project-decisions', ProjectDecisionSchema)) {
      if (decision.answer || decision.withdrawnAt || Date.parse(decision.createdAt) < cutoff) continue;
      if (!hub.get('projects', decision.projectId, ProjectSchema)) continue;
      const id = this.app.ownerTools.ids.one(decision.projectId, 'W', decision.id);
      const from = decision.threadId ? this.app.ownerTools.ids.shortOf(decision.projectId, decision.threadId) ?? 'a thread' : 'The coordinator';
      const options = decision.options.map(option => option.label);
      const kind = waitingKind(decision);
      if (kind === 'deploy' || kind === 'deploy_failed' || kind === 'rollback_question') {
        this.add({ projectId: decision.projectId, kind: 'deploy', key: `decision:${decision.id}`, ref: id, urgent: decision.urgent === true, at: decision.createdAt,
          text: `${id} waiting on you: ${line(decision.question)} Options: ${options.join(', ')}` });
        continue;
      }
      this.add({ projectId: decision.projectId, kind: 'waiting_created', key: `decision:${decision.id}`, ref: id, urgent: decision.urgent === true, at: decision.createdAt,
        text: options.length ? `${id} waiting on you: ${line(decision.question)} Options: ${options.join(', ')}` : `${id} ${from} asks: ${line(decision.question)}` });
    }
    // Jevellan's system events, with the existing notification copy.
    for (const { document: notification } of hub.list('project-notifications', ProjectNotificationSchema)) {
      if (!notification.projectId || Date.parse(notification.createdAt) < cutoff) continue;
      if (notification.kind === 'deploy') this.add({ projectId: notification.projectId, kind: 'deploy', key: `notification:${notification.id}`, urgent: notification.urgent === true, at: notification.createdAt, text: `${notification.title}: ${notification.body}` });
      else if (notification.kind === 'coordinator-unavailable') this.add({ projectId: notification.projectId, kind: 'coordinator_crashed', key: `notification:${notification.id}`, at: notification.createdAt, text: `${notification.title}: ${notification.body}` });
    }
    // Failed job and night runs, exhausted budgets and a coordinator that shows no activity while marked running: these read whole
    // project views, so they run every 30 seconds rather than on every sweep.
    const heavy = now - this.#lastHeavy >= 30_000; if (heavy) this.#lastHeavy = now;
    for (const project of heavy ? await this.app.ownerTools.projects() : []) {
      const daily = await this.app.projectWork.daily.view(project.id).catch(() => null); if (!daily) continue;
      const names = new Map([...daily.jobs.map(job => [job.id, job.name] as const), ...daily.dailies.flatMap(item => item.target.kind === 'job' ? [[item.target.jobId, item.name] as const] : [])]);
      for (const run of daily.runs) {
        if (!run.endedAt || !['failed', 'timed-out'].includes(run.conclusion ?? '') || Date.parse(run.endedAt) < cutoff) continue;
        const id = this.app.ownerTools.ids.one(project.id, 'J', run.id);
        this.add({ projectId: project.id, kind: 'job_failed', key: `run:${run.id}`, ref: id, at: run.endedAt, text: `${names.get(run.jobId) ?? 'A job'} failed (${id}): ${line(run.summary || run.conclusion || 'failed', 300).replace(/\.$/u, '')}.` });
      }
      const view = await this.app.projectWork.view(project.id).catch(() => null);
      if (view?.coordinator.state === 'running') {
        const last = this.app.projectWork.coordinatorLedger(project.id).events().at(-1);
        if (last && now - Date.parse(last.t) >= 20 * 60_000) this.add({ projectId: project.id, kind: 'coordinator_stalled', key: `stalled:${last.id}`, text: `The coordinator for ${project.name} has shown no activity for 20 min while marked running.` });
      }
    }
    for (const row of heavy ? await this.app.accounts.list().catch(() => []) : []) {
      const usage = [...row.statuses].sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]?.usage; if (!usage) continue;
      const used = Math.max(usage.weeklyPct ?? 0, usage.fiveHourPct ?? 0); const budget = row.account.ceilingPct ?? 90; if (used < budget) continue;
      const resets = (usage.weeklyPct ?? 0) >= budget ? usage.weeklyResetsAt : usage.fiveHourResetsAt;
      for (const project of await this.app.ownerTools.projects()) this.add({ projectId: project.id, kind: 'budget_exhausted', key: `budget:${row.account.id}:${resets ?? ''}`,
        text: `Account ${row.account.label} reached its ${budget}% budget. New work waits for another eligible account${resets ? ` or until ${ownerClock(resets, new Date(now), 'Europe/Lisbon')}` : ''}.` });
    }
    // Replies to the bridge's own messages to the coordinator.
    for (const [clientMessageId, pending] of [...this.app.ownerTools.awaitingReplies()]) {
      const project = hub.get('projects', pending.projectId, ProjectSchema)?.document; if (!project) { this.app.ownerTools.coordinatorReplyDelivered(clientMessageId); continue; }
      const reply = await coordinatorReply({ app: this.app, project } as never, clientMessageId, 0.001).catch(() => null);
      if (reply === null) continue;
      this.app.ownerTools.coordinatorReplyDelivered(clientMessageId);
      if (pending.question !== undefined) this.add({ projectId: project.id, kind: 'coordinator_answer', key: `reply:${clientMessageId}`, text: `Coordinator answered "${pending.question.slice(0, 80)}": ${line(reply)}` });
      else this.add({ projectId: project.id, kind: 'coordinator_reply', key: `reply:${clientMessageId}`, text: `Coordinator replied: ${line(reply)}` });
    }
    await this.app.ownerLogins.sweep().catch(() => undefined);
    // Unacked pushes older than a day leave the queue; they stay in status and activity.
    for (const { document, revision } of hub.list(NAMESPACE, OwnerPushSchema)) {
      if (!document.ackedAt && !document.droppedAt && Date.parse(document.createdAt) < cutoff) hub.put(NAMESPACE, document.id, OwnerPushSchema, { ...document, droppedAt: new Date(now).toISOString() }, revision);
    }
  }

  /** What the bridge should receive now: urgent pushes always; others outside quiet hours, the held ones as one summary. */
  messages(projectId: string): OwnerPushMessage[] {
    const hub = this.app.hub; const now = this.now();
    const pending = hub.list(NAMESPACE, OwnerPushSchema).map(row => row.document).filter(push => push.projectId === projectId && !push.ackedAt && !push.droppedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!pending.length) return [];
    const preferences = hub.get('project-work-settings', projectId, StoredProjectWorkSettingsSchema)?.document.notifications ?? defaultProjectNotifications;
    const quiet = insideQuietHours(now, preferences.quietHours);
    const message = (pushes: OwnerPush[], kind: OwnerPushMessage['kind'], text: string, ref?: string): OwnerPushMessage =>
      OwnerPushMessageSchema.parse({ schema: 'owner-push-message-v1', id: `pushmsg_${hash(...pushes.map(push => push.id))}`, projectId, pushIds: pushes.map(push => push.id), kind, ...(ref ? { ref } : {}), text: text.slice(0, 12000) });
    const urgent = pending.filter(push => push.urgent); let ordinary = pending.filter(push => !push.urgent);
    const out = urgent.map(push => message([push], push.kind, `[Jevellan] ${push.text}`, push.ref));
    // Held durably, like web push: a push created or waiting inside quiet hours stays held until they end, then goes in one summary.
    if (quiet) ordinary = ordinary.map(push => push.heldAt ? push : this.#hold(push, now));
    if (quiet || !ordinary.length) return out;
    const heldOver = ordinary.filter(push => push.heldAt || insideQuietHours(Date.parse(push.createdAt), preferences.quietHours));
    if (heldOver.length) {
      out.push(message(ordinary, 'quiet_summary', `[Jevellan] ${ordinary.length} update${ordinary.length === 1 ? '' : 's'} while you were away:\n${ordinary.map(push => push.text).join('\n')}`));
      return out;
    }
    const batchSeconds = this.app.ownerTools.projectSettings(projectId).push.batchSeconds;
    const recent = ordinary.filter(push => now - Date.parse(push.createdAt) <= batchSeconds * 1000);
    if (ordinary.length > 3 && recent.length > 3) { out.push(message(ordinary, 'batch', `[Jevellan] ${ordinary.length} updates:\n${ordinary.map(push => push.text).join('\n')}`)); return out; }
    for (const push of ordinary) out.push(message([push], push.kind, `[Jevellan] ${push.text}`, push.ref));
    return out;
  }
  #hold(push: OwnerPush, now: number): OwnerPush {
    const stored = this.app.hub.get(NAMESPACE, push.id, OwnerPushSchema); if (!stored || stored.document.heldAt) return stored?.document ?? push;
    return this.app.hub.put(NAMESPACE, push.id, OwnerPushSchema, { ...stored.document, heldAt: new Date(now).toISOString() }, stored.revision).document;
  }
  ack(projectId: string, pushIds: readonly string[]): number {
    const hub = this.app.hub; let count = 0; const at = new Date(this.now()).toISOString();
    for (const id of pushIds) {
      const stored = hub.get(NAMESPACE, id, OwnerPushSchema);
      if (!stored || stored.document.projectId !== projectId || stored.document.ackedAt) continue;
      hub.put(NAMESPACE, id, OwnerPushSchema, { ...stored.document, ackedAt: at }, stored.revision); count++;
    }
    return count;
  }
  /**
   * An ack means the forwarder wrote the push, not that the session took it: a bridge that is shutting down still acks. When the bridge
   * starts again, every push acked since the previous start whose text is not in that session's transcript is sent again.
   */
  requeueUndelivered(projectId: string, since: number, transcript: string): number {
    const hub = this.app.hub; let count = 0;
    for (const { document: push, revision } of hub.list(NAMESPACE, OwnerPushSchema)) {
      if (push.projectId !== projectId || !push.ackedAt || push.droppedAt || Date.parse(push.ackedAt) < since) continue;
      if (transcript.includes(JSON.stringify(push.text).slice(1, -1))) continue;
      const { ackedAt: _acked, ...rest } = push; void _acked;
      hub.put(NAMESPACE, push.id, OwnerPushSchema, rest, revision); count++;
    }
    return count;
  }
  /** One line per push for tests and the run log. */
  describe(projectId: string): string[] { return this.app.hub.list(NAMESPACE, OwnerPushSchema).map(row => row.document).filter(row => row.projectId === projectId).map(row => `${ownerClock(row.createdAt, new Date(this.now()), 'Europe/Lisbon')} ${row.kind} ${row.text}`); }
}
