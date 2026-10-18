import { expect, test, vi } from 'vitest';
import { once } from 'node:events';
import { spawnGroup, terminateGroup, groupAlive } from '../packages/runtime-contract/dist/index.js';
import { rememberProcessTree } from '../packages/core/dist/index.js';

test('a transient signal permission refusal still requires fresh confirmation that the owned process exited', async () => {
  const { child, native } = await spawnGroup(process.execPath, ['-e', 'console.log("ready"); process.stdin.once("data", () => setTimeout(() => process.exit(0), 50)); process.stdin.resume()'], { cwd: process.cwd(), env: {} });
  const kill = process.kill.bind(process); let denied = 0;
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if ((pid === native.pid || pid === -native.pgid) && signal !== 0) { if (denied++ === 0) child.stdin.end('exit'); throw Object.assign(new Error('Signal refused.'), { code: 'EPERM' }); }
    return kill(pid, signal);
  });
  try {
    await once(child.stdout, 'data');
    await terminateGroup(native, 2_000);
    expect(denied).toBeGreaterThan(0); expect(groupAlive(native.pgid)).toBe(false);
  } finally { spy.mockRestore(); await terminateGroup(native, 100); }
});

test('a persistent signal permission refusal cannot claim termination of a live owned process', async () => {
  const { child, native } = await spawnGroup(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { cwd: process.cwd(), env: {} });
  const kill = process.kill.bind(process);
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if ((pid === native.pid || pid === -native.pgid) && signal !== 0) throw Object.assign(new Error('Signal refused.'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  try {
    await once(child.stdout, 'data');
    await expect(terminateGroup(native, 10)).rejects.toThrow('Runtime descendant termination could not be confirmed.');
    expect(groupAlive(native.pgid)).toBe(true);
  } finally { spy.mockRestore(); await terminateGroup(native, 100); }
});

test('a recovered signal permission allows graceful termination before escalation', async () => {
  const { child, native } = await spawnGroup(process.execPath, ['-e', 'process.on("SIGTERM", () => { console.log("graceful"); process.exit(0) }); console.log("ready"); setInterval(() => {}, 1000)'], { cwd: process.cwd(), env: {} });
  const kill = process.kill.bind(process); let denied = 0, output = '';
  child.stdout.on('data', data => { output += String(data); });
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if ((pid === native.pid || pid === -native.pgid) && signal === 'SIGTERM' && denied < 2) { denied++; throw Object.assign(new Error('Signal refused.'), { code: 'EPERM' }); }
    return kill(pid, signal);
  });
  try {
    await once(child.stdout, 'data'); await terminateGroup(native, 1_000);
    expect(denied).toBe(2); expect(output).toContain('graceful'); expect(groupAlive(native.pgid)).toBe(false);
  } finally { spy.mockRestore(); await terminateGroup(native, 100); }
});

test('termination waits for the group, including a descendant that ignores SIGTERM', async () => {
  const program = `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    process.on('SIGTERM', () => {});
    descendant.stdout.once('data', () => console.log('ready'));
    setInterval(() => {}, 1000);
  `;
  const { child, native } = await spawnGroup(process.execPath, ['-e', program], { cwd: process.cwd(), env: {} });
  try {
    await once(child.stdout, 'data');
    expect(groupAlive(native.pgid)).toBe(true);
    await terminateGroup(native, 100);
    expect(groupAlive(native.pgid)).toBe(false);
  } finally { await terminateGroup(native, 100); }
});

test('a failed launch rejects instead of inventing a native process identity', async () => {
  await expect(spawnGroup('/no/such/jevellan-runtime', [], { cwd: process.cwd(), env: {} })).rejects.toThrow();
});

test('termination refuses the daemon and invalid group identities', async () => {
  await expect(terminateGroup({ pid: process.pid, pgid: process.pid })).rejects.toThrow('unowned');
  await expect(terminateGroup({ pid: 1, pgid: 1 })).rejects.toThrow('unowned');
  await expect(terminateGroup({ pid: 1234, pgid: 5678 })).rejects.toThrow('unowned');
});

test('termination also removes a descendant that starts its own process group', async () => {
  const program = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], {detached: true, stdio:['ignore','pipe','ignore']}); child.stdout.once('data', () => console.log(child.pid)); setInterval(() => {}, 1000);`;
  const { child, native } = await spawnGroup(process.execPath, ['-e', program], { cwd: process.cwd(), env: {} });
  let descendant: number | undefined;
  try {
    const [data] = await once(child.stdout, 'data'); descendant = Number(String(data).trim());
    expect(Number.isSafeInteger(descendant)).toBe(true); expect(groupAlive(descendant)).toBe(true);
    await terminateGroup(native, 100);
    expect(groupAlive(native.pgid)).toBe(false); expect(groupAlive(descendant)).toBe(false);
  } finally {
    await terminateGroup(native, 100);
    if (descendant && groupAlive(descendant)) process.kill(-descendant, 'SIGKILL');
  }
});

test('a reused native identity is refused without signalling the unrelated process', async () => {
  const { child, native } = await spawnGroup(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { cwd: process.cwd(), env: {} });
  try {
    await once(child.stdout, 'data');
    await expect(terminateGroup({ ...native, startIdentity: 'an earlier process' }, 100)).rejects.toThrow('reused');
    expect(groupAlive(native.pgid)).toBe(true);
  } finally { await terminateGroup(native, 100); }
});

test('termination and process-tree snapshots read the process table without blocking the event loop', async () => {
  // A synchronous ps over every process stalled the daemon's HTTP answers for seconds on a busy machine.
  const { child, native } = await spawnGroup(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { cwd: process.cwd(), env: {} });
  const order: string[] = [];
  try {
    await once(child.stdout, 'data');
    setImmediate(() => order.push('timer before the snapshot'));
    const snapshot = rememberProcessTree(native); order.push('snapshot call returned');
    await snapshot; order.push('snapshot done');
    expect(order).toEqual(['snapshot call returned', 'timer before the snapshot', 'snapshot done']);
    order.length = 0;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => { order.push(`signal ${String(signal)}`); kill.mockRestore(); return process.kill(pid, signal); });
    setImmediate(() => order.push('timer before the first signal'));
    await terminateGroup(native, 1000);
    expect(order.slice(0, 2)).toEqual(['timer before the first signal', 'signal SIGTERM']);
  } finally { vi.restoreAllMocks(); await terminateGroup(native, 100); }
});
