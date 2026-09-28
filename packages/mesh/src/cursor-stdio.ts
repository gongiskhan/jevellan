import { homedir } from 'node:os';
import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { z } from 'zod';
import { CursorMessageInputSchema, CursorSessionIdSchema, Homes, IdSchema } from '@jevellan/core/cursor';
import { cursorList, cursorTranscript } from './cursor-reader.js';
import { queueCursorMessage, cancelCursorMessage } from './cursor-control.js';

const RequestSchema = z.strictObject({
  schema: z.literal('cursor-request-v1'), operation: z.enum(['list', 'read', 'send', 'cancel']),
  home: z.string().startsWith('/'), userHome: z.string().startsWith('/').optional(),
  deviceId: IdSchema, deviceName: z.string(), projectPaths: z.array(z.string()).default([]),
  id: CursorSessionIdSchema.optional(), message: CursorMessageInputSchema.optional(), messageId: IdSchema.optional(),
});
export type CursorRequest = z.input<typeof RequestSchema>;
function run(value: unknown) {
  const request = RequestSchema.parse(value);
  const homes = new Homes(request.home, request.userHome ?? homedir());
  const options = { ...request, home: homes.root, userHome: homes.userHome };
  if (request.operation === 'list') return cursorList(options);
  const id = CursorSessionIdSchema.parse(request.id);
  if (request.operation === 'read') return cursorTranscript(options, id);
  if (request.operation === 'send') return queueCursorMessage(options, id, request.message);
  return cancelCursorMessage(options, id, IdSchema.parse(request.messageId));
}
try {
  if (isMainThread) {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Request too large.'); chunks.push(Buffer.from(chunk)); }
    process.stdout.write(JSON.stringify(run(JSON.parse(Buffer.concat(chunks).toString('utf8')))) + '\n');
  } else parentPort?.postMessage(run(workerData));
} catch (error) {
  const result = { schema: 'cursor-error-v1', message: error instanceof z.ZodError ? 'Invalid Cursor request.' : error instanceof Error ? error.message : 'Cursor is unavailable.' };
  if (isMainThread) process.stdout.write(JSON.stringify(result) + '\n'); else parentPort?.postMessage(result);
}
