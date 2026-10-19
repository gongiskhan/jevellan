import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, rmSync, statfsSync, truncateSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CleanupReceiptSchema, CleanupStateSchema, type CleanupCategory, type CleanupReceipt, type CleanupState } from './cleanup-schemas.js';
import { CleanupSettingsSchema, type CleanupSettings } from './cleanup-settings-schemas.js';
import { readDocument, writeDocument } from './files.js';
import { inside, resolvedPath, type Homes } from './homes.js';

/** Internal inventory only. Owner routes accept no filesystem paths or deletion commands. */
export type CleanupItem = { category: CleanupCategory; path: string; since: string; protected?: string;
  verify(): boolean | Promise<boolean>; remove?(): void | Promise<void> };
const GB = 1e9, DAY = 86400000;
export function cleanupFootprint(path: string): { bytes: number; fingerprint: string } {
  let bytes = 0; const hash = createHash('sha256');
  const visit = (current: string) => {
    const stat = lstatSync(current); bytes += stat.blocks * 512;
    hash.update(JSON.stringify([relative(path, current), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]));
    if (stat.isDirectory()) for (const name of readdirSync(current).sort()) visit(join(current, name));
  };
  visit(path); return { bytes, fingerprint: hash.digest('hex') };
}
const safe = (category: CleanupCategory, path: string): boolean => {
  const id = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
  const patterns = { logs: `^(?:logs/[^/]+|project-work/${id}/job-logs/${id}\\.(?:log|json))$`,
    evidence: `^(?:projects/${id}/threads/${id}/(?:evidence|screenshots)|worktrees/${id}/${id}/(?:evidence|screenshots|test-results|\\.jevellan/(?:evidence|screenshots)))$`,
    worktrees: `^worktrees/${id}/${id}$`, workspaces: `^(?:project-work/${id}/job-workspaces/${id}|worktrees/${id}/(?:jobs|pr-verification|nightly-reviews)/${id})$` };
  return new RegExp(patterns[category], 'u').test(path) && (category !== 'worktrees' || !['jobs', 'pr-verification', 'nightly-reviews'].includes(path.split('/').at(-1)!));
};
/** An idle maintenance reservation covers inventory, revalidation and removal. */
export class CleanupService {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<CleanupState> | undefined;
  #closed = false;
  constructor(readonly o: { homes: Homes; deviceId: string; settings(): Promise<CleanupSettings>; inventory(): Promise<CleanupItem[]>;
    maintenance(): (() => void) | null; now?(): number; freeBytes?(): number; protectedPaths?(): string[] | Promise<string[]> }) {}
  #now() { return this.o.now?.() ?? Date.now(); }
  #free() { const stat = this.o.freeBytes ? undefined : statfsSync(this.o.homes.root); return Math.max(0, Math.floor(this.o.freeBytes?.() ?? stat!.bavail * stat!.bsize)); }
  #statePath() { return this.o.homes.at('cleanup', 'last-run.json'); }
  state(): CleanupState { return existsSync(this.#statePath()) ? readDocument(this.#statePath(), CleanupStateSchema) : { schema: 'cleanup-state-v1', deviceId: this.o.deviceId, lastRun: null }; }
  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => { void this.run('hourly').catch(() => undefined); }, 3600000); this.#timer.unref();
  }
  run(trigger: 'hourly' | 'manual' = 'manual'): Promise<CleanupState> {
    if (this.#closed) return Promise.reject(new Error('Cleanup is stopping.'));
    if (this.#running) return this.#running;
    const run = this.#run(trigger).finally(() => { this.#running = undefined; }); this.#running = run; return run;
  }
  async #run(trigger: 'hourly' | 'manual'): Promise<CleanupState> {
    const settings = CleanupSettingsSchema.parse(await this.o.settings()), startedAt = new Date(this.#now()).toISOString();
    const categories = { logs: { freedBytes: 0, removed: 0 }, evidence: { freedBytes: 0, removed: 0 }, worktrees: { freedBytes: 0, removed: 0 }, workspaces: { freedBytes: 0, removed: 0 } };
    const receipt: CleanupReceipt = { schema: 'cleanup-receipt-v1', deviceId: this.o.deviceId, trigger, startedAt, endedAt: startedAt, state: 'completed',
      freedBytes: 0, removed: 0, protected: 0, changed: 0, freeBytes: this.#free(), floorMet: false, categories };
    const release = this.o.maintenance();
    try {
      if (!release) { receipt.state = 'deferred'; receipt.reason = 'This device has active work. Cleanup will try again when it is idle.'; }
      else {
        const roots = await this.o.protectedPaths?.() ?? [];
        const items: Array<CleanupItem & { bytes: number; fingerprint: string; removed: boolean; eligible: boolean }> = [];
        for (const item of await this.o.inventory()) {
          if (!existsSync(item.path)) continue;
          const rel = relative(this.o.homes.root, item.path).split('\\').join('/');
          if (!safe(item.category, rel) || resolvedPath(item.path) !== item.path || !inside(this.o.homes.root, item.path)
            || roots.some(root => inside(root, item.path) || inside(item.path, root))) { receipt.protected++; continue; }
          if (item.category === 'logs' && !lstatSync(item.path).isFile()) { receipt.protected++; continue; }
          if (item.protected) receipt.protected++;
          items.push({ ...item, ...cleanupFootprint(item.path), removed: false, eligible: !item.protected });
        }
        items.sort((a, b) => a.since.localeCompare(b.since) || a.path.localeCompare(b.path));
        const remove = async (item: typeof items[number]) => {
          if (item.removed || !item.eligible) return;
          if (!existsSync(item.path)) { receipt.changed++; item.removed = true; return; }
          if (!await item.verify() || resolvedPath(item.path) !== item.path || cleanupFootprint(item.path).fingerprint !== item.fingerprint) { receipt.changed++; item.eligible = false; return; }
          if (item.remove) await item.remove();
          else if (item.path === join(this.o.homes.root, 'logs', 'daemon.log')) truncateSync(item.path, 0);
          else rmSync(item.path, { recursive: true });
          item.removed = true; receipt.freedBytes += item.bytes; receipt.removed++;
          categories[item.category].freedBytes += item.bytes; categories[item.category].removed++; receipt.freeBytes = this.#free();
          for (const parent of items) if (parent.protected && parent.path !== item.path && inside(parent.path, item.path)) parent.bytes = Math.max(0, parent.bytes - item.bytes);
        };
        for (const item of items) if (this.#now() - Date.parse(item.since) >= settings[item.category].days * DAY) await remove(item);
        for (const category of ['logs', 'evidence', 'worktrees', 'workspaces'] as const) {
          let bytes = items.filter(item => item.category === category && !item.removed).reduce((sum, item) => sum + item.bytes, 0);
          for (const item of items.filter(item => item.category === category && !item.removed && item.eligible)) {
            if (bytes <= settings[category].maxGb * GB) break;
            const before = receipt.freedBytes; await remove(item); bytes -= receipt.freedBytes - before;
          }
        }
        for (const item of items) { if (receipt.freeBytes >= settings.freeDiskFloorGb * GB) break; await remove(item); }
      }
    } catch { receipt.state = 'deferred'; receipt.reason = 'Cleanup could not verify every eligible item. Unverified items were kept.'; }
    finally { release?.(); }
    receipt.endedAt = new Date(this.#now()).toISOString(); receipt.floorMet = receipt.freeBytes >= settings.freeDiskFloorGb * GB;
    const state = CleanupStateSchema.parse({ schema: 'cleanup-state-v1', deviceId: this.o.deviceId, lastRun: CleanupReceiptSchema.parse(receipt) });
    writeDocument(this.#statePath(), CleanupStateSchema, state); return state;
  }
  async close(): Promise<void> { this.#closed = true; if (this.#timer) clearInterval(this.#timer); await this.#running; }
}
