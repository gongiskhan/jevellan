import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { minimalEnvironment, type RiggingItem } from '@jevellan/core';
import { AsyncQueue } from './queue.js';
import { RuntimeEventSchema, RunResultSchema, StretchInputSchema, type RuntimeAdapter, type RuntimeEvent, type StretchInput, type StretchRun, type RunResult } from './contract.js';
import { groupAlive, terminateGroup, identifySpawnedGroup, type NativeProcess } from './process-group.js';

export type FakeStep = (turn: { input: StretchInput; message: string; signal: AbortSignal; emit(event: RuntimeEvent): void }) => Promise<RunResult> | RunResult;

class FakeRun implements StretchRun {
  readonly native: NativeProcess;
  #queue = new AsyncQueue<RuntimeEvent>();
  #controller = new AbortController();
  #done!: Promise<RunResult>;
  #resolve!: (result: RunResult) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #settled = false; #terminated = false;
  constructor(readonly input: StretchInput, readonly step: () => FakeStep) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: input.cwd, env: minimalEnvironment('codex', input.account.home), detached: true, stdio: 'ignore' });
    if (!child.pid) throw new Error('Fake runtime process failed to start.');
    this.native = { ...identifySpawnedGroup(child.pid), sessionId: `fixture-${randomUUID()}` };
    child.on('error', () => this.#finish({ status: 'failed', error: { kind: 'other', message: 'Fake runtime process failed.' } }));
    child.on('close', () => this.#finish({ status: this.#terminated ? 'interrupted' : 'failed' }));
    this.#begin(input.brief, input.timeoutMs);
  }
  get events(): AsyncIterable<RuntimeEvent> { return this.#queue; }
  get done(): Promise<RunResult> { return this.#done; }
  #begin(message: string, timeoutMs: number, repair = false): void {
    this.#queue = new AsyncQueue(); this.#controller = new AbortController(); this.#settled = false;
    this.#done = new Promise((resolve) => { this.#resolve = resolve; });
    this.#timer = setTimeout(() => { void this.interrupt(); }, timeoutMs);
    const signal = this.#controller.signal;
    queueMicrotask(() => {
      void Promise.resolve().then(() => this.step()({ input: repair ? { ...this.input, permissions: 'read-only', memoryWrite: false } : this.input, message, signal, emit: (raw) => { if (!signal.aborted && !this.#settled) this.#queue.push(RuntimeEventSchema.parse(raw)); } }))
        .then((result) => { if (!signal.aborted) this.#finish(RunResultSchema.parse(result)); })
        .catch(() => { if (!signal.aborted) this.#finish({ status: 'failed', error: { kind: 'other', message: 'The scripted runtime failed.' } }); });
    });
  }
  #finish(result: RunResult): void { if (this.#settled) return; this.#settled = true; clearTimeout(this.#timer); this.#queue.close(); this.#resolve(result); }
  async interrupt(): Promise<void> { this.#controller.abort(); this.#finish({ status: 'interrupted' }); }
  async continue(message: string, timeoutMs: number): Promise<void> {
    if (!this.#settled || this.#terminated || !groupAlive(this.native.pgid)) throw new Error('Fake session is not available for continuation.');
    this.#begin(message, timeoutMs, true); await this.#done;
  }
  async terminate(): Promise<void> { this.#terminated = true; this.#controller.abort(); await terminateGroup(this.native); this.#finish({ status: 'interrupted' }); }
}

/** Scripted integration adapter. Its process is real; model behavior is simulated. */
export class FakeRuntime implements RuntimeAdapter {
  readonly id = 'fake'; readonly displayName = 'Scripted test runtime';
  readonly accountKinds = ['subscription', 'api-key'] as RuntimeAdapter['accountKinds'];
  readonly riggingKinds: RiggingItem['kind'][] = [];
  readonly capabilities = { edit: true, shell: true, mcp: true, images: false, interrupt: true, usage: true, continueSession: true, perLaunchConfig: true, readOnlyEnforced: false };
  readonly starts: StretchInput[] = [];
  readonly runs: StretchRun[] = [];
  #steps: FakeStep[];
  constructor(steps: FakeStep[] = []) { this.#steps = [...steps]; }
  enqueue(...steps: FakeStep[]): void { this.#steps.push(...steps); }
  async listModels() { return [{ id: 'scripted-model', label: 'Scripted model', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const }].map((model) => ({ ...model, efforts: [...model.efforts] })); }
  async beginLogin() { return { instructions: 'Simulated login.', poll: async () => 'done' as const, cancel: async () => {} }; }
  async probe() { return { auth: 'ready' as const }; }
  async materialiseRigging() { return []; }
  startStretch(raw: StretchInput): StretchRun {
    const input = StretchInputSchema.parse(raw); this.starts.push(structuredClone(input));
    const run = new FakeRun(input, () => { const step = this.#steps.shift(); if (!step) throw new Error('No scripted turn remains.'); return step; }); this.runs.push(run); return run;
  }
  async close(): Promise<void> { await Promise.all(this.runs.map((run) => run.terminate())); }
}
