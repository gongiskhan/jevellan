import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

// The browser fixture server (scripts/test-server.mjs) as Playwright stops it: `gracefulShutdown` signals the server's whole
// process group, then kills the group if it has not exited within 15 seconds. A server whose close fails or is killed leaves
// its temporary root behind (D320).

const started: { launcher: ChildProcess; tmp: string }[] = [];
afterEach(() => {
  for (const { launcher, tmp } of started.splice(0)) {
    try { process.kill(-launcher.pid!, 'SIGKILL'); } catch { /* already gone */ }
    for (const row of processes()) if (row.ppid === launcher.pid) try { process.kill(-row.pgid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(tmp, { recursive: true, force: true });
  }
});

function processes() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) }] : [];
  });
}
const free = (port: number) => new Promise<boolean>((resolve) => {
  const probe = createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});
/** A port whose server, member (+100) and control (+200) ports are free, away from the browser matrix (19771 and up). */
async function ports(): Promise<number> {
  for (let port = 23_000 + (process.pid % 400); port < 23_800; port++) if ((await Promise.all([port, port + 100, port + 200].map(free))).every(Boolean)) return port;
  throw new Error('No free fixture ports.');
}
const until = async (check: () => boolean | Promise<boolean>, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`); await new Promise((resolve) => setTimeout(resolve, 100)); }
};

/**
 * Starts the fixture server in a process group of its own, as Playwright's shell does, with a private temporary folder, and
 * waits until it is ready (its control listener binds after all seeding) or, with `ready: false`, until it has its root.
 */
async function start({ ready = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'jevellan-fixture-close-')); const port = await ports();
  const launcher = spawn(process.execPath, ['scripts/test-server.mjs', '--port', String(port)], { detached: true, env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'ignore', 'pipe'] });
  started.push({ launcher, tmp });
  let stderr = ''; launcher.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => launcher.once('exit', (code) => resolve(code)));
  if (ready) await until(async () => !(await free(port + 200)), 60_000, 'the fixture server');
  else await until(() => readdirSync(tmp).length > 0, 30_000, 'the temporary root');
  expect(readdirSync(tmp)).toHaveLength(1);
  return { launcher, tmp, port, exited, stderr: () => stderr };
}
const released = async (port: number) => (await Promise.all([port, port + 100, port + 200].map(free))).every(Boolean);

test('a fixture server stopped by a signal to its process group runs its own group, closes cleanly and removes its root', async () => {
  const server = await start();
  // The server process runs in a group of its own, so the group signal reaches neither it nor its git, ps or provider processes;
  // its launcher passes the signal on to the server process alone.
  const child = processes().find((row) => row.ppid === server.launcher.pid);
  expect(child, 'the server runs under its launcher').toBeDefined();
  expect(child!.pgid).toBe(child!.pid); expect(child!.pgid).not.toBe(server.launcher.pid);
  process.kill(-server.launcher.pid!, 'SIGTERM');
  expect(await server.exited).toBe(0);
  expect(server.stderr()).not.toContain('did not complete');
  expect(readdirSync(server.tmp)).toEqual([]);
  expect(await released(server.port)).toBe(true);
}, 90_000);

test('a fixture server whose launcher is killed closes and removes its root, also while it is starting', async () => {
  // Playwright's last resort after its 15 seconds: SIGKILL to the group. The server then closes on its own.
  for (const ready of [true, false]) {
    const server = await start({ ready });
    process.kill(-server.launcher.pid!, 'SIGKILL');
    await server.exited;
    await until(() => readdirSync(server.tmp).length === 0, 40_000, `the temporary root to be removed (ready: ${ready})`);
    await until(() => released(server.port), 30_000, `the ports to be released (ready: ${ready})`);
  }
}, 150_000);
