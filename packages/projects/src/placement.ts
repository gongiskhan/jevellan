import type { z } from 'zod';
import type { AccountService } from '@jevellan/accounts';
import {
  HubUnavailable, ProjectDeviceSetupSchema, isTerminal, type AccountView, type Configuration, type DeviceRosterSchema, type PlacementRecord, type Project, type ProjectDeviceSetup, type ProjectHub,
  type ProjectWorkSettings, type SecretRedactor, type ThreadIndex,
} from '@jevellan/core';
import {
  JevError, decidePlacement, fixedPlacementFields, placementCandidates, placementDeviceSetup, type DecisionClient, type PlacementActiveThread, type PlacementDevice, type PlacementFixed,
  type PlacementGates, type PlacementInput, type PlacementPacketInput,
} from '@jevellan/decisions';
import type { RuntimeAdapter } from '@jevellan/runtime-contract';
import type { Admission } from './admission.js';
import { UNKNOWN_THREAD } from './copy.js';

export type DeviceRoster = z.infer<typeof DeviceRosterSchema>;
/** The phase gates (D88): main isolation opened in phase 6, other devices in phase 5. Placement and the settings views read this one value. */
export const PHASE_GATES: PlacementGates = { mainIsolation: true, remoteDevices: true };
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
  /** A thread whose own checkout claim does not count against the main rule: a next-turn override checks the thread where it is (D292). */
  exclude?: string | undefined;
};
/** A main thread this device started on another device whose index the hub may not have yet (D288). */
export type PendingMain = { threadId: string; deviceId: string; title: string };
export type PlacementOptions = {
  settings(): Promise<Configuration['x-jevellan']>; accounts: Pick<AccountService, 'list'>; runtimes: ReadonlyMap<string, RuntimeAdapter>;
  roster(): Promise<DeviceRoster>; admission: Pick<Admission, 'counts'>; deviceId: string; deviceName: string;
  /** Thread indexes, recent overrides and reservations for the state packet (brief 10); held checkouts for the main rule (D65, D288). */
  hub: Pick<ProjectHub, 'threads' | 'recentOverrides' | 'reservations' | 'heldCheckouts'>;
  /** This device's threads of the project as indexes: the hub copy lags by one publish (D252). */
  local(projectId: string): ThreadIndex[];
  /** Main threads started from here on other devices whose index has not reached the hub yet. */
  pendingMain?(projectId: string): Promise<PendingMain[]>;
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
 * with the deterministic fallback and records why; no question at all records `source: 'fixed'` (D30b). Every online device with
 * the project path and an eligible account is a candidate, and Call B asks for the device when more than one qualifies.
 * Main isolation (brief 10, D64, D65, D288) also needs the device's checkout on main by its latest heartbeat and no claim or main thread
 * there: the hub derives held checkouts from claims and thread indexes, this device adds its own threads and its starts still in flight.
 */
export class Placement {
  readonly #o: PlacementOptions & { now(): number; gates: PlacementGates };
  constructor(o: PlacementOptions) {
    this.#o = { ...o, now: o.now ?? Date.now, gates: o.gates ?? PHASE_GATES };
  }
  /** The decisions input for one start; exported for views that explain exclusions. */
  async input(input: PlaceInput): Promise<PlacementInput> {
    const { project, workSettings } = input;
    const main = this.#o.gates.mainIsolation && input.fixed.isolation !== 'worktree';
    const [settings, accounts, roster, counts, held] = await Promise.all([this.#o.settings(), this.#o.accounts.list(), this.#o.roster(), this.#o.admission.counts(project.id),
      main ? this.#held(project.id, input.exclude) : new Map<string, string>()]);
    input.signal?.throwIfAborted();
    return {
      settings, project, defaultIsolation: workSettings.defaultIsolation, runtimes: this.#runtimes(),
      accounts: accounts.map((view) => view.account), statuses: accounts.flatMap((view) => view.statuses), devices: this.#devices(project, roster, input.coordinatorDeviceId, counts.devices, held),
      maxRunningPerDevice: workSettings.maxRunningPerDevice, ignoreRunningLimit: input.ignoreRunningLimit,
      deviceId: this.#o.deviceId, coordinatorDeviceId: input.coordinatorDeviceId, gates: this.#o.gates, fixed: input.fixed, now: this.#o.now(),
    };
  }
  #runtimes(): PlacementInput['runtimes'] {
    return new Map([...this.#o.runtimes].map(([id, adapter]) => [id, { ...adapter.capabilities, displayName: adapter.displayName }]));
  }
  /**
   * Per device, the title of what keeps a new main thread off its checkout (D65, D288): this device's own main threads that have not
   * ended (its hub indexes lag one publish), main starts sent to other devices that the hub does not know yet, then the hub's held
   * checkouts (claims of conversations and threads, and main threads there). During a hub outage only this device's knowledge counts;
   * the claim at preparation still refuses a busy checkout.
   */
  async #held(projectId: string, exclude: string | undefined): Promise<Map<string, string>> {
    const held = new Map<string, string>();
    const hold = (deviceId: string, ownerId: string, title: string) => { if (ownerId !== exclude && !held.has(deviceId)) held.set(deviceId, title); };
    const [pending, hub] = await Promise.all([this.#o.pendingMain?.(projectId) ?? [], bestEffort(this.#o.hub.heldCheckouts(projectId), [])]);
    for (const index of this.#o.local(projectId)) if (index.isolation === 'main' && !isTerminal(index.state)) hold(index.ownerDeviceId, index.id, index.title);
    for (const entry of pending) hold(entry.deviceId, entry.threadId, entry.title);
    for (const entry of hub) hold(entry.deviceId, entry.ownerId, entry.title);
    return held;
  }
  /** The roster as placement sees it, with running counts per device and the main rule's holders when given. */
  #devices(project: Project, roster: DeviceRoster, coordinatorDeviceId: string, counts?: ReadonlyMap<string, number>, held?: ReadonlyMap<string, string>): PlacementDevice[] {
    const device = (id: string, name: string) => ({ id, name, hasPath: !!project.paths[id], allowed: !project.allowedDevices || project.allowedDevices.includes(id),
      running: counts?.get(id) ?? 0, isCoordinator: id === coordinatorDeviceId, ...(held?.has(id) ? { mainBlockedBy: held.get(id)! } : {}) });
    const devices: PlacementDevice[] = roster.devices.map((view) => ({ ...device(view.device.id, view.device.name), status: view.status, revoked: view.revoked,
      checkoutBranch: view.heartbeat?.projects.find((entry) => entry.projectId === project.id)?.branch }));
    // The placing device is always a candidate device row, even before its first heartbeat reached the roster (D8).
    if (!devices.some((entry) => entry.id === this.#o.deviceId)) devices.unshift({ ...device(this.#o.deviceId, this.#o.deviceName), status: 'online', revoked: false });
    return devices;
  }
  /**
   * The work view's device list (D281): every device that is not revoked, in roster order, with the reason no thread of the project can
   * run there, as `placing` would place threads (the placing device always counts as online, D8). Built from the roster, settings and
   * accounts the view read anyway, without running counts: a full device only queues a thread.
   */
  deviceSetup(project: Project, workSettings: ProjectWorkSettings, roster: DeviceRoster, placing: string,
    read: { settings: Configuration['x-jevellan']; accounts: AccountView[] }): ProjectDeviceSetup[] {
    const { settings, accounts } = read;
    const devices = this.#devices(project, roster, placing);
    const reasons = new Map(placementDeviceSetup({ settings, project, defaultIsolation: workSettings.defaultIsolation, runtimes: this.#runtimes(), accounts: accounts.map((view) => view.account),
      statuses: accounts.flatMap((view) => view.statuses), devices, maxRunningPerDevice: workSettings.maxRunningPerDevice, ignoreRunningLimit: true, deviceId: placing,
      coordinatorDeviceId: placing, gates: this.#o.gates, fixed: {}, now: this.#o.now() }).map((entry) => [entry.deviceId, entry.reason]));
    return devices.filter((device) => !device.revoked).map((device) => {
      const reason = reasons.get(device.id);
      return ProjectDeviceSetupSchema.parse({ schema: 'project-device-setup-v1', deviceId: device.id, name: device.name, ...(reason ? { reason: reason.slice(0, 400) } : {}) });
    });
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
   * The packet input (D249): the project's non-terminal threads oldest first, with device names, model labels and the paths their active
   * reservations hold, and the last 8 overrides with their threads' titles. This device's own threads come from memory.
   */
  async #packet(input: PlaceInput, devices: PlacementDevice[]): Promise<PlacementPacketInput> {
    const projectId = input.project.id;
    const [remote, overrides, reservations] = await Promise.all([bestEffort(this.#indexes(projectId), []), bestEffort(this.#o.hub.recentOverrides(projectId, 8), []),
      bestEffort(this.#o.hub.reservations(projectId), [])]);
    const indexes = new Map(remote.map((index) => [index.id, index]));
    for (const index of this.#o.local(projectId)) indexes.set(index.id, index);
    const device = (deviceId: string) => devices.find((entry) => entry.id === deviceId)?.name ?? deviceId;
    const reserved = (threadId: string) => [...new Set(reservations.filter((entry) => entry.threadId === threadId).flatMap((entry) => entry.paths))];
    const activeThreads = [...indexes.values()].filter((index) => !isTerminal(index.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((index): PlacementActiveThread => ({ title: index.title, isolation: index.isolation, device: device(index.ownerDeviceId), model: index.modelLabel, effort: index.effort,
        reservedPaths: reserved(index.id) }));
    return { title: input.title, task: input.task, note: input.note, activeThreads,
      overrides: overrides.map((entry) => ({ mode: entry.mode, changes: entry.changes, at: entry.at, title: indexes.get(entry.threadId)?.title ?? UNKNOWN_THREAD })) };
  }
  async place(input: PlaceInput): Promise<PlacementResult> {
    const decision = await this.input(input);
    const candidates = placementCandidates(decision);
    if ('refused' in candidates) return { kind: 'refused', message: candidates.refused };
    // All four fields fixed asks nothing, so the packet is not gathered.
    const fields = fixedPlacementFields(input.fixed);
    const packet = ['isolation', 'model', 'effort', 'device'].every((field) => fields.includes(field as typeof fields[number])) ? { title: input.title, task: input.task, activeThreads: [], overrides: [] } : await this.#packet(input, decision.devices);
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
