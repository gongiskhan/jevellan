import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { EmptySchema, ErrorDocumentSchema, HubUnavailable, IdSchema, ThreadAttachRequestSchema, ThreadDetachRequestSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { diagnoseApplication, type LocalDiagnostics } from './diagnostics.js';
import { json, requestBody } from './http.js';

const DOCTOR = '/api/local/doctor';
const THREAD = /^\/api\/local\/threads\/([A-Za-z0-9_-]+)\/(attach|detach)$/;
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

/**
 * The local control routes (`/api/local/*`): the installed command's requests over the loopback listener, authorized by the
 * installation control file (127.0.0.1 on both ends, no `Origin`, the control token), never by a browser session. Doctor keeps its
 * exact behavior; terminal takeover (brief phase 7) answers attach and detach with the thread's own refusal sentences. The attach
 * answer is the one response sent without the redactor: it carries the native session id and the account credentials the command
 * needs (D46).
 */
export async function handleLocalApi(app: Application | undefined, control: LocalDiagnostics | undefined, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  if (path === DOCTOR) {
    if (request.method !== 'POST' || !app || !control?.authorized(request)) { json(response, ErrorDocumentSchema.parse({ schema: 'error-v1', code: 'unauthenticated', message: 'Local diagnostics require the installation control file.' }), 401); return; }
    let release: (() => void) | undefined;
    try { EmptySchema.parse(await requestBody(request)); release = app.lifecycle.enter({ kind: 'request' }); json(response, await diagnoseApplication(app)); }
    catch { json(response, ErrorDocumentSchema.parse({ schema: 'error-v1', code: 'request-failed', message: 'Diagnostics are unavailable while Jevellan is changing or stopping.' }), 503); }
    finally { release?.(); }
    return;
  }
  if (!app || !control?.authorized(request)) { json(response, ErrorDocumentSchema.parse({ schema: 'error-v1', code: 'unauthenticated', message: 'Local commands require the installation control file.' }), 401); return; }
  let release: (() => void) | undefined;
  try {
    const match = path.match(THREAD);
    if (!match) throw failure('Not found.', 404);
    if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
    const threadId = IdSchema.parse(match[1]);
    if (match[2] === 'attach') {
      ThreadAttachRequestSchema.parse(await requestBody(request));
      release = app.lifecycle.enter({ kind: 'request' });
      json(response, await app.projectWork.attach(threadId)); return;
    }
    ThreadDetachRequestSchema.parse(await requestBody(request));
    release = app.lifecycle.enter({ kind: 'request' });
    json(response, app.redactor.document(await app.projectWork.detach(threadId)));
  } catch (error) {
    const candidate = error as { status?: unknown; message?: unknown };
    const status = typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status <= 599 ? candidate.status : 400;
    json(response, app.redactor.document(ErrorDocumentSchema.parse({ schema: 'error-v1',
      code: error instanceof HubUnavailable ? 'hub-unavailable' : status === 409 ? 'conflict' : status === 404 ? 'not-found' : 'request-failed', ...(error instanceof HubUnavailable ? { retryable: true } : {}),
      message: error instanceof z.ZodError ? 'Check the submitted fields.' : typeof candidate?.message === 'string' ? app.redactor.text(candidate.message) : 'The request could not complete.' })), status);
  } finally { release?.(); }
}
