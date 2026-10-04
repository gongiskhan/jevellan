import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BridgeResultSchema, BridgeToolsSchema, ErrorDocumentSchema, minimalEnvironment, type RiggingItem } from '@jevellan/core';
import { AsyncQueue } from './queue.js';
import { RuntimeEventSchema, RunResultSchema, StretchInputSchema, TurnInputSchema, type RuntimeAdapter, type RuntimeEvent, type StretchInput, type StretchRun, type RunResult, type TurnInput } from './contract.js';
import { groupAlive, terminateGroup, identifySpawnedGroup, type NativeProcess } from './process-group.js';
import { writeFakeNativeSession, type FakeNativeTool } from './fake-native.js';
import { nativeFormat } from './native-format.js';

export type FakeStep = (turn: { input: StretchInput; message: string; signal: AbortSignal; emit(event: RuntimeEvent): void }) => Promise<RunResult> | RunResult;
export type FakeTurn = {
  input: TurnInput; message: string; signal: AbortSignal;
  session: { id: string; resumed: boolean };
  /** Validated, dropped after abort or settle. */
  emit(event: RuntimeEvent): void;
  /** Emits a text delta and records it as assistant text in the native session file. */
  say(text: string): void;
  /** Calls a tool through the daemon bridge with this turn's scoped token; returns `result`, throws the daemon's message. */
  bridge(name: string, args: unknown): Promise<unknown>;
  tools(): Promise<string[]>;
};
export type FakeTurnStep = (turn: FakeTurn) => Promise<RunResult> | RunResult;
export type FakeTurnMatch = (input: TurnInput) => boolean;
export const forCoordinator: FakeTurnMatch = (input) => input.owner.kind === 'coordinator';
export function forThread(predicate?: (input: TurnInput) => boolean): FakeTurnMatch { return (input) => input.owner.kind === 'thread' && (!predicate || predicate(input)); }

type Script = (message: string, repair: boolean, signal: AbortSignal, emit: (raw: RuntimeEvent) => boolean) => Promise<RunResult> | RunResult;

