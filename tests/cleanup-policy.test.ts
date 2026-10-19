import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CleanupService, CleanupSettingsSchema, Homes, cleanupFootprint, defaultCleanupSettings, type CleanupCategory, type CleanupItem, type CleanupSettings } from '../packages/core/dist/index.js';
let root: string, homes: Homes, settings: CleanupSettings, items: CleanupItem[], now: number;
const services: CleanupService[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-cleanup-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'home'), join(root, 'user')); homes.ensure(); settings = { ...defaultCleanupSettings(), freeDiskFloorGb: 0 }; items = []; now = Date.parse('2026-10-19T12:00:00Z'); });
afterEach(async () => { vi.useRealTimers(); await Promise.all(services.splice(0).map(service => service.close())); rmSync(root, { recursive: true, force: true }); });
function create(category: CleanupCategory, ref: string, age: number, protectedReason?: string): CleanupItem {
  const path = join(homes.root, ref), file = category === 'logs' ? path : join(path, 'fixture.bin'); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.alloc(8192, 1));
  const item: CleanupItem = { category, path, since: new Date(now - age * 86400000).toISOString(), verify: () => true, ...(protectedReason ? { protected: protectedReason } : {}) }; items.push(item); return item;
}
function service(extra: Partial<ConstructorParameters<typeof CleanupService>[0]> = {}) { const service = new CleanupService({ homes, deviceId: 'device', settings: async () => settings, inventory: async () => items, maintenance: () => () => {}, now: () => now, freeBytes: () => 80e9, ...extra }); services.push(service); return service; }
const refs = { logs: (id: string) => `logs/${id}.log`, evidence: (id: string) => `projects/project/threads/${id}/evidence`, worktrees: (id: string) => `worktrees/project/${id}`, workspaces: (id: string) => `project-work/project/job-workspaces/${id}` };
for (const category of ['logs', 'evidence', 'worktrees', 'workspaces'] as const) test(`${category} retention removes old eligible items and keeps younger ones`, async () => {
  settings[category] = { days: 3, maxGb: 20 }; const old = create(category, refs[category]('old'), 4), young = create(category, refs[category]('young'), 2);
  const result = (await service().run()).lastRun!; expect(result.removed).toBe(1); expect(result.categories[category].removed).toBe(1); expect(result.freedBytes).toBeGreaterThan(0);
  expect(existsSync(old.path)).toBe(false); expect(existsSync(young.path)).toBe(true);
});

test('category capacity removes the oldest eligible item before its retention age', async () => {
  const old = create('logs', refs.logs('old'), 1), young = create('logs', refs.logs('young'), 0.5);
  settings.logs = { days: 14, maxGb: cleanupFootprint(young.path).bytes / 1e9 };
  expect((await service().run()).lastRun?.removed).toBe(1); expect(existsSync(old.path)).toBe(false); expect(existsSync(young.path)).toBe(true);
});

test('the free-disk floor removes oldest eligible items regardless of age and never an unlanded worktree', async () => {
  const unlanded = create('worktrees', refs.worktrees('unlanded'), 30, 'Not landed or resolved.');
  const old = create('logs', refs.logs('old'), 1), young = create('logs', refs.logs('young'), 0.5);
  settings.freeDiskFloorGb = 50;
  const result = (await service({ freeBytes: () => existsSync(old.path) ? 50e9 - 1 : 50e9 + 1 }).run()).lastRun!;
  expect(result.removed).toBe(1); expect(result.floorMet).toBe(true); expect(result.protected).toBe(1);
  expect(existsSync(unlanded.path)).toBe(true); expect(existsSync(young.path)).toBe(true);
});

test('protected capacity still counts toward the category limit', async () => {
  const protectedItem = create('worktrees', refs.worktrees('unlanded'), 30, 'Unlanded.');
  const eligible = create('worktrees', refs.worktrees('landed'), 1); settings.worktrees.maxGb = cleanupFootprint(protectedItem.path).bytes / 1e9;
  expect((await service().run()).lastRun?.removed).toBe(1); expect(existsSync(eligible.path)).toBe(false); expect(existsSync(protectedItem.path)).toBe(true);
});

