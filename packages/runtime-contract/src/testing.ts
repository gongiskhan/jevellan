import assert from 'node:assert/strict';
import { RuntimeEventSchema, type RuntimeAdapter, type RuntimeContext, type RuntimeEvent, type StretchInput, type StretchRun } from './contract.js';
import { groupAlive } from './process-group.js';

export const contractChecks = ['interrupt', 'events-and-usage', 'continue-session', 'concurrent-isolation', 'read-only', 'safety', 'terminate-group'] as const;
export type ContractCheck = typeof contractChecks[number];
export type ContractEvidence = { check: ContractCheck; evidence: 'live' | 'simulated' | 'not-run'; status: 'passed' | 'failed' | 'not-run'; note?: string };
type Case = { evidence: 'live' | 'simulated'; run(adapter: RuntimeAdapter): Promise<void> } | { evidence: 'not-run'; reason: string };

/** Drivers exercise native controls, not a model's voluntary refusal to try a tool. */
export async function runContractTests(factory: (context: RuntimeContext) => RuntimeAdapter, options: { context: RuntimeContext; cases: Record<ContractCheck, Case> }): Promise<ContractEvidence[]> {
  const adapter = factory(options.context); const evidence: ContractEvidence[] = [];
  assert(adapter.id && adapter.displayName, 'The adapter must identify its runtime.');
  for (const check of contractChecks) {
    const test = options.cases[check];
    if (test.evidence === 'not-run') { assert(test.reason.trim()); evidence.push({ check, evidence: 'not-run', status: 'not-run', note: test.reason }); continue; }
    try { await test.run(adapter); evidence.push({ check, evidence: test.evidence, status: 'passed' }); }
    catch (error) { evidence.push({ check, evidence: test.evidence, status: 'failed', note: options.context.redactor?.text(error instanceof Error ? error.message : 'Contract check failed.') ?? 'Contract check failed.' }); }
  }
  return evidence;
}

export async function collectEvents(run: StretchRun): Promise<RuntimeEvent[]> { const events: RuntimeEvent[] = []; for await (const event of run.events) events.push(RuntimeEventSchema.parse(event)); return events; }

export async function checkEventsAndContinuation(adapter: RuntimeAdapter, input: StretchInput, continuation: { message: string; expectedText: string }): Promise<void> {
  const run = adapter.startStretch(input);
  try {
    const events = await collectEvents(run); assert.equal((await run.done).status, 'completed');
    for (const kind of ['text', 'tool-start', 'tool-end', 'usage']) assert(events.some((event) => event.type === kind), `Missing ${kind} event.`);
    const session = run.native.sessionId; assert(session, 'Missing native session identity.');
    const continued = run.continue(continuation.message, 90_000); const next = await collectEvents(run); await continued;
    assert.equal((await run.done).status, 'completed'); assert.equal(run.native.sessionId, session);
    assert(next.flatMap((event) => event.type === 'text' ? [event.delta] : []).join('').includes(continuation.expectedText), 'Continuation did not preserve context.');
  } finally { await run.terminate(); assert(!groupAlive(run.native.pgid), 'Runtime process group remains alive.'); }
}
