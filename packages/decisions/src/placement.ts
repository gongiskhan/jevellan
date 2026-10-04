import { rankAccounts, type RankedAccount } from '@jevellan/accounts';
import { mapEffort, PlacementRecordSchema, type Account, type AccountStatus, type Configuration, type DevicePresence, type Effort, type ExclusionReason, type Isolation, type JevCall, type ModelOption, type PlacementField, type PlacementRecord, type Project } from '@jevellan/core';
import type { RuntimeSupport } from './selection.js';

export const PLACEMENT_QUESTION_SET = 'p-v1';
// Placement copy. The Projects copy module re-exports these constants and never retypes them.
export const NO_PLACEMENT = 'No device can run any enabled model';
export const NO_THREAD_MODEL = 'No enabled model can run threads.';
export const LEAVE_GIT_MAIN = 'This project is set to Leave git to me, so threads cannot work on main.';
export const MAIN_NOT_AVAILABLE = 'Main isolation is not available yet.';
export const REMOTE_NOT_AVAILABLE = 'Threads run only on this device for now.';
export const UNKNOWN_PLACEMENT_MODEL = 'Choose a model from the configuration.';
export const UNKNOWN_PLACEMENT_DEVICE = 'Choose a registered device.';
export const REMOTE_GATE_REASON = 'not available until remote threads exist';
export const NOT_CHOSEN_REASON = 'not chosen';
/** The fallback error recorded until Jev placement exists (D82). */
export const PLACEMENT_NOT_ENABLED = { kind: 'not-enabled', message: 'Jev placement is not enabled yet.' } as const;
export const ACCOUNT_REASON_TEXT: Record<ExclusionReason, string> = {
  'needs-login': 'needs login', expired: 'login expired', 'usage-ceiling': 'usage ceiling reached', cooling: 'cooling down',
  disabled: 'account disabled', 'no-account': 'no account', 'paid-not-allowed': 'paid use not allowed', unsupported: 'not supported',
};

/** One roster device as placement sees it; the caller derives running counts (live work only, D9) and the main rule inputs. */
export type PlacementDevice = {
  id: string; name: string; status: DevicePresence; revoked: boolean; hasPath: boolean; allowed: boolean; running: number;
  isCoordinator: boolean; checkoutBranch?: string | undefined;
  /** Title of the running main thread or conversation owner holding this device's checkout. */
  mainBlockedBy?: string | undefined;
};
export type PlacementFixed = { isolation?: Isolation | undefined; modelId?: string | undefined; effort?: Effort | undefined; deviceId?: string | undefined };
export type PlacementRuntime = RuntimeSupport & { turns: boolean; displayName: string };
/** Capabilities that later phases build; the Projects placement lifts each gate in its phase (D88). */
export type PlacementGates = { mainIsolation: boolean; remoteDevices: boolean };
export type PlacementInput = {
  settings: Configuration['x-jevellan']; project: Project; defaultIsolation: Isolation;
  runtimes: ReadonlyMap<string, PlacementRuntime>; accounts: Account[]; statuses: AccountStatus[]; devices: PlacementDevice[];
  maxRunningPerDevice: number;
  /** True when the thread will queue anyway (project limit), so full devices stay candidates (D9). */
  ignoreRunningLimit: boolean;
  /** The device placing the thread; it always counts as online (D8). */
  deviceId: string; coordinatorDeviceId: string; gates: PlacementGates; fixed: PlacementFixed; now: number;
};
type Exclusion = { deviceId: string; reason: string };
/** devices: candidate devices with an eligible account for the model; unavailable: candidate devices without one. */
export type PlacementModel = { model: ModelOption; devices: string[]; unavailable: Exclusion[] };
export type PlacementOptions = {
  models: PlacementModel[]; devices: PlacementDevice[];
  excludedModels: Array<{ modelId: string; reason: string }>; excludedDevices: Exclusion[];
};
/**
 * The top-level options are the union over the allowed isolations (worktree whenever it is allowed); `main` narrows them to
 * devices that pass the main rule. `atLimit` means every device that could run the thread is at its running limit: the
 * options ignore the limit and the start queues (D71).
 */
export type PlacementCandidates = PlacementOptions & { isolations: Isolation[]; atLimit: boolean; main?: PlacementOptions };

function modelReason(input: PlacementInput, model: ModelOption): string | undefined {
  if (input.fixed.modelId !== undefined && model.id !== input.fixed.modelId) return NOT_CHOSEN_REASON;
  if (!model.enabled) return model.unavailableReason?.trim().replace(/\.$/, '') || 'disabled in Settings';
  if (!input.settings.runtimes[model.runtime]?.enabled) return 'runtime disabled';
  const runtime = input.runtimes.get(model.runtime);
  if (!runtime?.turns || !runtime.mcp || !runtime.edit || !runtime.shell) return 'runtime cannot run threads here';
  return undefined;
}

