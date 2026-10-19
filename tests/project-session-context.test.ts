import { afterEach, beforeEach, expect, test } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, ProjectWorkSettingsSchema, StoredProjectWorkSettingsSchema, defaultProjectWorkSettings } from '../packages/core/dist/index.js';
import { compactPercent, nightlyFixMinutes } from '../packages/projects/dist/session-context.js';
import { CodexContextMonitor, CodexContextRecords } from '../runtimes/codex/dist/context.js';
import { discoveredContextWindow } from '../runtimes/codex/dist/control.js';
import type { RuntimeEvent } from '../packages/runtime-contract/dist/index.js';

let root: string; let homes: Homes;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-context-'))); homes = new Homes(join(root, 'data'), join(root, 'user')); homes.ensure(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const snapshot = (tokens: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens }, model_context_window: 10000 } } });

test('settings default to 70%, enforce production bounds, and migrate old settings without resetting owner choices', () => {
  const settings = defaultProjectWorkSettings('proj_context'); expect(settings.compactAtPercent).toBe(70);
  for (const value of [49, 91, 70.5]) expect(ProjectWorkSettingsSchema.safeParse({ ...settings, compactAtPercent: value }).success).toBe(false);
  for (const value of [50, 90]) expect(ProjectWorkSettingsSchema.parse({ ...settings, compactAtPercent: value }).compactAtPercent).toBe(value);
  const old = { schema: 'project-work-settings-v1', projectId: 'proj_context', revision: 7, defaultIsolation: 'main', coordinator: { modelId: 'chosen', effort: 'high' },
    setupCommand: 'npm ci', maxRunningThreads: 9, maxRunningPerDevice: 3, threadTurnCap: 51 };
  expect(StoredProjectWorkSettingsSchema.parse(old)).toMatchObject({ ...old, schema: 'project-work-settings-v5', compactAtPercent: 70 });
  expect(StoredProjectWorkSettingsSchema.parse({ ...old, schema: 'project-work-settings-v2', threadRules: 'Keep my rules', coordinatorReview: false, nightlyWindow: { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' } }))
    .toMatchObject({ compactAtPercent: 70, instructions: 'Keep my rules', nightlyWindow: { enabled: true, time: '01:00' } });
});

test('the low test threshold is accepted only by an uninstalled test daemon', () => {
  expect(compactPercent(70, homes, {})).toBe(70);
  for (const value of ['15', '20', '49']) expect(compactPercent(70, homes, { NODE_ENV: 'test', JEVELLAN_TEST_COMPACT_PERCENT: value })).toBe(Number(value));
  for (const value of ['14', '50', '20.5', '20x', '']) expect(() => compactPercent(70, homes, { NODE_ENV: 'test', JEVELLAN_TEST_COMPACT_PERCENT: value })).toThrow('15 to 49');
  expect(() => compactPercent(70, homes, { NODE_ENV: 'production', JEVELLAN_TEST_COMPACT_PERCENT: '20' })).toThrow('production');
  writeFileSync(homes.at('install.json'), '{}');
  expect(() => compactPercent(70, homes, { NODE_ENV: 'test', JEVELLAN_TEST_COMPACT_PERCENT: '20' })).toThrow('production');
});
test('the short live night cutoff is explicitly fenced and cannot affect an installed hub', () => {
  expect(nightlyFixMinutes(homes, {})).toBe(150);
  expect(nightlyFixMinutes(homes, { NODE_ENV: 'test', JEVELLAN_TEST_NIGHTLY_FIX_MINUTES: '30' })).toBe(30);
  expect(() => nightlyFixMinutes(homes, { NODE_ENV: 'test', JEVELLAN_TEST_NIGHTLY_FIX_MINUTES: '20' })).toThrow('must be 30');
  expect(() => nightlyFixMinutes(homes, { NODE_ENV: 'production', JEVELLAN_TEST_NIGHTLY_FIX_MINUTES: '30' })).toThrow('production');
  writeFileSync(homes.at('install.json'), '{}');
  expect(() => nightlyFixMinutes(homes, { NODE_ENV: 'test', JEVELLAN_TEST_NIGHTLY_FIX_MINUTES: '30' })).toThrow('production');
});

test('Codex context records recognise a boundary once, and use the context drop when there is no explicit boundary', () => {
  const events: RuntimeEvent[] = []; const records = new CodexContextRecords(event => events.push(event));
  records.read(snapshot(7500)); records.read(JSON.stringify({ type: 'compacted', payload: {} })); records.read(snapshot(1500)); records.read(snapshot(1400));
  expect(events).toEqual([{ type: 'context', tokens: 7500, contextWindow: 10000 }, { type: 'compacted', beforeTokens: 7500, afterTokens: null, contextWindow: 10000 },
    { type: 'context', tokens: 1500, contextWindow: 10000 }, { type: 'compacted', beforeTokens: 1500, afterTokens: 1400, contextWindow: 10000 }, { type: 'context', tokens: 1400, contextWindow: 10000 }]);
});

test('a resumed journal seeds existing context, reads new partial records once and never modifies the account home', () => {
  const home = homes.ensure('homes', 'codex', 'acc_fixture'); const dir = join(home, 'sessions', '2026', '10', '12'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-fixture-session.jsonl'); const history = `${snapshot(8000)}\n${JSON.stringify({ type: 'compacted', payload: {} })}\n${snapshot(2000)}\n`;
  writeFileSync(file, history); const events: RuntimeEvent[] = []; const monitor = new CodexContextMonitor(home, event => events.push(event), 'session');
  monitor.poll(); expect(events).toEqual([]); expect(readFileSync(file, 'utf8')).toBe(history);
  const next = snapshot(2500); appendFileSync(file, next.slice(0, 30)); monitor.poll(); expect(events).toEqual([]);
  appendFileSync(file, `${next.slice(30)}\n`); monitor.poll(); monitor.poll(); expect(events).toEqual([{ type: 'context', tokens: 2500, contextWindow: 10000 }]);
  appendFileSync(file, 'x'.repeat(1024 * 1024 + 10)); monitor.poll(); appendFileSync(file, `${snapshot(9)}\n${snapshot(3000)}\n`); monitor.poll();
  expect(events.at(-1)).toEqual({ type: 'context', tokens: 3000, contextWindow: 10000 }); expect(events.some(event => event.type === 'context' && event.tokens === 9)).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe(history + next + '\n' + 'x'.repeat(1024 * 1024 + 10) + snapshot(9) + '\n' + snapshot(3000) + '\n');
});

test('journal and model discovery never follow a symlink outside the isolated home', () => {
  const home = homes.ensure('homes', 'codex', 'acc_fixture'); const native = join(root, 'user', '.codex'); mkdirSync(native, { recursive: true });
  const file = join(native, 'rollout-fixture-session.jsonl'); writeFileSync(file, `${snapshot(8000)}\n`); symlinkSync(native, join(home, 'sessions'));
  const catalog = JSON.stringify({ models: [{ slug: 'fixture-model', context_window: 10000 }] }); writeFileSync(join(native, 'models_cache.json'), catalog);
  symlinkSync(join(native, 'models_cache.json'), join(home, 'models_cache.json'));
  const events: RuntimeEvent[] = []; const monitor = new CodexContextMonitor(home, event => events.push(event)); monitor.track('session'); monitor.poll();
  expect(events).toEqual([]); expect(discoveredContextWindow(home, 'fixture-model')).toBeUndefined();
  expect(readFileSync(file, 'utf8')).toBe(`${snapshot(8000)}\n`); expect(readFileSync(join(native, 'models_cache.json'), 'utf8')).toBe(catalog);
});

test('model context windows come from the isolated account catalog; unknown and malformed catalogs stay unknown', () => {
  const home = homes.ensure('homes', 'codex', 'acc_fixture'); const file = join(home, 'models_cache.json');
  writeFileSync(file, JSON.stringify({ models: [{ slug: 'fixture-model', context_window: 10000 }] }));
  expect(discoveredContextWindow(home, 'fixture-model')).toBe(10000); expect(discoveredContextWindow(home, 'missing')).toBeUndefined();
  writeFileSync(file, 'invalid'); expect(discoveredContextWindow(home, 'fixture-model')).toBeUndefined();
});
