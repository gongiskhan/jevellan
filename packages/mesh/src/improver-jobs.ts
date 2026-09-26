import { createHash, randomUUID } from 'node:crypto';
import {
  IdSchema, ImproverJobSchema, ImproverJobScopeSchema, ImproverSettingsSchema, stableJson,
  type ImproverJob, type ImproverJobScope, type ImproverSettings,
} from '@jevellan/core';
import type { HubDatabase } from './database.js';

const namespace = 'improver-jobs';
const leaseMs = 120_000;
function replaced(): never { throw Object.assign(new Error('This improver job expired or belongs to a newer worker.'), { status: 409 }); }
export function improverJobId(scope: ImproverJobScope): string {
  return `job_${createHash('sha256').update(stableJson(ImproverJobScopeSchema.parse(scope))).digest('hex')}`;
}

/** Only the hub chooses the local calendar date; repeated clocks retain the same daily identity. */
export function dueImproverDate(raw: ImproverSettings, now = new Date()): string | null {
  const settings = ImproverSettingsSchema.parse(raw);
  if (!Number.isFinite(now.getTime())) throw new Error('A valid schedule time is required.');
  const [hours, minutes] = settings.schedule.time.split(':').map(Number) as [number, number];
  if (!settings.schedule.enabled || now.getHours() * 60 + now.getMinutes() < hours * 60 + minutes) return null;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Durable claims are distinct from checkout ownership; both are required for project writes. */
export class ImproverJobs {
  constructor(readonly hub: HubDatabase, private readonly now: () => number = Date.now) {}
  list(): ImproverJob[] { return this.hub.list(namespace, ImproverJobSchema).map(value => value.document); }
  claim(raw: ImproverJobScope, deviceId: string, retry = false): { claimed: boolean; job: ImproverJob } {
    const scope = ImproverJobScopeSchema.parse(raw); IdSchema.parse(deviceId); const id = improverJobId(scope);
    return this.hub.transaction(() => {
      const now = this.now(); const previous = this.hub.get(namespace, id, ImproverJobSchema); const current = previous?.document;
      if (current && (current.status === 'complete' || current.status === 'skipped' || current.status === 'failed' && !retry || current.status === 'running' && Date.parse(current.leaseUntil) > now)) return { claimed: false, job: current };
      const at = new Date(now).toISOString();
      const job = ImproverJobSchema.parse({ schema: 'improver-job-v1', id, scope, deviceId, token: randomUUID(), attempt: (current?.attempt ?? 0) + 1,
        status: 'running', startedAt: at, updatedAt: at, leaseUntil: new Date(now + leaseMs).toISOString(), finishedAt: null, note: '' });
      return { claimed: true, job: this.hub.put(namespace, id, ImproverJobSchema, job, previous?.revision ?? 0).document };
    });
  }
  assertOwned(raw: ImproverJob): ImproverJob {
    const job = ImproverJobSchema.parse(raw); const current = this.hub.get(namespace, job.id, ImproverJobSchema)?.document;
    if (!current || current.token !== job.token || current.deviceId !== job.deviceId || current.status !== 'running' || Date.parse(current.leaseUntil) <= this.now()) replaced();
    return current;
  }
  renew(job: ImproverJob): ImproverJob {
    return this.#update(job, current => ({ ...current, updatedAt: new Date(this.now()).toISOString(), leaseUntil: new Date(this.now() + leaseMs).toISOString() }));
  }
  finish(job: ImproverJob, status: 'complete' | 'skipped' | 'failed', note: string): ImproverJob {
    return this.#update(job, current => ({ ...current, status, note, updatedAt: new Date(this.now()).toISOString(), finishedAt: new Date(this.now()).toISOString() }));
  }
  #update(job: ImproverJob, update: (current: ImproverJob) => ImproverJob): ImproverJob {
    return this.hub.transaction(() => {
      const current = this.assertOwned(job); const stored = this.hub.get(namespace, current.id, ImproverJobSchema)!;
      return this.hub.put(namespace, current.id, ImproverJobSchema, update(current), stored.revision).document;
    });
  }
}
