import {deviceToolReply} from './device-management.js';
import {ownerToolMaintenance} from '@jevellan/core';
import { healthRefusal } from '@jevellan/core';
import { ProjectHealthRequestSchema } from '@jevellan/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { EmptySchema, ErrorDocumentSchema, HubUnavailable, IdSchema, ThreadAttachRequestSchema, ThreadDetachRequestSchema } from '@jevellan/core';
import { JournalRebuildInputSchema, JournalRebuildReceiptSchema } from '@jevellan/core';
import { ProjectSendRequestSchema, ProjectSendResultSchema } from '@jevellan/core';
import { ProjectStatusViewSchema, OwnerBridgeRequestSchema, OwnerInPlaceAccountRequestSchema, OwnerInPlaceAccountResultSchema, OwnerPushAckSchema, OwnerRemoteRequestSchema, OwnerToolRequestSchema, StatusLineRequestSchema, StatusLineViewSchema } from '@jevellan/core';
import { OwnerRefusal } from './owner-tools.js';
import { renderStatusLine } from '@jevellan/projects';
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
    if (path === '/api/local/events') {
      if (request.method !== 'GET') throw failure('This operation does not support that method.', 405);
      const after = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0); const project = url.searchParams.get('project');
      const projectId = project ? (await app.ownerTools.resolveProject({ project })).id : undefined;
      app.ownerEvents.stream(response, Number.isFinite(after) && after > 0 ? after : 0, projectId); return;
    }
    if (path === '/api/local/pushes') {
      // The bridge forwarder's push feed: every unacked message for its project, then new ones as they appear.
      if (request.method !== 'GET') throw failure('This operation does not support that method.', 405);
      const project = await app.ownerTools.resolveProject({ project: url.searchParams.get('project') ?? '' });
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const sent = new Set<string>();
      const tick = () => { if (!app.ownerBridges.accepting(project.id)) return; for (const message of app.ownerPushes.messages(project.id)) if (!sent.has(message.id)) { sent.add(message.id); response.write(`id: ${message.id}\nevent: push\ndata: ${JSON.stringify(message)}\n\n`); } };
      tick(); const timer = setInterval(() => { try { tick(); } catch { /* the next tick retries */ } }, 1000); const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
      response.on('close', () => { clearInterval(timer); clearInterval(keepAlive); }); return;
    }
    if (path === '/api/local/pushes/ack') {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = OwnerPushAckSchema.parse(await requestBody(request)); const project = await app.ownerTools.resolveProject({ project: input.project });
      json(response, { schema: 'owner-push-acked-v1', acked: app.ownerPushes.ack(project.id, input.pushIds) }); return;
    }
    if (path === '/api/local/bridge') {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = OwnerBridgeRequestSchema.parse(await requestBody(request)); const project = await app.ownerTools.resolveProject({ project: input.project ?? '', ...(input.cwd ? { cwd: input.cwd } : {}) });
      release = app.lifecycle.enter({ kind: 'request' });
      try {
        const text = input.operation === 'stop' ? app.ownerBridges.stopBridge(project) : await app.ownerBridges.startBridge(project, { restart: input.operation === 'restart', ...(input.claudeConfigDir ? { claudeConfigDir: input.claudeConfigDir } : {}), ...(input.remoteName ? { remoteName: input.remoteName } : {}) });
        json(response, { schema: 'owner-bridge-result-v1', ok: true, text });
      } catch (error) { if (error instanceof OwnerRefusal) { json(response, { schema: 'owner-bridge-result-v1', ok: false, text: error.message }); return; } throw error; }
      return;
    }
    if (path === '/api/local/accounts/in-place') {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = OwnerInPlaceAccountRequestSchema.parse(await requestBody(request));
      try { json(response, OwnerInPlaceAccountResultSchema.parse({ schema: 'owner-in-place-account-result-v1', ok: true, text: await app.ownerLogins.addInPlace(input.label, input.runtime, input.folder) })); }
      catch (error) { if (error instanceof OwnerRefusal) { json(response, { schema: 'owner-in-place-account-result-v1', ok: false, text: error.message }); return; } throw error; }
      return;
    }
    if (path === '/api/local/remote') {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = OwnerRemoteRequestSchema.parse(await requestBody(request)); const remote = app.ownerRemote;
      if (!remote) throw failure('Remote access runs on the state point.', 409);
      if (input.operation === 'revoke') { json(response, { schema: 'owner-remote-result-v1', text: `Revoked ${remote.revoke()} remote tokens and sign-ins. Remote clients must sign in again.` }); return; }
      try { json(response, { schema: 'owner-remote-result-v1', text: remote.setup(input.port, input.clientId && input.clientSecret ? { clientId: input.clientId, clientSecret: input.clientSecret } : undefined) }); }
      catch (error) { throw failure(error instanceof Error ? error.message : 'Setup failed.', 400); }
      return;
    }
    const tool = path.match(/^\/api\/local\/tools\/([a-z_]{1,40})$/u);
    if (tool) {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = OwnerToolRequestSchema.parse(await requestBody(request));
      if (!ownerToolMaintenance(tool[1]!,input)) release = app.lifecycle.enter({ kind: 'request' });
      // Keep hub validation, project resolution and caller logging; inventory facts belong to this device.
      const localRuntimeEditor = tool[1] === 'config' && (input.action ?? input.args.action) === 'runtimes_editor';
      if (app.member) {
        const result = await app.member.ownerTool({ schema: 'owner-tool-forward-v1', name: tool[1]!, request: input });
        json(response, deviceToolReply(app,tool[1]!,input.args,localRuntimeEditor && result.ok ? { ...result, data: await app.runtimeSettings() } : result,input.action)); return;
      }
      json(response, deviceToolReply(app,tool[1]!,input.args,await app.ownerTools.call(tool[1]!, input),input.action)); return;
    }
    if (path === '/api/local/statusline') {
      if (request.method !== 'POST') throw failure('This operation does not support that method.', 405);
      const input = StatusLineRequestSchema.parse(await requestBody(request));
      if (app.member) {
        const result = await app.member.ownerTool({ schema: 'owner-tool-forward-v1', name: 'status', request: { schema: 'owner-tool-request-v1', caller: 'cli', args: {}, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.project ? { project: input.project } : {}) } });
        const view = result.ok ? ProjectStatusViewSchema.safeParse(result.data) : undefined;
        json(response, StatusLineViewSchema.parse({ schema: 'status-line-view-v1', text: view?.success ? renderStatusLine(view.data) : 'Jevellan · no project here' })); return;
      }
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
