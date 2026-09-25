import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Homes, LifecycleGate, lifecycleActivity } from '../packages/core/dist/index.js';
import { startDaemon } from '../apps/daemon/dist/index.js';

const roots: string[] = [], gates: LifecycleGate[] = [], releases: (() => void)[] = [], children: ChildProcessWithoutNullStreams[] = [];
const daemons: Awaited<ReturnType<typeof startDaemon>>[] = [];
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'close'); child.kill('SIGTERM'); await done; }
  await Promise.all(daemons.splice(0).map(daemon => daemon.close()));
  gates.splice(0).forEach(gate => gate.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-lifecycle-'))); roots.push(root); mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'data'), join(root, 'user'));
  const gate = () => { const value = new LifecycleGate(homes); gates.push(value); return value; };
  return { homes, gate };
}
test('maintenance waits for all admitted work, then excludes new work until released', () => {
  const { homes, gate } = fixture(), daemon = gate(), installer = gate();
  const first = daemon.enter({ kind: 'conversation', id: 'conversation_1', title: 'Active work' }); releases.push(first);
  const request = daemon.enter({ kind: 'request' }); releases.push(request);
  expect(installer.tryMaintenance()).toBeNull(); expect(lifecycleActivity(homes)).toHaveLength(2);
  first(); first(); expect(installer.tryMaintenance()).toBeNull(); request();
  const maintenance = installer.tryMaintenance()!; releases.push(maintenance); expect(maintenance).toBeTypeOf('function');
  expect(() => daemon.enter({ kind: 'conversation', id: 'conversation_2' })).toThrow('being updated');
  expect(lifecycleActivity(homes)).toEqual([]); maintenance();
  const after = daemon.enter({ kind: 'conversation', id: 'conversation_2' }); releases.push(after); after();
});

test.each(['work', 'maintenance'] as const)('an exited process releases its %s lock without a stale timeout', async mode => {
  const { homes, gate } = fixture(); const observer = gate();
  const module = new URL('../packages/core/dist/index.js', import.meta.url).href;
  const program = `import { Homes, LifecycleGate } from ${JSON.stringify(module)}; const gate = new LifecycleGate(new Homes(process.argv[1], process.argv[2])); ${mode === 'work' ? 'gate.enter({kind:"conversation",id:"active"});' : 'if(!gate.tryMaintenance()) throw new Error("busy");'} console.log('held'); process.stdin.resume();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, homes.root, homes.userHome], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  expect(String((await once(child.stdout, 'data'))[0]).trim()).toBe('held'); expect(observer.tryMaintenance()).toBeNull();
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  const maintenance = observer.tryMaintenance()!; releases.push(maintenance); expect(maintenance).toBeTypeOf('function'); maintenance();
});

test('the daemon refuses a mutation before it changes state while an installer holds maintenance', async () => {
  const { homes, gate } = fixture(); const daemon = await startDaemon(0, { homes, timers: false, runtimes: () => new Map(), tailscaleAddress: async () => null }); daemons.push(daemon);
  await daemon.application.conversations.ready; const installer = gate(), release = installer.tryMaintenance()!; releases.push(release);
  const response = await fetch(`${daemon.addresses[0]}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'disposable fixture phrase' }) });
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ message: expect.stringContaining('being updated') });
  const before = await fetch(`${daemon.addresses[0]}/api/auth`); expect(await before.json()).toMatchObject({ configured: false });
  release();
  const after = await fetch(`${daemon.addresses[0]}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'disposable fixture phrase' }) });
  expect(after.status).toBe(200);
});
