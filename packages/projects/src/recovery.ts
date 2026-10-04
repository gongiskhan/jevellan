import { existsSync } from 'node:fs';
import { liveWork, processStartIdentity, terminateGroup, type CoordinatorEvent, type NativeProcess, type ProjectLedgerEvent, type SecretRedactor, type Thread, type TurnProcess } from '@jevellan/core';
import { RESTARTED, RESTART_UNCONFIRMED } from './copy.js';
import type { CoordinatorService } from './coordinator.js';
import { derivedId } from './decision-items.js';
import type { ProjectLedgers } from './ledger.js';
import type { ProjectPaths } from './paths.js';
import type { ThreadStore } from './stores.js';
import { withState } from './thread-runner.js';

export type RecoveryOptions = {
  paths: ProjectPaths; ledgers: ProjectLedgers; store: ThreadStore; coordinators: CoordinatorService;
  toCoordinator(projectId: string, event: CoordinatorEvent): Promise<void>;
  redactor: SecretRedactor; now(): number;
  /** Process group cleanup; the conversation rules by default (`terminateGroup`). */
  terminate?(native: NativeProcess): Promise<void>;
};
export type RecoveryReport = { restarted: string[]; failed: Array<{ threadId: string; reason: string }>; coordinators: string[] };

/**
 * Ends a recorded turn process like conversation recovery: without a start identity while the pid exists nothing is
 * killed (it may be reused), and a reused identity is refused. Returns the failure, or undefined when the group is gone.
 */
async function stopProcess(process: TurnProcess, terminate: (native: NativeProcess) => Promise<void>, redactor: SecretRedactor): Promise<string | undefined> {
  try {
    if (!process.startIdentity && processStartIdentity(process.pid)) throw new Error('This turn has no process start identity. Refusing to stop a potentially reused process.');
    await terminate({ pid: process.pid, pgid: process.pgid, ...(process.startIdentity ? { startIdentity: process.startIdentity } : {}) });
    return undefined;
  } catch (error) { return redactor.text(error instanceof Error ? error.message : 'Process cleanup could not be confirmed.'); }
}

/**
 * Startup recovery (brief 8.6, 2.6.13, D24), before anything launches: ledger locks of a crashed writer are cleared, state
 * events a crash lost are repaired, orphaned turn processes are terminated from the sidecars, threads that were in a live
 * step rest `idle` with the restart reason and the coordinator hears it, a running coordinator turn is dropped with its
 * events still queued, and every index is published again. Nothing is resumed: no thread turn starts here.
 */
export async function recoverProjects(o: RecoveryOptions): Promise<RecoveryReport> {
  const terminate = o.terminate ?? ((native: NativeProcess) => terminateGroup(native));
  const report: RecoveryReport = { restarted: [], failed: [], coordinators: [] };
  const at = () => new Date(o.now()).toISOString();
  o.ledgers.recoverAll();
  for (const thread of o.store.all()) o.store.reconcile(thread.id);

  for (const thread of o.store.all()) {
    const process = o.store.local(thread.id).process;
    const failure = process ? await stopProcess(process, terminate, o.redactor) : undefined;
    if (process) o.store.updateLocal(thread.id, (local) => { const cleared = { ...local }; delete cleared.process; return cleared; });
    if (failure !== undefined) {
      o.ledgers.thread(thread.projectId, thread.id).append({ type: 'notice', data: { schema: 'project-notice-v1', text: failure, kind: 'error' } });
      if (thread.state !== 'failed' && thread.state !== 'done' && thread.state !== 'stopped') {
        await interrupted(o, thread, 'failed', RESTART_UNCONFIRMED);
        o.store.update(thread.id, (current) => ({ ...withState(current, 'failed', RESTART_UNCONFIRMED), endedAt: current.endedAt ?? at() }));
      }
      report.failed.push({ threadId: thread.id, reason: failure });
      continue;
    }
    if (!liveWork(thread.state)) continue;
    // The event first, under an id derived from the interrupted step, so a crash between the two writes repeats nothing (D162).
    await interrupted(o, thread, 'restart', RESTARTED);
    o.store.update(thread.id, (current) => withState(current, 'idle', RESTARTED));
    report.restarted.push(thread.id);
  }

  for (const projectId of o.paths.projectIds()) {
    if (!existsSync(o.paths.coordinator(projectId))) continue;
    const store = o.coordinators.store; const state = store.get(projectId); const process = store.local(projectId).process;
    if (process) {
      const failure = await stopProcess(process, terminate, o.redactor);
      if (failure !== undefined) o.ledgers.coordinator(projectId).append({ type: 'notice', data: { schema: 'project-notice-v1', text: failure, kind: 'error' } });
      store.updateLocal(projectId, (local) => { const cleared = { ...local }; delete cleared.process; return cleared; });
    }
    if (state.state === 'running') {
      // The dropped turn's events were not delivered: they stay queued, and `start()` runs a new turn normally (brief 8.6).
      // Its number is the last one the coordinator handed out, also when a crash came before its turn-start record.
      const ledger = o.ledgers.coordinator(projectId);
      const started = ledger.events().filter((event) => event.type === 'coordinator-turn-start').at(-1);
      const turn = store.local(projectId).deliveredTurn
        || (started ? ledger.payload(started as ProjectLedgerEvent & { type: 'coordinator-turn-start' }).turn : (state.session?.turns ?? 0) + 1);
      ledger.append({ type: 'coordinator-turn-end', turn, data: { schema: 'coordinator-turn-end-v1', turn, status: 'dropped' } });
      store.update(projectId, (current) => ({ ...current, state: 'idle' }));
      report.coordinators.push(projectId);
    }
    o.coordinators.get(projectId).reconcile();
  }
  o.store.publishAll();
  return report;
}

async function interrupted(o: RecoveryOptions, thread: Thread, reason: 'restart' | 'failed', message: string): Promise<void> {
  const lastEvent = o.ledgers.thread(thread.projectId, thread.id).lastId();
  await o.toCoordinator(thread.projectId, { schema: 'coordinator-event-v1', kind: 'thread-interrupted', id: derivedId('cev', 'interrupted', reason, thread.id, String(lastEvent)),
    at: new Date(o.now()).toISOString(), threadId: thread.id, reason, message });
}
