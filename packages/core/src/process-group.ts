import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const execFileAsync = promisify(execFile);

export type NativeProcess = { pid: number; pgid: number; startIdentity?: string; sessionId?: string };
type ProcessIdentity = { pid: number; ppid: number; pgid: number; start: string };
const terminations = new WeakMap<NativeProcess, Promise<void>>();
const descendants = new WeakMap<NativeProcess, Map<number, ProcessIdentity>>();

/**
 * The process table is read without blocking the event loop where callers can wait: on a busy machine one `ps` over every process
 * takes long enough that reading it synchronously, as termination polls do every 50 ms, stalled the daemon's HTTP answers for seconds.
 */
async function ownedProcesses(native: NativeProcess, strictIdentity = true): Promise<ProcessIdentity[]> {
  const known = descendants.get(native) ?? new Map<number, ProcessIdentity>(); descendants.set(native, known);
  const rows = await processTableAsync(); const root = rows.find((row) => row.pid === native.pid);
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

export async function rememberProcessTree(native: NativeProcess): Promise<void> { await ownedProcesses(native); }
export function terminateDescendants(native: NativeProcess, graceMs = 10_000): Promise<void> { return terminateOwned(native, graceMs, true); }

// Do not inspect arguments or environments; they may contain credentials.
const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,lstart='];
const PS_OPTIONS = { encoding: 'utf8' as const, timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { LC_ALL: 'C', TZ: 'UTC' } };
function processTable(): ProcessIdentity[] {
  return parseProcessTable(execFileSync('/bin/ps', PS_ARGS, { ...PS_OPTIONS, stdio: ['ignore', 'pipe', 'ignore'] }));
}
async function processTableAsync(): Promise<ProcessIdentity[]> {
  return parseProcessTable((await execFileAsync('/bin/ps', PS_ARGS, PS_OPTIONS)).stdout);
}
function parseProcessTable(output: string): ProcessIdentity[] {
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[4]! }] : [];
  });
}

let linuxClock: { bootSeconds: number; ticks: number } | null | undefined;
function currentProcess(pid: number): ProcessIdentity | undefined {
  if (process.platform !== 'linux') return processTable().find(row => row.pid === pid);
  // Launch identity must be synchronous so a short command cannot exit before its callers attach listeners.
  // Reading one proc entry avoids a synchronous whole-machine ps on every Git command and admission read.
  // Preserve ps's UTC lstart representation so existing process receipts and asynchronous tree scans still agree.
  if (linuxClock === undefined) {
    try {
      const bootSeconds = Number(/^btime (\d+)$/mu.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
      const ticks = Number(execFileSync('/usr/bin/getconf', ['CLK_TCK'], PS_OPTIONS).trim());
      linuxClock = Number.isFinite(bootSeconds) && ticks > 0 ? { bootSeconds, ticks } : null;
    } catch { linuxClock = null; }
  }
  if (!linuxClock) return processTable().find(row => row.pid === pid);
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    return processTable().find(row => row.pid === pid);
  }
  // comm can contain spaces and parentheses; the numeric fields begin after its final closing parenthesis.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  const ppid = Number(fields[1]), pgid = Number(fields[2]), ticks = Number(fields[19]);
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || !Number.isSafeInteger(ticks)) throw new Error('Process identity is unreadable.');
  const date = new Date((linuxClock.bootSeconds + Math.floor(ticks / linuxClock.ticks)) * 1000);
  const [weekday, day, month, year, time] = date.toUTCString().split(' ');
  return { pid, ppid, pgid, start: `${weekday!.slice(0, 3)} ${month} ${String(Number(day)).padStart(2, ' ')} ${time} ${year}` };
}

export function processIdentity(pid: number): NativeProcess {
  const process = currentProcess(pid);
  if (process && process.pgid !== pid) throw new Error('Runtime did not start in its own process group.');
  return { pid, pgid: pid, startIdentity: process?.start ?? 'exited-before-identity-observed' };
}
export function processStartIdentity(pid: number): string | null { return currentProcess(pid)?.start ?? null; }

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
  const observe = async () => {
    const alive = await ownedProcesses(native, first);
    first = false;
    return childrenOnly ? alive.filter((row) => row.pid !== native.pid) : alive;
  };
  const signal = (pid: number, name: NodeJS.Signals) => {
    try { process.kill(pid, name); return true; }
    catch (error) {
      // A short-lived descendant can refuse a signal during an exec/permission transition. Never
      // claim it stopped: the bounded fresh identity scans below must still confirm every exit.
      if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      return false;
    }
  };
  let alive = await observe(); if (!alive.length) return;
  // Capture ancestry before stopping the parent: native shell tools may have
  // created separate groups and become orphaned when the SDK worker exits.
  if (!childrenOnly && alive.some((row) => row.pgid === native.pgid)) signal(-native.pgid, 'SIGTERM');
  const signalled = new Set<string>();
  const deadline = Date.now() + graceMs;
  while (alive.length && Date.now() < deadline) {
    for (const row of alive) {
      const identity = `${row.pid}:${row.start}`;
      if (!signalled.has(identity) && signal(row.pid, 'SIGTERM')) signalled.add(identity);
    }
    await delay(50); alive = await observe();
  }
  for (const row of alive) signal(row.pid, 'SIGKILL');
  const killDeadline = Date.now() + 10_000;
  while (alive.length && Date.now() < killDeadline) {
    await delay(50); alive = await observe();
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
  // Identified synchronously: callers attach their exit listeners when this returns, so awaiting here could miss a quick exit.
  return { child, native: identifySpawnedGroup(child.pid) };
}
