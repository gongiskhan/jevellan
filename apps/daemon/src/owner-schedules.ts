import { z } from 'zod';
import { IdSchema, TimestampSchema, newId, ownerClock, ownerLocal, type ProjectJob } from '@jevellan/core';
import type { Application } from './application.js';

const ALIVE = 'owner-alive', MISSED = 'owner-missed-nights', AUTO = 'owner-auto-deploys';
// state point hub namespace owner-auto-deploys, key deployId: deploys the switch approved, watched until they conclude
const AutoDeploySchema = z.strictObject({ schema: z.literal('owner-auto-deploy-v1'), projectId: IdSchema, deployId: IdSchema, mode: z.enum(['nightly', 'automatic']), at: TimestampSchema, handled: z.boolean() });
const AliveSchema = z.strictObject({ schema: z.literal('owner-alive-v1'), at: TimestampSchema, startedAt: TimestampSchema });
// state point hub namespace owner-missed-nights, key `${projectId}_${date}`
export const MissedNightSchema = z.strictObject({ schema: z.literal('owner-missed-night-v1'), projectId: IdSchema, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), items: z.array(z.string().max(120)).max(50),
  reason: z.string().max(400), caughtUp: z.boolean(), at: TimestampSchema });
export type MissedNight = z.infer<typeof MissedNightSchema>;
const WINDOW_HOURS = 7;

/**
 * Scheduling the state point adds for the bridge (bridge specification, "Missed nights" and "What jobs shows"): interval command jobs
 * between two local times (no misses), the optional heartbeat, and the record of nights the state point could not run. It never builds
 * a second scheduler: runs go through the existing Run now, windows through the existing night window.
 */
