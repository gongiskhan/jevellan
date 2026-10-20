import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { defaultProjectWorkSettings, type CoordinatorView, type DocumentSchema, type DocumentStore, type ProjectDecision, type ProjectGoal, type ProjectJob, type ProjectJobRun,
  type ProjectWorkSettings, type ProjectWorkTask, type Stored, type ThreadIndex } from '../../packages/core/dist/index.js';

/** An in-memory document store with the hub's revision rule, for engine views in unit tests. */
export class MemoryStore implements DocumentStore {
  readonly rows = new Map<string, Stored<unknown>>();
  get<T>(namespace: string, id: string, schema: DocumentSchema<T>): Stored<T> | null {
    const row = this.rows.get(`${namespace}/${id}`); return row ? { revision: row.revision, document: schema.parse(structuredClone(row.document)) } : null;
  }
  list<T>(namespace: string, schema: DocumentSchema<T>): Stored<T>[] {
    return [...this.rows.entries()].filter(([key]) => key.startsWith(`${namespace}/`)).map(([, row]) => ({ revision: row.revision, document: schema.parse(structuredClone(row.document)) }));
  }
  put<T>(namespace: string, id: string, schema: DocumentSchema<T>, document: unknown, expectedRevision: number): Stored<T> {
    const key = `${namespace}/${id}`; const current = this.rows.get(key)?.revision ?? 0;
    if (current !== expectedRevision) throw Object.assign(new Error('Revision conflict.'), { status: 409 });
    const row = { revision: current + 1, document: schema.parse(structuredClone(document)) }; this.rows.set(key, row); return row as Stored<T>;
  }
}

/** Compares text with `tests/golden/<name>.txt`; `JEVELLAN_UPDATE_GOLDEN=1` writes it (copy changes are deliberate). */
export function golden(name: string, text: string): void {
  const path = join(import.meta.dirname, '..', 'golden', `${name}.txt`);
  if (process.env.JEVELLAN_UPDATE_GOLDEN === '1' || !existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${text}\n`); }
  expect(text).toBe(readFileSync(path, 'utf8').replace(/\n$/u, ''));
}

export const NOW = new Date('2026-10-20T13:24:00.000Z'); // 14:24 in Lisbon
export const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
export const sha = (seed: string) => seed.repeat(40).slice(0, 40);
export function settings(patch: Partial<ProjectWorkSettings> = {}): ProjectWorkSettings {
  const base = defaultProjectWorkSettings('sandbox');
  return { ...base, nightlyWindow: { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' }, notifications: { level: 'standard', quietHours: { enabled: true, start: '23:00', end: '08:00', timezone: 'Europe/Lisbon' } }, ...patch };
}
export function coordinator(state: CoordinatorView['state'] = 'idle'): CoordinatorView {
  return { state, deviceId: 'device_one', deviceName: 'dev-box', online: true, canMoveHere: false,
    session: { runtime: 'claude', modelLabel: 'opus-5.5', effort: 'high', accountLabel: 'main', turns: 4 }, planned: null };
}
export function thread(id: string, title: string, patch: Partial<ThreadIndex> = {}): ThreadIndex {
  return { schema: 'project-thread-index-v1', revision: 1, id, projectId: 'sandbox', title, state: 'running', isolation: 'worktree', ownerDeviceId: 'device_one', runtime: 'claude', modelLabel: 'opus-5.5', effort: 'high',
    accountLabel: 'main', delivery: 'land', turns: 2, createdAt: at(22), updatedAt: at(1), ...patch } as ThreadIndex;
}
export function task(id: string, title: string, patch: Partial<ProjectWorkTask> = {}): ProjectWorkTask {
  return { schema: 'project-work-task-v1', id, projectId: 'sandbox', revision: 1, title, brief: `${title}.`, kind: 'session', type: 'feature', goalId: null, source: 'owner', state: 'queued', rank: 'm', ownerRanked: false, now: false,
    after: [], needs: [], dailyId: null, jobId: null, threadId: null, jobRunId: null, fixed: {}, createdAt: at(60), updatedAt: at(60), ...patch } as ProjectWorkTask;
}
export function goal(id: string, name: string, patch: Partial<ProjectGoal> = {}): ProjectGoal {
  return { schema: 'project-goal-v1', id, projectId: 'sandbox', revision: 1, name, motivation: `${name} matters.`, health: '', autonomy: 'auto', state: 'active', dailyRefillCap: 3, openPrCap: 3, createdAt: at(10000), updatedAt: at(10000), ...patch } as ProjectGoal;
}
export function decision(id: string, question: string, patch: Partial<ProjectDecision> = {}): ProjectDecision {
  return { schema: 'project-decision-v1', revision: 1, id, projectId: 'sandbox', from: 'coordinator', question, options: [], createdAt: at(30), ...patch } as ProjectDecision;
}
export function job(id: string, name: string): ProjectJob {
  return { schema: 'project-job-v1', id, projectId: 'sandbox', revision: 1, name, goalId: null, run: { kind: 'command', command: 'npm test', needs: [], cwd: 'checkout' }, gate: null, enabled: true, createdAt: at(10000), updatedAt: at(10000) } as unknown as ProjectJob;
}
export function run(id: string, jobId: string, patch: Partial<ProjectJobRun> = {}): ProjectJobRun {
  return { schema: 'project-job-run-v1', id, projectId: 'sandbox', revision: 1, jobId, taskId: `task_${id}`, commit: sha('a'), deviceId: 'device_one', projectDay: '2026-10-20', startedAt: at(8), conclusion: null, summary: '', deliveries: [], findings: [], logTail: '', ...patch } as ProjectJobRun;
}
