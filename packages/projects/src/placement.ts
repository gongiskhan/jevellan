import type { z } from 'zod';
import type { AccountService } from '@jevellan/accounts';
import {
  HubUnavailable, isTerminal, type Configuration, type DeviceRosterSchema, type PlacementRecord, type Project, type ProjectHub, type ProjectWorkSettings, type SecretRedactor,
  type ThreadIndex,
} from '@jevellan/core';
import {
  JevError, decidePlacement, fixedPlacementFields, placementCandidates, type DecisionClient, type PlacementActiveThread, type PlacementDevice, type PlacementFixed, type PlacementGates,
  type PlacementInput, type PlacementPacketInput,
} from '@jevellan/decisions';
import type { RuntimeAdapter } from '@jevellan/runtime-contract';
import type { Admission } from './admission.js';
import { UNKNOWN_THREAD } from './copy.js';

export type DeviceRoster = z.infer<typeof DeviceRosterSchema>;
/** The phase gates (D88): main isolation opens in phase 6, other devices in phase 5. Placement and the settings views read this one value. */
export const PHASE_GATES: PlacementGates = { mainIsolation: false, remoteDevices: false };
export type PlacementLabels = { modelLabel: string; deviceName: string; runtimeName: string };
export type PlacementResult =
  /** `atLimit`: every device that could run the thread is at its running limit, so the start queues (D9, D133). */
  | { kind: 'placed'; record: PlacementRecord; labels: PlacementLabels; atLimit: boolean }
  | { kind: 'refused'; message: string };
export type PlaceInput = {
  project: Project; workSettings: ProjectWorkSettings; title: string; task: string;
  /** The coordinator's one-line reason (`jevellan_thread_start`), or the owner's note of a restart (D252). */
  note?: string | undefined;
  fixed: PlacementFixed; coordinatorDeviceId: string; ignoreRunningLimit: boolean; signal?: AbortSignal | undefined;
};
export type PlacementOptions = {
  settings(): Promise<Configuration['x-jevellan']>; accounts: Pick<AccountService, 'list'>; runtimes: ReadonlyMap<string, RuntimeAdapter>;
  roster(): Promise<DeviceRoster>; admission: Pick<Admission, 'counts'>; deviceId: string; deviceName: string;
  /** Thread indexes and recent overrides for the state packet (brief 10). */
  hub: Pick<ProjectHub, 'threads' | 'recentOverrides'>;
  /** This device's threads of the project as indexes: the hub copy lags by one publish (D252). */
  local(projectId: string): ThreadIndex[];
  /** Jev; without one every question falls back as when no key is saved. */
  decisionClient?(): Promise<DecisionClient>;
  redactor: Pick<SecretRedactor, 'document'>;
  now?(): number; gates?: PlacementGates;
};
const NO_KEY: DecisionClient = { decide: async () => { throw new JevError('no-key'); } };
/** Packet reads are best effort: during a hub outage Jev still places the thread with what this device knows. */
const bestEffort = <T>(read: Promise<T>, fallback: T): Promise<T> => read.catch((error: unknown) => { if (error instanceof HubUnavailable) return fallback; throw error; });

/**
 * Where a new thread runs (brief 10). Gathers the configuration, this daemon's runtime capabilities (applied to every device,
 * D37), accounts, the roster and live work per device (D9), then asks Jev through `@jevellan/decisions` with the redacted
 * `placement-state-v1` packet: active threads, the project's last 8 overrides and the coordinator's note. Any Jev failure places
 * with the deterministic fallback and records why; no question at all records `source: 'fixed'` (D30b).
 * Phase gates (D88): worktree isolation only until phase 6, this device only until phase 5.
 */
