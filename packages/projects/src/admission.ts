import { HubUnavailable, defaultProjectWorkSettings, deviceResourceRefusal, liveWork, type DeviceFacts, type ProjectHub, type ProjectWorkSettings, type ThreadIndex } from '@jevellan/core';
import { projectDay } from './project-day.js';
import { queuedReason, waitingForSlotReason, waitingForResourceReason, PROJECT_PAUSED, WAITING_FOR_HUB_SLOT, newThreadsPerDayReached } from './copy.js';

export type AdmissionCounts = {
  /** Live threads of the project (remote indexes, local runners and pending dispatches, each thread once). */
  project: number;
  /** The same work per owner device. */
  devices: Map<string, number>;
  limits: { project: number; device: number; perDevice?: Record<string, number> };
};
export type AdmissionRefusal = {
  ok: false; scope: 'project' | 'device' | 'all'; limit: number;
  /** Device name for a device limit, null for the project limit. */
  device: string | null;
  /** `Waiting for a free slot: ...` (a turn from a non-live state). */
  reason: string;
  /** `Queued: ...` (a new thread). */
  queued: string;
};
export type AdmissionResult = { ok: true; release(): void } | AdmissionRefusal;
type Live = { projectId: string; threadId: string; deviceId: string };
/** A dispatch to another device counts this long at most, when its thread's index never leaves `queued` (3.5.1, D264). */
export const DISPATCH_HOLD_MS = 120_000;

/**
 * Running limits (D9). Only live work counts: hub indexes in `preparing`, `running` or `publishing` owned by other devices,
 * this device's runners in a live step (from memory, never from the hub) and pending dispatches, each thread once. The last
 * good hub read per project is kept; while the hub is unreachable admission reuses it (zero when none), so turns keep running
 * during an outage. Both limits are project settings: `maxRunningPerDevice` counts one project's threads per device. A start or
 * dispatch sent to another device counts until its hub index leaves `queued` (the owner published what it does) or two minutes
 * pass (D264).
 */
