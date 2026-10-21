import { OwnerCommandViewRequestSchema, OwnerCommandViewSchema, ownerCommandPresentation } from '@jevellan/core';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { DeviceOriginSchema, OwnerCommandRunRequestSchema, OwnerCommandRunReceiptSchema, TerminalAccessSchema, TerminalAckSchema, TerminalCreateRequestSchema,
  OwnerCommandReceiptRequestSchema, OwnerCommandReceiptViewSchema,
  TerminalHubRequestSchema, TerminalListSchema, TerminalPeerRequestSchema, TerminalPeerResultSchema, TerminalReadInputSchema, TerminalReadResultSchema,
  TerminalSessionSchema, TerminalSnapshotSchema, TerminalTicketSchema, applicationRoot, resolveProjectPath, stableJson,
  parseReply, type TerminalAccess, type TerminalCreateRequest, type TerminalHubRequest, type TerminalSession } from '@jevellan/core';
import type { Application } from './application.js';
import { TerminalManager, type TerminalManagerOptions } from './terminal-manager.js';
import { shellQuote } from './terminal-shell.js';

const refuse = (message: string, status = 409) => Object.assign(new Error(message), { status });
const fingerprint = (input: unknown) => createHash('sha256').update(stableJson(input)).digest('hex');
type Peer = z.infer<typeof TerminalPeerRequestSchema>;
type Source = { threadId?: string; decisionId?: string; coordinator?: true };

