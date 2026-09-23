import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export type NativeProcess = { pid: number; pgid: number; sessionId?: string };

export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export async function terminateGroup(native: NativeProcess, graceMs = 10_000): Promise<void> {
  if (!Number.isSafeInteger(native.pgid) || native.pgid < 2 || native.pid !== native.pgid || native.pgid === process.pid) {
    throw new Error('Refusing to terminate an unowned process group.');
  }
  const signal = (name: NodeJS.Signals) => {
    try { process.kill(-native.pgid, name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  if (!groupAlive(native.pgid)) return;
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (groupAlive(native.pgid) && Date.now() < deadline) await delay(20);
  if (groupAlive(native.pgid)) signal('SIGKILL');
  const killDeadline = Date.now() + 10_000;
  while (groupAlive(native.pgid) && Date.now() < killDeadline) await delay(20);
  if (groupAlive(native.pgid)) throw new Error('Process group termination could not be confirmed.');
}

export async function spawnGroup(command: string, args: string[], options: { cwd: string; env: Record<string, string> }): Promise<{ child: ChildProcessWithoutNullStreams; native: NativeProcess }> {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.off('error', reject); resolve(); });
  });
  if (!child.pid) throw new Error('Runtime worker started without a process identity.');
  return { child, native: { pid: child.pid, pgid: child.pid } };
}
