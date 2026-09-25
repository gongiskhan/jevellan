import { rankAccounts, type RankedAccount } from '@jevellan/accounts';
import { ACTION_DESCRIPTIONS, ActionSchema, EffortSchema, mapEffort, type Account, type AccountStatus, type Action, type Configuration, type DecisionRecord, type Effort, type ExclusionReason, type ModelOption } from '@jevellan/core';
import { JevError, type JevQuestions, type JevResponse } from './contract.js';

export const QUESTION_SET = 'q-v2';
type ActionRecord = DecisionRecord['action'];
type ModelRecord = NonNullable<DecisionRecord['model']>;
type EffortRecord = NonNullable<DecisionRecord['effort']>;
export type Preferences = { modelId?: string | undefined; effort?: Effort | undefined };
export type ActionPlan = { questions: JevQuestions; allowed: Action[]; fixed?: ActionRecord };

export function prepareAction(input: { allowed: Action[]; override?: Action; newMessage: boolean }): ActionPlan {
  const allowed = [...new Set(input.allowed.map((action) => ActionSchema.parse(action)))];
  if (!allowed.length || allowed.includes('integrate') || input.override && !allowed.includes(input.override)) throw new JevError('invalid-request');
  const questions: JevQuestions = {};
  const chosen = input.override ?? (allowed.length === 1 ? allowed[0] : undefined);
  if (!chosen) questions.next_action = { type: 'choice', instructions: 'Given the rules and the conversation, what should happen next?', criteria: Object.fromEntries(allowed.map((action) => [action, ACTION_DESCRIPTIONS[action]])) };
  if (input.newMessage) questions.remember_request = { type: 'noul', instructions: "The user's latest message explicitly asks to record something in the project's memory.", criteria: { true: 'The latest message explicitly requests recording project memory.', false: 'There is no explicit request to record project memory.' } };
  return { allowed, questions, ...(chosen ? { fixed: { chosen, source: input.override ? 'override' : 'only-option', allowed } satisfies ActionRecord } : {}) };
}

function choice(response: JevResponse | undefined, id: string) {
  const answer = response?.answers[id]; if (answer?.type !== 'choice') throw new JevError('invalid-response'); return answer;
}
function noul(response: JevResponse | undefined, id: string): number {
  const answer = response?.answers[id]; if (answer?.type !== 'noul') throw new JevError('invalid-response'); return answer.noul;
}
export function resolveAction(plan: ActionPlan, response?: JevResponse): { action: ActionRecord; remember: boolean } {
  const answer = plan.fixed ? undefined : choice(response, 'next_action');
  const chosen = plan.fixed?.chosen ?? ActionSchema.parse(answer!.choice);
  if (!plan.allowed.includes(chosen)) throw new JevError('invalid-response');
  const rememberP = plan.questions.remember_request ? noul(response, 'remember_request') : 0;
  return { action: plan.fixed ?? { chosen, source: 'jev', allowed: plan.allowed, probabilities: answer!.probabilities, confidence: answer!.confidence }, remember: chosen === 'reply' && rememberP >= 0.7 };
}

export type ModelCandidate = { model: ModelOption; ranking: RankedAccount[]; reason?: ExclusionReason };
export type RuntimeSupport = { mcp: boolean; readOnlyEnforced: boolean; edit: boolean; shell: boolean };
export function modelCandidates(input: {
  settings: Configuration['x-jevellan']; action: Action; runtimes: ReadonlyMap<string, RuntimeSupport>;
  accounts: Account[]; statuses: AccountStatus[]; deviceId: string; now?: number;
}): ModelCandidate[] {
  const writing = ['implement', 'test', 'integrate'].includes(input.action);
  return input.settings.menu.filter((model) => {
    const runtime = input.runtimes.get(model.runtime);
    return model.enabled && input.settings.runtimes[model.runtime]?.enabled && runtime?.mcp
      && (writing ? runtime.edit && runtime.shell : runtime.readOnlyEnforced);
  }).map((model) => {
    const ranking = rankAccounts({ accounts: input.accounts, statuses: input.statuses, runtime: model.runtime, deviceId: input.deviceId, ...(input.now === undefined ? {} : { now: input.now }) }).filter((entry) => entry.account.runtime === model.runtime);
    const excluded = ranking.some((entry) => entry.eligible) ? undefined : ranking[0]?.reason ?? 'no-account';
    return { model, ranking, ...(excluded && excluded !== 'eligible' ? { reason: excluded } : {}) };
  });
}