export class OwnerSchedules {
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastHeartbeat = 0;
  readonly #previousAlive: string | null;
  constructor(private readonly app: Application, readonly now: () => number = Date.now, readonly fetcher: typeof fetch = fetch) {
    this.#previousAlive = app.hub.get(ALIVE, 'state-point', AliveSchema)?.document.at ?? null;
    this.#alive();
  }
  start(): void { if (!this.#timer) { this.#timer = setInterval(() => { void this.tick().catch(() => undefined); }, 60_000); this.#timer.unref(); } }
  close(): void { clearInterval(this.#timer); this.#timer = undefined; }
  #alive(): void {
    const stored = this.app.hub.get(ALIVE, 'state-point', AliveSchema); const at = new Date(this.now()).toISOString();
    this.app.hub.put(ALIVE, 'state-point', AliveSchema, { schema: 'owner-alive-v1', at, startedAt: stored && stored.document.at === this.#previousAlive ? at : stored?.document.startedAt ?? at }, stored?.revision ?? 0);
  }
  async tick(): Promise<void> {
    this.#alive();
    await this.intervals();
    await this.autoDeploy().catch(() => undefined);
    await this.heartbeat();
  }

  /**
   * The deploy switch (bridge specification, "Deploy switch"): in nightly mode the open deploy message is approved once the night's full
   * suite passed on its pinned commit; in automatic mode also `debounceMinutes` after the last landing (at most 30 minutes after the first).
   * Approval goes through the owner's own answer path, so health checks, rollback and the database exception apply unchanged. A deploy
   * that changes the database waits for the owner; an automatic deploy that fails or is rolled back pauses deploys.
   */
  async autoDeploy(): Promise<void> {
    for (const project of await this.app.ownerTools.projects()) {
      const view = await this.app.projectWork.view(project.id).catch(() => null); if (!view) continue;
      const owner = this.app.ownerTools.projectSettings(project.id); const records = (await this.app.projectWork.deploys.view(project.id)).records;
      for (const auto of this.app.hub.list(AUTO, AutoDeploySchema).map(row => row.document).filter(row => row.projectId === project.id && !row.handled)) {
        const record = records.find(row => row.id === auto.deployId); if (!record) continue;
        if (record.state === 'failed' || record.rollback) {
          this.app.ownerTools.updateProjectSettings(project.id, current => ({ ...current, deploy: { ...current.deploy, paused: true } }));
          this.app.ownerPushes.add({ projectId: project.id, kind: 'deploy', key: `auto-paused:${record.id}`, urgent: true, text: `Deploy ${record.commit.slice(0, 7)} ${record.rollback ? 'was rolled back' : 'failed'}. Automatic deploys are paused until you resume them.` });
          this.#auto({ ...auto, handled: true });
        } else if (record.state === 'deployed') this.#auto({ ...auto, handled: true });
      }
      const mode = view.settings.deploy.mode; if (mode === 'approve' || owner.deploy.paused) continue;
      const decision = view.decisions.open.find(row => row.deploy?.action === 'approve'); if (!decision) continue;
      const record = records.find(row => row.id === decision.deploy!.deployId); if (!record || record.state !== 'open') continue;
      const suitePassed = record.suite.conclusion === 'passed' && record.suite.commit === record.commit;
      const landings = record.threads.flatMap(thread => { const row = view.threads.find(entry => entry.id === thread.threadId); return row?.landing ? [Date.parse(row.landing.at)] : []; });
      const settled = landings.length > 0 && (this.now() - Math.max(...landings) >= owner.deploy.debounceMinutes * 60_000 || this.now() - Math.min(...landings) >= 30 * 60_000);
      if (!(suitePassed || (mode === 'automatic' && settled))) continue;
      if (await this.app.projectWork.deploys.changesDatabase(project.id, record.id)) {
        this.app.ownerPushes.add({ projectId: project.id, kind: 'deploy', key: `database:${record.id}:${record.commit}`, ref: this.app.ownerTools.ids.one(project.id, 'W', decision.id),
          text: `Deploy ${record.commit.slice(0, 7)} is ready, but it changes the database, so it waits for your approval.` });
        continue;
      }
      const option = decision.options.find(entry => entry.label.startsWith('Deploy ')); if (!option) continue;
      await this.app.projectWork.answerDecision(project.id, decision.id, { schema: 'decision-answer-request-v1', clientRequestId: `auto_${record.id}`.slice(0, 128), expectedRevision: decision.revision, optionLabel: option.label });
      this.#auto({ schema: 'owner-auto-deploy-v1', projectId: project.id, deployId: record.id, mode, at: new Date(this.now()).toISOString(), handled: false });
      this.app.ownerEvents.publish({ projectId: project.id, source: 'jevellan', kind: 'state', text: `${mode} deploy of ${record.commit.slice(0, 7)} approved by the deploy switch` });
    }
  }
  #auto(row: z.infer<typeof AutoDeploySchema>): void { const stored = this.app.hub.get(AUTO, row.deployId, AutoDeploySchema); this.app.hub.put(AUTO, row.deployId, AutoDeploySchema, row, stored?.revision ?? 0); }

  /** Interval command jobs: due when inside their local hours and no run of theirs started within the interval. */
  async intervals(): Promise<void> {
    for (const project of await this.app.ownerTools.projects()) {
      const view = await this.app.projectWork.daily.view(project.id).catch(() => null); if (!view) continue;
      const tz = (await this.app.projectWork.view(project.id)).settings.nightlyWindow.timezone;
      for (const job of view.jobs) {
        if (!job.interval || job.paused || !job.enabled) continue;
        const last = [...view.runs].filter(run => run.jobId === job.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        const pending = view.tasks.some(task => task.jobId === job.id && ['queued', 'active'].includes(task.state));
        if (pending || !this.due(job.interval, last?.startedAt ?? null, tz)) continue;
        await this.app.projectWork.daily.runJob(project.id, job.id, { schema: 'project-run-request-v1', clientRequestId: newId('interval') }).catch(() => undefined);
      }
    }
  }
  due(interval: NonNullable<ProjectJob['interval']>, lastStartedAt: string | null, tz: string): boolean {
    const clock = ownerLocal(new Date(this.now()), tz).clock;
    const inside = interval.start <= interval.end ? clock >= interval.start && clock < interval.end : clock >= interval.start || clock < interval.end;
    return inside && (!lastStartedAt || this.now() - Date.parse(lastStartedAt) >= interval.everyMinutes * 60_000);
  }
  /** The next run of an interval job, as the owner reads it. */
  nextInterval(interval: NonNullable<ProjectJob['interval']>, lastStartedAt: string | null, tz: string): string {
    const now = new Date(this.now());
    if (this.due(interval, lastStartedAt, tz)) return 'within a minute';
    const candidate = lastStartedAt ? Date.parse(lastStartedAt) + interval.everyMinutes * 60_000 : this.now();
    for (let at = Math.max(candidate, this.now()); at < this.now() + 2 * 86_400_000; at += 60_000) {
      const clock = ownerLocal(new Date(at), tz).clock;
      if (interval.start <= interval.end ? clock >= interval.start && clock < interval.end : clock >= interval.start || clock < interval.end) return ownerClock(new Date(at), now, tz);
    }
    return 'not scheduled';
  }

  /** Optional heartbeat (bridge specification): `GET {url}` every `intervalMinutes`, so an outside checker notices the machine is down. */
  async heartbeat(): Promise<void> {
    const settings = this.app.ownerTools.installationSettings().heartbeat; if (!settings.url) return;
    if (this.now() - this.#lastHeartbeat < settings.intervalMinutes * 60_000 - 5000) return;
    this.#lastHeartbeat = this.now();
    await this.fetcher(settings.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) }).then(response => response.body?.cancel()).catch(() => undefined);
  }

  /**
   * The night guard: a window that should have opened while the state point was down opens late as a catch-up only within
   * `night.catchUpHours` after the window would have ended; later, the night is recorded as missed and its items run the next night.
   * Either way one `night_missed` push says so.
   */
  async nightGuard(projectId: string, date: string, latenessMs: number, items: readonly string[]): Promise<{ open: true } | { open: false; outcome: string }> {
    const catchUp = this.app.ownerTools.projectSettings(projectId).night.catchUpHours;
    const downSince = this.#previousAlive; const tz = (await this.app.projectWork.view(projectId)).settings.nightlyWindow.timezone; const now = new Date(this.now());
    const reason = downSince ? `state point down from ${ownerClock(downSince, now, tz)} to ${ownerClock(this.app.hub.get(ALIVE, 'state-point', AliveSchema)?.document.startedAt ?? now.toISOString(), now, tz)}` : 'state point was not running at the window';
    const tooLate = latenessMs > (WINDOW_HOURS + catchUp) * 3600_000;
    // A window less than its own length late is an ordinary late start, not a missed night.
    if (latenessMs <= WINDOW_HOURS * 3600_000 && !tooLate) return { open: true };
    const record: MissedNight = { schema: 'owner-missed-night-v1', projectId, date, items: [...items], reason, caughtUp: !tooLate, at: now.toISOString() };
    const key = `${projectId}_${date}`; const stored = this.app.hub.get(MISSED, key, MissedNightSchema);
    if (!stored) this.app.hub.put(MISSED, key, MissedNightSchema, record, 0);
    this.app.ownerPushes.add({ projectId, kind: 'night_missed', key: `night:${date}`,
      text: `Missed last night's ${items.join(', ')} (${reason}). ${tooLate ? 'Outside the catch-up window; they run tonight.' : 'Running them now as a catch-up.'}` });
    return tooLate ? { open: false, outcome: `Missed: ${reason}. Outside the ${catchUp}-hour catch-up window; the items run the next night.` } : { open: true };
  }
  missed(projectId: string, days: number): MissedNight[] {
    const since = this.now() - days * 86_400_000;
    return this.app.hub.list(MISSED, MissedNightSchema).map(row => row.document).filter(row => row.projectId === projectId && Date.parse(row.at) >= since).sort((a, b) => b.date.localeCompare(a.date));
  }
}
