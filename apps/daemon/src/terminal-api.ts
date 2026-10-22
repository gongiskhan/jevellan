import { readTerminalView } from './terminal-reading-view.js';
import { readTerminalLauncherView, readTerminalListView } from './terminal-launcher-view.js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { EmptySchema, IdSchema, PeerLoginSessionInputSchema, TerminalAckSchema, TerminalCreateRequestSchema, TerminalInputFrameSchema, TerminalOutputFrameSchema,
  TerminalPeerRequestSchema, TerminalSendRequestSchema, type TerminalSession } from '@jevellan/core';
import { sessionFromCookie } from '@jevellan/mesh';
import type { Application } from './application.js';
import { requestBody, json } from './http.js';
import { terminalPlain } from './terminal-buffer.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
const peerAuth = (request: IncomingMessage) => PeerLoginSessionInputSchema.parse({ schema: 'peer-login-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'], token: request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined });

export async function handleTerminalPeer(app: Application, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/mesh/terminals') return false;
  if (request.headers.origin || request.headers['sec-fetch-site'] || request.method !== 'POST') throw refuse('Use the device connection for this request.', 403);
  const caller = peerAuth(request); if (!await app.peerLoginAuthenticated(caller)) throw refuse('Sign in to Jevellan.', 401);
  app.redactor.add(caller.token);
  const result = await app.terminals.local(TerminalPeerRequestSchema.parse(await requestBody(request)));
  if (!await app.peerLoginAuthenticated(caller)) throw refuse('Sign in to Jevellan.', 401);
  json(response, app.redactor.document(result)); return true;
}
export async function handleTerminalApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, token: string): Promise<boolean> {
  if (!url.pathname.startsWith('/api/terminals')) return false;
  const service = app.terminals, method = request.method ?? 'GET', path = url.pathname;
  const reading = /^\/api\/terminals\/([A-Za-z0-9_-]+)\/read-view$/u.exec(path);
  if (reading) {
    if (method !== 'GET') throw refuse('Unsupported terminal read method.', 405);
    json(response, app.redactor.document(await readTerminalView(app, { schema: 'terminal-read-request-v1', sessionId: reading[1]! }, token))); return true;
  }
  if (path === '/api/terminals/launcher-view' || path === '/api/terminals/list-view') {
    if (method !== 'GET') throw refuse('Unsupported terminal view method.', 405);
    const projectId = url.searchParams.get('projectId'), deviceId = url.searchParams.get('deviceId');
    if (path.endsWith('/launcher-view')) json(response, app.redactor.document(await readTerminalLauncherView(app, { schema: 'terminal-launcher-view-request-v1', ...(projectId ? { projectId } : {}), ...(deviceId ? { deviceId } : {}) })));
    else json(response, app.redactor.document(await readTerminalListView(app, { schema: 'terminal-list-request-v1', ...(projectId ? { projectId } : { deviceId: deviceId ?? app.device.deviceId }) }, token)));
    return true;
  }
  if (path === '/api/terminals' && method === 'GET') {
    const projectId = url.searchParams.get('projectId'), deviceId = url.searchParams.get('deviceId');
    json(response, await service.list(token, { ...(projectId ? { projectId: IdSchema.parse(projectId) } : {}), ...(deviceId ? { deviceId: IdSchema.parse(deviceId) } : {}) })); return true;
  }
  if (path === '/api/terminals' && method === 'POST') { json(response, await service.create(TerminalCreateRequestSchema.parse(await requestBody(request)), token), 201); return true; }
  if (path === '/api/terminals/owner-command/view' && method === 'POST') { json(response, await service.ownerCommandView(await requestBody(request), token)); return true; }
  if (path === '/api/terminals/owner-command' && method === 'POST') { json(response, await service.ownerCommand(await requestBody(request), token), 201); return true; }
  if (path === '/api/terminals/owner-command/receipt' && method === 'POST') { json(response, await service.commandReceipt(await requestBody(request), token)); return true; }
  const match = path.match(/^\/api\/terminals\/([A-Za-z0-9_-]+)(?:\/(ticket|close|send))?$/u);
  if (!match) throw refuse('Terminal operation not found.', 404);
  const id = IdSchema.parse(match[1]);
  if (!match[2] && method === 'GET') { json(response, await service.snapshot(id, token)); return true; }
  if (match[2] === 'ticket' && method === 'POST') { EmptySchema.parse(await requestBody(request)); json(response, service.ticket(await service.indexed(id, token), token)); return true; }
  if (match[2] === 'close' && method === 'POST') { EmptySchema.parse(await requestBody(request)); json(response, await service.stop(id, token)); return true; }
  if (match[2] === 'send' && method === 'POST') {
    const input = TerminalSendRequestSchema.parse(await requestBody(request)), snapshot = await service.snapshot(id, token), projectId = snapshot.session.projectId;
    if (!projectId) throw refuse('Choose a project terminal to send its output.', 400);
    let text: string;
    if (input.content === 'selection') { if (!input.selection) throw refuse('Select text to send.', 400); text = input.selection; }
    else text = snapshot.commands.slice(input.content === 'last' ? -1 : -5).map(row => `$ ${row.command}\n${row.output}\nExit code: ${row.exitCode ?? 'unknown'}`).join('\n\n');
    text = app.redactor.text(terminalPlain(text)).slice(-30000); if (!text.trim()) throw refuse('This terminal has no command output yet.', 400);
    if (input.target.kind === 'thread') {
      const thread = (await app.projectHub.thread(input.target.threadId))?.document;
      if (!thread || thread.projectId !== projectId || ['done', 'failed', 'stopped'].includes(thread.state)) throw refuse('Choose an active thread of this project.', 400);
    }
    await app.projectWork.terminalMessage(projectId, input.target.kind === 'thread' ? { threadId: input.target.threadId } : { coordinator: true },
      `The owner sent output from the terminal on ${(await service.device(snapshot.session.deviceId)).name} in ${snapshot.session.cwd}:\n${text}`, input.clientMessageId);
    json(response, TerminalAckSchema.parse({ schema: 'terminal-ack-v1', ok: true })); return true;
  }
  throw refuse('Terminal operation not found.', 404);
}

