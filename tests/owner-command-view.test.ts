import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerCommandScope } from '../apps/web/lib/owner-commands.js';
import { afterEach, expect, test, vi } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { UiAuth } from '../packages/mesh/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });
const command = { command: 'printf fixture', why: 'Inspect the simulated fixture.', cwd: 'checkout' };

test('shared owner-command presentation preserves scope precedence, copy-only prompts and exact shell fences', () => {
  expect(core.ownerCommandPresentation).toBeTypeOf('function');
  const parent = { projectId: 'project', deviceId: 'device_parent', cwd: 'checkout' as const };
  expect(core.mergeOwnerCommandScope(parent, { threadId: 'thread_one' }, 'device_thread')).toMatchObject({ deviceId: 'device_thread', threadId: 'thread_one', projectId: 'project' });
  expect(core.mergeOwnerCommandScope(parent, { threadId: 'thread_one', deviceId: 'device_explicit' }, 'device_thread').deviceId).toBe('device_explicit');
  expect(core.mergeOwnerCommandScope(parent, { threadId: 'thread_one', deviceId: undefined }, 'device_thread').deviceId).toBe('device_parent');
  const receipt = { schema: 'owner-command-run-receipt-v1' as const, terminalId: 'term_fixture', deviceId: 'device_one', deviceName: 'Fixture device', at: '2026-10-21T12:00:00.000Z' };
  expect(core.ownerCommandPresentation(command, { deviceId: 'device_one', deviceName: 'Fixture device', receipt })).toMatchObject({ schema: 'owner-command-presentation-v1', header: 'Fixture device · checkout', copyOnly: false, receiptPath: '/terminals/term_fixture', copyLabel: 'Copy', runLabel: 'Run in Terminal' });
  expect(core.ownerCommandPresentation({ ...command, kind: 'prompt' }, { deviceId: 'device_one', deviceName: 'Fixture device', receipt })).toMatchObject({ header: 'Paste into the Claude app on Fixture device', copyOnly: true, receipt: null, receiptPath: null });
  expect(core.ownerCommandPresentation({ ...command, kind: 'prompt' }, {}).header).toBe('Paste into the Claude app on the session device');
  for (const language of ['bash', 'sh', 'zsh', 'shell', 'console']) expect(core.isOwnerShellFence(`language-${language}`)).toBe(true);
  expect(core.isOwnerShellFence('language-js')).toBe(false); expect(core.isOwnerShellFence(undefined)).toBe(false);
  expect(core.shellOwnerCommand('printf fixture\n\n', 'worktree')).toMatchObject({ command: 'printf fixture\n', why: 'Run the command from this session.', cwd: 'worktree' });
});

test('owner-command read models use normal receipt authority without starting a terminal or provider turn', async () => {
  f = await projectFixture(); const before = f.app.terminals.manager.list().length;
  const writer = vi.spyOn(f.app.terminals, 'ownerCommand');
  const request = { schema: 'owner-command-view-request-v1', projectId: 'project', scopeDeviceId: f.app.device.deviceId, command };
  const response = await f.request('/api/terminals/owner-command/view', 'POST', request); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'owner-command-view-v1', projectId: 'project', presentation: { schema: 'owner-command-presentation-v1', header: `${f.app.device.name} · checkout`, copyOnly: false, receipt: null, receiptPath: null } });
  const auth = f.app.auth; if (!(auth instanceof UiAuth)) throw Error('Expected fixture state-point authority.');
  const issue = vi.spyOn(auth, 'issue'), logout = vi.spyOn(auth, 'logout');
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'owner_command_view', args: { project: 'project', command, device: f.app.device.deviceId } })).toMatchObject({ ok: true, data: view });
  expect(logout.mock.calls.length).toBe(issue.mock.calls.length); expect(issue).toHaveBeenCalledTimes(1);
  const receipt = vi.spyOn(f.app.terminals, 'commandReceipt');
  const prompt = await f.request('/api/terminals/owner-command/view', 'POST', { ...request, command: { ...command, kind: 'prompt' } }); expect(prompt.status).toBe(200); expect((await prompt.json()).presentation).toMatchObject({ copyOnly: true, receipt: null }); expect(receipt).not.toHaveBeenCalled();
  expect(writer).not.toHaveBeenCalled(); expect(f.app.terminals.manager.list()).toHaveLength(before); expect(f.fake.runs).toHaveLength(0);
});


test('explicit command scope devices never invoke the unused thread lookup', () => {
  const lookup = vi.fn(() => { throw Error('An explicit device must not look up the thread.'); });
  const tree = createElement(OwnerCommandScope, { value: { projectId: 'project', cwd: 'checkout', deviceId: 'device_parent', deviceForThread: lookup }, children:
    createElement(OwnerCommandScope, { value: { threadId: 'thread_not_loaded', deviceId: 'device_explicit' }, children: createElement('span', null, 'Scoped command') }) });
  expect(() => renderToStaticMarkup(tree)).not.toThrow(); expect(lookup).not.toHaveBeenCalled();
});