class FakeRun implements StretchRun {
  readonly native: NativeProcess;
  #queue = new AsyncQueue<RuntimeEvent>();
  #controller = new AbortController();
  #done!: Promise<RunResult>;
  #resolve!: (result: RunResult) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #settled = false; #terminated = false;
  // turn: one script per run; finished() records the native session before done resolves.
  constructor(cwd: string, home: string, sessionId: string, readonly script: Script, start: { message: string; timeoutMs: number }, readonly turn?: { finished(): void }) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, env: minimalEnvironment('codex', home), detached: true, stdio: 'ignore' });
    if (!child.pid) throw new Error('Fake runtime process failed to start.');
    this.native = { ...identifySpawnedGroup(child.pid), sessionId };
    child.on('error', () => this.#finish({ status: 'failed', error: { kind: 'other', message: 'Fake runtime process failed.' } }));
    child.on('close', () => this.#finish({ status: this.#terminated ? 'interrupted' : 'failed' }));
    this.#begin(start.message, start.timeoutMs);
  }
  get events(): AsyncIterable<RuntimeEvent> { return this.#queue; }
  get done(): Promise<RunResult> { return this.#done; }
  #begin(message: string, timeoutMs: number, repair = false): void {
    this.#queue = new AsyncQueue(); this.#controller = new AbortController(); this.#settled = false;
    this.#done = new Promise((resolve) => { this.#resolve = resolve; });
    this.#timer = setTimeout(() => { void this.interrupt(); }, timeoutMs);
    const signal = this.#controller.signal;
    const emit = (raw: RuntimeEvent) => { if (signal.aborted || this.#settled) return false; this.#queue.push(RuntimeEventSchema.parse(raw)); return true; };
    queueMicrotask(() => {
      void Promise.resolve().then(() => this.script(message, repair, signal, emit))
        .then((result) => { if (!signal.aborted) this.#finish(RunResultSchema.parse(result)); })
        .catch(() => { if (!signal.aborted) this.#finish({ status: 'failed', error: { kind: 'other', message: 'The scripted runtime failed.' } }); });
    });
  }
  #finish(result: RunResult): void {
    if (this.#settled) return; this.#settled = true; clearTimeout(this.#timer);
    try { this.turn?.finished(); } catch { /* A missing native file shows up in the transcript reader, not as a turn failure. */ }
    this.#queue.close(); this.#resolve(result);
  }
  async interrupt(): Promise<void> { this.#controller.abort(); this.#finish({ status: 'interrupted' }); }
  async continue(message: string, timeoutMs: number): Promise<void> {
    if (this.turn) throw new Error('Turns do not continue; start a new turn.');
    if (!this.#settled || this.#terminated || !groupAlive(this.native.pgid)) throw new Error('Fake session is not available for continuation.');
    this.#begin(message, timeoutMs, true); await this.#done;
  }
  async terminate(): Promise<void> { this.#terminated = true; this.#controller.abort(); await terminateGroup(this.native); this.#finish({ status: 'interrupted' }); }
}

async function bridgeRequest(input: TurnInput, body: object): Promise<unknown> {
  const url = input.launch.env.JEVELLAN_DAEMON_URL; const token = input.launch.env.JEVELLAN_STRETCH_TOKEN;
  if (!url || !token) throw new Error('This turn has no bridge.');
  const response = await fetch(new URL('/api/bridge', url), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ schema: 'bridge-request-v1', ...body }) });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) { const error = ErrorDocumentSchema.safeParse(data); throw new Error(error.success ? error.data.message : 'The owner daemon refused this tool request.'); }
  return data;
}

/** Scripted integration adapter. Its process is real; model behavior is simulated. */
export class FakeRuntime implements RuntimeAdapter {
  readonly id = 'fake'; readonly displayName = 'Scripted test runtime';
  readonly accountKinds = ['subscription', 'api-key'] as RuntimeAdapter['accountKinds'];
  readonly riggingKinds: RiggingItem['kind'][] = [];
  readonly capabilities = { edit: true, shell: true, mcp: true, images: false, interrupt: true, usage: true, continueSession: true, perLaunchConfig: true, readOnlyEnforced: false, turns: true };
  readonly starts: StretchInput[] = [];
  readonly turnStarts: TurnInput[] = [];
  readonly runs: StretchRun[] = [];
  #steps: FakeStep[];
  #turns: Array<{ step: FakeTurnStep; match: FakeTurnMatch }> = [];
  readonly #nativeFormat: 'claude' | 'codex' | undefined;
  constructor(steps: FakeStep[] = [], options: { nativeFormat?: 'claude' | 'codex' } = {}) { this.#steps = [...steps]; this.#nativeFormat = options.nativeFormat; }
  enqueue(...steps: FakeStep[]): void { this.#steps.push(...steps); }
  /** Concurrent owners take their own scripts: a turn consumes the first queued entry whose match accepts its input. */
  enqueueTurn(step: FakeTurnStep, match: FakeTurnMatch = () => true): void { this.#turns.push({ step, match }); }
  async listModels() { return [{ id: 'scripted-model', label: 'Scripted model', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const }].map((model) => ({ ...model, efforts: [...model.efforts] })); }
  async beginLogin() { return { instructions: 'Simulated login.', poll: async () => 'done' as const, cancel: async () => {} }; }
  async probe() { return { auth: 'ready' as const }; }
  async materialiseRigging() { return []; }
  startStretch(raw: StretchInput): StretchRun {
    const input = StretchInputSchema.parse(raw); this.starts.push(structuredClone(input));
    const run = new FakeRun(input.cwd, input.account.home, `fixture-${randomUUID()}`, (message, repair, signal, emit) => {
      const step = this.#steps.shift(); if (!step) throw new Error('No scripted turn remains.');
      return step({ input: repair ? { ...input, permissions: 'read-only', memoryWrite: false } : input, message, signal, emit });
    }, { message: input.brief, timeoutMs: input.timeoutMs });
    this.runs.push(run); return run;
  }
  startTurn(raw: TurnInput): StretchRun {
    const input = TurnInputSchema.parse(raw); this.turnStarts.push(structuredClone(input));
    const index = this.#turns.findIndex((entry) => entry.match(input));
    const step = index < 0 ? undefined : this.#turns.splice(index, 1)[0]!.step;
    const format = this.#nativeFormat ?? nativeFormat(input.account.account.runtime);
    const session = { id: input.resume?.sessionId ?? randomUUID(), resumed: !!input.resume };
    const native = { format, home: input.account.home, sessionId: session.id, cwd: input.cwd };
    writeFakeNativeSession({ ...native, rows: [{ role: 'user', text: input.prompt }], append: session.resumed });
    const said: string[] = []; const tools: FakeNativeTool[] = [];
    const call = async (name: string, args: unknown) => {
      const tool = { id: `fake_${randomUUID()}`, name: format === 'claude' ? `mcp__jevellan__${name}` : `jevellan__${name}`, input: args };
      try { const { result } = BridgeResultSchema.parse(await bridgeRequest(input, { operation: 'call', name, arguments: args })); tools.push({ ...tool, output: JSON.stringify(result) }); return result; }
      catch (error) { tools.push({ ...tool, output: error instanceof Error ? error.message : 'The tool request failed.', failed: true }); throw error; }
    };
    const run = new FakeRun(input.cwd, input.account.home, session.id, (message, _repair, signal, emit) => step ? step({
      input, message, signal, session, emit,
      say: (text) => { if (emit({ type: 'text', delta: text })) said.push(text); },
      bridge: call,
      tools: async () => BridgeToolsSchema.parse(await bridgeRequest(input, { operation: 'list' })).tools.map((tool) => tool.name),
    }) : { status: 'failed', error: { kind: 'other', message: 'No scripted turn remains.' } }, { message: input.prompt, timeoutMs: input.timeoutMs }, {
      finished: () => { writeFakeNativeSession({ ...native, rows: [{ role: 'assistant', text: said.join(''), tools }], append: true }); },
    });
    this.runs.push(run); return run;
  }
  async close(): Promise<void> { await Promise.all(this.runs.map((run) => run.terminate())); }
}
