import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DaemonOwnership, Homes } from '../packages/core/dist/index.js';
import { Application } from '../apps/daemon/dist/application.js';

let root: string; let homes: Homes; const leases: DaemonOwnership[] = []; const children: ChildProcessWithoutNullStreams[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-owner-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); });
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; }
  for (const lease of leases.splice(0)) lease.close(); rmSync(root, { recursive: true, force: true });
});
const moduleUrl = new URL('../packages/core/dist/index.js', import.meta.url).href;
test('a live owner is exclusive even inside the same process; release permits a new daemon', () => {
  const first = new DaemonOwnership(homes); leases.push(first);
  expect(() => new DaemonOwnership(homes)).toThrow('already owns'); first.assert(); first.close();
  const next = new DaemonOwnership(homes); leases.push(next); next.assert(); expect(() => first.assert()).toThrow('closed');
});
test('an exited daemon leaves durable ownership that startup can reclaim without a lease timeout', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { Homes, DaemonOwnership } from ${JSON.stringify(moduleUrl)}; new DaemonOwnership(new Homes(process.argv[1], process.argv[2]));`, homes.root, homes.userHome], { stdio: 'ignore' });
  const recovered = new DaemonOwnership(homes); leases.push(recovered); recovered.assert();
});
test('two actual daemon processes racing for the same home produce exactly one owner', async () => {
  const program = `import { Homes, DaemonOwnership } from ${JSON.stringify(moduleUrl)}; try { const owner = new DaemonOwnership(new Homes(process.argv[1], process.argv[2])); console.log('owned'); process.stdin.resume(); process.stdin.once('data',()=>{owner.close(); process.exit(0);}); } catch { console.log('busy'); process.exit(0); }`;
  const launch = async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, homes.root, homes.userHome], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    const [data] = await once(child.stdout, 'data'); return String(data).trim();
  };
  const outcomes = await Promise.all([launch(), launch()]); expect(outcomes.sort()).toEqual(['busy', 'owned']);
});
test('a reused PID does not pin an old owner, and its stale token cannot release the replacement', () => {
  const first = new DaemonOwnership(homes);
  const db = new DatabaseSync(homes.at('locks', 'daemon.db'));
  try {
    const row = db.prepare('SELECT document FROM owner WHERE id=1').get()!; const stale = JSON.parse(String(row.document)); stale.startIdentity = 'previous process';
    db.prepare('UPDATE owner SET document=? WHERE id=1').run(JSON.stringify(stale));
  } finally { db.close(); }
  const next = new DaemonOwnership(homes); leases.push(next);
  expect(() => first.close()).toThrow('lost'); next.assert();
});
test('the application retains its home until shutdown and releases it after initialization failure', async () => {
  const app = new Application({ homes, timers: false, runtimes: () => new Map() });
  try { expect(() => new Application({ homes, timers: false })).toThrow('already owns'); }
  finally { await app.close(); }
  writeFileSync(homes.at('device.json'), '{"schema":"invalid"}');
  expect(() => new Application({ homes, timers: false })).toThrow();
  const recovered = new DaemonOwnership(homes); leases.push(recovered); recovered.assert();
});