/** Every HTTP listener owns only its sockets. The Application owns PTYs and tickets across all listeners. */
export function installTerminalStreams(server: Server, application: () => Application | undefined, origin: (request: IncomingMessage) => void) {
  const websockets = new WebSocketServer({ noServer: true, maxPayload: 90_000, perMessageDeflate: false });
  const upstreams = new Set<WebSocket>();
  server.on('upgrade', (request, socket, head) => {
    void upgrade(request, socket, head).catch(error => { if (!socket.destroyed) { const status = (error as { status?: number }).status ?? 400;
      socket.end(`HTTP/1.1 ${status} Terminal unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } });
  });
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const app = application(); if (!app) throw refuse('Jevellan is starting.', 503);
    origin(request);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), match = url.pathname.match(/^\/api\/(mesh\/)?terminals\/([A-Za-z0-9_-]+)\/stream$/u);
    if (!match) throw refuse('Terminal stream not found.', 404);
    const id = IdSchema.parse(match[2]); let session: TerminalSession; let authenticated: () => Promise<boolean>; let token: string;
    if (match[1]) {
      if (request.headers.origin || request.headers['sec-fetch-site']) throw refuse('Use the device connection.', 403);
      const input = peerAuth(request); if (!await app.peerLoginAuthenticated(input)) throw refuse('Sign in to Jevellan.', 401);
      token = input.token; session = app.terminals.manager.session(id); authenticated = () => app.peerLoginAuthenticated(input, true);
    } else {
      token = sessionFromCookie(request.headers.cookie) ?? ''; if (!await app.auth.verify(token)) throw refuse('Sign in to Jevellan.', 401);
      app.terminals.consumeTicket(id, url.searchParams.get('ticket') ?? '', token);
      session = await app.terminals.indexed(id, token); authenticated = () => app.streamAuthenticated(token);
    }
    if (socket.destroyed) return;
    let remote: WebSocket | undefined;
    if (session.deviceId !== app.device.deviceId) {
      const device = await app.terminals.device(session.deviceId), target = new URL(device.url); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'; target.pathname = `/api/mesh/terminals/${id}/stream`;
      remote = new WebSocket(target, { headers: { Authorization: `Bearer ${token}`, 'X-Jevellan-Source-Device': app.device.deviceId }, handshakeTimeout: 20_000, maxPayload: 90_000, perMessageDeflate: false });
      upstreams.add(remote); remote.once('close', () => upstreams.delete(remote!));
    }
    websockets.handleUpgrade(request, socket, head, ws => connect(app, ws, session, authenticated, remote));
  }
  function connect(app: Application, ws: WebSocket, session: TerminalSession, authenticated: () => Promise<boolean>, remote?: WebSocket) {
    const send = (data: string) => { if (ws.readyState !== WebSocket.OPEN) return; if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Reconnect to replay terminal output.'); return; } ws.send(data); };
    const frame = (input: unknown) => send(JSON.stringify(TerminalOutputFrameSchema.parse(input)));
    const output = (data: string) => { const bytes = Buffer.from(data); for (let start = 0; start < bytes.length; start += 32768) frame({ schema: 'terminal-frame-v1', type: 'output', data: bytes.subarray(start, start + 32768).toString('base64') }); };
    let unsubscribe: () => void = () => {}; const queued: string[] = []; let pendingBytes = 0;
    if (remote) {
      remote.on('message', data => send(data.toString()));
      remote.on('open', () => { for (const data of queued) remote.send(data); queued.length = 0; });
      remote.on('error', () => ws.close(1011, 'The terminal device could not be reached.'));
      remote.on('close', () => ws.close(1011, 'Reconnect the terminal.'));
    } else {
      let approximate = app.terminals.manager.approximate(session.id);
      const replay = app.terminals.manager.subscribe(session.id, data => {
        output(data); const next = app.terminals.manager.approximate(session.id);
        if (next !== approximate) { approximate = next; frame({ schema: 'terminal-frame-v1', type: 'replay-end', approximate }); }
      }, reason => frame({ schema: 'terminal-frame-v1', type: 'closed', reason }));
      unsubscribe = replay.unsubscribe;
      frame({ schema: 'terminal-frame-v1', type: 'replay-start', session }); output(replay.raw); frame({ schema: 'terminal-frame-v1', type: 'replay-end', approximate: replay.approximate });
      if (session.status === 'closed') frame({ schema: 'terminal-frame-v1', type: 'closed', reason: session.closedReason ?? 'Terminal closed.' });
    }
    ws.on('message', raw => {
      try {
        const input = TerminalInputFrameSchema.parse(JSON.parse(raw.toString()));
        if (remote) {
          const data = JSON.stringify(input); if (remote.readyState === WebSocket.OPEN) remote.send(data);
          else { pendingBytes += Buffer.byteLength(data); if (pendingBytes > 90_000) throw refuse('Terminal connection is busy.', 400); queued.push(data); }
        } else if (input.type === 'input') app.terminals.manager.input(session.id, Buffer.from(input.data, 'base64').toString('utf8'));
        else if (input.type === 'resize') app.terminals.manager.resize(session.id, input.cols, input.rows);
        else frame({ schema: 'terminal-frame-v1', type: 'heartbeat' });
      } catch { ws.close(1008, 'Invalid terminal frame.'); }
    });
    let checking = false;
    const timer = setInterval(() => { if (checking) return; checking = true; void authenticated().then(valid => { if (!valid) ws.close(1008, 'Sign in to Jevellan.'); else frame({ schema: 'terminal-frame-v1', type: 'heartbeat' }); }).catch(() => ws.close(1011, 'Reconnect the terminal.')).finally(() => { checking = false; }); }, 15_000); timer.unref();
    ws.on('error', () => {});
    ws.once('close', () => { clearInterval(timer); unsubscribe(); remote?.terminate(); });
  }
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => { for (const ws of websockets.clients) ws.terminate(); for (const upstream of upstreams) upstream.terminate(); return close(callback); }) as typeof server.close;
}
