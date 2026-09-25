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

export async function checkInterruption(adapter: RuntimeAdapter, input: StretchInput, ready: (event: RuntimeEvent) => boolean): Promise<void> {
  const run = adapter.startStretch(input); let interrupted = false;
  try {
    for await (const event of run.events) {
      if (!interrupted && ready(event)) {
        interrupted = true; const start = Date.now(); await run.interrupt('steer');
        assert(Date.now() - start < 20_000, 'Interruption exceeded its bounded deadline.');
      }
    }
    assert(interrupted, 'The driver never observed a running tool.');
    assert.equal((await run.done).status, 'interrupted');
  } finally { await run.terminate(); assert(!groupAlive(run.native.pgid), 'Runtime process group remains alive.'); }
}

export async function checkConcurrentIsolation(adapter: RuntimeAdapter, cases: readonly [{ input: StretchInput; marker: string }, { input: StretchInput; marker: string }], tool: string): Promise<void> {
  assert.equal(cases[0].input.account.home, cases[1].input.account.home, 'The check must share one account home.');
  assert.notEqual(cases[0].input.cwd, cases[1].input.cwd, 'The check needs two projects.');
  assert.notEqual(cases[0].marker, cases[1].marker);
  const runs: StretchRun[] = [];
  try {
    const attempts = await Promise.allSettled(cases.map(async (entry, index) => {
      const run = adapter.startStretch(entry.input); runs.push(run);
      const events = await collectEvents(run); assert.equal((await run.done).status, 'completed');
      assert(events.some((event) => event.type === 'tool-start' && event.name === tool), 'The scoped tool was not called.');
      const text = events.flatMap((event) => event.type === 'text' ? [event.delta] : []).join('');
      assert(text.includes(entry.marker), 'The response did not contain its own scoped memory.');
      assert(!text.includes(cases[1 - index]!.marker), 'The response leaked another project’s memory.');
    }));
    for (const attempt of attempts) if (attempt.status === 'rejected') throw attempt.reason;
  } finally { await Promise.all(runs.map((run) => run.terminate())); assert(runs.every((run) => !groupAlive(run.native.pgid)), 'Runtime process group remains alive.'); }
}

export async function checkGroupTermination(adapter: RuntimeAdapter, input: StretchInput, ready: (event: RuntimeEvent) => boolean): Promise<void> {
  const run = adapter.startStretch(input); let observed = false;
  try {
    for await (const event of run.events) if (ready(event)) { observed = true; break; }
    assert(observed, 'The driver never observed the running descendant.');
    assert(groupAlive(run.native.pgid), 'The runtime group ended before termination was tested.');
    await run.terminate(); assert(!groupAlive(run.native.pgid), 'A runtime process remains after termination.');
    assert.equal((await run.done).status, 'interrupted');
  } finally { await run.terminate(); }
}

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
