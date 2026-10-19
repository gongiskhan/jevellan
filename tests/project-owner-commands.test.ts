// Simulated providers; real hook subprocesses, disposable paths, Git, HTTP and hub persistence.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AskUserInputSchema, DeviceSchema, DeviceViewSchema, OwnerCommandSchema, ProjectDecisionSchema, ThreadReportInputSchema, type ProjectDecision } from '../packages/core/dist/index.js';
import { claudePermissionHook, fileWriteDenial, ownerCommandDenial, safetyDenial, THREAD_SAFETY_REASON } from '../packages/runtime-contract/dist/index.js';
import { DecisionItems } from '../packages/projects/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture, type ProjectMember } from './helpers/project-fixture.js';

let root: string; let f: ProjectFixture | undefined; let member: ProjectMember | undefined;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-owner-command-'))); for (const path of ['worktree', 'checkout', 'reserved']) mkdirSync(join(root, path)); symlinkSync(join(root, 'reserved'), join(root, 'worktree', 'linked')); });
afterEach(async () => { member = undefined; await f?.close(); f = undefined; rmSync(root, { recursive: true, force: true }); });
const context = () => ({ cwd: join(root, 'worktree'), daemonPid: 41999, profile: 'thread' as const, protectedPaths: [join(root, 'checkout'), join(root, 'reserved')] });
const reason = () => ownerCommandDenial(`A worktree thread cannot act inside a registered checkout or protected path. ${THREAD_SAFETY_REASON}`);
const command = { kind: 'shell' as const, command: 'scripts/owner-only.sh', why: 'The project reserves this step for the owner.', cwd: 'worktree' };

test('owner commands validate exact text, five-command limits and supported folders for every report status', () => {
  for (const cwd of ['worktree', 'checkout', 'home', '/tmp/folder with spaces']) expect(OwnerCommandSchema.parse({ ...command, cwd }).cwd).toBe(cwd);
  for (const cwd of ['relative/path', '/tmp/bad\nfolder', '']) expect(OwnerCommandSchema.safeParse({ ...command, cwd }).success).toBe(false);
  for (const change of [{ command: 'x'.repeat(4001) }, { why: 'x'.repeat(301) }]) expect(OwnerCommandSchema.safeParse({ ...command, ...change }).success).toBe(false);
  for (const status of ['progress', 'done', 'blocked', 'needs-decision'] as const) {
    const report = { status, summary: 'Run the reserved script.', ...(status === 'needs-decision' ? { question: 'Run this?' } : {}), ownerCommands: [command] };
    expect(ThreadReportInputSchema.parse(report).ownerCommands).toEqual([command]);
    expect(ThreadReportInputSchema.safeParse({ ...report, ownerCommands: Array(6).fill(command) }).success).toBe(false);
  }
  expect(AskUserInputSchema.parse({ question: 'Sign in?', ownerCommands: [command] }).ownerCommands).toEqual([command]);
});
test('coordinator questions and the thread fallback retain owner commands and retry one stored question', async () => {
  const rows = new Map<string, ProjectDecision>();
  const items = new DecisionItems({ hub: { createDecision: async (raw: ProjectDecision) => { const decision = ProjectDecisionSchema.parse(raw); rows.set(decision.id, decision); return { document: decision, revision: 1 }; },
    decision: async (id: string) => { const document = rows.get(id); return document ? { document, revision: 1 } : null; } } as never,
    threads: () => ({}) as never, toCoordinator: async () => undefined });
  const input = AskUserInputSchema.parse({ question: 'Sign in?', threadId: 'thread_one', ownerCommands: [command] });
  await items.ask('project', input, 'coordinator', 'question_one'); await items.ask('project', input, 'coordinator', 'question_one');
  await items.fromReport('project', 'thread_one', { summary: 'Owner step.', ownerCommands: [command] });
  expect([...rows.values()]).toHaveLength(2); for (const decision of rows.values()) expect(decision).toMatchObject({ threadId: 'thread_one', ownerCommands: [command] });
});
test.each([
  'git -C ../checkout status', 'git -C../checkout diff', 'git --work-tree=../checkout status', 'git --git-dir ../checkout/.git status',
  'cd ../checkout && git status', 'cd ../reserved; git diff', 'bash -lc "git -C ../checkout log"',
  'printf value > ../reserved/new.txt', 'printf value >>../reserved/new.txt', 'touch ../checkout/new.txt',
  'cp source ../reserved/new.txt', 'cp -t ../reserved source', 'cp --target-directory=../reserved source', 'mv ../reserved/old.txt local',
  'tee ../reserved/new.txt', "sed -i '' s/a/b/ ../reserved/file", 'chmod 600 ../reserved/file', 'git -C linked status', 'touch linked/not-yet-existing/file',
])('both provider hooks refuse another checkout or protected target: %s', async command => {
  const ctx = context(); const input = { tool_name: 'Bash', tool_input: { command } };
  expect(safetyDenial(command, ctx)).not.toBeNull();
  expect(await claudePermissionHook({ ...ctx, permissions: 'write' })(input)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason() } });
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../runtimes/codex/dist/safety-hook.js', import.meta.url)), JSON.stringify(ctx)], { input: JSON.stringify({ hook_event_name: 'PreToolUse', ...input }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  expect(JSON.parse(output)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason() } });
});
test.each(['Write', 'Edit', 'NotebookEdit', 'apply_patch'])('file tools resolve protected symlinks and new paths: %s', async tool => {
  const ctx = context(); const path = join(ctx.cwd, 'linked', 'new.txt');
  const input = tool === 'apply_patch' ? `*** Begin Patch\n*** Add File: ${path}\n+changed\n*** End Patch` : tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path };
  expect(fileWriteDenial(tool, input, ctx)).not.toBeNull();
  expect(await claudePermissionHook({ ...ctx, permissions: 'write' })({ tool_name: tool, tool_input: input })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});