type ReadyModelPlan = {
  kind: 'ready'; questions: JevQuestions; enabled: ModelCandidate[]; eligible: ModelCandidate[];
  currentId?: string; fixedModel?: { chosen: string; source: 'override' | 'pin' };
  fixedEffort?: { requested: Effort; source: 'override' | 'pin' };
};
export type ModelPlan = ReadyModelPlan | { kind: 'waiting'; message: string; reasons: { modelId: string; reason: ExclusionReason; accountIds: string[] }[] };

export function prepareModel(input: {
  action: Action; candidates: ModelCandidate[]; effortGuide: Record<Effort, string>;
  currentId?: string; once?: Preferences; pins?: Preferences;
}): ModelPlan {
  const enabled = input.candidates; const eligible = enabled.filter((candidate) => !candidate.reason);
  if (enabled.length > 19 || new Set(enabled.map((entry) => entry.model.id)).size !== enabled.length) throw new JevError('invalid-request');
  const fixedModel = input.once?.modelId ? { chosen: input.once.modelId, source: 'override' as const } : input.pins?.modelId ? { chosen: input.pins.modelId, source: 'pin' as const } : undefined;
  const fixedEffort = input.once?.effort ? { requested: input.once.effort, source: 'override' as const } : input.pins?.effort ? { requested: input.pins.effort, source: 'pin' as const } : undefined;
  if (!eligible.length || fixedModel && !eligible.some((entry) => entry.model.id === fixedModel.chosen)) {
    const relevant = fixedModel ? enabled.filter((entry) => entry.model.id === fixedModel.chosen) : enabled;
    const reasons = relevant.map((entry) => ({ modelId: entry.model.id, reason: entry.reason ?? 'unsupported' as const, accountIds: entry.ranking.map((rank) => rank.account.id) }));
    if (fixedModel && !reasons.length) reasons.push({ modelId: fixedModel.chosen, reason: 'unsupported', accountIds: [] });
    return { kind: 'waiting', reasons, message: `No model can run this step right now: ${reasons.map((entry) => `${enabled.find((candidate) => candidate.model.id === entry.modelId)?.model.label ?? entry.modelId}: ${entry.reason}`).join(', ') || 'no enabled model supports this action'}.` };
  }
  const questions: JevQuestions = {};
  const criteria = (candidates: ModelCandidate[]) => Object.fromEntries(candidates.map(({ model }) => [model.id, `${model.label}: ${model.description}`]));
  const current = eligible.find((candidate) => candidate.model.id === input.currentId);
  if (!fixedModel) {
    if (current) questions.keep_current = { type: 'noul', instructions: `The current model (${current.model.label}: ${current.model.description}) is well suited for the next step: ${input.action}.`, criteria: { true: 'Well suited to this step.', false: 'Another model is better suited.' } };
    if (eligible.length > 1) questions.pick_eligible = { type: 'choice', instructions: `Which model best suits the next step: ${input.action}?`, criteria: criteria(eligible) };
    if (enabled.length > eligible.length) questions.pick_any = { type: 'choice', instructions: `Which model best suits the next step: ${input.action}?`, criteria: criteria(enabled) };
  }
  if (!fixedEffort) questions.effort = { type: 'choice', instructions: `How much reasoning effort does the next step (${input.action}) need, given the work so far?`, criteria: { ...input.effortGuide } };
  return { kind: 'ready', questions, enabled, eligible, ...(current ? { currentId: current.model.id } : {}), ...(fixedModel ? { fixedModel } : {}), ...(fixedEffort ? { fixedEffort } : {}) };
}

