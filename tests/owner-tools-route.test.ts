import { afterEach, expect, test } from 'vitest';
import { DoctorControlSchema, doctorControlPath, readDocument, OWNER_TOOLS } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const call = async (name: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const control = readDocument(doctorControlPath(f!.homes), DoctorControlSchema);
  const response = await fetch(`${control.origin}/api/local/tools/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ schema: 'owner-tool-request-v1', caller: 'cli', ...body }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

test('the tool route answers status with text and logs every call, refusing unknown tools, actions and arguments', async () => {
  f = await projectFixture({ control: true });
  const first = await call('status', { args: {} });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ schema: 'owner-tool-result-v1', ok: true });
  expect(String(first.body.text)).toMatch(/^\S+ · coordinator \w+/u);
  expect(String(first.body.text)).toContain('Nothing waiting on you.');
  expect((await call('nothing', { args: {} })).body).toMatchObject({ ok: false, error: { code: 'unknown_tool', text: `There is no tool nothing. Tools: ${OWNER_TOOLS.map(tool => tool.name).join(', ')}.` } });
  expect((await call('work', { action: 'juggle', args: {} })).body).toMatchObject({ ok: false, error: { code: 'unknown_action', text: 'work takes list, add, reorder, cancel, inspect, editor, preview, save, queue_view, task_edit_view, task_draft, task_command.' } });
  expect((await call('status', { args: { section: 'everything' } })).body).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
  expect((await call('status', { args: { project: 'missing' } })).body).toMatchObject({ ok: false, error: { code: 'project_unknown', text: `Which project? Known projects: ${f.project.name}.` } });
  expect((await call('status', { args: {} }, { Origin: 'http://example.test' })).status).toBe(401);
  const log = f.app.ownerTools.callerLog();
  expect(log.map(entry => [entry.tool, entry.action, entry.access, entry.ok, entry.errorCode ?? null])).toEqual([
    ['status', 'status', 'read', true, null], ['status', 'nothing', 'read', false, 'unknown_tool'], ['work', 'juggle', 'read', false, 'unknown_action'],
    ['status', 'status', 'read', false, 'invalid_arguments'], ['status', 'status', 'read', false, 'project_unknown']]);
  expect(log.every(entry => entry.caller === 'cli' && /^[a-f0-9]{64}$/u.test(entry.argsDigest))).toBe(true);
});

test('the status line resolves the project from the working folder and says when there is none', async () => {
  f = await projectFixture({ control: true });
  const control = readDocument(doctorControlPath(f.homes), DoctorControlSchema);
  const line = async (cwd: string) => (await (await fetch(`${control.origin}/api/local/statusline`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'status-line-request-v1', cwd }) })).json() as { text: string }).text;
  expect(await line(f.checkout)).toMatch(new RegExp(`^Jevellan ${f.project.name} · 0 running · 0 queued · 0 waiting`, 'u'));
  expect(await line('/')).toMatch(/^Jevellan /u); // the only project answers anywhere
});

test('the overview board comes from the engine in display order', async () => {
  f = await projectFixture();
  const view = await f.app.projectWork.view('project');
  expect(Object.keys(view.board ?? {})).toEqual(['waiting', 'review', 'working', 'landing', 'landed', 'idle', 'resolved']);
});

test('the recursion guard: every session Jevellan starts carries its role, so the forwarder registers no tools there', async () => {
  const { forCoordinator } = await import('../packages/runtime-contract/dist/index.js');
  f = await projectFixture({ control: true, coordinator: true });
  f.fake.enqueueTurn(async turn => { turn.say('Noted.'); return { status: 'completed' }; }, forCoordinator);
  const control = readDocument(doctorControlPath(f.homes), DoctorControlSchema);
  await fetch(`${control.origin}/api/local/projects/project/coordinator/messages`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'project-send-request-v1', clientMessageId: 'role_one', text: 'Hello.', waitSeconds: 30 }) });
  const coordinatorTurn = f.fake.turnStarts.find(input => input.owner.kind === 'coordinator');
  expect(coordinatorTurn?.launch.env.JEVELLAN_ROLE).toBe('coordinator');
  expect(coordinatorTurn?.launch.mcpServers?.jevellan?.env?.JEVELLAN_ROLE).toBe('coordinator');
});

test('the event stream numbers coordinator events and resumes after a seq', async () => {
  const { forCoordinator } = await import('../packages/runtime-contract/dist/index.js');
  f = await projectFixture({ control: true, coordinator: true });
  f.fake.enqueueTurn(async turn => { turn.say('Working on it.'); return { status: 'completed' }; }, forCoordinator);
  const control = readDocument(doctorControlPath(f.homes), DoctorControlSchema);
  await fetch(`${control.origin}/api/local/projects/project/coordinator/messages`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'project-send-request-v1', clientMessageId: 'events_one', text: 'Status?', waitSeconds: 30 }) });
  const events = f.app.ownerEvents.since(0, 'project');
  expect(events.map(event => [event.source, event.kind])).toContainEqual(['C', 'text']);
  expect(events.find(event => event.kind === 'text')?.text).toBe('Working on it.');
  expect(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq)).toBe(true);
  const controller = new AbortController();
  const said = events.find(event => event.kind === 'text')!; const before = events.filter(event => event.seq < said.seq);
  const response = await fetch(`${control.origin}/api/local/events?project=project&after=${said.seq - 1}`, { headers: { Authorization: `Bearer ${control.token}` }, signal: controller.signal });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const reader = response.body!.getReader(); let text = '';
  while (!text.includes('Working on it.')) text += new TextDecoder().decode((await reader.read()).value);
  for (const event of before) expect(text).not.toContain(`id: ${event.seq}\n`);
  controller.abort();
});

test('a member device forwards owner tool calls to the state point, which resolves folders on that device', async () => {
  const { projectMember } = await import('./helpers/project-fixture.js');
  f = await projectFixture();
  const member = await projectMember(f);
  const result = await member.app.member!.ownerTool({ schema: 'owner-tool-forward-v1', name: 'status', request: { schema: 'owner-tool-request-v1', caller: 'cli', args: {}, cwd: member.checkout } });
  expect(result).toMatchObject({ ok: true }); expect(result.ok && result.text).toMatch(/^\S+ · coordinator /u);
  expect(f.app.ownerTools.callerLog().at(-1)).toMatchObject({ tool: 'status', ok: true, caller: 'cli' });

});
