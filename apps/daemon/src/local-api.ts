import { healthRefusal } from '@jevellan/core';
import { ProjectHealthRequestSchema } from '@jevellan/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { EmptySchema, ErrorDocumentSchema, HubUnavailable, IdSchema, ThreadAttachRequestSchema, ThreadDetachRequestSchema } from '@jevellan/core';
import { JournalRebuildInputSchema, JournalRebuildReceiptSchema } from '@jevellan/core';
import { ProjectSendRequestSchema, ProjectSendResultSchema } from '@jevellan/core';
import { OwnerToolRequestSchema, StatusLineRequestSchema, StatusLineViewSchema } from '@jevellan/core';
import { setTimeout as delay } from 'node:timers/promises';
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
    const send = path.match(/^\/api\/local\/projects\/([^/]+)\/coordinator\/messages$/u);
    if (send) {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const name = decodeURIComponent(send[1]!), input = ProjectSendRequestSchema.parse(await requestBody(request));
      const matches = (await app.state.projects.list()).map(row => row.project).filter(project => project.id === name || project.name === name);
      if (matches.length !== 1) throw failure(matches.length ? 'More than one project has that name. Use its id.' : 'Project not found.', matches.length ? 409 : 404);
      const projectId = matches[0]!.id;
      release = app.lifecycle.enter({ kind: 'request' });
      await app.projectWork.sendOwnerMessage(projectId, input);
      const deadline = Date.now() + input.waitSeconds * 1000;
      while (input.waitSeconds && !response.destroyed) {
        try {
          const query = { schema: 'project-journal-request-v1' as const, projectId, operation: 'coordinator-reply' as const, clientMessageId: input.clientMessageId };
          const result = app.member ? await app.member.projectJournal(query) : await app.projectWork.journal!.request(query, app.device.deviceId);
          if (result.operation === 'coordinator-reply' && result.reply) { json(response, app.redactor.document(ProjectSendResultSchema.parse({ ...result.reply, schema: 'project-send-result-v1' }))); return; }
        } catch (error) { if (!(error instanceof HubUnavailable)) throw error; }
        const left = deadline - Date.now(); if (left <= 0) break;
        await delay(Math.min(left, 1000));
      }
      if (!response.destroyed) json(response, ProjectSendResultSchema.parse({ schema: 'project-send-result-v1', projectId, turn: null, reply: null, at: new Date().toISOString() }));
      return;
    }
    const tool = path.match(/^\/api\/local\/tools\/([a-z_]{1,40})$/u);
    if (tool) {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = OwnerToolRequestSchema.parse(await requestBody(request));
      release = app.lifecycle.enter({ kind: 'request' });
      json(response, app.redactor.document(await app.ownerTools.call(tool[1]!, input))); return;
    }
    if (path === '/api/local/statusline') {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = StatusLineRequestSchema.parse(await requestBody(request));
      json(response, StatusLineViewSchema.parse({ schema: 'status-line-view-v1', text: await app.ownerTools.statusLine(input) })); return;
    }
    if (path === '/api/local/health') {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = ProjectHealthRequestSchema.parse(await requestBody(request)); release = app.lifecycle.enter({ kind: 'request' });
      json(response, app.redactor.document(await app.projectHealthRequest(input))); return;
    }
    if (path === '/api/local/journal/rebuild') {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = JournalRebuildInputSchema.parse(await requestBody(request)), projects = (await app.state.projects.list()).map(row => row.project);
      const found = projects.filter(project => project.id === input.project || project.name === input.project);
      if (found.length !== 1) throw failure(found.length ? 'More than one project has that name. Use its id.' : 'Project not found.', found.length ? 409 : 404);
      if (!app.projectWork.journal) throw failure('The project journal is unavailable.', 503);
      release = app.lifecycle.enter({ kind: 'request' });
      const project = found[0]!;
      if (app.member) await app.member.projectJournal({ schema: 'project-journal-request-v1', projectId: project.id, operation: 'rebuild' });
      await app.projectWork.journal.sync(project.id, true);
      json(response, JournalRebuildReceiptSchema.parse({ schema: 'project-journal-rebuilt-v1', projectId: project.id, path: app.projectWork.journal.path(project.id), files: Object.keys(app.projectWork.journal.state(project.id).files).length })); return;
    }
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
      message: healthRefusal(error) ?? (error instanceof z.ZodError ? 'Check the submitted fields.' : typeof candidate?.message === 'string' ? app.redactor.text(candidate.message) : 'The request could not complete.') })), status);
  } finally { release?.(); }
}