function deviceReason(input: PlacementInput, device: PlacementDevice, main: boolean, limits: boolean): string | undefined {
  if (input.fixed.deviceId !== undefined && device.id !== input.fixed.deviceId) return NOT_CHOSEN_REASON;
  if (!input.gates.remoteDevices && device.id !== input.deviceId) return REMOTE_GATE_REASON;
  if (device.revoked || (device.id !== input.deviceId && device.status !== 'online')) return 'offline';
  if (!device.hasPath || !device.allowed) return 'not set up for this project';
  if (limits && device.running >= input.maxRunningPerDevice) return `at its running limit (${input.maxRunningPerDevice})`;
  if (main && device.mainBlockedBy) return `main checkout busy: ${device.mainBlockedBy}`;
  if (main && device.checkoutBranch && device.checkoutBranch !== 'main') return `checkout is on ${device.checkoutBranch}, not main`;
  return undefined;
}

function ranking(input: PlacementInput, model: ModelOption, deviceId: string): RankedAccount[] {
  return rankAccounts({ accounts: input.accounts, statuses: input.statuses, runtime: model.runtime, model: model.model, deviceId, now: input.now })
    .filter((entry) => entry.account.runtime === model.runtime);
}

type Evaluation = PlacementOptions & { gaps: Exclusion[] };
function evaluate(input: PlacementInput, main: boolean, limits: boolean): Evaluation {
  const devices: PlacementDevice[] = []; const excludedDevices: Exclusion[] = [];
  for (const device of input.devices) {
    const reason = deviceReason(input, device, main, limits);
    if (reason) excludedDevices.push({ deviceId: device.id, reason }); else devices.push(device);
  }
  const models: PlacementModel[] = []; const excludedModels: PlacementOptions['excludedModels'] = []; const gaps: Exclusion[] = [];
  for (const model of input.settings.menu) {
    const configured = modelReason(input, model);
    if (configured) { excludedModels.push({ modelId: model.id, reason: configured }); continue; }
    const displayName = input.runtimes.get(model.runtime)!.displayName;
    const eligible: string[] = []; const unavailable: Exclusion[] = [];
    for (const device of devices) {
      const ranked = ranking(input, model, device.id); const best = ranked[0]?.reason;
      if (ranked.some((entry) => entry.eligible)) eligible.push(device.id);
      else unavailable.push({ deviceId: device.id, reason: `${displayName} ${ACCOUNT_REASON_TEXT[best && best !== 'eligible' ? best : 'no-account']}` });
    }
    gaps.push(...unavailable);
    if (eligible.length) models.push({ model, devices: eligible, unavailable });
    else excludedModels.push({ modelId: model.id, reason: unavailable.map((gap) => `${devices.find((device) => device.id === gap.deviceId)!.name}: ${gap.reason}`).join('; ') || 'no device can run it' });
  }
  return { models, devices, excludedModels, excludedDevices, gaps };
}

function options({ models, devices, excludedModels, excludedDevices }: PlacementOptions): PlacementOptions { return { models, devices, excludedModels, excludedDevices }; }

function refusal(input: PlacementInput, evaluation: Evaluation): string {
  const fixedModel = input.settings.menu.find((model) => model.id === input.fixed.modelId);
  if (fixedModel) { const reason = modelReason(input, fixedModel); if (reason) return `${fixedModel.label} cannot run threads: ${reason}.`; }
  else if (!input.settings.menu.some((model) => !modelReason(input, model))) return NO_THREAD_MODEL;
  // Devices left out only by a phase gate or by the owner's own choice are not reasons; they stay in the record.
  const reasons = [...new Set(input.devices.flatMap((device) => {
    const excluded = evaluation.excludedDevices.find((entry) => entry.deviceId === device.id);
    if (excluded) return excluded.reason === NOT_CHOSEN_REASON || excluded.reason === REMOTE_GATE_REASON ? [] : [`${device.name}: ${excluded.reason}`];
    return evaluation.gaps.filter((gap) => gap.deviceId === device.id).map((gap) => `${device.name}: ${gap.reason}`);
  }))];
  return `${fixedModel ? `No device can run ${fixedModel.label}` : NO_PLACEMENT}${reasons.length ? `: ${reasons.join('; ')}` : ''}.`;
}

