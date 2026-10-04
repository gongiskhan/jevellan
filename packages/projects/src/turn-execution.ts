import type { AccountService } from '@jevellan/accounts';
import { UsageSchema, type AccountStatus, type SecretRedactor } from '@jevellan/core';
import { RuntimeEventSchema, classifyRuntimeError, type NativeProcess, type RunResult, type RuntimeEvent, type StretchRun } from '@jevellan/runtime-contract';
import type { z } from 'zod';

export type Usage = z.infer<typeof UsageSchema>;
export type RuntimeError = NonNullable<RunResult['error']>;
export type TurnStatus = 'completed' | 'failed' | 'timed-out' | 'steered' | 'stopped' | 'shutdown';
export type TurnOutcome = { status: TurnStatus; error?: RuntimeError | undefined; sessionId?: string | undefined; finalText: string; usage: Usage };
export type TurnExecutionOptions = {
  run: StretchRun; accountId: string; secretRef: string | null;
  /** The runtime model string; a model-scoped limit cools only this model on the account. */
  model: string;
  deviceId: string; accounts: Pick<AccountService, 'recordUsage' | 'recordError'>;
  initialUsage?: AccountStatus['usage'] | undefined;
  /** Called when the native session id first appears and whenever it changes (never with undefined). */
  onSession(sessionId: string): void;
  /** Called once with the worker's process identity, for restart recovery. */
  onProcess(native: NativeProcess): void;
  redactor: SecretRedactor;
};
/** Turn text kept in memory, capped to its tail: only the final message and the synthesized summary use it. */
export const TURN_TEXT_LIMIT = 200_000;
const keep = (text: string) => text.length <= TURN_TEXT_LIMIT ? text : text.slice(-TURN_TEXT_LIMIT);
const INTENTS = ['steered', 'stopped', 'shutdown'] as const;
type Intent = typeof INTENTS[number];

/**
 * Drains one turn's run (brief 8.2): usage and rate limits are recorded on the account exactly as stretches do, text deltas
 * stay in memory (the text after the last tool call, else all text, D20), and nothing is written per event. The run is
 * always terminated before `done` resolves, so no successor can start while a process lives. Own intent wins the status
 * (shutdown over stop over steer); a steer counts only when it interrupted the turn.
 */
