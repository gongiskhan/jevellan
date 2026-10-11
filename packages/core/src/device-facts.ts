import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { statfsSync } from 'node:fs';
import { DeviceFactsSchema, type DeviceFacts } from './schemas.js';
import type { Homes } from './homes.js';
export function collectDeviceFacts(homes: Homes, runningThreads: string[] = [], runningJobRuns: string[] = []): DeviceFacts {
  const disk = statfsSync(homes.root), load = loadavg();
  return DeviceFactsSchema.parse({ schema: 'device-facts-v1', cores: Math.max(1, cpus().length), load1: load[0], load5: load[1], totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(),
    freeDiskBytes: disk.bavail * disk.bsize, os: platform(), runningThreads, runningJobRuns });
}
const gb = (bytes: number) => Math.floor(bytes / 1_000_000_000);
export function deviceResourceRefusal(name: string, facts?: DeviceFacts): string | undefined {
  if (!facts) return undefined;
  if (facts.freeDiskBytes < 20_000_000_000) return `${name} has ${gb(facts.freeDiskBytes)} GB free; Jevellan needs at least 20 GB to start work there.`;
  if (facts.load5 > 2 * facts.cores) return `${name} is busy (load ${Number(facts.load5.toFixed(1))} on ${facts.cores} cores).`;
  return undefined;
}
