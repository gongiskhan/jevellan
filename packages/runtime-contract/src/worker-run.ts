import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { minimalEnvironment, SecretRedactor } from '@jevellan/core';
import { AsyncQueue } from './queue.js';
import { groupAlive, terminateGroup, type NativeProcess } from './process-group.js';
import { StretchInputSchema, WorkerCommandSchema, WorkerMessageSchema, type RuntimeContext, type RuntimeEvent, type RunResult, type StretchInput, type StretchRun, type WorkerCommand } from './contract.js';

export function launchEnvironment(runtime: 'claude' | 'codex', input: StretchInput): Record<string, string> {
  const auth: Record<string, string> = {};
  if (runtime === 'claude') for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (input.account.env[key]) auth[key] = input.account.env[key]!;
  const launch: Record<string, string> = {};
  for (const key of ['JEVELLAN_STRETCH_TOKEN', 'JEVELLAN_DAEMON_URL']) if (input.launch.env[key]) launch[key] = input.launch.env[key]!;
  return minimalEnvironment(runtime, input.account.home, auth, launch, { ...process.env, ...input.launch.env });
}

export class WorkerRun implements StretchRun {
  #queue = new AsyncQueue<RuntimeEvent>();
  #resolve!: (result: RunResult) => void;
  #done!: Promise<RunResult>;
  #settled = false;
  #terminated = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #child: ChildProcessWithoutNullStreams;
  readonly native: NativeProcess;
  readonly #redactor: SecretRedactor;
  constructor(runtime: 'claude' | 'codex', worker: string, raw: StretchInput, context: RuntimeContext) {
    const input = StretchInputSchema.parse(raw);
    if (input.account.account.runtime !== runtime) throw new Error('Account belongs to another runtime.');
    if (realpathSync(input.account.home) !== context.homes.account(runtime, input.account.account.id)) throw new Error('Runtime account home is not owned by Jevellan.');
    if (!isAbsolute(input.cwd)) throw new Error('Runtime requires an absolute project path.');
    realpathSync(input.cwd);
    if (input.action === 'done' || input.action === 'ask-you') throw new Error('This action does not launch a runtime stretch.');
    if (['reply', 'plan', 'review', 'adversarial-review'].includes(input.action) && input.permissions !== 'read-only') throw new Error('This action requires read-only permissions.');
    const env = launchEnvironment(runtime, input);
    this.#redactor = context.redactor ?? new SecretRedactor();
    for (const [key, value] of Object.entries(env)) if (/TOKEN|KEY/.test(key)) this.#redactor.add(value);
    for (const server of Object.values(input.launch.mcpServers)) {
      for (const [key, value] of Object.entries(server.env)) if (env[key] !== value) throw new Error('Per-launch MCP environment must use the scoped inherited environment.');
    }
    const cleanInput = { ...input, account: { ...input.account, env: {} }, launch: { env: {}, mcpServers: Object.fromEntries(Object.entries(input.launch.mcpServers).map(([name, server]) => [name, { ...server, env: {} }])) } };
    this.#begin(input.timeoutMs);
    this.#child = spawn(process.execPath, [worker], { cwd: input.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child.on('error', () => this.#finish({ status: 'failed', error: { kind: 'other', message: 'Runtime worker failed to start.' } }));
    if (!this.#child.pid) { clearTimeout(this.#timer); throw new Error('Runtime worker did not start.'); }
    this.native = { pid: this.#child.pid, pgid: this.#child.pid };
    this.#child.stdin.on('error', () => this.#finish({ status: 'failed', error: { kind: 'other', message: 'Runtime command channel closed.' } }));
    this.#child.stderr.on('data', () => { /* SDK diagnostics never bypass the validated event channel. */ });
    const lines = createInterface({ input: this.#child.stdout });
    lines.on('line', (line) => {
      try {
        if (line.length > 2 * 1024 * 1024) throw new Error('Runtime message exceeds limit.');
        const message = WorkerMessageSchema.parse(JSON.parse(line));
        if (message.type === 'session') this.native.sessionId = message.sessionId;
        else if (message.type === 'result') this.#finish(this.#redactor.document(message.result));
        else if (!this.#settled) this.#queue.push(this.#redactor.document(message.event));
      } catch {
        this.#finish({ status: 'failed', error: { kind: 'other', message: 'Runtime sent an invalid event.' } });
        void this.terminate().catch(() => undefined);
      }
    });
    this.#child.on('close', () => {
      lines.close();
      if (!this.#settled) this.#finish({ status: this.#terminated ? 'interrupted' : 'failed', ...(this.#terminated ? {} : { error: { kind: 'other' as const, message: 'Runtime worker exited before finishing.' } }) });
    });
    this.#send({ schema: 'runtime-command-v1', type: 'start', input: cleanInput, daemonPid: context.daemonPid ?? process.pid, ...(context.executable ? { executable: context.executable } : {}) });
  }
  get events(): AsyncIterable<RuntimeEvent> { return this.#queue; }
  get done(): Promise<RunResult> { return this.#done; }
  #begin(timeoutMs: number): void {
    this.#settled = false;
    this.#queue = new AsyncQueue();
    this.#done = new Promise((resolve) => { this.#resolve = resolve; });
    this.#timer = setTimeout(() => {
      void this.interrupt('timeout');
      this.#timer = setTimeout(() => { void this.terminate().catch(() => undefined); }, 10_000);
    }, timeoutMs);
  }
  #finish(result: RunResult): void {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#timer);
    this.#queue.close(); this.#resolve(result);
  }
  #send(command: WorkerCommand): void { this.#child.stdin.write(`${JSON.stringify(WorkerCommandSchema.parse(command))}\n`); }
  async interrupt(reason: 'steer' | 'timeout' | 'cancel'): Promise<void> {
    if (this.#settled || this.#terminated) return;
    this.#send({ schema: 'runtime-command-v1', type: 'interrupt', reason });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = await Promise.race([this.#done.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 10_000); })]);
      if (!stopped) await this.terminate();
    } finally { clearTimeout(timer); }
  }
  async continue(message: string, timeoutMs: number): Promise<void> {
    if (!this.#settled || this.#terminated || !groupAlive(this.native.pgid)) throw new Error('Runtime session is not available for continuation.');
    this.#begin(timeoutMs);
    this.#send({ schema: 'runtime-command-v1', type: 'continue', message, timeoutMs });
    const result = await this.#done;
    if (result.status === 'failed') throw new Error(result.error?.message ?? 'Runtime continuation failed.');
  }
  async terminate(): Promise<void> {
    this.#terminated = true;
    await terminateGroup(this.native);
    this.#finish({ status: 'interrupted' });
  }
}