export class TurnExecution {
  readonly done: Promise<TurnOutcome>;
  readonly #o: TurnExecutionOptions;
  #intent: Intent | undefined;
  #settled = false;
  #steering: Promise<void> | undefined;
  #session: string | undefined;
  #process = false;
  #all = ''; #last = '';
  #usage: Extract<RuntimeEvent, { type: 'usage' }>[] = [];
  #accounting: Promise<void> = Promise.resolve();
  #streamUsage: AccountStatus['usage'] | undefined;
  constructor(o: TurnExecutionOptions) { this.#o = o; this.#streamUsage = o.initialUsage; this.done = this.#execute(); }
  #want(intent: Intent): void { if (!this.#intent || INTENTS.indexOf(intent) > INTENTS.indexOf(this.#intent)) this.#intent = intent; }
  /** A message with interrupt: the running turn is interrupted once and the next turn carries the message. */
  steer(): Promise<void> {
    if (this.#settled) return Promise.resolve();
    this.#want('steered');
    this.#steering ??= this.#o.run.interrupt('steer');
    return this.#steering;
  }
  stop(): Promise<void> { this.#want('stopped'); return this.#o.run.terminate(); }
  /** Daemon shutdown: the turn is left for restart recovery. */
  shutdown(): Promise<void> { this.#want('shutdown'); return this.#o.run.terminate(); }
  #native(): void {
    const native = this.#o.run.native;
    if (!this.#process) { this.#process = true; this.#o.onProcess({ pid: native.pid, pgid: native.pgid, ...(native.startIdentity ? { startIdentity: native.startIdentity } : {}) }); }
    if (native.sessionId && native.sessionId !== this.#session) { this.#session = native.sessionId; this.#o.onSession(native.sessionId); }
  }
  #account(task: () => Promise<unknown>): void {
    // Reporting to the hub must not stall or fail a turn already in progress.
    this.#accounting = this.#accounting.then(task).then(() => undefined, () => undefined);
  }
  #event(event: RuntimeEvent): void {
    if (event.type === 'text') { this.#all = keep(this.#all + event.delta); this.#last = keep(this.#last + event.delta); }
    else if (event.type === 'tool-start' || event.type === 'tool-end') this.#last = '';
    else if (event.type === 'usage') this.#usage.push(event);
    else if (event.type === 'rate-limit') {
      const usage = this.#streamUsage;
      this.#streamUsage = { ...usage, fiveHourPct: event.fiveHourPct ?? usage?.fiveHourPct, weeklyPct: event.weeklyPct ?? usage?.weeklyPct,
        fiveHourResetsAt: event.fiveHourResetsAt ?? usage?.fiveHourResetsAt, weeklyResetsAt: event.weeklyResetsAt ?? usage?.weeklyResetsAt, source: 'stream', observedAt: new Date().toISOString() };
      const snapshot = this.#streamUsage;
      this.#account(() => this.#o.accounts.recordUsage(this.#o.accountId, snapshot, this.#o.secretRef));
    }
  }
  async #execute(): Promise<TurnOutcome> {
    const { run } = this.#o; let result: RunResult = { status: 'failed' }; let failure: RuntimeError | undefined; let caught = false;
    try {
      this.#native();
      const drain = (async () => { for await (const raw of run.events) { const event = RuntimeEventSchema.parse(raw); this.#native(); this.#event(event); } })();
      const completion = run.done.then((value) => { this.#settled = true; return value; });
      [result] = await Promise.all([completion, drain]);
      this.#native();
      await this.#steering;
      failure = result.error;
    } catch (error) {
      caught = true; failure = classifyRuntimeError(error);
    } finally {
      this.#settled = true;
      // Never report a result while an owned process lives; a cleanup failure rejects this turn's result.
      await run.terminate();
    }
    if (failure) {
      const error = failure;
      // A limit on one model cools only that model on this account; any other limit cools the account (as stretches do).
      const limit = error.scope === 'model' ? { model: this.#o.model, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) } : {};
      this.#account(() => this.#o.accounts.recordError(this.#o.accountId, error.kind, this.#o.secretRef, limit));
    }
    await this.#accounting;
    const usage = this.#usage; const knownCost = usage.length > 0 && usage.every((event) => event.costUsd !== undefined);
    // A steer counts only when it interrupted the turn; a turn that finished first keeps its own result.
    const status: TurnStatus = this.#intent === 'stopped' || this.#intent === 'shutdown' ? this.#intent
      : this.#intent === 'steered' && !caught && result.status === 'interrupted' ? 'steered'
        : caught || result.status === 'failed' ? 'failed' : result.status === 'interrupted' ? 'timed-out' : 'completed';
    const finalText = (this.#last.trim() ? this.#last : this.#all).trim();
    return {
      status, finalText, ...(this.#session ? { sessionId: this.#session } : {}), ...(failure ? { error: this.#o.redactor.document(failure) } : {}),
      usage: UsageSchema.parse({ inputTokens: usage.reduce((sum, event) => sum + event.inputTokens, 0), outputTokens: usage.reduce((sum, event) => sum + event.outputTokens, 0),
        cacheReadTokens: usage.reduce((sum, event) => sum + (event.cacheReadTokens ?? 0), 0), cacheWriteTokens: usage.reduce((sum, event) => sum + (event.cacheWriteTokens ?? 0), 0),
        ...(knownCost ? { costUsd: usage.reduce((sum, event) => sum + event.costUsd!, 0), costSource: usage.some((event) => event.costSource === 'estimated') ? 'estimated' : 'reported' } : { costSource: 'unknown' }) }),
    };
  }
}
