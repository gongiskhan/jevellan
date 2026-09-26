import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccountSchema, AccountStatusSchema, ActionSchema, ConfigurationSchema, DecisionComparisonSchema, DecisionEvaluationSchema, EffortSchema, IdSchema,
  configurationDigest, stableJson, type Configuration, type DecisionComparison, type DecisionEvaluation,
} from '@jevellan/core';
import { DecisionStateSchema } from './state.js';
import { decideNext, type DecisionClient } from './engine.js';
import { modelCandidates } from './selection.js';
import { JevError } from './contract.js';

export const SavedDecisionCaseSchema = z.strictObject({
  schema: z.literal('saved-decision-case-v1'), id: IdSchema, title: z.string().min(1), state: DecisionStateSchema,
  allowedActions: z.array(ActionSchema.exclude(['integrate'])).min(1), availableModels: z.array(IdSchema).min(1),
  newMessage: z.boolean(), questionAvailable: z.boolean(),
  acceptable: z.strictObject({ actions: z.array(ActionSchema).min(1), models: z.array(IdSchema), efforts: z.array(EffortSchema) }),
}).superRefine((value, context) => {
  if (value.acceptable.actions.some(action => !value.allowedActions.some(allowed => allowed === action))) context.addIssue({ code: 'custom', message: 'An acceptable action must be allowed.' });
  if (value.acceptable.models.some(model => !value.availableModels.includes(model))) context.addIssue({ code: 'custom', message: 'An acceptable model must be available.' });
});
export type SavedDecisionCase = z.infer<typeof SavedDecisionCaseSchema>;
const SavedDecisionCasesSchema = z.strictObject({ schema: z.literal('saved-decision-cases-v1'), cases: z.array(SavedDecisionCaseSchema).min(1) })
  .refine(value => new Set(value.cases.map(entry => entry.id)).size === value.cases.length, 'Case identifiers must be unique.');
export function savedDecisionCases(): SavedDecisionCase[] {
  return SavedDecisionCasesSchema.parse(JSON.parse(readFileSync(new URL('../cases/decision-cases-v1.json', import.meta.url), 'utf8'))).cases;
}
export function decisionCaseManifest(cases: SavedDecisionCase[] = savedDecisionCases()): { digest: string; ids: string[] } {
  const checked = SavedDecisionCasesSchema.parse({ schema: 'saved-decision-cases-v1', cases });
  return { digest: createHash('sha256').update(stableJson(checked)).digest('hex'), ids: checked.cases.map(example => example.id) };
}

/** Fixed account availability isolates routing quality from this machine's logins. No runtime is launched. */
export async function evaluateDecisionCase(client: DecisionClient, raw: SavedDecisionCase, configuration: Configuration, signal: AbortSignal): Promise<DecisionEvaluation> {
  const example = SavedDecisionCaseSchema.parse(raw); const settings = ConfigurationSchema.parse(configuration)['x-jevellan'];
  if (example.availableModels.some(id => !settings.menu.some(model => model.id === id))) throw new Error(`Saved case ${example.id} needs a model that is missing from the menu.`);
  const menu = settings.menu.filter(model => example.availableModels.includes(model.id)).map(model => ({ ...model, enabled: true }));
  const runtimes = [...new Set(menu.map(model => model.runtime))];
  const accounts = runtimes.map(runtime => AccountSchema.parse({ schema: 'account-v1', id: `case_${runtime}`, runtime, label: 'Saved case account', kind: 'subscription', enabled: true, credential: 'per-device' }));
  const now = Date.now();
  const statuses = accounts.map(account => AccountStatusSchema.parse({ schema: 'account-status-v1', accountId: account.id, deviceId: 'saved_cases', auth: 'ready', observedAt: new Date(now).toISOString() }));
  const state = DecisionStateSchema.parse(example.state);
  state.rules.routingProfile = settings.routingProfile; state.rules.effortGuide = settings.effortGuide;
  if (state.current) {
    const current = menu.find(model => model.id === state.current!.modelId);
    if (!current) throw new Error(`Saved case ${example.id} has an unavailable current model.`);
    state.current.label = current.label; state.current.description = current.description;
  }
  const result = await decideNext(client, {
    model: settings.decisions.model, state: JSON.stringify(state), allowed: example.allowedActions, newMessage: example.newMessage,
    candidates: action => modelCandidates({ action, settings: { ...settings, menu, runtimes: Object.fromEntries(runtimes.map(runtime => [runtime, { enabled: true }])) },
      runtimes: new Map(runtimes.map(runtime => [runtime, { mcp: true, readOnlyEnforced: true, edit: true, shell: true }])), accounts, statuses, deviceId: 'saved_cases', now }),
    effortGuide: settings.effortGuide, keepCurrentThreshold: settings.decisions.keepCurrentThreshold,
    ...(state.current ? { currentId: state.current.modelId } : {}), deviceLabel: 'Saved cases', questionAvailable: example.questionAvailable,
    assertCurrent: () => { if (signal.aborted) throw new JevError('cancelled'); },
  }, signal);
  if (result.kind !== 'selected') throw new Error(`Saved case ${example.id} could not select a model.`);
  const { action, model, effort, calls } = result.selection;
  const choice = { action: action.chosen, modelId: model?.chosen ?? null, effort: effort?.requested ?? null };
  const failedFields: Array<'action' | 'model' | 'effort'> = [];
  if (!example.acceptable.actions.includes(choice.action)) failedFields.push('action');
  if (choice.modelId !== null && !example.acceptable.models.includes(choice.modelId)) failedFields.push('model');
  if (choice.effort !== null && !example.acceptable.efforts.includes(choice.effort)) failedFields.push('effort');
  return DecisionEvaluationSchema.parse({ schema: 'decision-evaluation-v1', caseId: example.id, title: example.title, choice, acceptable: !failedFields.length, failedFields, calls });
}

export async function compareDecisionCases(client: DecisionClient, cases: SavedDecisionCase[], before: Configuration, after: Configuration, evidence: DecisionComparison['evidence'], signal: AbortSignal): Promise<DecisionComparison> {
  const checked = SavedDecisionCasesSchema.parse({ schema: 'saved-decision-cases-v1', cases });
  const originalConfiguration = ConfigurationSchema.parse(before); const proposedConfiguration = ConfigurationSchema.parse(after);
  const results: DecisionComparison['cases'] = [];
  for (const example of checked.cases) {
    const original = await evaluateDecisionCase(client, example, originalConfiguration, signal);
    const proposed = await evaluateDecisionCase(client, example, proposedConfiguration, signal);
    results.push({ before: original, after: proposed, change: original.acceptable === proposed.acceptable ? 'unchanged' : proposed.acceptable ? 'better' : 'worse' });
  }
  return DecisionComparisonSchema.parse({ schema: 'decision-comparison-v1', evidence, at: new Date().toISOString(), cases: results,
    beforeConfiguration: configurationDigest(originalConfiguration), afterConfiguration: configurationDigest(proposedConfiguration), caseSet: decisionCaseManifest(checked.cases).digest,
    unchanged: results.filter(value => value.change === 'unchanged').length, better: results.filter(value => value.change === 'better').length, worse: results.filter(value => value.change === 'worse').length });
}