export class Admission {
  readonly #remote = new Map<string, Live[]>();
  readonly #settings = new Map<string, ProjectWorkSettings>();
  readonly #pending = new Map<symbol, Live>();
  readonly #dispatched = new Map<string, Live & { until: number }>();
  #admissions: Promise<unknown> = Promise.resolve();
  readonly #hub: Pick<ProjectHub, 'threads' | 'settings'> & Partial<Pick<ProjectHub, 'admitThread'>>; readonly #deviceId: string; readonly #deviceName: string;
  readonly #localLive: (projectId: string) => Iterable<string>;
  readonly #names: ((deviceId: string) => Promise<string | undefined>) | undefined;
  readonly #now: () => number;
  readonly #facts: (() => DeviceFacts) | undefined;
  readonly #created: ((projectId: string) => Iterable<Pick<ThreadIndex, 'id' | 'createdAt' | 'restartedAs'>>) | undefined;
  readonly #defaultDelivery: 'land' | 'pull-request';
  readonly #guard: ((projectId: string, deviceId: string, threadId: string) => Promise<string | undefined>) | undefined;
  constructor(o: { defaultDelivery?: 'land' | 'pull-request'; hub: Pick<ProjectHub, 'threads' | 'settings'> & Partial<Pick<ProjectHub, 'admitThread'>>; deviceId: string; deviceName: string;
    /** Local threads of the project in a live step, from the runners' memory. */
    localLive(projectId: string): Iterable<string>;
    /** Names for the device-limit text; this device's name is known. */
    nameOf?(deviceId: string): Promise<string | undefined>; now?(): number; facts?(): DeviceFacts;
    createdThreads?(projectId: string): Iterable<Pick<ThreadIndex, 'id' | 'createdAt' | 'restartedAs'>>;
    guard?(projectId: string, deviceId: string, threadId: string): Promise<string | undefined> }) {
    this.#hub = o.hub; this.#deviceId = o.deviceId; this.#deviceName = o.deviceName; this.#localLive = o.localLive; this.#names = o.nameOf; this.#now = o.now ?? Date.now;
    this.#facts = o.facts; this.#created = o.createdThreads;
    this.#guard = o.guard; this.#defaultDelivery = o.defaultDelivery ?? 'land';
  }
  async #read<T>(cache: Map<string, T>, projectId: string, load: () => Promise<T>, fallback: () => T): Promise<T> {
    try { const value = await load(); cache.set(projectId, value); return value; }
    catch (error) { if (error instanceof HubUnavailable) return cache.get(projectId) ?? fallback(); throw error; }
  }
  /** Work settings with the hub default; the last good read during an outage. */
  settings(projectId: string): Promise<ProjectWorkSettings> {
    const defaults = () => ({ ...defaultProjectWorkSettings(projectId), delivery: this.#defaultDelivery });
    return this.#read(this.#settings, projectId, async () => (await this.#hub.settings(projectId))?.document ?? defaults(), defaults);
  }
  #remoteLive(projectId: string): Promise<Live[]> {
    return this.#read(this.#remote, projectId, async () => {
      const live: Live[] = []; let after: string | undefined;
      do {
        const page = await this.#hub.threads(projectId, after);
        for (const index of page.records) {
          if (index.projectId !== projectId) continue;
          // The owner published what its dispatched thread does now: from here its index counts, or not.
          if (index.state !== 'queued') this.#dispatched.delete(index.id);
          // This device's own threads are counted from memory: its indexes lag by one publish.
          if (index.ownerDeviceId !== this.#deviceId && liveWork(index.state)) live.push({ projectId, threadId: index.id, deviceId: index.ownerDeviceId });
        }
        after = page.next ?? undefined;
      } while (after !== undefined);
      return live;
    }, () => []);
  }
  /** Live work of one project; `exclude` leaves out the thread asking for its own next turn. */
  async counts(projectId: string, exclude?: string): Promise<AdmissionCounts> {
    const [settings, remote] = await Promise.all([this.settings(projectId), this.#remoteLive(projectId)]);
    const work = new Map<string, string>();
    for (const entry of remote) work.set(entry.threadId, entry.deviceId);
    for (const threadId of this.#localLive(projectId)) work.set(threadId, this.#deviceId);
    for (const entry of this.#pending.values()) if (entry.projectId === projectId) work.set(entry.threadId, entry.deviceId);
    for (const entry of this.#dispatched.values()) if (entry.projectId === projectId && this.isDispatched(entry.threadId)) work.set(entry.threadId, entry.deviceId);
    if (exclude !== undefined) work.delete(exclude);
    const devices = new Map<string, number>();
    for (const deviceId of work.values()) devices.set(deviceId, (devices.get(deviceId) ?? 0) + 1);
    return { project: work.size, devices, limits: { project: settings.maxRunningThreads, device: settings.maxRunningPerDevice, ...(Object.keys(settings.perDeviceLimits).length ? { perDevice: settings.perDeviceLimits } : {}) } };
  }
  /** New identities only: retries/restarts use their existing receipt and never consume another daily place. */
  async newThreadRefusal(projectId: string): Promise<string | undefined> {
    const settings = await this.settings(projectId); if (settings.status !== 'active') return PROJECT_PAUSED;
    const rows = new Map<string, Pick<ThreadIndex, 'id' | 'createdAt' | 'restartedAs'>>(); let after: string | undefined;
    do { const page = await this.#hub.threads(projectId, after); for (const row of page.records) rows.set(row.id, row); after = page.next ?? undefined; } while (after);
    for (const row of this.#created?.(projectId) ?? []) rows.set(row.id, { ...row, restartedAs: row.restartedAs ?? rows.get(row.id)?.restartedAs });
    const replacements = new Set([...rows.values()].flatMap(row => row.restartedAs ? [row.restartedAs] : []));
    const day = projectDay(this.#now(), '00:00', settings.nightlyWindow.timezone);
    const count = [...rows.values()].filter(row => !replacements.has(row.id) && projectDay(Date.parse(row.createdAt), '00:00', settings.nightlyWindow.timezone) === day).length;
    return count >= settings.maxNewThreadsPerDay ? newThreadsPerDayReached(settings.maxNewThreadsPerDay) : undefined;
  }
  /** Counts a dispatch that is not live yet (a start or a turn about to begin) until `release`. */
  hold(projectId: string, deviceId: string, threadId: string): () => void {
    const key = Symbol(threadId); this.#pending.set(key, { projectId, threadId, deviceId });
    return () => { this.#pending.delete(key); };
  }
  /**
   * A start or dispatch sent to `deviceId` through the relay (3.5.1 step 1, D9a): it counts toward both limits until the thread's
   * hub index leaves `queued` or `DISPATCH_HOLD_MS` pass, so the next start cannot take its slot before the owner runs it.
   */
  dispatched(projectId: string, deviceId: string, threadId: string): void {
    this.#dispatched.set(threadId, { projectId, threadId, deviceId, until: this.#now() + DISPATCH_HOLD_MS });
  }
  /** A dispatch still counts (the coordinator's sweep never sends it twice). */
  isDispatched(threadId: string): boolean {
    const entry = this.#dispatched.get(threadId); if (!entry) return false;
    if (entry.until > this.#now()) return true;
    this.#dispatched.delete(threadId); return false;
  }
  async #name(deviceId: string): Promise<string> {
    if (deviceId === this.#deviceId) return this.#deviceName;
    return (await this.#names?.(deviceId).catch(() => undefined)) ?? deviceId;
  }
  /**
   * Whether `threadId` may start live work on `deviceId` now. On success the slot is held until `release()`, so two
   * admissions cannot both take the last slot before either thread turns live.
   */
  admit(projectId: string, deviceId: string, threadId: string): Promise<AdmissionResult> {
    // Admissions run one at a time: the count and the hold must not interleave with another admission's.
    const result = this.#admissions.then(() => this.#admit(projectId, deviceId, threadId));
    this.#admissions = result.then(() => undefined, () => undefined);
    return result;
  }
  async #global(projectId: string, deviceId: string, threadId: string, reserve: boolean): Promise<AdmissionRefusal | undefined> {
    if (this.#hub.admitThread) {
      try {
        const claim = await this.#hub.admitThread(projectId, threadId, deviceId, reserve);
        if (!claim.admitted) { const reason = `Waiting for a free slot: ${claim.running} threads are running across all projects (limit ${claim.limit}).`; return { ok: false, scope: 'all', limit: claim.limit, device: null, reason, queued: reason }; }
      } catch (error) {
        if (!(error instanceof HubUnavailable)) throw error;
        const reason = WAITING_FOR_HUB_SLOT;
        return { ok: false, scope: 'all', limit: 0, device: null, reason, queued: reason };
      }
    }
    return undefined;
  }
  async #admit(projectId: string, deviceId: string, threadId: string): Promise<AdmissionResult> {
    if ((await this.settings(projectId)).status !== 'active') return { ok: false, scope: 'project', limit: 0, device: null, reason: PROJECT_PAUSED, queued: PROJECT_PAUSED };
    const resource = (deviceId === this.#deviceId ? deviceResourceRefusal(this.#deviceName, this.#facts?.()) : undefined) ?? await this.#guard?.(projectId, deviceId, threadId);
    if (resource) return { ok: false, scope: 'device', limit: 0, device: this.#deviceName, reason: waitingForResourceReason(resource), queued: resource };
    const global = await this.#global(projectId, deviceId, threadId, false); if (global) return global;
    const counts = await this.counts(projectId, threadId);
    const refuse = async (scope: 'project' | 'device', limit: number): Promise<AdmissionRefusal> => {
      const device = scope === 'project' ? null : await this.#name(deviceId);
      return { ok: false, scope, limit, device, reason: waitingForSlotReason(limit, device), queued: queuedReason(limit, device) };
    };
    if (counts.project >= counts.limits.project) return refuse('project', counts.limits.project);
    const deviceLimit = counts.limits.perDevice?.[deviceId] ?? counts.limits.device;
    if ((counts.devices.get(deviceId) ?? 0) >= deviceLimit) return refuse('device', deviceLimit);
    const claim = await this.#global(projectId, deviceId, threadId, true); if (claim) return claim;
    return { ok: true, release: this.hold(projectId, deviceId, threadId) };
  }
}
