import type { RankedAccount } from '@jevellan/accounts';
import { PlacementAccountChoiceSchema, type JevCall, type PlacementAccountChoice, type SecretRedactor } from '@jevellan/core';
import { JevError } from './contract.js';
import { askJev, type DecisionClient } from './engine.js';

export function accountChoice(ranking: readonly RankedAccount[], accountId: string, source: PlacementAccountChoice['source'], now: number,
  extra: Pick<PlacementAccountChoice, 'probabilities' | 'error' | 'jevCalls'> = { jevCalls: [] }): PlacementAccountChoice {
  if (!ranking.some(entry => entry.eligible && entry.account.id === accountId)) throw new Error('The chosen account is no longer eligible.');
  return PlacementAccountChoiceSchema.parse({ schema: 'placement-account-choice-v1', questionSet: 'a-v1', source, accountId, at: new Date(now).toISOString(),
    candidates: ranking.map(entry => ({ accountId: entry.account.id, label: entry.account.label, eligible: entry.eligible, reason: entry.reason,
      ceilingPct: entry.account.ceilingPct, credential: entry.account.credential, ...(entry.status ? { auth: entry.status.auth, statusDeviceId: entry.status.deviceId,
        ...(entry.status.usage ? { usage: entry.status.usage } : {}) } : {}) })), ...extra });
}

/** Resource eligibility is already enforced. Jev chooses only between the remaining saved accounts. */
export async function decideAccount(client: DecisionClient, input: { ranking: readonly RankedAccount[]; state: string | (() => string); model: string; now: number;
  redactor: Pick<SecretRedactor, 'text'>; fixed?: string }, signal: AbortSignal): Promise<PlacementAccountChoice> {
  const eligible = input.ranking.filter(entry => entry.eligible && (!input.fixed || entry.account.id === input.fixed));
  const first = eligible[0]; if (!first) throw new Error('No eligible saved account.');
  if (input.fixed || eligible.length === 1) return accountChoice(input.ranking, first.account.id, input.fixed ? 'fixed' : 'only-option', input.now);
  const calls: JevCall[] = [];
  try {
    const questions = { account: { type: 'choice' as const,
      instructions: 'Choose the saved account for this session. Respect the owner routing instructions. Prefer subscriptions and known usage with headroom below both usage ceilings; consider the five-hour and weekly reset times. Earlier options have better resource rank. Never choose a machine login or an unavailable account.',
      criteria: Object.fromEntries(eligible.map((entry, index) => [entry.account.id, input.redactor.text(JSON.stringify({ label: entry.account.label, resourceRank: index + 1,
        kind: entry.account.kind, ...(entry.account.endpoint ? { billing: entry.account.endpoint.billing } : {}), ceilingPct: entry.account.ceilingPct, usage: entry.status?.usage ?? 'unknown', credential: entry.account.credential }))])) } };
    const response = await askJev(client, { model: input.model, state: typeof input.state === 'function' ? input.state() : input.state, questions, kind: 'placement', calls }, signal);
    const answer = response?.answers.account;
    if (answer?.type !== 'choice') throw new JevError('invalid-response');
    const probabilities = answer.probabilities, highest = Math.max(...eligible.map(entry => probabilities[entry.account.id] ?? 0));
    const chosen = eligible.find(entry => entry.account.id === answer.choice && probabilities[entry.account.id] === highest)
      ?? eligible.find(entry => probabilities[entry.account.id] === highest);
    if (!chosen) throw new JevError('invalid-response');
    return accountChoice(input.ranking, chosen.account.id, 'jev', input.now, { probabilities, jevCalls: calls });
  } catch (error) {
    if (signal.aborted || error instanceof JevError && error.kind === 'cancelled') throw error;
    if (!(error instanceof JevError) && (error as { status?: number }).status !== 503) throw error;
    return accountChoice(input.ranking, first.account.id, 'fallback', input.now, { jevCalls: calls,
      error: { kind: error instanceof JevError ? error.kind : 'credential-unavailable', message: input.redactor.text(error instanceof Error ? error.message : 'Account choice failed.').slice(0, 300) } });
  }
}
