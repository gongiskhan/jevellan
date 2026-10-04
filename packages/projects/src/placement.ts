import type { z } from 'zod';
import type { AccountService } from '@jevellan/accounts';
import type { Configuration, DeviceRosterSchema, PlacementRecord, Project, ProjectWorkSettings } from '@jevellan/core';
import { PLACEMENT_NOT_ENABLED, fixedPlacementFields, placementCandidates, placementFallback, type PlacementDevice, type PlacementFixed, type PlacementGates, type PlacementInput } from '@jevellan/decisions';
import type { RuntimeAdapter } from '@jevellan/runtime-contract';
import type { Admission } from './admission.js';

export type DeviceRoster = z.infer<typeof DeviceRosterSchema>;
export type PlacementLabels = { modelLabel: string; deviceName: string; runtimeName: string };
export type PlacementResult =
  /** `atLimit`: every device that could run the thread is at its running limit, so the start queues (D9, D133). */
  | { kind: 'placed'; record: PlacementRecord; labels: PlacementLabels; atLimit: boolean }
  | { kind: 'refused'; message: string };
export type PlaceInput = {
  project: Project; workSettings: ProjectWorkSettings; title: string; task: string; note?: string | undefined;
  fixed: PlacementFixed; coordinatorDeviceId: string; ignoreRunningLimit: boolean; signal?: AbortSignal | undefined;
};

/**
 * Where a new thread runs (brief 10). Gathers the configuration, this daemon's runtime capabilities (applied to every device,
 * D37), accounts, the roster and live work per device (D9), then asks `@jevellan/decisions` for candidates. Until Jev placement
 * exists every non-fixed placement is the deterministic fallback (D82); all four fields fixed records `source: 'fixed'`.
 * Phase gates (D88): worktree isolation only until phase 6, this device only until phase 5.
 */
export class Placement {
  readonly #o: { settings(): Promise<Configuration['x-jevellan']>; accounts: Pick<AccountService, 'list'>; runtimes: ReadonlyMap<string, RuntimeAdapter>;
    roster(): Promise<DeviceRoster>; admission: Pick<Admission, 'counts'>; deviceId: string; deviceName: string; now(): number; gates: PlacementGates };
  constructor(o: { settings(): Promise<Configuration['x-jevellan']>; accounts: Pick<AccountService, 'list'>; runtimes: ReadonlyMap<string, RuntimeAdapter>;
    roster(): Promise<DeviceRoster>; admission: Pick<Admission, 'counts'>; deviceId: string; deviceName: string; now?(): number; gates?: PlacementGates }) {
    this.#o = { ...o, now: o.now ?? Date.now, gates: o.gates ?? { mainIsolation: false, remoteDevices: false } };
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
  async place(input: PlaceInput): Promise<PlacementResult> {
    const decision = await this.input(input);
    const candidates = placementCandidates(decision);
    if ('refused' in candidates) return { kind: 'refused', message: candidates.refused };
    const record = placementFallback(decision, candidates, PLACEMENT_NOT_ENABLED, [], fixedPlacementFields(input.fixed).length === 4);
    const model = decision.settings.menu.find((entry) => entry.id === record.modelId);
    return { kind: 'placed', record, atLimit: candidates.atLimit, labels: {
      modelLabel: model?.label ?? record.modelId,
      deviceName: decision.devices.find((device) => device.id === record.deviceId)?.name ?? record.deviceId,
      runtimeName: this.#o.runtimes.get(record.runtime)?.displayName ?? record.runtime,
    } };
  }
}