export class Placement {
  readonly #o: PlacementOptions & { now(): number; gates: PlacementGates };
  constructor(o: PlacementOptions) {
    this.#o = { ...o, now: o.now ?? Date.now, gates: o.gates ?? PHASE_GATES };
  }
  /** The decisions input for one start; exported for views that explain exclusions. */
  async input(input: PlaceInput): Promise<PlacementInput> {
    const { project, workSettings } = input;
    const [settings, accounts, roster, counts] = await Promise.all([this.#o.settings(), this.#o.accounts.list(), this.#o.roster(), this.#o.admission.counts(project.id)]);
    input.signal?.throwIfAborted();
    const devices: PlacementDevice[] = roster.devices.map((view) => ({
      id: view.device.id, name: view.device.name, status: view.status, revoked: view.revoked,
      hasPath: !!project.paths[view.device.id], allowed: !project.allowedDevices || project.allowedDevices.includes(view.device.id),
      running: counts.devices.get(view.device.id) ?? 0, isCoordinator: view.device.id === input.coordinatorDeviceId,
      checkoutBranch: view.heartbeat?.projects.find((entry) => entry.projectId === project.id)?.branch,
    }));
    // The placing device is always a candidate device row, even before its first heartbeat reached the roster (D8).
    if (!devices.some((device) => device.id === this.#o.deviceId)) {
      devices.unshift({ id: this.#o.deviceId, name: this.#o.deviceName, status: 'online', revoked: false, hasPath: !!project.paths[this.#o.deviceId],
        allowed: !project.allowedDevices || project.allowedDevices.includes(this.#o.deviceId), running: counts.devices.get(this.#o.deviceId) ?? 0,
        isCoordinator: this.#o.deviceId === input.coordinatorDeviceId });
    }
    return {
      settings, project, defaultIsolation: workSettings.defaultIsolation,
      runtimes: new Map([...this.#o.runtimes].map(([id, adapter]) => [id, { ...adapter.capabilities, displayName: adapter.displayName }])),
      accounts: accounts.map((view) => view.account), statuses: accounts.flatMap((view) => view.statuses), devices,
      maxRunningPerDevice: workSettings.maxRunningPerDevice, ignoreRunningLimit: input.ignoreRunningLimit,
      deviceId: this.#o.deviceId, coordinatorDeviceId: input.coordinatorDeviceId, gates: this.#o.gates, fixed: input.fixed, now: this.#o.now(),
    };
  }
  /** The refusal text for these fields, or undefined when a thread could run with them (a next-turn model override checks with it). */
  async refusal(input: PlaceInput): Promise<string | undefined> {
    const candidates = placementCandidates(await this.input(input));
    return 'refused' in candidates ? candidates.refused : undefined;
  }
  async #indexes(projectId: string): Promise<ThreadIndex[]> {
    const records: ThreadIndex[] = []; let after: string | undefined;
    do { const page = await this.#o.hub.threads(projectId, after); records.push(...page.records.filter((index) => index.projectId === projectId)); after = page.next ?? undefined; } while (after !== undefined);
    return records;
  }
  /**
   * The packet input (D249): the project's non-terminal threads oldest first, with device names and model labels, and the last 8
   * overrides with their threads' titles. This device's own threads come from memory; reserved paths arrive with phase 6.
   */
  async #packet(input: PlaceInput, devices: PlacementDevice[]): Promise<PlacementPacketInput> {
    const projectId = input.project.id;
    const [remote, overrides] = await Promise.all([bestEffort(this.#indexes(projectId), []), bestEffort(this.#o.hub.recentOverrides(projectId, 8), [])]);
    const indexes = new Map(remote.map((index) => [index.id, index]));
    for (const index of this.#o.local(projectId)) indexes.set(index.id, index);
    const device = (deviceId: string) => devices.find((entry) => entry.id === deviceId)?.name ?? deviceId;
    const activeThreads = [...indexes.values()].filter((index) => !isTerminal(index.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((index): PlacementActiveThread => ({ title: index.title, isolation: index.isolation, device: device(index.ownerDeviceId), model: index.modelLabel, effort: index.effort, reservedPaths: [] }));
    return { title: input.title, task: input.task, note: input.note, activeThreads,
      overrides: overrides.map((entry) => ({ mode: entry.mode, changes: entry.changes, at: entry.at, title: indexes.get(entry.threadId)?.title ?? UNKNOWN_THREAD })) };
  }
  async place(input: PlaceInput): Promise<PlacementResult> {
    const decision = await this.input(input);
    const candidates = placementCandidates(decision);
    if ('refused' in candidates) return { kind: 'refused', message: candidates.refused };
    // All four fields fixed asks nothing, so the packet is not gathered.
    const packet = fixedPlacementFields(input.fixed).length === 4 ? { title: input.title, task: input.task, activeThreads: [], overrides: [] } : await this.#packet(input, decision.devices);
    const client = this.#o.decisionClient ? await this.#o.decisionClient() : NO_KEY;
    const placed = await decidePlacement(client, { ...decision, jevModel: decision.settings.decisions.model, packet, redactor: this.#o.redactor },
      input.signal ?? new AbortController().signal);
    if (placed.kind === 'refused') return placed;
    const { record } = placed;
    const model = decision.settings.menu.find((entry) => entry.id === record.modelId);
    return { kind: 'placed', record, atLimit: placed.atLimit, labels: {
      modelLabel: model?.label ?? record.modelId,
      deviceName: decision.devices.find((device) => device.id === record.deviceId)?.name ?? record.deviceId,
      runtimeName: this.#o.runtimes.get(record.runtime)?.displayName ?? record.runtime,
    } };
  }
}
