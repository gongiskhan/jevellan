import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export type NativeProcess = { pid: number; pgid: number; startIdentity?: string; sessionId?: string };
type ProcessIdentity = { pid: number; ppid: number; pgid: number; start: string };
const terminations = new WeakMap<NativeProcess, Promise<void>>();
const descendants = new WeakMap<NativeProcess, Map<number, ProcessIdentity>>();

function ownedProcesses(native: NativeProcess, strictIdentity = true): ProcessIdentity[] {
  const known = descendants.get(native) ?? new Map<number, ProcessIdentity>(); descendants.set(native, known);
  const rows = processTable(); const root = rows.find((row) => row.pid === native.pid);
  const reused = root && native.startIdentity && root.start !== native.startIdentity;
  if (strictIdentity && reused) throw new Error('Refusing to terminate a reused process identity.');
  let alive = rows.filter((row) => (!reused && row.pgid === native.pgid) || known.get(row.pid)?.start === row.start);
  const owned = new Set(alive.map((row) => row.pid));
  for (;;) {
    const children = rows.filter((row) => !owned.has(row.pid) && owned.has(row.ppid));
    if (!children.length) break;
    for (const row of children) owned.add(row.pid);
    alive = [...alive, ...children];
  }
  for (const row of alive) known.set(row.pid, row);
  if (alive.some((row) => row.pid < 2 || row.pid === process.pid)) throw new Error('Refusing to terminate an unowned process.');
  return alive;
}

export function rememberProcessTree(native: NativeProcess): void { ownedProcesses(native); }
export function terminateDescendants(native: NativeProcess, graceMs = 10_000): Promise<void> { return terminateOwned(native, graceMs, true); }

function processTable(): ProcessIdentity[] {
  // Do not inspect arguments or environments; they may contain credentials.
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] });
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[4]! }] : [];
  });
}

export function processIdentity(pid: number): NativeProcess {
  const process = processTable().find((row) => row.pid === pid);
  if (process && process.pgid !== pid) throw new Error('Runtime did not start in its own process group.');
  return { pid, pgid: pid, startIdentity: process?.start ?? 'exited-before-identity-observed' };
}
export function processStartIdentity(pid: number): string | null { return processTable().find((row) => row.pid === pid)?.start ?? null; }

/** Only for a process just created by this caller in a detached group. */
export function identifySpawnedGroup(pid: number): NativeProcess {
  try { return processIdentity(pid); }
  catch (error) {
    try { process.kill(-pid, 'SIGKILL'); } catch (stopError) { if ((stopError as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Runtime identity and startup cleanup failed.'); }
    throw error;
  }
}

export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export function terminateGroup(native: NativeProcess, graceMs = 10_000): Promise<void> {
  const pending = terminations.get(native); if (pending) return pending;
  const task = terminateOwned(native, graceMs); terminations.set(native, task);
  void task.catch(() => { if (terminations.get(native) === task) terminations.delete(native); });
  return task;
}

async function terminateOwned(native: NativeProcess, graceMs: number, childrenOnly = false): Promise<void> {
  if (!Number.isSafeInteger(native.pgid) || native.pgid < 2 || native.pid !== native.pgid || native.pgid === process.pid) {
    throw new Error('Refusing to terminate an unowned process group.');
  }
  let first = true;
  const observe = () => {
    const alive = ownedProcesses(native, first);
    first = false;
    return childrenOnly ? alive.filter((row) => row.pid !== native.pid) : alive;
  };
  const signal = (pid: number, name: NodeJS.Signals) => {
    try { process.kill(pid, name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  let alive = observe(); if (!alive.length) return;
  // Capture ancestry before stopping the parent: native shell tools may have
  // created separate groups and become orphaned when the SDK worker exits.
  if (!childrenOnly && alive.some((row) => row.pgid === native.pgid)) signal(-native.pgid, 'SIGTERM');
  const signalled = new Set<string>();
  const deadline = Date.now() + graceMs;
  while (alive.length && Date.now() < deadline) {
    for (const row of alive) {
      const identity = `${row.pid}:${row.start}`;
      if (!signalled.has(identity)) { signal(row.pid, 'SIGTERM'); signalled.add(identity); }
    }
    await delay(50); alive = observe();
  }
  for (const row of alive) signal(row.pid, 'SIGKILL');
  const killDeadline = Date.now() + 10_000;
  while (alive.length && Date.now() < killDeadline) {
    await delay(50); alive = observe();
    for (const row of alive) signal(row.pid, 'SIGKILL');
  }
  if (alive.length) throw new Error('Runtime descendant termination could not be confirmed.');
}

export async function spawnGroup(command: string, args: string[], options: { cwd: string; env: Record<string, string> }): Promise<{ child: ChildProcessWithoutNullStreams; native: NativeProcess }> {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.off('error', reject); resolve(); });
  });
  if (!child.pid) throw new Error('Runtime worker started without a process identity.');
  return { child, native: identifySpawnedGroup(child.pid) };
}
