import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { IdSchema, TimestampSchema, installedCommand, newId, ownerClock, ownerDuration, quote, type Project, type ThreadIndex } from '@jevellan/core';
import type { Application } from './application.js';
import type { TmuxRunner } from './owner-bridge.js';
import { OwnerRefusal, type OwnerContext } from './owner-tools.js';

const NAMESPACE = 'owner-holds';
// state point hub namespace owner-holds, key threadId: a thread the owner took over (bridge specification, "open (takeover)")
export const OwnerHoldSchema = z.strictObject({ schema: z.literal('owner-hold-v1'), threadId: IdSchema, projectId: IdSchema, id: z.string().min(1).max(20), title: z.string().max(200),
  since: TimestampSchema, via: z.enum(['remote_control', 'tmux']), tmuxSession: z.string().min(1).max(120), runtime: z.string().max(40), configDir: z.string().max(4096).nullable(), cwd: z.string().max(4096),
  warnedAt: TimestampSchema.optional(), keptAt: TimestampSchema.optional() });
export type OwnerHold = z.infer<typeof OwnerHoldSchema>;
const IDLE_WARNING = 2 * 3600_000, AUTO_RETURN = 15 * 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Takeover (bridge specification, "Threads: say, takeover, hold rules"). Open interrupts a working thread at its next safe point, then
 * runs the installed `jevellan thread attach` in tmux on this device, which marks the thread attached (the hold: no coordinator work,
 * no landing, no cleanup) and resumes its native session, with remote control when the account folder has an interactive login. Return
 * ends that session through tmux; the command hands the thread back, and Jevellan resumes it, sends it to landing or stops it.
 */