export function resolveModel(plan: ReadyModelPlan, input: { response?: JevResponse; keepCurrentThreshold: number; deviceLabel: string }): {
  model: ModelRecord; effort: EffortRecord; account: NonNullable<DecisionRecord['account']>; notices: DecisionRecord['notices'];
} {
  if (!Number.isFinite(input.keepCurrentThreshold) || input.keepCurrentThreshold < 0 || input.keepCurrentThreshold > 1) throw new JevError('invalid-request');
  const keepCurrentP = plan.questions.keep_current ? noul(input.response, 'keep_current') : undefined;
  const picked = plan.questions.pick_eligible ? choice(input.response, 'pick_eligible') : undefined;
  const preferred = plan.questions.pick_any ? choice(input.response, 'pick_any') : undefined;
  const kept = keepCurrentP !== undefined && keepCurrentP >= input.keepCurrentThreshold;
  const chosen = plan.fixedModel?.chosen ?? (kept ? plan.currentId : plan.eligible.length === 1 ? plan.eligible[0]!.model.id : picked?.choice);
  const candidate = plan.eligible.find((entry) => entry.model.id === chosen);
  const account = candidate?.ranking.find((entry) => entry.eligible);
  if (!candidate || !account || preferred && !plan.enabled.some((entry) => entry.model.id === preferred.choice)) throw new JevError('invalid-response');
  const effortAnswer = plan.fixedEffort ? undefined : choice(input.response, 'effort');
  const requested = plan.fixedEffort?.requested ?? EffortSchema.parse(effortAnswer!.choice);
  const effective = mapEffort(requested, candidate.model.efforts);
  const notices: DecisionRecord['notices'] = [];
  if (requested !== effective) notices.push({ kind: 'effort-adjusted', text: `Requested ${requested}; using ${effective}, the nearest effort this model supports.` });
  const preferredCandidate = preferred && plan.enabled.find((entry) => entry.model.id === preferred.choice);
  if (preferredCandidate && ['needs-login', 'expired'].includes(preferredCandidate.reason ?? '')) {
    const missing = preferredCandidate.ranking.find((entry) => entry.reason === preferredCandidate.reason);
    if (missing) notices.push({ kind: 'preferred-needs-login', text: `${preferredCandidate.model.label} looked like the best fit, but ${missing.account.label} needs login on ${input.deviceLabel}. Used ${candidate.model.label} instead.`, accountId: missing.account.id });
  }
  return {
    model: { chosen: candidate.model.id, source: plan.fixedModel?.source ?? (kept ? 'kept' : plan.eligible.length === 1 ? 'only-option' : 'jev'),
      ...(keepCurrentP === undefined ? {} : { keepCurrentP }), eligible: plan.eligible.map((entry) => ({ modelId: entry.model.id, ...(picked ? { p: picked.probabilities[entry.model.id]! } : {}) })),
      ...(preferred ? { preferredAny: { modelId: preferred.choice, p: preferred.probabilities[preferred.choice]! } } : {}),
      excluded: plan.enabled.flatMap((entry) => entry.reason ? [{ modelId: entry.model.id, reason: entry.reason }] : []) },
    effort: { requested, effective, source: plan.fixedEffort?.source ?? 'jev', ...(effortAnswer ? { probabilities: effortAnswer.probabilities } : {}) },
    account: { chosen: account.account.id, ranking: candidate.ranking.map((entry) => ({ accountId: entry.account.id, eligible: entry.eligible, reason: entry.reason })) }, notices,
  };
}

export function manualFallback(error: JevError): DecisionRecord['notices'][number] {
  return { kind: 'jev-unavailable', text: `Jev is unavailable (${error.message}). Pick the next step:` };
}
