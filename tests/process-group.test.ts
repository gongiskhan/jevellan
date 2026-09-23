import { expect, test } from 'vitest';
import { once } from 'node:events';
import { spawnGroup, terminateGroup, groupAlive } from '../packages/runtime-contract/dist/index.js';

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
