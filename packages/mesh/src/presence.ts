import { execFile } from 'node:child_process';
import { cpus, freemem } from 'node:os';
import { HeartbeatSchema, gitEnvironment, resolveProjectPath, type Heartbeat, type Project } from '@jevellan/core';
import type { ExternalSessionSensor } from './sessions.js';
import { HEARTBEAT_INTERVAL_MS } from './devices.js';

type GitState = Omit<Heartbeat['projects'][number], 'projectId' | 'path'>;
/** Ahead/behind refer to the locally known upstream. Discovery never fetches. */
export function parseProjectGitStatus(text: string): GitState | null {
  let branch: string | undefined; let head: string | undefined; let dirty = false; let ahead = 0; let behind = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) branch = line.slice(14);
    else if (line.startsWith('# branch.oid ')) head = line.slice(13);
    else if (line.startsWith('# branch.ab ')) { const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line); if (counts) { ahead = Number(counts[1]); behind = Number(counts[2]); } }
    else if (!line.startsWith('# ')) dirty = true;
  }
  return branch && head ? { branch, head, dirty, ahead, behind } : null;
}
async function projectGit(project: Project, deviceId: string): Promise<Heartbeat['projects'][number] | null> {
  if (!project.paths[deviceId]) return null;
  let path: string;
  try { const visible = { ...project }; delete visible.allowedDevices; path = resolveProjectPath(visible, deviceId); } catch { return null; }
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch'],
      { cwd: path, env: gitEnvironment(), encoding: 'utf8', timeout: 4000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        const state = error ? null : parseProjectGitStatus(stdout);
        resolve(state ? { projectId: project.id, path, ...state } : null);
      });
  });
}
function cpuTimes() { return cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 }); }

export type DevicePresenceOptions = {
  deviceId: string; version: string; sensor: Pick<ExternalSessionSensor, 'read'>;
  projects(): Promise<Project[]>; running(): string[]; report(heartbeat: Heartbeat): Promise<unknown> | unknown;
  ready?: Promise<void>; timers?: boolean; now?: () => number;
};
/** Failure to report presence cannot stop a runtime. There is one in-flight
 * pulse; shutdown drains it before the hub or its credentials are closed. */
export class DevicePresence {
  #closed = false; #pending: Promise<Heartbeat | null> | undefined; #timer: ReturnType<typeof setInterval> | undefined;
  #cpu = cpuTimes();
  last: Heartbeat | null = null;
  unavailable = false;
  constructor(readonly options: DevicePresenceOptions) {
    if (options.timers !== false) {
      void this.pulse();
      this.#timer = setInterval(() => { void this.pulse(); }, HEARTBEAT_INTERVAL_MS); this.#timer.unref();
    }
  }
  pulse(): Promise<Heartbeat | null> {
    if (this.#closed) return Promise.resolve(null);
    return this.#pending ??= this.#send().catch(() => { this.unavailable = true; return null; }).finally(() => { this.#pending = undefined; });
  }
  async #send(): Promise<Heartbeat | null> {
    await this.options.ready; if (this.#closed) return null;
    const projects = await this.options.projects(); if (this.#closed) return null;
    const sessions = await this.options.sensor.read(projects, this.options.deviceId); if (this.#closed) return null;
    const checkouts: Heartbeat['projects'] = [];
    for (let index = 0; index < projects.length; index += 4) {
      const batch = await Promise.all(projects.slice(index, index + 4).map(project => projectGit(project, this.options.deviceId)));
      checkouts.push(...batch.filter((value): value is Heartbeat['projects'][number] => !!value)); if (this.#closed) return null;
    }
    const cpu = cpuTimes(); const total = cpu.total - this.#cpu.total; const idle = cpu.idle - this.#cpu.idle; this.#cpu = cpu;
    const heartbeat = HeartbeatSchema.parse({ schema: 'heartbeat-v1', deviceId: this.options.deviceId, version: this.options.version, at: new Date((this.options.now ?? Date.now)()).toISOString(),
      runningConversations: this.options.running(), projects: checkouts, externalSessions: sessions.sessions,
      load: { cpuPct: total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0, memFreeMb: freemem() / 1024 / 1024 } });
    await this.options.report(heartbeat); this.last = heartbeat; this.unavailable = false; return heartbeat;
  }
  async close() { this.#closed = true; clearInterval(this.#timer); await this.#pending; }
}
