import { JevError, type JevRequest, type JevResponse } from './contract.js';
import type { DecisionClient } from './engine.js';

/** The configured `decisions.timeoutMs` of a fresh installation; a source that cannot report its own uses it. */
export const DEFAULT_DECISION_TIMEOUT_MS = 4000;

/** One decision's overall deadline: the client's retry budget (two attempts and the one-second pause between them) plus five seconds. */
export function decisionDeadlineMs(timeoutMs: number): number { return 2 * timeoutMs + 1000 + 5000; }

/**
 * Where decisions get their client: the daemon reads the configuration (for the per-attempt timeout) and the key when a decision
 * asks. `deadlineMs` reports the overall deadline without a read, so a read that never settles is bounded too.
 */
export type DecisionSource = { (): DecisionClient | Promise<DecisionClient>; deadlineMs?(): number };

const NO_KEY: DecisionClient = { decide: async () => { throw new JevError('no-key'); } };

/**
 * Runs `work` under a deadline this helper owns. It settles with `JevError('timeout')` at the deadline and with
 * `JevError('cancelled')` when `signal` aborts, even when `work` never settles and ignores its own signal, which aborts in both cases.
 */
export function withDecisionDeadline<T>(deadlineMs: number, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(new JevError('cancelled'));
  const inner = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); settle(); };
    const cancel = () => finish(() => { inner.abort(); reject(new JevError('cancelled')); });
    const timer = setTimeout(() => finish(() => { inner.abort(); reject(new JevError('timeout')); }), deadlineMs);
    signal?.addEventListener('abort', cancel, { once: true });
    let running: Promise<T>;
    try { running = work(inner.signal); } catch (error) { running = Promise.reject(error); }
    running.then(value => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

/** One Jev decision: obtaining the client, the reads `work` makes, the key and every attempt, all under one overall deadline. */
export function runDecision<T>(source: DecisionSource | DecisionClient | undefined, signal: AbortSignal | undefined,
  work: (client: DecisionClient, signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadlineMs = typeof source === 'function' && source.deadlineMs ? source.deadlineMs() : decisionDeadlineMs(DEFAULT_DECISION_TIMEOUT_MS);
  return withDecisionDeadline(deadlineMs, signal, async inner => work(typeof source === 'function' ? await source() : source ?? NO_KEY, inner));
}

/** A client whose every `decide` is one decision under the deadline, obtaining its client from `source` inside it. */
export function deadlineClient(source: DecisionSource | DecisionClient | undefined): DecisionClient {
  return { decide: (input: JevRequest, signal?: AbortSignal): Promise<JevResponse> => runDecision(source, signal, (client, inner) => client.decide(input, inner)) };
}
