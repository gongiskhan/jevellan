import { createInterface } from 'node:readline';
import { WorkerCommandSchema, WorkerMessageSchema, type RuntimeEvent, type RunResult, type StretchInput, type WorkerMessage } from './contract.js';

export type WorkerSession = {
  run(message: string, timeoutMs: number, emit: (event: RuntimeEvent) => void, session: (id: string) => void): Promise<RunResult>;
  interrupt(): Promise<void>;
};
// A limit names what it applies to: "your Fable limit" or "switch to another model" is one model's; "your limit" or
// "your weekly limit" is the account's. Generic window words never count as a model name.
const LIMIT_REACHED = /\b(?:reached|hit|exceeded|used up)\b[^.\n]{0,40}\blimit\b|\blimit (?:reached|exceeded)\b|\busage limit\b/i;
const MODEL_LIMIT = /\b(?:reached|hit|exceeded|used up)\s+(?:your|the)\s+(?!(?:usage|rate|weekly|daily|monthly|hourly|session|plan|account|5-hour|five-hour|limit)\b)[a-z][\w.-]*(?:\s+[\w.-]+){0,2}?\s+(?:model\s+)?(?:usage\s+)?limit\b|\b(?:switch to|use|try)\s+(?:another|a different)\s+model\b/i;
export function classifyRuntimeError(error: unknown, structuredKind?: 'rate-limit'): NonNullable<RunResult['error']> {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Runtime failed.';
  const kind = structuredKind ?? (/429|rate.limit|quota.exceeded/i.test(message) || LIMIT_REACHED.test(message) ? 'rate-limit' : /401|authentication|unauthori[sz]ed|needs.login|token.*(?:expired|revoked)|not.logged.in/i.test(message) ? 'auth' : 'other');
  return { kind, message: message.slice(0, 2000), ...(kind === 'rate-limit' && MODEL_LIMIT.test(message) ? { scope: 'model' as const } : {}) };
}

export function serveWorker(factory: (input: StretchInput, daemonPid: number, executable?: string) => WorkerSession): void {
  let session: WorkerSession | undefined;
  let active = false;
  const send = (message: WorkerMessage) => process.stdout.write(`${JSON.stringify(WorkerMessageSchema.parse(message))}\n`);
  const emit = (event: RuntimeEvent) => { send({ schema: 'runtime-message-v1', type: 'event', event }); };
  const run = async (message: string, timeoutMs: number) => {
    active = true;
    let result: RunResult;
    try { result = await session!.run(message, timeoutMs, emit, (sessionId) => { send({ schema: 'runtime-message-v1', type: 'session', sessionId }); }); }
    catch (error) { result = { status: 'failed', error: classifyRuntimeError(error) }; }
    active = false;
    send({ schema: 'runtime-message-v1', type: 'result', result });
  };
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    try {
      if (line.length > 4 * 1024 * 1024) throw new Error('Runtime command exceeds limit.');
      const command = WorkerCommandSchema.parse(JSON.parse(line));
      if (command.type === 'start') {
        if (session || active) throw new Error('Runtime has already started.');
        session = factory(command.input, command.daemonPid, command.executable);
        void run(`${command.input.systemAppend}\n\n${command.input.brief}`, command.input.timeoutMs);
      } else if (command.type === 'continue') {
        if (!session || active) throw new Error('Runtime is not ready to continue.');
        void run(command.message, command.timeoutMs);
      } else if (session && active) {
        void session.interrupt().catch(() => { emit({ type: 'error', kind: 'other', message: 'Runtime interruption failed.' }); });
      }
    } catch { send({ schema: 'runtime-message-v1', type: 'result', result: { status: 'failed', error: { kind: 'other', message: 'Invalid runtime command or state.' } } }); }
  });
  lines.on('close', () => { if (active) void session?.interrupt(); });
}
