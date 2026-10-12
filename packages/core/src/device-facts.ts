import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DeviceFactsSchema, DevicePowerSchema, type DeviceFacts, type DevicePower } from './schemas.js';
import type { Homes } from './homes.js';
const readPmset = () => execFileSync('/usr/bin/pmset', ['-g', 'custom'], { encoding: 'utf8', timeout: 2500, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
export function readDevicePower(os: string = platform(), read: () => string = readPmset): DevicePower {
  const observedAt = new Date().toISOString(), base = { schema: 'device-power-v1', observedAt } as const;
  if (os !== 'darwin') return { ...base, status: 'not-applicable' };
  try {
    let ac = false;
    for (const line of read().split('\n')) {
      const text = line.trim(); if (/Power:$/u.test(text)) { ac = text === 'AC Power:'; continue; }
      const match = ac ? /^sleep\s+(\d+)(?:\s|$)/u.exec(text) : null;
      if (match && Number.isSafeInteger(Number(match[1]))) return DevicePowerSchema.parse({ ...base, status: 'available', acSleepMinutes: Number(match[1]) });
    }
  } catch { /* Do not retain command output or environment in a heartbeat. */ }
  return { ...base, status: 'unavailable' };
}
let powerCache: { at: number; value: DevicePower } | undefined;
function powerFacts() { const at = Date.now(); if (!powerCache || at < powerCache.at || at - powerCache.at >= 60_000) powerCache = { at, value: readDevicePower() }; return powerCache.value; }
export function collectDeviceFacts(homes: Homes, runningThreads: string[] = [], runningJobRuns: string[] = []): DeviceFacts {
  const disk = statfsSync(homes.root), load = loadavg();
  return DeviceFactsSchema.parse({ schema: 'device-facts-v1', cores: Math.max(1, cpus().length), load1: load[0], load5: load[1], totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(),
    freeDiskBytes: disk.bavail * disk.bsize, os: platform(), runningThreads, runningJobRuns, power: powerFacts() });
}
const gb = (bytes: number) => Math.floor(bytes / 1_000_000_000);
export function deviceResourceRefusal(name: string, facts?: DeviceFacts): string | undefined {
  if (!facts) return undefined;
  if (facts.freeDiskBytes < 20_000_000_000) return `${name} has ${gb(facts.freeDiskBytes)} GB free; Jevellan needs at least 20 GB to start work there.`;
  if (facts.load5 > 2 * facts.cores) return `${name} is busy (load ${Number(facts.load5.toFixed(1))} on ${facts.cores} cores).`;
  return undefined;
}
