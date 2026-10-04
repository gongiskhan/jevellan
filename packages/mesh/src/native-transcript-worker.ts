import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { nativeSessionsAt, nativeTranscriptAt } from './native-sessions.js';
import { NATIVE_TRANSCRIPT_UNREADABLE, NativeTranscriptRequestSchema } from './native-transcript-reader.js';

// Worker entry for native-transcript-reader.ts. Separate from cursor-stdio.ts, whose request schema is also the
// remote Cursor helper's stdin protocol. Only errors carrying a status (the 404) keep their text, so file system
// messages and account home paths never reach a page.
function run(value: unknown) {
  const request = NativeTranscriptRequestSchema.parse(value);
  if (request.operation === 'sessions') return { schema: 'native-sessions-v1', sessions: nativeSessionsAt(request) };
  return nativeTranscriptAt(request);
}
try { parentPort?.postMessage(run(workerData)); }
catch (error) {
  const status = (error as { status?: unknown } | null)?.status;
  parentPort?.postMessage({ schema: 'native-transcript-error-v1', ...(error instanceof Error && typeof status === 'number'
    ? { message: error.message, status } : { message: error instanceof z.ZodError ? 'Invalid thread transcript request.' : NATIVE_TRANSCRIPT_UNREADABLE }) });
}
