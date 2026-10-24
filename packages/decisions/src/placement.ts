import {JevLessonInputSchema,type JevLessonInput} from '@jevellan/core';
import type { PlacementPrompt } from '@jevellan/core';
import { MAIN_NOT_AVAILABLE, REMOTE_NOT_AVAILABLE } from '@jevellan/core';
export { MAIN_NOT_AVAILABLE, REMOTE_NOT_AVAILABLE } from '@jevellan/core';
import { z } from 'zod';
import { rankAccounts, type RankedAccount } from '@jevellan/accounts';
import { DeviceFactsSchema, DeviceTagsSchema, deviceResourceRefusal, EffortSchema, IsolationSchema, mapEffort, PlacementRecordSchema, type DeviceFacts, type Account, type AccountStatus, type Configuration, type DevicePresence, type Effort, type ExclusionReason, type Isolation, type JevCall, type ModelOption, type PlacementField, type PlacementOverride, type PlacementRecord, type Project, type SecretRedactor } from '@jevellan/core';
import { JevError, type JevQuestions, type JevResponse } from './contract.js';
import { askJev, type DecisionClient } from './engine.js';
import type { RuntimeSupport } from './selection.js';
import { approximateTokens } from './state.js';
import { accountChoice, decideAccount } from './account-choice.js';
import { applyJevEffortRules, jevEffortBounds, matchingJevRules } from './jev-rules.js';
import type { PlacementAccountChoice } from '@jevellan/core';

export const PLACEMENT_QUESTION_SET = 'p-v1';
// Placement copy. The Projects copy module re-exports these constants and never retypes them.
export const NO_PLACEMENT = 'No device can run any enabled model';
export const NO_THREAD_MODEL = 'No enabled model can run threads.';
export const PROJECT_MODEL_NOT_ALLOWED = "Not allowed in this project's settings.";
export const PROJECT_MODEL_EFFORT = "No supported effort meets this project's minimum.";
export const NO_PROJECT_MODEL = 'No model allowed in this project can run';
export const LEAVE_GIT_MAIN = 'This project is set to Leave git to me, so threads cannot work on main.';
export const UNKNOWN_PLACEMENT_MODEL = 'Choose a model from the configuration.';
export const UNKNOWN_PLACEMENT_DEVICE = 'Choose a registered device.';
export const UNKNOWN_PLACEMENT_RUNTIME = 'Choose an installed runtime.';
export const UNKNOWN_PLACEMENT_ACCOUNT = 'Choose a registered account.';
export const PLACEMENT_ACCOUNT_RUNTIME = 'The selected account does not belong to the selected runtime.';
export const REMOTE_GATE_REASON = 'not available until remote threads exist';
export const NOT_CHOSEN_REASON = 'not chosen';
/** The fallback error when Jev chose main with a model that no main checkout can run (D250). */
export const PLACEMENT_INCOMPATIBLE = { kind: 'incompatible-answer', message: 'no device can run the chosen model on main' } as const;
// Question set p-v1: the instructions (D30) and the isolation criteria (brief 10, verbatim).
export const PLACEMENT_INSTRUCTIONS = {
  isolation: 'Choose how this new thread works: in its own worktree ending in a pull request, or directly on main.',
  pick_model: 'Choose the model that should carry this thread end to end.',
  effort: 'Choose the reasoning effort this thread needs.',
  device: 'Choose the device that should run this thread.',
} as const;
export const PLACEMENT_ISOLATION_CRITERIA: Record<Isolation, string> = {
  worktree: 'Larger, riskier or multi-file change that should be reviewed as a pull request.',
  main: 'Small, contained change that is safe to land directly on main without review.',
};
export const TASK_SHORTENED = '\n[Task shortened.]';
export const ACCOUNT_REASON_TEXT: Record<ExclusionReason, string> = {
  'needs-login': 'needs login', expired: 'login expired', 'usage-ceiling': 'usage ceiling reached', cooling: 'cooling down',
  disabled: 'account disabled', 'no-account': 'no account', 'paid-not-allowed': 'paid use not allowed', unsupported: 'not supported', unreachable: 'is unreachable', 'model-not-served': 'This account does not serve {model}.',
};

