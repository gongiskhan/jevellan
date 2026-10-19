import { afterEach, expect, test } from 'vitest';
import { DoctorControlSchema, OwnerCommandSchema, doctorControlPath, readDocument } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { forCoordinator } from '../packages/runtime-contract/dist/index.js';
import { projectCommand } from '../packages/cli/dist/project-command.js';
import { vi } from 'vitest';

let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });
test('installation control sends an owner message once with its source label and refuses changed retries', async () => {
  f = await projectFixture({ control: true });
  const control = readDocument(doctorControlPath(f.homes), DoctorControlSchema);
  const input = { schema: 'project-send-request-v1', clientMessageId: 'cli_one', text: 'Which tests run?', via: 'CLI test', waitSeconds: 0 };
  const request = (body: unknown, extra: Record<string, string> = {}) => fetch(`${control.origin}/api/local/projects/project/coordinator/messages`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  expect((await request(input, { Origin: control.origin })).status).toBe(401);
  const first = await request(input); expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ schema: 'project-send-result-v1', projectId: 'project', turn: null, reply: null });
  expect((await request(input)).status).toBe(200);
  expect(f.coordinatorState().queue.filter(event => event.kind === 'user-message')).toMatchObject([{ text: input.text, via: 'CLI test' }]);
  expect((await request({ ...input, text: 'Different work.' })).status).toBe(409);
  expect((await request({ ...input, via: 'Different source' })).status).toBe(409);
});
test('prompt owner commands default old commands to shell and retain prompt intent', () => {
  const old = { command: 'printf ready', cwd: 'home', why: 'Confirm the local step.' };
  expect(OwnerCommandSchema.parse(old)).toMatchObject({ kind: 'shell' });
  expect(OwnerCommandSchema.parse({ ...old, kind: 'prompt' })).toMatchObject({ kind: 'prompt' });
});
test('the installed command waits over local HTTP for the actual coordinator turn reply', async () => {
  f = await projectFixture({ control: true, coordinator: true });
  f.fake.enqueueTurn(async turn => { turn.say('npm test'); return { status: 'completed' }; }, forCoordinator);
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await projectCommand(['send', f.project.name, '--from', 'CLI test', '--wait', '30', '--id', 'wait_one', 'Which tests?'], f.homes)).toBe(0);
  expect(output).toHaveBeenCalledWith('npm test');
  const event = f.app.projectWork.coordinatorLedger('project').events().find(row => row.type === 'coordinator-event');
  expect(event).toBeDefined();
});
test('a prompt is refused by both the owner terminal API and the receiving terminal service', async () => {
  f = await projectFixture();
  const input = { schema: 'owner-command-run-request-v1', clientRequestId: 'prompt_one', projectId: 'project', command: { kind: 'prompt', command: 'Check the local app connection.', cwd: 'home', why: 'Use the Claude app.' } };
  expect((await f.request('/api/terminals/owner-command', 'POST', input)).status).toBe(409);
  await expect(f.app.terminals.local({ schema: 'terminal-peer-request-v1', operation: 'owner-command', input })).rejects.toThrow('Claude app');
});