/** Terminals extend the existing owner API, device authentication and mesh; agents have only the scoped read path. */
export class TerminalService {
  readonly manager: TerminalManager;
  readonly #tickets = new Map<string, { sessionId: string; owner: string; until: number }>();
  constructor(readonly app: Application, options: Partial<Pick<TerminalManagerOptions, 'env' | 'now' | 'idleMs' | 'unknownMs'>> & { timers?: boolean } = {}) {
    this.manager = new TerminalManager({ ...options, homes: app.homes, deviceId: app.device.deviceId, deviceName: app.device.name, redactor: app.redactor,
      publish: snapshot => this.hub({ schema: 'terminal-hub-request-v1', operation: 'publish', snapshot }).then(() => undefined),
      deliver: async result => app.projectWork.terminalMessage(result.projectId, result.source, result.text, result.messageId),
      detached: async id => { if (app.projectWork.store.get(id)?.state === 'attached') await app.projectWork.detach(id); } });
  }
  async hub(input: TerminalHubRequest) { return this.app.member ? this.app.member.terminals(input) : this.hubRequest(input, this.app.device.deviceId); }
  async hubRequest(raw: unknown, deviceId: string) {
    const input = TerminalHubRequestSchema.parse(raw), app = this.app;
    if (input.operation === 'publish') {
      const { session } = input.snapshot;
      if (session.deviceId !== deviceId) throw refuse('A terminal belongs to its publishing device.', 403);
      if (session.projectId && !await app.state.projects.get(session.projectId)) throw refuse('Project not found.', 404);
      if (session.threadId) { const thread = (await app.projectHub.thread(session.threadId))?.document;
        if (!thread || thread.ownerDeviceId !== deviceId || thread.projectId !== session.projectId) throw refuse('This thread belongs to another device or project.', 403); }
      const previous = app.hub.get('owner-terminals', session.id, TerminalSnapshotSchema);
      if (previous && previous.document.session.deviceId !== deviceId) throw refuse('A terminal cannot move to another device.', 403);
      if (previous && (previous.document.session.projectId !== session.projectId || previous.document.session.threadId !== session.threadId)) throw refuse('A terminal cannot move to another project or thread.', 403);
      app.hub.put('owner-terminals', session.id, TerminalSnapshotSchema, app.redactor.document(input.snapshot), previous?.revision ?? 0);
      return TerminalAckSchema.parse({ schema: 'terminal-ack-v1', ok: true });
    }
    if (input.operation === 'session') {
      if (!app.hubAuth.verify(input.ownerSession, deviceId)) throw refuse('Sign in to Jevellan.', 401);
      const row = app.hub.get('owner-terminals', input.sessionId, TerminalSnapshotSchema);
      if (!row) throw refuse('Terminal not found.', 404); return row.document;
    }
    if (input.operation === 'receipt') {
      if (!app.hubAuth.verify(input.ownerSession, deviceId)) throw refuse('Sign in to Jevellan.', 401);
      const receipt = app.hub.list('owner-terminals', TerminalSnapshotSchema).map(row => row.document.ownerCommand).filter(row => row?.key === input.key).sort((a, b) => b!.receipt.at.localeCompare(a!.receipt.at))[0]?.receipt;
      return OwnerCommandReceiptViewSchema.parse({ schema: 'owner-command-receipt-view-v1', receipt: receipt ?? null });
    }
    const access = TerminalAccessSchema.parse(input.access);
    if (access.kind === 'owner') { app.redactor.add(access.ownerSession); if (!app.hubAuth.verify(access.ownerSession, deviceId)) throw refuse('Sign in to Jevellan.', 401); }
    else if (access.kind === 'coordinator') { if (await app.projectWork.coordinatorDevice(access.projectId) !== deviceId) throw refuse('This coordinator belongs to another device.', 403); }
    else { const thread = (await app.projectHub.thread(access.threadId))?.document; if (!thread || thread.projectId !== access.projectId || thread.ownerDeviceId !== deviceId) throw refuse('This thread belongs to another device.', 403); }
    const snapshots = app.hub.list('owner-terminals', TerminalSnapshotSchema).map(row => row.document).filter(row => access.kind === 'owner' || row.session.projectId === access.projectId || access.kind === 'thread' && row.session.deviceId === deviceId);
    if (input.input.action === 'list') return TerminalListSchema.parse({ schema: 'terminal-list-v1', sessions: snapshots.filter(row => row.session.status === 'open').map(row => row.session).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
    const sessionId = input.input.sessionId;
    const row = snapshots.find(row => row.session.id === sessionId); if (!row) throw refuse('This terminal is outside this project session.', 403);
    return TerminalReadResultSchema.parse(input.input.action === 'tail' ? { schema: 'terminal-tail-v1', sessionId: row.session.id, output: row.tail.slice(-input.input.chars) }
      : { schema: 'terminal-commands-v1', sessionId: row.session.id, commands: row.commands.slice(-input.input.last), approximate: row.approximate });
  }
  async read(access: TerminalAccess, raw: unknown) {
    const input = TerminalReadInputSchema.parse(raw); await this.manager.flush().catch(() => {});
    return TerminalReadResultSchema.parse(await this.hub({ schema: 'terminal-hub-request-v1', operation: 'read', access, input }));
  }
  async list(ownerSession: string, filters: { projectId?: string; deviceId?: string } = {}) {
    const result = TerminalListSchema.parse(await this.read({ kind: 'owner', ownerSession }, { action: 'list' }));
    return TerminalListSchema.parse({ ...result, sessions: result.sessions.filter(row => (!filters.projectId || row.projectId === filters.projectId) && (!filters.deviceId || row.deviceId === filters.deviceId)) });
  }
  async indexed(id: string, token: string): Promise<TerminalSession> {
    // Closed terminals remain in the hub's index so their receipts still open from another browser.
    const local = this.manager.list().find(row => row.id === id); if (local) return local;
    const result = TerminalSnapshotSchema.parse(await this.hub({ schema: 'terminal-hub-request-v1', operation: 'session', ownerSession: token, sessionId: id })); return result.session;
  }
  async device(id: string, requireOnline = true) {
    const view = (await this.app.roster()).devices.find(row => row.device.id === id);
    if (!view || view.revoked) throw refuse('This device is no longer in the mesh.');
    if (requireOnline && id !== this.app.device.deviceId && view.status === 'offline') throw refuse(`Can't reach ${view.device.name}.`, 502);
    return view.device;
  }
  async peer(deviceId: string, input: Peer, token: string) {
    if (deviceId === this.app.device.deviceId) return this.local(input);
    const device = await this.device(deviceId), url = new URL(DeviceOriginSchema.parse(device.url)); url.pathname = '/api/mesh/terminals';
    this.app.redactor.add(token);
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Jevellan-Source-Device': this.app.device.deviceId }, body: JSON.stringify(input) });
    if (!response.ok) { const failure = await response.json().catch(() => ({})) as { message?: string }; throw refuse(this.app.redactor.text(failure.message ?? `Can't reach ${device.name}.`), response.status); }
    const result = parseReply(TerminalPeerResultSchema, await response.json());
    if ((result.schema === 'terminal-session-v1' ? result.deviceId : result.schema === 'terminal-snapshot-v1' ? result.session.deviceId : deviceId) !== deviceId) throw refuse('The terminal device returned an invalid receipt.', 502);
    return result;
  }
  async #plan(input: TerminalCreateRequest, source?: Source, requireOnline = true) {
    const app = this.app;
    const project = input.projectId ? (await app.state.projects.get(input.projectId))?.project : undefined;
    if (input.projectId && !project) throw refuse('Project not found.', 404);
    const thread = input.threadId ? (await app.projectHub.thread(input.threadId))?.document : undefined;
    if (input.threadId && (!thread || thread.projectId !== input.projectId)) throw refuse('Thread not found in this project.', 404);
    const deviceId = input.deviceId ?? (source?.coordinator ? undefined : thread?.ownerDeviceId) ?? (project ? await app.projectWork.coordinatorDevice(project.id) : null) ?? app.device.deviceId;
    const device = await this.device(deviceId, requireOnline);
    let cwd: string;
    if (input.cwd.startsWith('/')) cwd = input.cwd;
    else if (input.cwd === 'home') cwd = deviceId === app.device.deviceId ? app.homes.userHome : 'home';
    else if (input.cwd === 'worktree') {
      if (!thread || thread.ownerDeviceId !== deviceId) throw refuse('Choose the thread’s device for its worktree.');
      if (deviceId !== app.device.deviceId) cwd = 'worktree';
      else { const local = app.projectWork.store.get(thread.id); if (!local?.cwd) throw refuse('This thread has no working folder yet.'); cwd = local.cwd; }
    } else {
      if (!project) throw refuse('Choose a project checkout or home.', 400);
      if (!project.paths[deviceId]) throw refuse(`Project ${project.name} isn't checked out on ${device.name}.`);
      cwd = deviceId === app.device.deviceId ? resolveProjectPath(project, deviceId, device.name) : project.paths[deviceId]!;
    }
    return { deviceId, deviceName: device.name, cwd };
  }
  async create(raw: unknown, token: string) {
    const input = TerminalCreateRequestSchema.parse(raw), plan = await this.#plan(input);
    const session = TerminalSessionSchema.parse(await this.peer(plan.deviceId, { schema: 'terminal-peer-request-v1', operation: 'create', input: { ...input, deviceId: plan.deviceId } }, token));
    return this.ticket(session, token);
  }
  async ownerCommandView(raw: unknown, token: string) {
    const input = OwnerCommandViewRequestSchema.parse(raw);
    if (!await this.app.state.projects.get(input.projectId)) throw refuse('Project not found.', 404);
    await this.#source(input);
    const thread = input.threadId ? (await this.app.projectHub.thread(input.threadId))?.document : undefined;
    if (input.threadId && (!thread || thread.projectId !== input.projectId)) throw refuse('Thread not found in this project.', 404);
    const deviceId = input.command.deviceId ?? input.scopeDeviceId ?? thread?.ownerDeviceId;
    const device = deviceId ? await this.device(deviceId, false) : undefined;
    const receipt = input.command.kind === 'prompt' ? null : (await this.commandReceipt({ schema: 'owner-command-receipt-request-v1', projectId: input.projectId, ...(input.threadId ? { threadId: input.threadId } : {}), ...(input.decisionId ? { decisionId: input.decisionId } : {}), command: input.command }, token)).receipt;
    return OwnerCommandViewSchema.parse(this.app.redactor.document({ schema: 'owner-command-view-v1', projectId: input.projectId, presentation: ownerCommandPresentation(input.command, { deviceId, deviceName: device?.name, receipt }) }));
  }
  async ownerCommand(raw: unknown, token: string) {
    const input = OwnerCommandRunRequestSchema.parse(raw);
    if (input.command.kind === 'prompt') throw refuse('Copy this prompt into the Claude app on the named device.', 409);
    const source = await this.#source(input);
    if (this.app.redactor.text(input.command.command) !== input.command.command) throw refuse('Enter secrets in the terminal’s hidden prompt, rather than an owner command.', 400);
    const plan = await this.#plan(TerminalCreateRequestSchema.parse({ schema: 'terminal-create-request-v1', clientRequestId: input.clientRequestId, projectId: input.projectId,
      ...(input.threadId ? { threadId: input.threadId } : {}), ...(input.command.deviceId ? { deviceId: input.command.deviceId } : {}), cwd: input.command.cwd }), source);
    const session = TerminalSessionSchema.parse(await this.peer(plan.deviceId, { schema: 'terminal-peer-request-v1', operation: 'owner-command', input: { ...input, command: { ...input.command, deviceId: plan.deviceId } } }, token));
    return OwnerCommandRunReceiptSchema.parse({ schema: 'owner-command-run-receipt-v1', terminalId: session.id, deviceId: session.deviceId, deviceName: plan.deviceName, at: session.createdAt });
  }
  async commandReceipt(raw: unknown, token: string) {
    const input = OwnerCommandReceiptRequestSchema.parse(raw), source = await this.#source(input);
    const plan = await this.#plan(TerminalCreateRequestSchema.parse({ schema: 'terminal-create-request-v1', clientRequestId: 'receipt_lookup', projectId: input.projectId,
      ...(input.threadId ? { threadId: input.threadId } : {}), ...(input.command.deviceId ? { deviceId: input.command.deviceId } : {}), cwd: input.command.cwd }), source, false);
    return OwnerCommandReceiptViewSchema.parse(await this.hub({ schema: 'terminal-hub-request-v1', operation: 'receipt', ownerSession: token,
      key: fingerprint({ projectId: input.projectId, source, command: input.command.command, cwd: input.command.cwd, deviceId: plan.deviceId }) }));
  }
  async #source(input: Pick<z.infer<typeof OwnerCommandRunRequestSchema>, 'projectId' | 'threadId' | 'decisionId'>): Promise<Source> {
    if (input.decisionId) {
      const decision = (await this.app.projectHub.decision(input.decisionId))?.document;
      if (!decision || decision.projectId !== input.projectId) throw refuse('Question not found in this project.', 404);
      if (decision.from === 'coordinator') return { decisionId: decision.id, coordinator: true };
      const threadId = decision.threadId ?? input.threadId; if (!threadId) throw refuse('This question has no requesting thread.', 400);
      return { decisionId: decision.id, threadId };
    }
    return input.threadId ? { threadId: input.threadId } : { coordinator: true };
  }
  async local(raw: unknown) {
    const request = TerminalPeerRequestSchema.parse(raw);
    if (request.operation === 'snapshot') return this.manager.snapshot(request.sessionId);
    if (request.operation === 'close') { await this.manager.stop(request.sessionId); return TerminalAckSchema.parse({ schema: 'terminal-ack-v1', ok: true }); }
    const owner = request.operation === 'owner-command' ? request.input : undefined;
    if (owner?.command.kind === 'prompt') throw refuse('Copy this prompt into the Claude app on the named device.', 409);
    const source = owner ? await this.#source(owner) : undefined;
    const input = owner ? TerminalCreateRequestSchema.parse({ schema: 'terminal-create-request-v1', clientRequestId: owner.clientRequestId, projectId: owner.projectId,
      ...(owner.threadId ? { threadId: owner.threadId } : {}), deviceId: owner.command.deviceId, cwd: owner.command.cwd, title: owner.command.command.slice(0, 40) }) : request.input as TerminalCreateRequest;
    const plan = await this.#plan(input, source);
    if (plan.deviceId !== this.app.device.deviceId) throw refuse('This terminal belongs to another device.', 403);
    const command = owner?.command.command ?? (input.takeover ? `${shellQuote(process.execPath)} ${shellQuote(join(applicationRoot(), 'bin', 'jevellan.mjs'))} thread attach ${shellQuote(input.threadId!)}` : undefined);
    return this.manager.create({ requestId: input.clientRequestId, fingerprint: fingerprint(request), cwd: plan.cwd, title: input.title ?? (input.takeover ? 'Take over thread' : 'Terminal'),
      ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.threadId ? { threadId: input.threadId } : {}), ...(source ? { source } : {}), ...(command ? { command } : {}), takeover: input.takeover,
      ...(owner ? { ownerCommandKey: fingerprint({ projectId: owner.projectId, source, command: owner.command.command, cwd: owner.command.cwd, deviceId: plan.deviceId }) } : {}) });
  }
  ticket(session: TerminalSession, token: string) {
    const now = Date.now(); for (const [key, ticket] of this.#tickets) if (ticket.until <= now) this.#tickets.delete(key);
    const ticket = randomBytes(32).toString('base64url'); this.#tickets.set(fingerprint(ticket), { sessionId: session.id, owner: fingerprint(token), until: now + 60_000 }); this.app.redactor.add(ticket);
    return TerminalTicketSchema.parse({ schema: 'terminal-ticket-v1', session, ticket, expiresAt: new Date(now + 60_000).toISOString() });
  }
  consumeTicket(id: string, ticket: string, token: string) {
    const key = fingerprint(ticket), value = this.#tickets.get(key); this.#tickets.delete(key);
    if (!value || value.sessionId !== id || value.owner !== fingerprint(token) || value.until <= Date.now()) throw refuse('This terminal ticket has expired. Reconnect the terminal.', 401);
  }
  async snapshot(id: string, token: string) { const session = await this.indexed(id, token); return TerminalSnapshotSchema.parse(await this.peer(session.deviceId, { schema: 'terminal-peer-request-v1', operation: 'snapshot', sessionId: id }, token)); }
  async stop(id: string, token: string) { const session = await this.indexed(id, token); return this.peer(session.deviceId, { schema: 'terminal-peer-request-v1', operation: 'close', sessionId: id }, token); }
  async close() { this.#tickets.clear(); await this.manager.close(); }
}
