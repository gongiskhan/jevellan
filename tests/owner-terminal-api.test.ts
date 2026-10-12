import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { OwnerCommandReceiptViewSchema, OwnerCommandRunReceiptSchema, TerminalOutputFrameSchema, TerminalSnapshotSchema, TerminalTicketSchema } from '../packages/core/dist/index.js';
import { projectFixture, projectMember, reportStep, type ProjectFixture } from './helpers/project-fixture.js';
import { start, rest } from './helpers/attach-cli.js';

let fixture: ProjectFixture | undefined; const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await fixture?.close(); fixture = undefined; });
const empty = { schema: 'empty-request-v1' };
const waiting = async (fn: () => boolean, timeout = 7000) => { const until = Date.now() + timeout; while (!fn()) { if (Date.now() >= until) throw new Error('Terminal stream timed out.'); await new Promise(resolve => setTimeout(resolve, 20)); } };
async function connect(f: ProjectFixture, id: string, ticket: string, options: { origin?: string; cookie?: string } = {}) {
  const url = new URL(`/api/terminals/${id}/stream`, f.base); url.protocol = 'ws:'; url.searchParams.set('ticket', ticket);
  const socket = new WebSocket(url, { headers: { Cookie: options.cookie ?? f.cookie, Origin: options.origin ?? f.base } }); sockets.push(socket);
  let output = '', replayed = false; const frames: ReturnType<typeof TerminalOutputFrameSchema.parse>[] = [];
  socket.on('message', raw => { const frame = TerminalOutputFrameSchema.parse(JSON.parse(raw.toString())); frames.push(frame);
    if (frame.type === 'output') output += Buffer.from(frame.data, 'base64').toString('utf8'); if (frame.type === 'replay-end') replayed = true; });
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  await waiting(() => replayed);
  return { socket, frames, output: () => output, write: (text: string) => socket.send(JSON.stringify({ schema: 'terminal-frame-v1', type: 'input', data: Buffer.from(text).toString('base64') })) };
}
async function fresh(f: ProjectFixture, input: { deviceId?: string; cwd?: string } = {}) {
  return f.json('/api/terminals', TerminalTicketSchema, 'POST', { schema: 'terminal-create-request-v1', clientRequestId: `terminal_api_${Date.now()}`,
    projectId: f.project.id, cwd: 'checkout', takeover: false, ...input });
}
test('owner HTTP creates in the project, live websocket input works, one-use tickets bind to the session, and replay survives reload', async () => {
  const f = fixture = await projectFixture(), opened = await fresh(f); expect(opened.session.cwd).toBe(f.checkout);
  const stream = await connect(f, opened.session.id, opened.ticket); stream.write('printf terminal-live\\n\r'); await waiting(() => stream.output().includes('terminal-live'));
  stream.write('pwd\r'); await waiting(() => stream.output().includes(f.checkout));
  const refused = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/terminals/${opened.session.id}/stream?ticket=${opened.ticket}`, { headers: { Cookie: f.cookie, Origin: f.base } }); sockets.push(refused);
  expect(await new Promise<number>(resolve => { refused.on('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); }); refused.on('error', () => {}); })).toBe(401);
  stream.socket.close(); await waiting(() => stream.socket.readyState === WebSocket.CLOSED);
  expect(f.app.terminals.manager.session(opened.session.id).status).toBe('open');
  const ticket = await f.json(`/api/terminals/${opened.session.id}/ticket`, TerminalTicketSchema, 'POST', empty), again = await connect(f, opened.session.id, ticket.ticket);
  expect(again.output()).toContain('terminal-live'); again.write('false\r'); await waiting(() => f.app.terminals.manager.snapshot(opened.session.id).commands.some(row => row.command === 'false' && row.exitCode === 1));
  const snapshot = await f.json(`/api/terminals/${opened.session.id}`, TerminalSnapshotSchema); expect(snapshot.commands.at(-1)).toMatchObject({ command: 'false', exitCode: 1 });
  await f.request(`/api/terminals/${opened.session.id}/close`, 'POST', empty); await waiting(() => again.frames.some(frame => frame.type === 'closed'));
}, 30_000);
test('unauthenticated and cross-origin connections are refused, and tickets expire and cannot cross terminals', async () => {
  const f = fixture = await projectFixture(), opened = await fresh(f);
  expect((await fetch(`${f.base}/api/terminals`)).status).toBe(401);
  for (const headers of [{ Origin: 'https://outside.example.invalid', Cookie: f.cookie }, { Origin: f.base, Cookie: '' }]) {
    const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/terminals/${opened.session.id}/stream?ticket=${opened.ticket}`, { headers }); sockets.push(ws);
    const status = await new Promise<number>(resolve => { ws.once('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); }); ws.on('error', () => {}); });
    expect([401, 403]).toContain(status);
  }
  const token = f.cookie.split('=')[1]!.split(';')[0]!, bound = f.app.terminals.ticket(opened.session, token);
  expect(() => f.app.terminals.consumeTicket('term_other', bound.ticket, token)).toThrow('expired');
  const valid = f.app.terminals.ticket(opened.session, token), { vi } = await import('vitest'); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  expect(() => f.app.terminals.consumeTicket(opened.session.id, valid.ticket, token)).toThrow('expired'); vi.restoreAllMocks();
});
test('a hub browser relays input and replay to a member PTY; agent reads are scoped and contain no internal tokens', async () => {
  const f = fixture = await projectFixture({ coordinator: true }), member = await projectMember(f), opened = await fresh(f, { deviceId: member.deviceId });
  expect(opened.session.deviceId).toBe(member.deviceId); expect(opened.session.cwd).toBe(member.checkout);
  const stream = await connect(f, opened.session.id, opened.ticket); stream.write("printf 'mesh-terminal\\n'; pwd\r"); await waiting(() => stream.output().includes('mesh-terminal') && stream.output().includes(member.checkout));
  await waiting(() => member.app.terminals.manager.snapshot(opened.session.id).commands.some(row => row.endedAt !== null)); await member.app.terminals.manager.flush();
  const projectId = f.project.id; await f.app.projectWork.coordinators.ensureAssigned(projectId);
  const read = await f.app.terminals.read({ kind: 'coordinator', projectId }, { action: 'commands', sessionId: opened.session.id, last: 5 });
  expect(read.schema).toBe('terminal-commands-v1'); expect(JSON.stringify(read)).toContain('mesh-terminal'); expect(JSON.stringify(read)).not.toContain('\\u001b'); expect(JSON.stringify(read)).not.toContain('133;C');
  const local = await f.app.terminals.manager.create({ requestId: 'owner_home', fingerprint: 'owner_home', cwd: f.homes.userHome, title: 'Home' });
  await expect(f.app.terminals.read({ kind: 'coordinator', projectId }, { action: 'tail', sessionId: local.id })).rejects.toThrow('outside');
  stream.socket.close(); await waiting(() => stream.socket.readyState === WebSocket.CLOSED); const ticket = await f.json(`/api/terminals/${opened.session.id}/ticket`, TerminalTicketSchema, 'POST', empty);
  expect((await connect(f, opened.session.id, ticket.ticket)).output()).toContain('mesh-terminal');
  await f.request(`/api/terminals/${opened.session.id}/close`, 'POST', empty);
  const closed = await f.json(`/api/terminals/${opened.session.id}`, TerminalSnapshotSchema); expect(closed.session.status).toBe('closed'); expect(closed.tail).toContain('mesh-terminal');
}, 30_000);
test('Run in Terminal has a durable receipt, sends the result to its requesting thread, and Send to retries deliver once', async () => {
  const f = fixture = await projectFixture(); f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'The owner runs the setup.' }));
  const threadId = await start(f, 'Owner setup', 'A reserved owner action.', 'fixture'); await rest(f, threadId);
  f.fake.enqueueTurn(async turn => { expect(turn.input.prompt).toContain('Exit code: 0'); expect(turn.input.prompt).toContain('owner-command-output'); return reportStep({ status: 'progress', summary: 'Continued from the owner result.' })(turn); });
  const command = { command: "printf 'owner-command-output\\n'", why: 'Owner setup', cwd: 'worktree' }, input = { projectId: f.project.id, threadId, command };
  const receipt = await f.json('/api/terminals/owner-command', OwnerCommandRunReceiptSchema, 'POST', { schema: 'owner-command-run-request-v1', clientRequestId: 'owner_http_result', ...input });
  await waiting(() => f.fake.turnStarts.length === 2); await rest(f, threadId);
  const view = await f.json('/api/terminals/owner-command/receipt', OwnerCommandReceiptViewSchema, 'POST', { schema: 'owner-command-receipt-request-v1', ...input }); expect(view.receipt).toEqual(receipt);
  expect(f.app.terminals.manager.session(receipt.terminalId).cwd).toBe(f.thread(threadId).cwd);
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Received terminal output.' }));
  const send = { schema: 'terminal-send-request-v1', clientMessageId: 'send_once', target: { kind: 'thread', threadId }, content: 'last' };
  expect((await f.request(`/api/terminals/${receipt.terminalId}/send`, 'POST', send)).ok).toBe(true); await rest(f, threadId);
  expect((await f.request(`/api/terminals/${receipt.terminalId}/send`, 'POST', send)).ok).toBe(true); await f.app.projectWork.idle(f.project.id); expect(f.fake.turnStarts).toHaveLength(3);
}, 30_000);
