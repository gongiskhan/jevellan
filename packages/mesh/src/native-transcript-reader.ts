import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { CursorTranscriptSchema, IdSchema } from '@jevellan/core/cursor';
import type { NativeJournal, NativeTranscriptAtOptions } from './native-sessions.js';
import type { NativeRuntime } from './native-transcript.js';

export const NATIVE_TRANSCRIPT_TIMEOUT = 'The thread transcript did not load in time.';
export const NATIVE_TRANSCRIPT_UNREADABLE = 'The thread transcript could not be read on this device.';
const PathSchema = z.string().min(1).max(4096).refine(isAbsolute);
const RuntimeSchema = z.enum(['claude', 'codex']);
export const NativeTranscriptRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('native-transcript-request-v1'), operation: z.literal('read'), runtime: RuntimeSchema, root: PathSchema,
    sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/), deviceId: IdSchema, deviceName: z.string(), title: z.string(), project: z.string(),
    file: PathSchema.optional() }),
  z.strictObject({ schema: z.literal('native-transcript-request-v1'), operation: z.literal('sessions'), runtime: RuntimeSchema, root: PathSchema }),
]);
export type NativeTranscriptRequest = z.input<typeof NativeTranscriptRequestSchema>;
export const NativeSessionsResultSchema = z.strictObject({
  schema: z.literal('native-sessions-v1'),
  sessions: z.array(z.strictObject({ nativeId: z.string().min(1), cwd: z.string().nullable(), file: z.string(), mtimeMs: z.number() })),
});
export const NativeTranscriptErrorSchema = z.strictObject({ schema: z.literal('native-transcript-error-v1'), message: z.string(), status: z.number().int().optional() });

/** Runs one request in `native-transcript-worker.js` so journal reads and parsing never block the daemon event loop (D60). */
function request<S extends z.ZodType>(input: NativeTranscriptRequest, result: S, timeoutMs = 12_000): Promise<z.output<S>> {
  return new Promise((resolve, reject) => {
    const workerData = NativeTranscriptRequestSchema.parse(input);
    // stderr is drained, not forwarded: every worker isolate would print Node's SQLite experimental warning again.
    const worker = new Worker(new URL('./native-transcript-worker.js', import.meta.url), { workerData, stderr: true });
    worker.stderr.resume();
    let open = true;
    const settle = (finish: () => void) => { if (open) { open = false; clearTimeout(timer); finish(); } };
    const timer = setTimeout(() => settle(() => { void worker.terminate(); reject(new Error(NATIVE_TRANSCRIPT_TIMEOUT)); }), timeoutMs);
    worker.once('message', (value: unknown) => settle(() => {
      const error = NativeTranscriptErrorSchema.safeParse(value);
      if (error.success) { reject(Object.assign(new Error(error.data.message), error.data.status === undefined ? {} : { status: error.data.status })); return; }
      const parsed = result.safeParse(value);
      if (parsed.success) resolve(parsed.data); else reject(new Error(NATIVE_TRANSCRIPT_UNREADABLE));
    }));
    worker.once('error', () => settle(() => reject(new Error(NATIVE_TRANSCRIPT_UNREADABLE))));
    worker.once('exit', () => settle(() => reject(new Error(NATIVE_TRANSCRIPT_UNREADABLE))));
  });
}
/** `nativeTranscriptAt` in a worker. A missing session rejects with status 404; a slow read with the timeout copy. */
export function readNativeTranscript(options: NativeTranscriptAtOptions, o: { timeoutMs?: number } = {}): Promise<z.infer<typeof CursorTranscriptSchema>> {
  const { file, ...rest } = options;
  return request({ schema: 'native-transcript-request-v1', operation: 'read', ...rest, ...(file ? { file } : {}) }, CursorTranscriptSchema, o.timeoutMs);
}
/** `nativeSessionsAt` in a worker. */
export async function listNativeSessions(options: { runtime: NativeRuntime; root: string }, o: { timeoutMs?: number } = {}): Promise<NativeJournal[]> {
  return (await request({ schema: 'native-transcript-request-v1', operation: 'sessions', runtime: options.runtime, root: options.root }, NativeSessionsResultSchema, o.timeoutMs)).sessions;
}
