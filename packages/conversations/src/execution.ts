import { HandoffSchema, UsageSchema, stableJson, type Handoff, type Stretch } from '@jevellan/core';
import { RuntimeEventSchema, classifyRuntimeError, type RuntimeAdapter, type RuntimeEvent, type RunResult, type StretchInput, type StretchRun } from '@jevellan/runtime-contract';
import { ConversationWork } from './work.js';

export type StretchOutcome = {
  status: Exclude<Stretch['status'], 'running' | 'undone'>;
  handoff: Handoff;
  usage: Stretch['usage'];
  correction: boolean;
  repaired: boolean;
  error?: RunResult['error'];
};
type Options = {
  work: ConversationWork;
  input: StretchInput;
  adapter: RuntimeAdapter;
  /** Downgrade the scoped bridge before giving the runtime its repair turn. */
  enterRepair(): void | Promise<void>;
  onEvent?(event: RuntimeEvent): void | Promise<void>;
  repairTimeoutMs?: number;
  correctionTimeoutMs?: number;
  cancelHandoffTimeoutMs?: number;
};

/** Runs one already-journalled stretch. Checkpoints and successors belong to the loop. */
export class StretchExecution {
  readonly done: Promise<StretchOutcome>;
  #active: StretchRun | undefined;
  #interruption: Promise<void> | undefined;
  #cancelled = false;
  #correction = false;
  #repairing = false;
  #native = '';
  #usage: Extract<RuntimeEvent, { type: 'usage' }>[] = [];
  constructor(readonly options: Options) {
    const { input, work } = options;
    const stretch = work.load().stretches.find((entry) => entry.n === input.stretch);
    if (input.conversationId !== work.ledger.id || !stretch || stretch.status !== 'running' || stretch.action !== input.action || stretch.accountId !== input.account.account.id) throw new Error('Runtime launch does not match the recorded stretch.');
    for (const [value, maximum] of [[options.repairTimeoutMs ?? 90_000, 90_000], [options.correctionTimeoutMs ?? 60_000, 60_000], [options.cancelHandoffTimeoutMs ?? 30_000, 30_000]]) {
      if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!) throw new Error('Invalid handoff repair timeout.');
    }
    this.done = this.#execute();
  }
  steer(): Promise<void> {
    this.#correction = true;
    if (!this.#active) return Promise.resolve();
    // A second correction ends the existing repair; it never starts another one.
    if (this.#repairing) return this.cancelRepair();
    this.#interruption ??= this.#active.interrupt('steer');
    return this.#interruption;
  }
  private cancelRepair(): Promise<void> {
    this.#interruption = this.#active!.interrupt('steer');
    return this.#interruption;
  }
  cancel(): Promise<void> {
    this.#cancelled = true;
    this.#interruption = this.#active?.terminate() ?? Promise.resolve();
    return this.#interruption;
  }
  #persistNative(run: StretchRun): void {
    const serialized = stableJson(run.native);
    if (serialized === this.#native) return;
    this.options.work.native(this.options.input.stretch, run.native);
    this.#native = serialized;
  }
  async #capture(run: StretchRun, completion = run.done): Promise<RunResult> {
    this.#persistNative(run);
    const drain = (async () => {
      for await (const raw of run.events) {
        const event = RuntimeEventSchema.parse(raw);
        this.#persistNative(run);
        if (event.type === 'usage') this.#usage.push(event);
        if (event.type === 'rate-limit') this.options.work.ledger.append({ type: 'notice', stretch: this.options.input.stretch, data: { schema: 'runtime-rate-limit-v1', ...event } });
        else this.options.work.runtimeEvent(event.type, event, this.options.input.stretch);
        await this.options.onEvent?.(event);
      }
    })();
    const [result] = await Promise.all([completion, drain]);
    this.#persistNative(run);
    await this.#interruption;
    return result;
  }
  #handoff(): Handoff | undefined { return this.options.work.ledger.handoffs().find((entry) => entry.stretch === this.options.input.stretch); }
  #cancelHandoff(): Promise<void> {
    if (this.#handoff()) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
      const unsubscribe = this.options.work.ledger.subscribe((event) => { if (event.type === 'handoff' && event.stretch === this.options.input.stretch) finish(); });
      const timer = setTimeout(finish, this.options.cancelHandoffTimeoutMs ?? 30_000);
    });
  }
  #tail(): string {
    const ledger = this.options.work.ledger;
    let tail = '';
    for (const event of ledger.events().filter((entry) => entry.stretch === this.options.input.stretch && ['text', 'tool-start', 'tool-end', 'error'].includes(entry.type)).slice(-20).reverse()) {
      const line = `[ledger/${event.id}] ${event.type}: ${JSON.stringify(ledger.data(event))}\n`;
      const remaining = 16_000 - tail.length;
      if (remaining <= 0) break;
      tail = line.slice(0, remaining) + tail;
    }
    return tail;
  }
  #fallback(): Handoff {
    const { work, input } = this.options;
    const events = work.ledger.events().filter((event) => event.stretch === input.stretch);
    const last = events.findLast((event) => event.type === 'tool-start');
    const data = last ? work.ledger.data(last) : undefined;
    const tool = data && typeof data === 'object' && 'name' in data && typeof data.name === 'string' ? data.name.slice(0, 200) : 'none';
    const summary = this.#cancelled ? `Stretch cancelled; last tool: ${tool}.` : `Stretch ended without a handoff; last tool: ${tool}.`;
    const handoff = HandoffSchema.parse({ schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: this.#cancelled ? 'partial' : 'failed', summary,
      evidence: last ? [{ kind: 'command', ref: `ledger/${last.id}`, note: 'Last recorded tool; this is not a success claim.' }] : [], findings: [], blockers: this.#cancelled ? [] : ['No valid handoff was received.'], failedApproaches: [], proposedNext: null, changedFiles: [] });
    work.runtimeEvent('error', { kind: 'other', message: summary }, input.stretch);
    return work.ledger.acceptHandoff(handoff).handoff;
  }
  async #execute(): Promise<StretchOutcome> {
    const { adapter, input, work } = this.options;
    let result: RunResult = { status: 'failed' }; let repaired = false; let failure: RunResult['error'];
    try {
      this.#active = adapter.startStretch(input);
      result = await this.#capture(this.#active);
      failure = result.error;
      if (failure && !work.ledger.events().some((event) => event.type === 'error' && event.stretch === input.stretch
        && event.data && typeof event.data === 'object' && 'message' in event.data && event.data.message === failure!.message)) {
        work.runtimeEvent('error', failure, input.stretch);
      }
      if (!this.#handoff() && !this.#cancelled) {
        this.#repairing = true;
        await this.options.enterRepair();
        if (this.#cancelled) throw new Error('Handoff repair was cancelled.');
        if (!adapter.capabilities.readOnlyEnforced) throw new Error('Runtime cannot enforce a read-only handoff repair.');
        const timeout = this.#correction ? this.options.correctionTimeoutMs ?? 60_000 : this.options.repairTimeoutMs ?? 90_000;
        const message = `Call jevellan_handoff now with stretch ${input.stretch}, action ${input.action}, and an honest status for what you did.${this.#correction ? ' The user corrected this step; report status partial.' : ''} Do not change code or memory.`;
        work.ledger.append({ type: 'notice', stretch: input.stretch, data: { schema: 'handoff-repair-v1', mode: adapter.capabilities.continueSession ? 'same-session' : 'fresh-session', timeoutMs: timeout } });
        this.#interruption = undefined;
        let repairResult: RunResult;
        if (adapter.capabilities.continueSession) {
          const continuing = this.#active.continue(message, timeout);
          repairResult = await this.#capture(this.#active, continuing.then(() => this.#active!.done));
        } else {
          await this.#active.terminate();
          if (this.#cancelled) throw new Error('Handoff repair was cancelled.');
          this.#active = adapter.startStretch({ ...input, permissions: 'read-only', memoryWrite: false, timeoutMs: timeout,
            systemAppend: 'This is only a handoff repair. Keep the original action in the handoff; do not perform more project work.',
            brief: `Original action: ${input.action}. Stretch: ${input.stretch}.\n# Original request\n${work.load().conversation.work!.request}\n# Tail of this stretch\n${this.#tail()}\n# Required handoff\n${message}` });
          repairResult = await this.#capture(this.#active);
        }
        if (repairResult.status === 'failed') throw new Error(repairResult.error?.message ?? 'Runtime handoff repair failed.');
        repaired = !!this.#handoff();
      }
    } catch (error) {
      failure = classifyRuntimeError(error);
      work.runtimeEvent('error', failure, input.stretch);
    } finally {
      // A caller must not checkpoint, release ownership or launch a successor
      // until every owned process has gone. Cleanup failure rejects this result.
      if (this.#active) await this.#active.terminate();
    }
    if (this.#cancelled) await this.#cancelHandoff();
    return this.#outcome(result, repaired, failure);
  }
  #outcome(result: RunResult, repaired: boolean, error?: RunResult['error']): StretchOutcome {
    const accepted = this.#handoff(); const handoff = accepted ?? this.#fallback();
    const usage = this.#usage;
    const knownCost = usage.length > 0 && usage.every((event) => event.costUsd !== undefined);
    return {
      status: this.#cancelled || this.#correction ? 'interrupted' : result.status === 'interrupted' ? 'timed-out' : !accepted || error ? 'failed' : result.status,
      handoff, correction: this.#correction, repaired,
      usage: UsageSchema.parse({ inputTokens: usage.reduce((sum, event) => sum + event.inputTokens, 0), outputTokens: usage.reduce((sum, event) => sum + event.outputTokens, 0),
        cacheReadTokens: usage.reduce((sum, event) => sum + (event.cacheReadTokens ?? 0), 0), cacheWriteTokens: usage.reduce((sum, event) => sum + (event.cacheWriteTokens ?? 0), 0),
        ...(knownCost ? { costUsd: usage.reduce((sum, event) => sum + event.costUsd!, 0), costSource: usage.some((event) => event.costSource === 'estimated') ? 'estimated' : 'reported' } : { costSource: 'unknown' }) }),
      ...(error ? { error: this.options.work.ledger.redact(error) } : {}),
    };
  }
}