test('ordinary worktree edits and reads stay available, and a similar prefix is not protected', () => {
  for (const command of ['npm test', 'git status', 'git add -A', 'git commit -m change', 'touch local.txt', 'cat ../reserved/file', 'cp ../reserved/file local', 'touch ../reserved-other/file']) expect(safetyDenial(command, context()), command).toBeNull();
  expect(fileWriteDenial('Write', { file_path: 'local.txt' }, context())).toBeNull();
  expect(fileWriteDenial('apply_patch', '*** Begin Patch\n*** Update File: local.txt\n@@\n-a\n+b\n*** End Patch', context())).toBeNull();
  expect(safetyDenial('git -C ../checkout status', { ...context(), profile: 'stretch' })).toBeNull();
});
test('owner protected paths persist through heartbeat and settings relays; device credentials cannot edit them', async () => {
  f = await projectFixture(); const deviceId = f.app.device.deviceId;
  const saved = await f.json('/hub/devices/settings', DeviceViewSchema, 'POST', { schema: 'device-settings-input-v1', deviceId, protectedPaths: [join(root, 'reserved')] });
  expect(saved.device.protectedPaths).toEqual([join(root, 'reserved')]); await f.app.presence.pulse();
  expect((await f.app.roster()).devices.find(row => row.device.id === deviceId)?.device.protectedPaths).toEqual(saved.device.protectedPaths);
  expect((await f.request('/hub/devices/settings', 'POST', { schema: 'device-settings-input-v1', deviceId, protectedPaths: Array(21).fill('/tmp/folder') })).status).toBe(400);
  const refused = await fetch(`${f.base}/hub/devices/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'device-settings-input-v1', deviceId, protectedPaths: [] }) }); expect(refused.status).toBe(401);
  member = await projectMember(f);
  expect((await member.request('/hub/devices/settings', 'POST', { schema: 'device-settings-input-v1', deviceId: member.deviceId, protectedPaths: ['/srv/member-owner-checkout'] })).status).toBe(200);
  await member.heartbeat(); expect(f.app.hub.get('devices', member.deviceId, DeviceSchema)?.document.protectedPaths).toEqual(['/srv/member-owner-checkout']);
});
test('registering the dedicated Madrid Ekoa binding adds the owner checkout protection without replacing existing paths', async () => {
  f = await projectFixture(); const deviceId = f.app.device.deviceId; const row = f.app.hub.get('devices', deviceId, DeviceSchema)!;
  f.app.hub.put('devices', deviceId, DeviceSchema, { ...row.document, os: 'linux', protectedPaths: ['/srv/keep'] }, row.revision);
  await f.app.state.projects.put({ ...f.project, id: 'ekoa', remoteUrl: 'https://github.com/gongiskhan/ekoa-code.git', paths: { [deviceId]: '/home/ggomes/jevellan-projects/ekoa-code' } }, 0);
  expect(f.app.hub.get('devices', deviceId, DeviceSchema)?.document.protectedPaths).toEqual(['/srv/keep', '/home/ggomes/dev/ekoa-code']);
  const current = f.app.hub.get('devices', deviceId, DeviceSchema)!;
  f.app.hub.put('devices', deviceId, DeviceSchema, { ...current.document, protectedPaths: Array.from({ length: 20 }, (_, index) => `/srv/keep-${index}`) }, current.revision);
  const project = { ...f.project, id: 'ekoa_overflow', remoteUrl: 'https://github.com/gongiskhan/ekoa-code.git', paths: { [deviceId]: '/home/ggomes/jevellan-projects/ekoa-code' } };
  expect(() => f!.app.state.projects.put(project, 0)).toThrow('20 protected paths');
  expect(f.app.state.projects.get(project.id)).toBeNull();
});