export class OwnerTakeover {
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly app: Application, private readonly tmux: TmuxRunner, readonly now: () => number = Date.now, readonly waitMs = 90_000) {}
  start(): void { if (!this.#timer) { this.#timer = setInterval(() => { void this.sweep().catch(() => undefined); }, 60_000); this.#timer.unref(); void this.recover().catch(() => undefined); } }
  close(): void { clearInterval(this.#timer); this.#timer = undefined; }
  holds(projectId?: string): OwnerHold[] { return this.app.hub.list(NAMESPACE, OwnerHoldSchema).map(row => row.document).filter(row => !projectId || row.projectId === projectId); }
  hold(threadId: string): OwnerHold | null { return this.app.hub.get(NAMESPACE, threadId, OwnerHoldSchema)?.document ?? null; }
  #put(hold: OwnerHold | null, threadId: string): void {
    const stored = this.app.hub.get(NAMESPACE, threadId, OwnerHoldSchema);
    if (hold) this.app.hub.put(NAMESPACE, threadId, OwnerHoldSchema, hold, stored?.revision ?? 0); else if (stored) this.app.hub.delete(NAMESPACE, threadId);
  }
  #alive(session: string): boolean { return this.tmux(['has-session', '-t', `=${session}`]).status === 0; }
  #state(threadId: string): string | undefined { return this.app.projectWork.store.get(threadId)?.state; }
  /** The interactive session's newest transcript change, for idle and mid-turn checks. */
  #lastActivity(hold: OwnerHold): number {
    if (!hold.configDir) return Date.parse(hold.keptAt ?? hold.since);
    const directory = join(hold.configDir, 'projects', hold.cwd.replace(/[^A-Za-z0-9]/gu, '-'));
    let newest = Date.parse(hold.keptAt ?? hold.since);
    try { for (const name of readdirSync(directory)) if (name.endsWith('.jsonl')) newest = Math.max(newest, statSync(join(directory, name)).mtimeMs); } catch { /* none yet */ }
    return newest;
  }
  /** Mid-turn: the interactive session wrote its transcript in the last five seconds. */
  #midTurn(hold: OwnerHold): boolean {
    if (!hold.configDir) return false;
    const directory = join(hold.configDir, 'projects', hold.cwd.replace(/[^A-Za-z0-9]/gu, '-')); let newest = 0;
    try { for (const name of readdirSync(directory)) if (name.endsWith('.jsonl')) newest = Math.max(newest, statSync(join(directory, name)).mtimeMs); } catch { return false; }
    return newest > 0 && Date.now() - newest < 5000;
  }

  async open(context: OwnerContext, id: string, row: ThreadIndex | null): Promise<{ text: string }> {
    const { app, project } = context;
    if (!row) throw new OwnerRefusal(`${id} has not started yet. It can be taken over once it runs.`, 'not_running', 409);
    if (row.state === 'publishing' || row.landingStage) throw new OwnerRefusal(`${id} is landing. Take it over after it lands or fails.`, 'landing', 409);
    if (['done', 'stopped', 'failed'].includes(row.state)) throw new OwnerRefusal(`${id} has ended. Continue it with a message instead.`, 'ended', 409);
    if (row.state === 'attached') { const hold = this.hold(row.id); return { text: hold ? `${id} is already yours (tmux ${hold.tmuxSession}).` : `${id} is already attached in a terminal.` }; }
    if (row.ownerDeviceId !== app.device.deviceId) {
      const name = (await app.roster()).devices.find(entry => entry.device.id === row.ownerDeviceId)?.device.name ?? row.ownerDeviceId;
      throw new OwnerRefusal(`${id} runs on ${name}. Take it over there: jevellan call thread open ${id}.`, 'other_device', 409);
    }
    const thread = app.projectWork.store.get(row.id)!;
    if (!['claude', 'codex'].includes(thread.placement.runtime)) throw new OwnerRefusal(`${id} runs on ${thread.placement.runtime}, which has no terminal session to take over.`, 'runtime', 409);
    // Safe point: the in-flight step finishes and the turn ends, then the thread rests.
    if (app.projectWork.pauseThread(project.id, row.id)) {
      const deadline = Date.now() + this.waitMs;
      while (Date.now() < deadline && !['idle', 'waiting-for-you', 'in-review'].includes(this.#state(row.id) ?? '')) await sleep(500);
      if (!['idle', 'waiting-for-you', 'in-review'].includes(this.#state(row.id) ?? '')) throw new OwnerRefusal(`${id} did not reach a safe point within 90 seconds. Try again.`, 'busy', 409);
    }
    const account = await app.accounts.resolve(thread.placement.accountId);
    const remote = thread.placement.runtime === 'claude' && existsSync(join(account.home, '.credentials.json'));
    const session = `jv-${id}`; const title = row.title;
    if (this.#alive(session)) this.tmux(['kill-session', '-t', `=${session}`]);
    const command = [...installedCommand(app.homes), 'thread', 'attach', row.id, ...(remote ? ['--remote-control', `${id} · ${title}`.slice(0, 120)] : [])];
    const started = this.tmux(['new-session', '-d', '-s', session, '-x', '200', '-y', '50', '-c', thread.cwd, '-e', `JEVELLAN_HOME=${app.homes.root}`, command.map(quote).join(' ')]);
    if (started.status !== 0) throw new OwnerRefusal(`tmux could not start the session for ${id}.`, 'tmux_failed', 500);
    const deadline = Date.now() + this.waitMs;
    while (Date.now() < deadline && this.#state(row.id) !== 'attached' && this.#alive(session)) await sleep(500);
    if (this.#state(row.id) !== 'attached') { if (this.#alive(session)) this.tmux(['kill-session', '-t', `=${session}`]); throw new OwnerRefusal(`${id} could not be taken over: its session did not start. It continues with the coordinator.`, 'attach_failed', 409); }
    this.#put(OwnerHoldSchema.parse({ schema: 'owner-hold-v1', threadId: row.id, projectId: project.id, id, title, since: new Date(this.now()).toISOString(), via: remote ? 'remote_control' : 'tmux', tmuxSession: session,
      runtime: thread.placement.runtime, configDir: thread.placement.runtime === 'claude' ? account.home : null, cwd: thread.cwd }), row.id);
    context.tools.steering(project.id, { thread: id, threadId: row.id, kind: 'takeover', by: context.tools.steeringBy(context.request.caller) });
    const device = app.device.name;
    const hand = `While you hold it, the coordinator won't send it work, land it or touch its worktree.\nTo hand it back, say return ${id} to resume it, return ${id} as done to send it to landing, or stop ${id}.`;
    if (thread.placement.runtime === 'codex') return { text: `${id} is yours in the terminal on ${device}: jevellan attach ${id} (tmux session ${session}). Codex threads have no phone view.\n${hand}` };
    if (!remote) return { text: `${id} is yours in the terminal on ${device}: jevellan attach ${id} (tmux session ${session}). Remote control is not available: account ${row.accountLabel} has no interactive Claude login, so it does not show in the Claude app.\n${hand}` };
    return { text: `${id} is yours. In the Claude app, open the session "${id} · ${title}" (account ${row.accountLabel}; it shows only when the app is signed in to that account). In a terminal on ${device}: jevellan attach ${id}.\n${hand}` };
  }

  /** Ends the interactive session (waiting up to 10 minutes for a turn in progress) so the command hands the thread back. */
  async #end(hold: OwnerHold): Promise<void> {
    if (!this.#alive(hold.tmuxSession)) return;
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline && this.#midTurn(hold)) await sleep(1000);
    if (this.#midTurn(hold)) { this.tmux(['send-keys', '-t', `=${hold.tmuxSession}`, 'Escape']); await sleep(1000); }
    this.tmux(['send-keys', '-t', `=${hold.tmuxSession}`, hold.runtime === 'codex' ? '/quit' : '/exit', 'Enter']);
    const exit = Date.now() + 60_000;
    while (Date.now() < exit && this.#state(hold.threadId) === 'attached') await sleep(500);
    if (this.#alive(hold.tmuxSession)) { this.tmux(['kill-session', '-t', `=${hold.tmuxSession}`]); await sleep(1000); }
    if (this.#state(hold.threadId) === 'attached') await this.app.projectWork.detach(hold.threadId);
  }

  async return(context: Pick<OwnerContext, 'app' | 'project' | 'tools' | 'request'>, id: string, row: ThreadIndex | null, as: 'resume' | 'done' | 'stop', note?: string, by?: string): Promise<{ text: string }> {
    const hold = row ? this.hold(row.id) : null;
    if (!row || (!hold && row.state !== 'attached')) throw new OwnerRefusal(`${id} is not held.`, 'not_held', 409);
    const current = hold ?? OwnerHoldSchema.parse({ schema: 'owner-hold-v1', threadId: row.id, projectId: context.project.id, id, title: row.title, since: row.updatedAt, via: 'tmux', tmuxSession: `jv-${id}`, runtime: row.runtime, configDir: null, cwd: '/' });
    await this.#end(current); this.#put(null, row.id);
    const engine = this.app.projectWork; const projectId = context.project.id; const steeringBy = (by ?? context.tools.steeringBy(context.request.caller)) as never;
    context.tools.steering(projectId, { thread: id, threadId: row.id, kind: by === 'jevellan' ? 'auto_return' : as === 'stop' ? 'stop' : 'return', ...(note ? { text: note } : {}), by: steeringBy });
    if (as === 'stop') { await engine.stopThread(projectId, row.id, { schema: 'thread-stop-request-v1', reason: 'Stopped by you after a takeover.' }); return { text: `Stopped ${id}. Its worktree stays until it is resolved.` }; }
    if (as === 'done') {
      await engine.threadAction(projectId, row.id, { schema: 'thread-action-request-v1', clientRequestId: newId('owner_done'), action: row.delivery === 'land' ? 'land-now' : 'publish' });
      return { text: `${id} is marked done and goes to landing.` };
    }
    const tz = (await engine.view(projectId)).settings.nightlyWindow.timezone; const now = new Date(this.now());
    await engine.threadMessage(projectId, row.id, { schema: 'thread-message-request-v1', clientMessageId: newId('owner_return'), interrupt: false,
      text: `[Jevellan] The owner steered this thread directly from ${ownerClock(current.since, now, tz)} to ${ownerClock(now, now, tz)}. Continue from where the conversation is now and keep the coordinator informed as usual.${note ? ` ${note}` : ''}` });
    return { text: `${id} is back with the coordinator and continues from where you left it.` };
  }

  /** Hold rules: a warning after 2 hours idle, an automatic return 15 minutes later, never mid-turn. */
  async sweep(): Promise<void> {
    for (const hold of this.holds()) {
      const project = (await this.app.ownerTools.projects()).find(row => row.id === hold.projectId); if (!project) continue;
      if (!this.#alive(hold.tmuxSession)) { await this.#autoReturn(project, hold, 'gone'); continue; }
      const idleFor = this.now() - this.#lastActivity(hold); if (this.#midTurn(hold)) continue;
      if (hold.warnedAt && this.#lastActivity(hold) > Date.parse(hold.warnedAt)) { this.#put({ ...hold, warnedAt: undefined as never }, hold.threadId); continue; }
      if (!hold.warnedAt && idleFor >= IDLE_WARNING) {
        const warned = { ...hold, warnedAt: new Date(this.now()).toISOString() }; this.#put(warned, hold.threadId);
        const tz = (await this.app.projectWork.view(project.id)).settings.nightlyWindow.timezone;
        const w = this.waitingId(warned);
        this.app.ownerPushes.add({ projectId: project.id, kind: 'held_idle_warning', key: `held:${hold.threadId}:${warned.warnedAt}`, ref: w,
          text: `${hold.id} has been held for ${ownerDuration(idleFor)} with no activity. It goes back to the coordinator at ${ownerClock(new Date(this.now() + AUTO_RETURN), new Date(this.now()), tz)} unless you use it. Answer keep on ${w} to hold it longer.` });
      } else if (hold.warnedAt && this.now() - Date.parse(hold.warnedAt) >= AUTO_RETURN) await this.#autoReturn(project, hold, 'idle');
    }
  }
  waitingId(hold: OwnerHold): string { return this.app.ownerTools.ids.one(hold.projectId, 'W', `held-${hold.threadId}`.slice(0, 128)); }
  async #autoReturn(project: Project, hold: OwnerHold, why: 'idle' | 'gone'): Promise<void> {
    const row = (await this.app.projectWork.view(project.id)).threads.find(thread => thread.id === hold.threadId) ?? null;
    if (!row) { this.#put(null, hold.threadId); return; }
    const context = { app: this.app, project, tools: this.app.ownerTools, request: { schema: 'owner-tool-request-v1' as const, caller: 'cli', args: {} } };
    await this.return(context, hold.id, row, 'resume', undefined, 'jevellan');
    if (why === 'idle') this.app.ownerPushes.add({ projectId: project.id, kind: 'held_auto_return', key: `return:${hold.threadId}:${hold.since}`,
      text: `Handed ${hold.id} back to the coordinator after ${ownerDuration(this.now() - Date.parse(hold.since))} without activity. It continues where you left it.` });
  }
  /** After a restart or update: a hold whose tmux session is alive stays; one whose session is gone is returned with resume. */
  async recover(): Promise<void> {
    for (const hold of this.holds()) if (!this.#alive(hold.tmuxSession)) {
      const project = (await this.app.ownerTools.projects()).find(row => row.id === hold.projectId); if (project) await this.#autoReturn(project, hold, 'gone').catch(() => undefined);
    }
  }
  /** `respond` on a held-idle item: keep restarts the idle timer, return hands it back. */
  async answerIdle(context: OwnerContext, internalId: string, option: 'keep' | 'return'): Promise<string> {
    const hold = this.hold(internalId.slice('held-'.length));
    if (!hold || !hold.warnedAt) throw new OwnerRefusal('This hold is no longer waiting on you.', 'not_open', 409);
    if (option === 'keep') { this.#put({ ...hold, warnedAt: undefined as never, keptAt: new Date(this.now()).toISOString() }, hold.threadId); return `Keeping ${hold.id} for you. The idle timer restarted.`; }
    const row = (await this.app.projectWork.view(hold.projectId)).threads.find(thread => thread.id === hold.threadId) ?? null;
    await this.return(context, hold.id, row, 'resume'); return `Handed ${hold.id} back to the coordinator.`;
  }
  async stop(context: OwnerContext, id: string, row: ThreadIndex, reason?: string): Promise<{ text: string }> { return this.return(context, id, row, 'stop', reason); }
}
