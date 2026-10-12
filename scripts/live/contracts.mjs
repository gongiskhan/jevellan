import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { SecretRedactor } from '../../packages/core/dist/index.js';

const id = z.string().regex(/^[A-Za-z0-9_-]+$/u), absolute = z.string().refine(isAbsolute, 'Use an absolute path.');
export const LiveConfigSchema = z.strictObject({ schema: z.literal('live-scenarios-config-v1'),
  hub: z.url(), storageState: absolute, stateFile: absolute,
  repository: z.literal('gongiskhan/jevellan-live-sandbox'), projectPrefix: id.default('live_day'),
  projectId: id.optional(), proDeviceId: id, madridDeviceId: id,
  proCheckout: absolute, madridCheckout: absolute,
  madridHost: z.string().regex(/^(?!-)[A-Za-z0-9._-]+$/u).default('dev-madrid'), madridNode: absolute,
  hubHome: absolute, output: z.string().default('docs/acceptance/scenarios'),
  ekoaLabel: z.string().min(1).max(120).optional(),
});
export const LiveStateSchema = z.strictObject({ schema: z.literal('live-scenarios-state-v1'),
  projectId: id.optional(), firstScenarioAt: z.iso.datetime().nullable().default(null),
  baseline: z.string().regex(/^[a-f0-9]{40}$/u).nullable().default(null),
  lastA: z.strictObject({ passed: z.boolean(), projectId: id, receipt: z.string(), coordinator: z.enum(['claude', 'codex']) }).nullable().default(null),
  consecutiveAB: z.number().int().nonnegative().default(0), consecutiveC: z.number().int().nonnegative().default(0),
  dLayouts: z.array(z.string()).default([]),
});
export const StepSchema = z.strictObject({ id: z.string(), assertion: z.string(),
  verdict: z.enum(['passed', 'failed', 'blocked', 'not run']), startedAt: z.iso.datetime(), endedAt: z.iso.datetime(),
  seconds: z.number().nonnegative(), reason: z.string().max(4000).optional(), evidence: z.record(z.string(), z.unknown()),
});
export const SessionCostSchema = z.strictObject({ key: z.string(), runtime: z.string(), model: z.string(),
  inputTokens: z.number().nonnegative().nullable(), outputTokens: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(), costSource: z.enum(['reported', 'estimated', 'unknown']).default('unknown'), seconds: z.number().nonnegative(),
});
export const ScenarioReceiptSchema = z.strictObject({ schema: z.literal('live-scenario-receipt-v1'),
  scenario: z.enum(['A', 'B', 'C', 'D']), run: id, coordinator: z.enum(['claude', 'codex']),
  layout: z.string().optional(), label: z.enum(['live', 'blocked', 'simulated', 'not run']), passed: z.boolean(),
  startedAt: z.iso.datetime().nullable(), endedAt: z.iso.datetime(), minutes: z.number().nonnegative(),
  clockStartedAt: z.iso.datetime().nullable(), timeBoxEnded: z.boolean(), projectId: id.optional(),
  steps: z.array(StepSchema), messages: z.array(z.strictObject({ owner: z.string(), reply: z.string(), turn: z.number().int().nonnegative() })),
  toolCalls: z.array(z.record(z.string(), z.unknown())), pullRequests: z.array(z.number().int().positive()),
  workflowRunIds: z.array(z.number().int().positive()), notes: z.array(z.string()), sessions: z.array(SessionCostSchema),
  providerTotals: z.record(z.string(), z.strictObject({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative(), unknownTokenSessions: z.number().int().nonnegative(), unknownCostSessions: z.number().int().nonnegative(), minutes: z.number().nonnegative() })),
  blockedBy: z.array(z.string()), observations: z.array(z.string()),
}).superRefine((value, context) => {
  if (value.passed && (value.label !== 'live' || !value.startedAt || !value.steps.length || value.steps.some(step => step.verdict !== 'passed')))
    context.addIssue({ code: 'custom', message: 'A pass requires a real run and every required step passing.' });
  if (!value.startedAt && value.minutes) context.addIssue({ code: 'custom', message: 'An unstarted run cannot record elapsed scenario time.' });
});
export const newId = (prefix = 'live') => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function titleSimilarity(a, b) {
  const words = text => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []), left = words(a), right = words(b);
  const union = new Set([...left, ...right]); return union.size ? [...left].filter(word => right.has(word)).length / union.size : 1;
}
export function canStart(state, now = Date.now()) { return !state.firstScenarioAt || now < Date.parse(state.firstScenarioAt) + 10 * 60 * 60_000; }
/** @returns {{scenario: string, coordinator: string, layout?: string, gating?: boolean, failingSuite?: boolean}[]} */
export function gatingPlan(coordinator = 'claude') {
  return coordinator === 'codex' ? [{ scenario: 'A', coordinator, gating: false }] : [
    { scenario: 'A', coordinator }, { scenario: 'B', coordinator }, { scenario: 'A', coordinator }, { scenario: 'B', coordinator },
    { scenario: 'C', coordinator }, { scenario: 'C', coordinator },
    ...['phone-light', 'phone-dark', 'desktop-light', 'desktop-dark'].map(layout => ({ scenario: 'D', coordinator, layout })),
    { scenario: 'A', coordinator, gating: false }, { scenario: 'B', coordinator, failingSuite: true, gating: false }, { scenario: 'A', coordinator: 'codex', gating: false },
  ];
}
export function loadState(path) { try { return LiveStateSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; return LiveStateSchema.parse({ schema: 'live-scenarios-state-v1' }); } }
export function saveState(path, state) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(LiveStateSchema.parse(state), null, 2) + '\n', { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, path); }
export function totals(sessions) {
  const result = {};
  for (const session of sessions) {
    const row = result[session.runtime] ??= { inputTokens: 0, outputTokens: 0, costUsd: 0, unknownTokenSessions: 0, unknownCostSessions: 0, minutes: 0 };
    row.inputTokens += session.inputTokens ?? 0; row.outputTokens += session.outputTokens ?? 0; row.costUsd += session.costUsd ?? 0; row.minutes += session.seconds / 60;
    if (session.inputTokens === null || session.outputTokens === null) row.unknownTokenSessions++; if (session.costUsd === null) row.unknownCostSessions++;
  }
  return result;
}
export function evidenceRedactor(secrets = []) {
  const redactor = new SecretRedactor(); for (const secret of secrets) if (secret) redactor.add(secret);
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['transcriptPath', 'auth', 'token', 'secret'].includes(key)).map(([key, item]) => [key,
      key === 'nativeSessionId' && typeof item === 'string' ? createHash('sha256').update(item).digest('hex') : clean(item)]));
    return typeof value === 'string' ? redactor.text(value) : value;
  };
  return clean;
}
export class ScenarioRecorder {
  /** @param {{scenario: string, coordinator: string, layout?: string, output: string, state: object, secrets?: string[], now?: () => number}} options */
  constructor({ scenario, coordinator, layout, output, state, secrets = [], now = Date.now }) {
    this.now = now; this.output = output; this.clean = evidenceRedactor(secrets); this.state = state;
    this.receipt = { schema: 'live-scenario-receipt-v1', scenario, coordinator, ...(layout ? { layout } : {}), run: newId('run'),
      label: 'blocked', passed: false, startedAt: null, endedAt: new Date(now()).toISOString(), minutes: 0,
      clockStartedAt: state.firstScenarioAt, timeBoxEnded: !canStart(state, now()), steps: [], messages: [], toolCalls: [],
      pullRequests: [], workflowRunIds: [], notes: [], sessions: [], providerTotals: {}, blockedBy: [], observations: [] };
  }
  begin(projectId) {
    if (!canStart(this.state, this.now())) throw new Error('The ten-hour live time box ended; do not start another scenario.');
    const at = new Date(this.now()).toISOString(); this.state.firstScenarioAt ??= at;
    Object.assign(this.receipt, { label: 'live', startedAt: at, clockStartedAt: this.state.firstScenarioAt, projectId });
  }
  async step(id, assertion, run) {
    const start = this.now(); let verdict = 'passed', evidence = {}, reason;
    try { evidence = await run() ?? {}; } catch (error) { verdict = error.blocked ? 'blocked' : 'failed'; reason = error.message; }
    this.receipt.steps.push(StepSchema.parse({ id, assertion, verdict, startedAt: new Date(start).toISOString(), endedAt: new Date(this.now()).toISOString(), seconds: (this.now() - start) / 1000, evidence: this.clean(evidence), ...(reason ? { reason: this.clean(reason) } : {}) }));
    if (verdict !== 'passed') { const error = new Error(`${id}: ${reason}`); error.blocked = verdict === 'blocked'; throw error; }
    return evidence;
  }
  finish(blockedBy = []) {
    this.receipt.blockedBy.push(...blockedBy); const end = this.now(); this.receipt.endedAt = new Date(end).toISOString();
    this.receipt.minutes = this.receipt.startedAt ? (end - Date.parse(this.receipt.startedAt)) / 60000 : 0;
    this.receipt.timeBoxEnded = !canStart(this.state, end); this.receipt.providerTotals = totals(this.receipt.sessions);
    this.receipt.passed = this.receipt.label === 'live' && this.receipt.steps.length > 0 && !blockedBy.length && this.receipt.steps.every(step => step.verdict === 'passed');
    const value = ScenarioReceiptSchema.parse(this.clean(this.receipt)), date = value.endedAt.slice(0, 10), folder = `${this.output}/${date}`;
    mkdirSync(folder, { recursive: true }); const file = `${folder}/${value.scenario}-${value.run}.json`;
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); return { file, receipt: value };
  }
}