test('an idle maintenance reservation is required and a deferred attempt is durable', async () => {
  const old = create('logs', refs.logs('old'), 100); const first = await service({ maintenance: () => null }).run();
  expect(first.lastRun).toMatchObject({ state: 'deferred', removed: 0 }); expect(existsSync(old.path)).toBe(true); expect(service().state()).toEqual(first);
});

test('changed files and new work are rechecked before deletion and the reservation is always released', async () => {
  const changed = create('logs', refs.logs('changed'), 100), held = create('worktrees', refs.worktrees('held'), 100);
  changed.verify = () => { writeFileSync(changed.path, 'New log data.'); return true; }; held.verify = () => false;
  const release = vi.fn(); const result = (await service({ maintenance: () => release }).run()).lastRun!;
  expect(result.removed).toBe(0); expect(result.changed).toBe(2); expect(release).toHaveBeenCalledOnce(); expect(readFileSync(changed.path, 'utf8')).toBe('New log data.'); expect(existsSync(held.path)).toBe(true);
});

test('backups, vault, memory, ledgers, journal, authentication and paths outside the isolated home cannot be candidates', async () => {
  const refs = ['backups/copy', 'vault/secret', 'basic-memory/note', 'projects/project/ledger/event', 'project-journal/project/INDEX.md', 'homes/codex/account/auth.json'];
  const verify = vi.fn(() => true);
  for (const ref of refs) { const path = join(homes.root, ref); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'keep'); items.push({ category: 'logs', path, since: '2000-01-01T00:00:00Z', verify }); }
  const external = join(root, 'outside'); writeFileSync(external, 'outside'); items.push({ category: 'logs', path: external, since: '2000-01-01T00:00:00Z', verify });
  const result = (await service().run()).lastRun!; expect(result.removed).toBe(0); expect(result.protected).toBe(7); expect(verify).not.toHaveBeenCalled();
  for (const ref of refs) expect(readFileSync(join(homes.root, ref), 'utf8')).toBe('keep'); expect(readFileSync(external, 'utf8')).toBe('outside');
});

test('a symlink cannot alias a log to native authentication', async () => {
  const external = join(root, 'native-auth'); writeFileSync(external, 'keep'); const path = join(homes.ensure('logs'), 'alias.log'); symlinkSync(external, path);
  items.push({ category: 'logs', path, since: '2000-01-01T00:00:00Z', verify: () => true });
  expect((await service().run()).lastRun?.protected).toBe(1); expect(readFileSync(external, 'utf8')).toBe('keep');
});

test('the current daemon log is truncated while its pathname is retained', async () => {
  const log = create('logs', 'logs/daemon.log', 20); expect((await service().run()).lastRun?.removed).toBe(1); expect(statSync(log.path).size).toBe(0);
});

test('hourly sweeps coalesce and stop when the service closes', async () => {
  vi.useFakeTimers(); const inventory = vi.fn(async () => items), engine = service({ inventory }); engine.start();
  await vi.advanceTimersByTimeAsync(3599999); expect(inventory).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(inventory).toHaveBeenCalledOnce(); expect(engine.state().lastRun?.trigger).toBe('hourly');
  await engine.close(); await vi.advanceTimersByTimeAsync(3600000); expect(inventory).toHaveBeenCalledOnce();
});

test('cleanup settings migrate with bounded defaults and reject invalid limits', () => {
  expect(defaultCleanupSettings()).toEqual({ schema: 'cleanup-settings-v1', logs: { days: 14, maxGb: 5 }, evidence: { days: 30, maxGb: 10 }, worktrees: { days: 3, maxGb: 20 }, workspaces: { days: 2, maxGb: 20 }, freeDiskFloorGb: 50 });
  expect(CleanupSettingsSchema.safeParse({ ...settings, logs: { days: -1, maxGb: 1 } }).success).toBe(false); expect(CleanupSettingsSchema.safeParse({ ...settings, freeDiskFloorGb: -1 }).success).toBe(false);
});

test('a device protected path keeps an otherwise eligible landed worktree', async () => {
  const tree = create('worktrees', refs.worktrees('landed'), 100);
  const result = (await service({ protectedPaths: async () => [join(tree.path, 'fixture.bin')] }).run()).lastRun!;
  expect(result.protected).toBe(1); expect(result.removed).toBe(0); expect(existsSync(tree.path)).toBe(true);
});
