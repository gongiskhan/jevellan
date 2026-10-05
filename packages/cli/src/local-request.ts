import { DoctorControlSchema, ErrorDocumentSchema, doctorControlPath, readDocument, type Homes } from '@jevellan/core';
import type { z } from 'zod';

export type LocalRequestOptions = {
  fetcher?: typeof fetch; timeoutMs?: number;
  /** Thrown when the daemon gives no usable answer: not JSON, no body, or a failure while `daemonErrors` is off. */
  unanswered: string;
  /** Thrown when the answer exceeds 64 KiB. */
  tooLarge: string;
  /** A failure answer (`error-v1`) throws `LocalRequestError` with the daemon's own sentence instead of `unanswered`. */
  daemonErrors?: boolean;
};

/** The daemon answered and refused: its own sentence, already redacted by the daemon, and the HTTP status. */
export class LocalRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * A request from the installed command to the running daemon's local control routes (`/api/local/*`): the installation control file
 * gives the loopback origin (the schema refuses any other) and the token, read fresh for every request because the token rotates on
 * every daemon start. The answer is read with a 64 KiB cap and parsed with `schema`.
 */
export async function localRequest<T>(homes: Homes, path: string, body: unknown, schema: z.ZodType<T>, options: LocalRequestOptions): Promise<T> {
  const control = readDocument(doctorControlPath(homes), DoctorControlSchema);
  const response = await (options.fetcher ?? fetch)(`${control.origin}${path}`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if ((!response.ok && !options.daemonErrors) || response.headers.get('content-type')?.split(';')[0] !== 'application/json' || !response.body) { await response.body?.cancel(); throw new Error(options.unanswered); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length; if (length > 64 * 1024) { await reader.cancel(); throw new Error(options.tooLarge); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const document: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!response.ok) { const error = ErrorDocumentSchema.safeParse(document); throw new LocalRequestError(error.success ? error.data.message : options.unanswered, response.status); }
  return schema.parse(document);
}