/** One roster device as placement sees it; the caller derives running counts (live work only, D9) and the main rule inputs. */
export type PlacementDevice = {
  id: string; name: string; status: DevicePresence; revoked: boolean; hasPath: boolean; allowed: boolean; running: number;
  isCoordinator: boolean; checkoutBranch?: string | undefined;
  tags?: string[] | undefined; facts?: DeviceFacts | undefined;
  /** Title of the running main thread or conversation owner holding this device's checkout. */
  mainBlockedBy?: string | undefined;
  runtimeRefusals?: Record<string, string> | undefined;
};
export type PlacementFixed = { isolation?: Isolation | undefined; runtimeId?: string | undefined; accountId?: string | undefined; modelId?: string | undefined; effort?: Effort | undefined; deviceId?: string | undefined };
export type PlacementRuntime = RuntimeSupport & { turns: boolean; displayName: string };
/** Capabilities that later phases build; the Projects placement lifts each gate in its phase (D88). */
export type PlacementGates = { mainIsolation: boolean; remoteDevices: boolean };
export type PlacementInput = {
  settings: Configuration['x-jevellan']; project: Project; defaultIsolation: Isolation; prompt?: PlacementPrompt | undefined;
  constraints?: NonNullable<PlacementRecord['constraints']> | undefined; projectGuidance?: string | undefined;
  reason?: PlacementRecord['reason']; minimumEffort?: Effort | undefined; excludedModels?: Record<string, string> | undefined;
  continuity?: { modelId: string; effort: Effort; accountId: string } | undefined;
  runtimes: ReadonlyMap<string, PlacementRuntime>; accounts: Account[]; statuses: AccountStatus[]; devices: PlacementDevice[];
  maxRunningPerDevice: number;
  perDeviceLimits?: Record<string, number> | undefined; needs?: string[] | undefined;
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

function effortFloor(input: PlacementInput): Effort | undefined {
  if (input.fixed.effort !== undefined) return undefined;
  const floors = [input.constraints?.minEffort, input.minimumEffort].filter((value): value is Effort => !!value);
  return floors.sort((a, b) => EffortSchema.options.indexOf(b) - EffortSchema.options.indexOf(a))[0];
}
/** Actual menu efforts after mapping and the owner's floor; fixed effort remains the owner's choice. */
export function placementEfforts(input: PlacementInput, models: readonly PlacementModel[]): Effort[] {
  const floor = effortFloor(input); if (!floor) return [...EffortSchema.options];
  const offered = new Set(models.flatMap(entry => entry.model.efforts));
  return EffortSchema.options.filter(effort => offered.has(effort) && models.every(entry => EffortSchema.options.indexOf(mapEffort(effort, entry.model.efforts)) >= EffortSchema.options.indexOf(floor)));
}
function effectiveEffort(input: PlacementInput, model: ModelOption, requested: Effort): Effort {
  const mapped = mapEffort(requested, model.efforts), floor = effortFloor(input);
  return floor && EffortSchema.options.indexOf(mapped) < EffortSchema.options.indexOf(floor) ? mapEffort(floor, model.efforts) : mapped;
}

function modelReason(input: PlacementInput, model: ModelOption): string | undefined {
  const accountRuntime = input.fixed.accountId && input.accounts.find((account) => account.id === input.fixed.accountId)?.runtime;
  if (input.fixed.runtimeId !== undefined && model.runtime !== input.fixed.runtimeId || accountRuntime && model.runtime !== accountRuntime) return NOT_CHOSEN_REASON;
  if (input.fixed.modelId !== undefined && model.id !== input.fixed.modelId) return NOT_CHOSEN_REASON;
  if (input.constraints?.allowedModelIds && !input.constraints.allowedModelIds.includes(model.id) && input.fixed.modelId === undefined) return PROJECT_MODEL_NOT_ALLOWED;
  if (input.excludedModels?.[model.id]) return input.excludedModels[model.id];
  const floor = effortFloor(input);
  if (floor && !model.efforts.some(effort => EffortSchema.options.indexOf(effort) >= EffortSchema.options.indexOf(floor))) return PROJECT_MODEL_EFFORT;
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
  const missing = (input.needs ?? []).filter(tag => !device.tags?.includes(tag));
  if (missing.length) return `missing tags: ${missing.join(', ')}`;
  const resource = deviceResourceRefusal(device.name, device.facts);
  if (resource) return resource;
  const limit = input.perDeviceLimits?.[device.id] ?? input.maxRunningPerDevice;
  if (limits && device.running >= limit) return `at its running limit (${limit})`;
  if (main && device.mainBlockedBy) return `main checkout busy: ${device.mainBlockedBy}`;
  if (main && device.checkoutBranch && device.checkoutBranch !== 'main') return `checkout is on ${device.checkoutBranch}, not main`;
  return undefined;
}

function ranking(input: PlacementInput, model: ModelOption, deviceId: string): RankedAccount[] {
  return rankAccounts({ accounts: input.accounts, statuses: input.statuses, runtime: model.runtime, model: model.model, deviceId, now: input.now })
    .filter((entry) => entry.account.runtime === model.runtime && (input.fixed.accountId === undefined || entry.account.id === input.fixed.accountId));
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
      const refusal = device.runtimeRefusals?.[model.runtime];
      if (refusal) { unavailable.push({ deviceId: device.id, reason: refusal }); continue; }
      const ranked = ranking(input, model, device.id); const best = ranked[0]?.reason;
      if (ranked.some((entry) => entry.eligible)) eligible.push(device.id);
      else unavailable.push({ deviceId: device.id, reason: `${displayName} ${ACCOUNT_REASON_TEXT[best && best !== 'eligible' ? best : 'no-account'].replace('{model}', model.label)}` });
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
export function placementCandidates(input: PlacementInput): PlacementCandidates | { refused: string; retryable?: boolean } {
  const { fixed } = input;
  if (fixed.runtimeId !== undefined && !input.runtimes.has(fixed.runtimeId)) return { refused: UNKNOWN_PLACEMENT_RUNTIME };
  const account = fixed.accountId === undefined ? undefined : input.accounts.find((entry) => entry.id === fixed.accountId);
  if (fixed.accountId !== undefined && !account) return { refused: UNKNOWN_PLACEMENT_ACCOUNT };
  const model = input.settings.menu.find((entry) => entry.id === fixed.modelId);
  if (account && (fixed.runtimeId !== undefined && account.runtime !== fixed.runtimeId || model && account.runtime !== model.runtime)) return { refused: PLACEMENT_ACCOUNT_RUNTIME };
  if (model && fixed.runtimeId !== undefined && model.runtime !== fixed.runtimeId) return { refused: 'The selected model does not belong to the selected runtime.' };
  if (fixed.modelId !== undefined && !input.settings.menu.some((model) => model.id === fixed.modelId)) return { refused: UNKNOWN_PLACEMENT_MODEL };
  if (fixed.deviceId !== undefined && !input.devices.some((device) => device.id === fixed.deviceId)) return { refused: UNKNOWN_PLACEMENT_DEVICE };
  if (fixed.isolation === 'main' && !input.gates.mainIsolation) return { refused: MAIN_NOT_AVAILABLE };
  if (fixed.deviceId !== undefined && !input.gates.remoteDevices && fixed.deviceId !== input.deviceId) return { refused: REMOTE_NOT_AVAILABLE };
  if ((input.constraints?.allowedModelIds !== undefined && input.constraints.allowedModelIds !== null || effortFloor(input)) && !input.settings.menu.some(model => !modelReason(input, model))) {
    const reasons = input.settings.menu.map(model => `${model.label}: ${modelReason(input, model)}`).join('; ') || NO_THREAD_MODEL;
    return { refused: `${NO_PROJECT_MODEL}: ${reasons}`, retryable: false };
  }
  const mainAllowed = input.gates.mainIsolation && fixed.isolation !== 'worktree';
  const assess = (limits: boolean) => {
    const main = mainAllowed ? evaluate(input, true, limits) : undefined;
    return { main: main?.models.length ? main : undefined, top: fixed.isolation === 'main' ? main! : evaluate(input, false, limits) };
  };
  const limited = assess(!input.ignoreRunningLimit);
  const chosen = limited.top.models.length ? limited : input.ignoreRunningLimit ? undefined : assess(false);
  if (!chosen?.top.models.length) {
    const available = input.devices.filter(device => device.allowed && device.hasPath && !device.revoked && (device.id === input.deviceId || device.status === 'online') && (!fixed.deviceId || device.id === fixed.deviceId));
    const resources = available.map(device => deviceResourceRefusal(device.name, device.facts));
    if (available.length && resources.every(Boolean)) return { refused: resources.join(' '), retryable: true };
    if (available.length && input.needs?.length && available.every(device => input.needs!.some(tag => !device.tags?.includes(tag)))) return { refused: refusal(input, (chosen ?? limited).top), retryable: false };
    if (fixed.deviceId && !input.devices.find(device => device.id === fixed.deviceId)?.allowed) return { refused: refusal(input, (chosen ?? limited).top), retryable: false };
    return { refused: refusal(input, (chosen ?? limited).top), retryable: true };
  }
  const isolations: Isolation[] = [...(fixed.isolation === 'main' ? [] : ['worktree' as const]), ...(chosen.main ? ['main' as const] : [])];
  return { ...options(chosen.top), isolations, atLimit: chosen !== limited, ...(chosen.main ? { main: options(chosen.main) } : {}) };
}

/**
 * Every device in roster order with the reason no thread of the project can run there (D281): offline (the placing device always counts
 * as online, D8), not set up for the project, or no eligible account for any model that runs threads (the per-model account gaps). Running
 * limits only queue a thread and fixed fields are the owner's choice, so neither is a reason. Without any model that runs threads no device
 * is to blame: placement refuses with its own sentence. New thread and Override use it to disable what placement would refuse.
 */
export function placementDeviceSetup(input: PlacementInput): Array<{ deviceId: string; reason?: string }> {
  const open: PlacementInput = { ...input, fixed: {}, ignoreRunningLimit: true };
  const evaluation = evaluate(open, false, false); const anyModel = input.settings.menu.some((model) => !modelReason(open, model));
  return input.devices.map((device) => {
    const excluded = evaluation.excludedDevices.find((entry) => entry.deviceId === device.id)?.reason;
    if (excluded && excluded !== REMOTE_GATE_REASON) return { deviceId: device.id, reason: excluded };
    if (excluded || !anyModel || evaluation.models.some((model) => model.devices.includes(device.id))) return { deviceId: device.id };
    return { deviceId: device.id, reason: evaluation.gaps.filter((gap) => gap.deviceId === device.id).map((gap) => gap.reason).join('; ') };
  });
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

const FIXED_KEYS = { isolation: 'isolation', runtime: 'runtimeId', account: 'accountId', model: 'modelId', effort: 'effort', device: 'deviceId' } as const satisfies Record<PlacementField, keyof PlacementFixed>;
export function fixedPlacementFields(fixed: PlacementFixed): PlacementField[] {
  return (Object.keys(FIXED_KEYS) as PlacementField[]).filter((field) => fixed[FIXED_KEYS[field]] !== undefined);
}

type PlacementChoice = { isolation: Isolation; options: PlacementOptions; entry: PlacementModel; device: PlacementDevice | undefined; effortRequested: Effort; accountChoice?: PlacementAccountChoice };
type PlacementOutcome = { source: PlacementRecord['source']; calls: JevCall[]; probabilities?: PlacementRecord['probabilities']; error?: { kind: string; message: string } };
function continuityAccount(input: PlacementInput, model: ModelOption, effort: Effort, ranked: RankedAccount[]): PlacementAccountChoice | undefined {
  const old = input.continuity;
  return old && old.modelId === model.id && old.effort === effectiveEffort(input, model, effort) && ranked.some(row => row.eligible && row.account.id === old.accountId)
    ? accountChoice(ranked, old.accountId, 'session', input.now) : undefined;
}
/** One record for every source: the lists are the chosen isolation's options and the chosen model's devices (D136). */
function placementRecord(input: PlacementInput, { isolation, options, entry, device, effortRequested, accountChoice: chosenAccount }: PlacementChoice, outcome: PlacementOutcome): PlacementRecord {
  const rankedAccounts = device ? ranking(input, entry.model, device.id) : [];
  chosenAccount ??= continuityAccount(input, entry.model, effortRequested, rankedAccounts);
  const account = rankedAccounts.find(ranked => ranked.eligible && (!chosenAccount || ranked.account.id === chosenAccount.accountId));
  if (!device || !account) throw new Error('Placement candidates have no device for the model.');
  const choice = placementDevices(input, options, entry);
  return PlacementRecordSchema.parse({
    schema: 'placement-v1', questionSet: PLACEMENT_QUESTION_SET, source: outcome.source, fixed: fixedPlacementFields(input.fixed),
    isolation, runtime: entry.model.runtime, modelId: entry.model.id, model: entry.model.model,
    effortRequested, effortEffective: effectiveEffort(input, entry.model, effortRequested),
    ...(input.reason ? { reason: input.reason } : {}), ...(input.constraints ? { constraints: input.constraints } : {}), deviceId: device.id, accountId: account.account.id,
    accountChoice: chosenAccount ?? accountChoice(rankedAccounts, account.account.id, input.fixed.accountId ? 'fixed' : outcome.source === 'fallback' ? 'fallback' : 'only-option', input.now),
    ...(outcome.probabilities ? { probabilities: outcome.probabilities } : {}),
    eligibleModels: options.models.map((model) => model.model.id), excludedModels: options.excludedModels,
    eligibleDevices: choice.devices.map((candidate) => candidate.id), excludedDevices: choice.excluded,
    ...(input.devices.some(device => device.facts) ? { deviceFacts: input.devices.map(device => ({ deviceId: device.id, name: device.name, running: device.running, tags: device.tags ?? [], ...(device.facts ? { facts: device.facts } : {}) })) } : {}),
    ...(outcome.error ? { error: { kind: outcome.error.kind, message: outcome.error.message.slice(0, 300) } } : {}),
    jevCalls: [...outcome.calls], decidedAt: new Date(input.now).toISOString(),
  });
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
  const options = placementOptions(candidates, isolation); const entry = options.models[0];
  if (!entry) throw new Error('Placement candidates have no model.');
  const { devices } = placementDevices(input, options, entry);
  const device = devices.find((candidate) => candidate.id === input.coordinatorDeviceId)
    ?? [...devices].sort((a, b) => a.running - b.running || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
  return placementRecord(input, { isolation, options, entry, device, effortRequested: input.fixed.effort ?? 'medium' },
    fixedOnly ? { source: 'fixed', calls } : { source: 'fallback', calls, error });
}

const STATE_TOKENS = 12_000;
const TASK_CHARS = 6000;
const text = z.string();
/** The redacted packet both placement calls send (brief 10). Rules hold configuration; thread and project text stays outside them. */
export const PlacementStateSchema = z.strictObject({
  schema: z.literal('placement-state-v3'), task: TaskPlacementContextSchema, lessons: JevLessonInputSchema.optional(),
  // The newest eight same-type corrections, then four from other types; one sentence per changed field.
  rules: z.strictObject({ projectGuidance: z.string().max(2000), routingProfile: text, effortGuide: z.record(EffortSchema, text), recentOverrides: z.array(text).max(72) }),
  project: z.strictObject({ name: text, defaultIsolation: IsolationSchema, gitPolicy: z.enum(['main', 'external']).optional() }),
  thread: z.strictObject({ title: text, task: text.max(TASK_CHARS), coordinatorNote: text.max(600).optional(), trouble: z.string().max(2000).optional() }),
  activeThreads: z.array(z.strictObject({ title: text, isolation: IsolationSchema, device: text, model: text, effort: EffortSchema, reservedPaths: z.array(text) })).max(50),
  devices: z.array(z.strictObject({ name: text, running: z.number().int().nonnegative(), tags: DeviceTagsSchema, facts: DeviceFactsSchema.optional() })).max(200).optional(),
});
export type PlacementState = z.infer<typeof PlacementStateSchema>;
/** A non-terminal thread of the project as the packet shows it: device name and model label, not ids. */
export type PlacementActiveThread = PlacementState['activeThreads'][number];
export type PlacementOverrideEntry = Pick<PlacementOverride, 'mode' | 'changes' | 'at' | 'taskType'> & { title: string };
/** Active threads are oldest first. Corrections prefer the newest eight of this type, then four of other types. */
export type PlacementPacketInput = { lessons?: JevLessonInput | undefined; title: string; task: string; taskContext?: TaskPlacementContext | undefined; note?: string | undefined; trouble?: string | undefined; activeThreads: PlacementActiveThread[]; overrides: PlacementOverrideEntry[] };
type PlacementStateInput = PlacementInput & { storedState?: string; packet: PlacementPacketInput; redactor: Pick<SecretRedactor, 'document'> };

/** `{field} changed from {from} to {to} for '{title}' ({mode})` (brief 10), with the stored values (model ids, D249). */
export function overrideSentence(change: { field: PlacementField; from: string; to: string }, title: string, mode: PlacementOverride['mode'], type: TaskType = 'feature'): string {
  return `${change.field} changed from ${change.from} to ${change.to} for a ${type} task '${title}' (${mode})`;
}

/**
 * The `placement-state-v3` packet: redacted first, then the task is cut to 6,000 characters with the marker and the note to 600, so a
 * cut never splits a secret before the redactor saw it. Over 12,000 estimated tokens it drops reserved paths, then trouble, then active threads,
 * then override sentences, oldest first each; still too large is `state-too-large` (D249).
 */
export function buildPlacementState(input: PlacementStateInput): { state: string; approximateTokens: number } {
  const { packet } = input;
  const taskContext = packet.taskContext ?? { type: 'feature', needs: [], goal: null };
  const recent = [...packet.overrides].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const same = (entry: PlacementOverrideEntry) => (entry.taskType ?? 'feature') === taskContext.type;
  const overrides = [...recent.filter(same).slice(0, 8), ...recent.filter(entry => !same(entry)).slice(0, 4)];
  const mainAllowed = input.gates.mainIsolation;
  const note = packet.note?.trim();
  const redacted = input.redactor.document({
    schema: 'placement-state-v3', task: taskContext, ...(packet.lessons ? {lessons:packet.lessons} : {}),
    rules: { projectGuidance: input.projectGuidance ?? '', routingProfile: input.settings.routingProfile, effortGuide: { ...input.settings.effortGuide },
      recentOverrides: overrides.flatMap((entry) => entry.changes.map((change) => overrideSentence(change, entry.title, entry.mode, entry.taskType))).slice(0, 72) },
    project: { name: input.project.name, defaultIsolation: input.defaultIsolation === 'main' && !mainAllowed ? 'worktree' : input.defaultIsolation, gitPolicy: input.project.branchPolicy },
    thread: { title: packet.title, task: packet.task, ...(note ? { coordinatorNote: note } : {}), ...(packet.trouble ? { trouble: packet.trouble } : {}) },
    activeThreads: packet.activeThreads.slice(-50).map((thread) => ({ title: thread.title, isolation: thread.isolation, device: thread.device, model: thread.model, effort: thread.effort, reservedPaths: [...thread.reservedPaths] })),
    ...(input.devices.some(device => device.facts) ? { devices: input.devices.map(device => ({ name: device.name, running: device.running, tags: device.tags ?? [], ...(device.facts ? { facts: device.facts } : {}) })) } : {}),
  } satisfies PlacementState);
  const { task, coordinatorNote, trouble } = redacted.thread;
  const packed = PlacementStateSchema.parse({ ...redacted, rules: { ...redacted.rules, projectGuidance: redacted.rules.projectGuidance.slice(0, 2000) }, task: { ...redacted.task, goal: redacted.task.goal ? { ...redacted.task.goal, motivation: redacted.task.goal.motivation.slice(0, 600) } : null }, thread: { ...redacted.thread,
    task: task.length > TASK_CHARS ? `${task.slice(0, TASK_CHARS - TASK_SHORTENED.length)}${TASK_SHORTENED}` : task,
    ...(coordinatorNote ? { coordinatorNote: coordinatorNote.slice(0, 600) } : {}), ...(trouble ? { trouble: trouble.slice(0, 2000) } : {}) } });
  let state = '';
  const over = () => approximateTokens(state = JSON.stringify(packed)) > STATE_TOKENS;
  for (const thread of packed.activeThreads) { if (!over()) break; thread.reservedPaths = []; }
  if (over()) delete packed.thread.trouble;
  while (over() && packed.activeThreads.length) packed.activeThreads.shift();
  while (over() && packed.rules.recentOverrides.length) packed.rules.recentOverrides.pop();
  if (over()) throw new JevError('state-too-large');
  return { state, approximateTokens: approximateTokens(state) };
}

/** Replays retain the stored packet; adding lessons may refuse the same ordinary budget, never silently drop old context. */
export function placementReplayState(input:unknown,redactor:Pick<SecretRedactor,'document'>):string{
 const state=JSON.stringify(PlacementStateSchema.parse(redactor.document(input)));
 if(approximateTokens(state)>STATE_TOKENS)throw new JevError('state-too-large');
 return state;
}

/** Call A (brief 10): isolation only when both are allowed, the model among the eligible ones, the effort; each omitted when fixed or single. */
export function preparePlacementA(input: PlacementInput, candidates: PlacementCandidates): JevQuestions {
  const questions: JevQuestions = {};
  if (input.fixed.isolation === undefined && candidates.isolations.length > 1) {
    const manual = input.project.branchPolicy === 'external';
    questions.isolation = { type: 'choice', instructions: manual ? 'Choose the workspace. This project leaves git to the owner. Existing uncommitted and untracked files are only present in the project checkout; a worktree starts from committed files.' : (input.prompt?.instructions.isolation ?? PLACEMENT_INSTRUCTIONS.isolation),
      criteria: Object.fromEntries(candidates.isolations.map((isolation) => [isolation, manual && isolation === 'main' ? 'Edit the existing project checkout, including untracked files. Leave changes in place without staging, committing, switching branches, resetting or pushing. Use this for changes to an app served from that checkout.' : (input.prompt?.isolation[isolation] ?? PLACEMENT_ISOLATION_CRITERIA[isolation])])) };
  }
  if (input.fixed.modelId === undefined && candidates.models.length > 1) {
    questions.pick_model = { type: 'choice', instructions: input.prompt?.instructions.pick_model ?? PLACEMENT_INSTRUCTIONS.pick_model, criteria: Object.fromEntries(candidates.models.map(({ model }) => [model.id, model.description])) };
  }
  const efforts = placementEfforts(input, candidates.models);
  if (input.fixed.effort === undefined && efforts.length > 1) questions.effort = { type: 'choice', instructions: input.prompt?.instructions.effort ?? PLACEMENT_INSTRUCTIONS.effort, criteria: Object.fromEntries(efforts.map(effort => [effort, input.settings.effortGuide[effort]])) };
  return questions;
}

const deviceCriterion = (device: PlacementDevice) => device.facts
  ? `${device.name}: ${device.running} running, load ${Number(device.facts.load5.toFixed(1))} on ${device.facts.cores} cores, ${Math.floor(device.facts.freeDiskBytes / 1e9)} GB free, ${Number((device.facts.freeMemoryBytes / 1e9).toFixed(1))} GB memory free, tags ${(device.tags ?? []).join(', ') || 'none'}`
  : `${device.name}: ${device.running} threads running here${device.isCoordinator ? ", this is the coordinator's device" : ''}${device.checkoutBranch ? `, project checkout is on ${device.checkoutBranch}` : ''}${device.tags ? `, tags ${device.tags.join(', ') || 'none'}` : ''}`;
/** Call B (brief 10): one option per candidate device with an eligible account for the chosen model under the chosen isolation. */
export function preparePlacementB(input: PlacementInput, candidates: PlacementCandidates, chosen: { isolation: Isolation; model: ModelOption }): JevQuestions {
  const options = placementOptions(candidates, chosen.isolation);
  const entry = options.models.find((model) => model.model.id === chosen.model.id);
  if (!entry) throw new Error('This model is not a placement candidate for this isolation.');
  const { devices } = placementDevices(input, options, entry);
  if (input.fixed.deviceId !== undefined || devices.length < 2) return {};
  return { device: { type: 'choice', instructions: input.prompt?.instructions.device ?? PLACEMENT_INSTRUCTIONS.device, criteria: Object.fromEntries(devices.map((device) => [device.id, deviceCriterion(device)])) } };
}

/** The highest-probability option; exact ties go to Jev's choice, else to the first tied option in criteria order (D30, D251). */
function resolveChoice(questions: JevQuestions, response: JevResponse | undefined, id: string): { option: string; probabilities: Record<string, number> } {
  const question = questions[id]; const answer = response?.answers[id];
  if (question?.type !== 'choice' || answer?.type !== 'choice') throw new JevError('invalid-response');
  const keys = Object.keys(question.criteria); const p = (key: string) => answer.probabilities[key] ?? 0;
  const max = Math.max(...keys.map(p));
  return { option: p(answer.choice) === max ? answer.choice : keys.find((key) => p(key) === max)!, probabilities: answer.probabilities };
}

export type PlacementDecision = { kind: 'placed'; record: PlacementRecord; atLimit: boolean } | { kind: 'refused'; message: string };
/**
 * Jev placement (brief 10): candidates in code, then Call A and Call B, each sent only with questions, over one redacted packet. Any Jev
 * failure except cancellation, and the unavailable credential source, places with the deterministic fallback and records why (D30a);
 * no question at all records `source: 'fixed'` (D30b). `atLimit` passes the candidates' running-limit flag to the caller (D251).
 */
export async function decidePlacement(client: DecisionClient, input: PlacementStateInput & { jevModel: string }, signal: AbortSignal): Promise<PlacementDecision> {
  const candidates = placementCandidates(input);
  if ('refused' in candidates) return { kind: 'refused', message: candidates.refused };
  if (signal.aborted) throw new JevError('cancelled');
  const placed = (record: PlacementRecord): PlacementDecision => {
    const packet = state ? PlacementStateSchema.parse(JSON.parse(state)) : undefined;
    return { kind: 'placed', record: PlacementRecordSchema.parse({ ...record,
      ...(packet ? { taskContext: packet.task, correctionsShown: packet.rules.recentOverrides } : {}) }), atLimit: candidates.atLimit };
  };
  const calls: JevCall[] = []; const probabilities: Record<string, Record<string, number>> = {}; let state: string | undefined;
  const ask = async (questions: JevQuestions) => {
    if (!Object.keys(questions).length) return undefined;
    state ??= input.storedState ?? buildPlacementState(input).state;
    return askJev(client, { model: input.jevModel, state, questions, kind: 'placement', calls }, signal);
  };
  const choose = (questions: JevQuestions, response: JevResponse | undefined, id: string): string | undefined => {
    if (!questions[id]) return undefined;
    const resolved = resolveChoice(questions, response, id); probabilities[id] = resolved.probabilities; return resolved.option;
  };
  try {
    const a = preparePlacementA(input, candidates); const answerA = await ask(a);
    const isolation = IsolationSchema.safeParse(choose(a, answerA, 'isolation') ?? candidates.isolations[0]);
    const modelId = choose(a, answerA, 'pick_model') ?? candidates.models[0]!.model.id;
    const effort = EffortSchema.safeParse(input.fixed.effort ?? choose(a, answerA, 'effort') ?? placementEfforts(input, candidates.models)[0]);
    if (!isolation.success || !candidates.isolations.includes(isolation.data) || !effort.success) throw new JevError('invalid-response');
    const options = placementOptions(candidates, isolation.data);
    const entry = options.models.find((model) => model.model.id === modelId);
    if (!entry && candidates.models.some((model) => model.model.id === modelId)) return placed(placementFallback(input, candidates, PLACEMENT_INCOMPATIBLE, calls));
    if (!entry) throw new JevError('invalid-response');
    const b = preparePlacementB(input, candidates, { isolation: isolation.data, model: entry.model }); const answerB = await ask(b);
    const { devices } = placementDevices(input, options, entry);
    const deviceId = choose(b, answerB, 'device') ?? devices[0]?.id;
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new JevError('invalid-response');
    const ranked = ranking(input, entry.model, device.id);
    const chosenAccount = continuityAccount(input, entry.model, effort.data, ranked) ?? await decideAccount(client, { ranking: ranked, state: () => state ?? input.storedState ?? buildPlacementState(input).state,
      model: input.jevModel, now: input.now, redactor: { text: value => input.redactor.document(value) }, ...(input.fixed.accountId ? { fixed: input.fixed.accountId } : {}) }, signal);
    calls.push(...chosenAccount.jevCalls);
    if (chosenAccount.probabilities) probabilities.account = chosenAccount.probabilities;
    return placed(placementRecord(input, { isolation: isolation.data, options, entry, device, effortRequested: effort.data, accountChoice: chosenAccount },
      chosenAccount.source === 'fallback' ? { source: 'fallback', calls, probabilities, ...(chosenAccount.error ? { error: chosenAccount.error } : {}) }
        : calls.length ? { source: 'jev', calls, probabilities } : { source: 'fixed', calls }));
  } catch (error) {
    if (error instanceof JevError && error.kind !== 'cancelled') return placed(placementFallback(input, candidates, { kind: error.kind, message: error.message }, calls));
    // The hub-backed key source answers 503 while the hub is unreachable; the client raises it as a plain error.
    if (error instanceof Error && (error as Error & { status?: unknown }).status === 503) {
      return placed(placementFallback(input, candidates, { kind: 'credential-unavailable', message: error.message }, calls));
    }
    throw error;
  }
}
import { TaskPlacementContextSchema, type TaskPlacementContext, type TaskType } from '@jevellan/core';

/** Owner clamps narrow the normal candidate evaluation; they never turn a rule into a privileged fixed field. */
export type PlacementRuleChoice = Pick<PlacementRecord, 'isolation' | 'runtime' | 'modelId' | 'model' | 'effortRequested' | 'effortEffective' | 'deviceId' | 'accountId' | 'source' | 'fixed' | 'jevCalls' | 'accountChoice' | 'probabilities' | 'error'>;
export function clampPlacementRules<T extends PlacementRuleChoice>(input: PlacementInput, raw: T, rules: readonly import('@jevellan/core').JevRule[], context: import('./jev-rules.js').JevRuleContext): {kind:'placed';record:T|PlacementRecord;rulesApplied:string[];reason:string}|{kind:'refused';message:string;rulesApplied:string[];reason:string} {
  const ranked = matchingJevRules(input.project.id, rules, context).filter(({rule}) => rule.set.minModel || rule.set.minEffort || rule.set.maxEffort || rule.set.account || rule.set.runtime)
    .sort((a,b) => Number(b.rule.scope==='project')-Number(a.rule.scope==='project') || b.fields-a.fields || Number(a.rule.id.slice(1))-Number(b.rule.id.slice(1)));
  if(!ranked.length)return{kind:'placed',record:raw,rulesApplied:[],reason:''};
  const relevant=new Set<string>();
  const constraint=(field:'account'|'runtime')=>{
    const rows=ranked.filter(row=>row.rule.set[field]);const top=rows[0];if(!top)return undefined;
    const tied=rows.filter(row=>row.rule.scope===top.rule.scope&&row.fields===top.fields);if(new Set(tied.map(row=>row.rule.set[field])).size>1)throw Error(`Equally specific owner rules disagree on ${field}: ${tied.map(row=>row.rule.id).join(', ')}.`);
    relevant.add(top.rule.id);return top.rule.set[field];
  };
  try{
    const accountId=input.fixed.accountId?undefined:constraint('account'),runtimeId=input.fixed.runtimeId||input.fixed.modelId?undefined:constraint('runtime');
    const floors=input.fixed.modelId?[]:ranked.filter(row=>row.rule.set.minModel),firstFloor=floors[0];let floor:ModelOption|undefined;
    if(firstFloor){const tied=floors.filter(row=>row.rule.scope===firstFloor.rule.scope&&row.fields===firstFloor.fields);const models=tied.map(row=>input.settings.menu.find(model=>model.id===row.rule.set.minModel));if(models.some(model=>!model))throw Error('An owner rule model is no longer configured.');
      const distinct=[...new Map(models.map(model=>[model!.id,model!])).values()];if(distinct.length>1&&distinct.some(model=>model.qualityRank===undefined))throw Error('Conflicting owner model floors need explicit quality ranks.');floor=distinct.toSorted((a,b)=>(b.qualityRank??0)-(a.qualityRank??0)||a.id.localeCompare(b.id))[0];
      const selected=tied.find(row=>row.rule.set.minModel===floor!.id)!;relevant.add(selected.rule.id);
    }
    const bounds=jevEffortBounds(input.project.id,rules,context),effortRule=applyJevEffortRules(input.project.id,raw.effortRequested,rules,context);for(const id of effortRule.rulesApplied)relevant.add(id);
    const allowedEffort=(effort:Effort)=>input.fixed.effort!==undefined||EffortSchema.options.indexOf(effort)>=EffortSchema.options.indexOf(bounds.minimum)&&EffortSchema.options.indexOf(effort)<=EffortSchema.options.indexOf(bounds.maximum);
    const narrowed:PlacementInput={...input,accounts:accountId?input.accounts.filter(account=>account.id===accountId):input.accounts,settings:{...input.settings,menu:input.settings.menu.map(model=>{
      const modelAllowed=(!runtimeId||model.runtime===runtimeId)&&(!floor||model.id===floor.id||model.qualityRank!==undefined&&floor.qualityRank!==undefined&&model.qualityRank>=floor.qualityRank),efforts=model.efforts.filter(allowedEffort);
      return{...model,enabled:model.enabled&&modelAllowed&&efforts.length>0,efforts:efforts.length?efforts:model.efforts};
    })}};
    const candidates=placementCandidates(narrowed);if('refused'in candidates)return{kind:'refused',message:`Owner rules ${[...relevant].join(', ')} leave no eligible placement. ${candidates.refused}`,rulesApplied:[...relevant],reason:'Owner rules retain the normal account, project and device guards.'};
    const isolation=candidates.isolations.includes(raw.isolation)?raw.isolation:candidates.isolations[0]!,options=placementOptions(candidates,isolation),entry=options.models.find(row=>row.model.id===raw.modelId)??options.models.find(row=>row.model.id===floor?.id)??options.models.toSorted((a,b)=>(a.model.qualityRank??Number.MAX_SAFE_INTEGER)-(b.model.qualityRank??Number.MAX_SAFE_INTEGER)||a.model.id.localeCompare(b.model.id))[0]!;
    const {devices}=placementDevices(narrowed,options,entry),device=devices.find(row=>row.id===raw.deviceId)??devices.find(row=>row.id===input.coordinatorDeviceId)??devices.toSorted((a,b)=>a.running-b.running||a.name.localeCompare(b.name)||a.id.localeCompare(b.id))[0];
    if(!device)throw Error('Owner rules leave no eligible device.');const accounts=ranking(narrowed,entry.model,device.id),account=accounts.find(row=>row.eligible&&row.account.id===raw.accountId)??accounts.find(row=>row.eligible);if(!account)throw Error('Owner rules leave no eligible account.');
    const desired=input.fixed.effort??effortRule.effort,choice=accountChoice(accounts,account.account.id,account.account.id===raw.accountId?raw.accountChoice?.source??'only-option':accounts.filter(row=>row.eligible).length===1?'only-option':'fallback',input.now);
    const record=placementRecord(narrowed,{isolation,options,entry,device,effortRequested:desired,accountChoice:choice},{source:raw.source,calls:raw.jevCalls,...(raw.probabilities?{probabilities:raw.probabilities}:{}),...(raw.error?{error:raw.error}:{})});
    const changed=(['isolation','runtime','modelId','effortRequested','effortEffective','deviceId','accountId'] as const).some(key=>record[key]!==raw[key]);
    const reason=changed?`Owner rules ${[...relevant].join(', ')} changed placement from ${raw.modelId} ${raw.effortEffective} to ${record.modelId} ${record.effortEffective}${account.account.id!==raw.accountId?` on account ${account.account.id}`:''}. ${effortRule.reason}`.trim():'';
    return{kind:'placed',record:{...record,fixed:raw.fixed},rulesApplied:changed?[...relevant]:[],reason};
  }catch(error){return{kind:'refused',message:error instanceof Error?error.message:'The owner rules could not be applied.',rulesApplied:[...relevant],reason:'Owner rules could not produce a guarded placement.'};}
}