/** Candidate isolations, models and devices for a new thread (brief 10, D8, D9, D37, D65, D71, D88), or the refusal text. */
export function placementCandidates(input: PlacementInput): PlacementCandidates | { refused: string } {
  const { fixed, project } = input;
  if (fixed.modelId !== undefined && !input.settings.menu.some((model) => model.id === fixed.modelId)) return { refused: UNKNOWN_PLACEMENT_MODEL };
  if (fixed.deviceId !== undefined && !input.devices.some((device) => device.id === fixed.deviceId)) return { refused: UNKNOWN_PLACEMENT_DEVICE };
  if (fixed.isolation === 'main' && project.branchPolicy !== 'main') return { refused: LEAVE_GIT_MAIN };
  if (fixed.isolation === 'main' && !input.gates.mainIsolation) return { refused: MAIN_NOT_AVAILABLE };
  if (fixed.deviceId !== undefined && !input.gates.remoteDevices && fixed.deviceId !== input.deviceId) return { refused: REMOTE_NOT_AVAILABLE };
  const mainAllowed = input.gates.mainIsolation && project.branchPolicy === 'main' && fixed.isolation !== 'worktree';
  const assess = (limits: boolean) => {
    const main = mainAllowed ? evaluate(input, true, limits) : undefined;
    return { main: main?.models.length ? main : undefined, top: fixed.isolation === 'main' ? main! : evaluate(input, false, limits) };
  };
  const limited = assess(!input.ignoreRunningLimit);
  const chosen = limited.top.models.length ? limited : input.ignoreRunningLimit ? undefined : assess(false);
  if (!chosen?.top.models.length) return { refused: refusal(input, (chosen ?? limited).top) };
  const isolations: Isolation[] = [...(fixed.isolation === 'main' ? [] : ['worktree' as const]), ...(chosen.main ? ['main' as const] : [])];
  return { ...options(chosen.top), isolations, atLimit: chosen !== limited, ...(chosen.main ? { main: options(chosen.main) } : {}) };
}

/** The options of one allowed isolation. */
export function placementOptions(candidates: PlacementCandidates, isolation: Isolation): PlacementOptions {
  if (!candidates.isolations.includes(isolation)) throw new Error('This isolation is not a placement candidate.');
  return options(isolation === 'main' ? candidates.main! : candidates);
}

/** Devices that can run one model under the given options, and every other device with its reason, in roster order. */
export function placementDevices(input: Pick<PlacementInput, 'devices'>, options: PlacementOptions, model: PlacementModel): { devices: PlacementDevice[]; excluded: Exclusion[] } {
  const excluded = [...options.excludedDevices, ...model.unavailable];
  const order = (deviceId: string) => input.devices.findIndex((device) => device.id === deviceId);
  return { devices: options.devices.filter((device) => model.devices.includes(device.id)), excluded: excluded.sort((a, b) => order(a.deviceId) - order(b.deviceId)) };
}

const FIXED_KEYS = { isolation: 'isolation', model: 'modelId', effort: 'effort', device: 'deviceId' } as const satisfies Record<PlacementField, keyof PlacementFixed>;
export function fixedPlacementFields(fixed: PlacementFixed): PlacementField[] {
  return (Object.keys(FIXED_KEYS) as PlacementField[]).filter((field) => fixed[FIXED_KEYS[field]] !== undefined);
}

/**
 * Deterministic placement (brief 10 fallback): the project default isolation when allowed (else worktree), the first eligible menu
 * entry, `medium` mapped to the model's efforts, then the coordinator's device when it can run the model, else the device with the
 * fewest running threads, ties by name. Fixed fields win. `fixedOnly` records `source: 'fixed'` without an error (D30b).
 */
export function placementFallback(input: PlacementInput, candidates: PlacementCandidates,
  error: { kind: string; message: string }, calls: JevCall[], fixedOnly = false): PlacementRecord {
  const isolation = candidates.isolations.includes(input.defaultIsolation) ? input.defaultIsolation : candidates.isolations[0];
  if (!isolation) throw new Error('Placement candidates have no isolation.');
  const available = placementOptions(candidates, isolation); const entry = available.models[0];
  if (!entry) throw new Error('Placement candidates have no model.');
  const choice = placementDevices(input, available, entry);
  const device = choice.devices.find((candidate) => candidate.id === input.coordinatorDeviceId)
    ?? [...choice.devices].sort((a, b) => a.running - b.running || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
  const account = device && ranking(input, entry.model, device.id).find((ranked) => ranked.eligible);
  if (!device || !account) throw new Error('Placement candidates have no device for the model.');
  const effortRequested = input.fixed.effort ?? 'medium';
  return PlacementRecordSchema.parse({
    schema: 'placement-v1', questionSet: PLACEMENT_QUESTION_SET, source: fixedOnly ? 'fixed' : 'fallback', fixed: fixedPlacementFields(input.fixed),
    isolation, runtime: entry.model.runtime, modelId: entry.model.id, model: entry.model.model,
    effortRequested, effortEffective: mapEffort(effortRequested, entry.model.efforts), deviceId: device.id, accountId: account.account.id,
    eligibleModels: available.models.map((model) => model.model.id), excludedModels: available.excludedModels,
    eligibleDevices: choice.devices.map((candidate) => candidate.id), excludedDevices: choice.excluded,
    ...(fixedOnly ? {} : { error: { kind: error.kind, message: error.message.slice(0, 300) } }),
    jevCalls: [...calls], decidedAt: new Date(input.now).toISOString(),
  });
}
