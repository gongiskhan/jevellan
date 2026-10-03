import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigurationSchema, Homes, ImproverSettingsSchema, LegacyConfigurationSchema, defaultImproverSettings,
  exportConfiguration, parseConfiguration, seedConfiguration, stableJson,
} from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';

let root: string; let homes: Homes; let hub: HubDatabase;
const author = { deviceId: 'first', source: 'ui' as const };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-improver-configuration-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'home'), join(root, 'user')); hub = new HubDatabase(homes, 'hub');
});
afterEach(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });

function legacyConfiguration() {
  const current = seedConfiguration(); const settings: Record<string, unknown> = { ...current['x-jevellan'], schema: 1 };
  delete settings.improver;
  return LegacyConfigurationSchema.parse({ ...current, 'x-jevellan': settings });
}
function saveLegacy() {
  const configuration = legacyConfiguration(); configuration['x-jevellan'].routingProfile = 'Preserve the existing routing guidance.';
  const revision = { schema: 'config-revision-v1', revision: 1, configuration, changedBy: author, at: '2026-09-24T12:00:00.000Z' };
  const fingerprint = createHash('sha256').update(stableJson({ configuration, expectedRevision: 0, changedBy: author })).digest('hex');
  const receipt = { schema: 'configuration-request-v1', id: 'saved_before_upgrade', deviceId: author.deviceId, fingerprint, revision: 1 };
  hub.db.prepare('INSERT INTO configuration_revisions(revision,document) VALUES(?,?)').run(1, JSON.stringify(revision));
  hub.db.prepare('INSERT INTO configuration_requests(device_id,request_id,document) VALUES(?,?,?)').run(author.deviceId, receipt.id, JSON.stringify(receipt));
  return { configuration, revision, receipt };
}

test('version one gains only versioned improver defaults and cannot silently contain new settings', () => {
  const legacy = legacyConfiguration(); legacy['x-jevellan'].guards.pauseAfterPlan = false;
  legacy['x-jevellan'].menu[0]!.description = 'Keep this model description.';
  const upgraded = ConfigurationSchema.parse(legacy);
  expect(upgraded).toEqual({ ...legacy, 'x-jevellan': { ...legacy['x-jevellan'], schema: 2, improver: defaultImproverSettings() } });
  expect(upgraded['x-jevellan'].improver).toMatchObject({ schedule: { enabled: true, time: '03:00' }, routing: { mode: 'suggest' }, context: { mode: 'suggest' }, memory: { mode: 'apply-and-tell', projects: {} } });
  expect(ConfigurationSchema.safeParse({ ...legacy, 'x-jevellan': { ...legacy['x-jevellan'], improver: defaultImproverSettings() } }).success).toBe(false);
  const independent = defaultImproverSettings(); independent.memory.projects.project = false;
  expect(defaultImproverSettings().memory.projects).toEqual({});
});

test('improver settings round-trip with project choices and reject unsupported scheduling or automatic routing', () => {
  const configuration = seedConfiguration(); const settings = configuration['x-jevellan'].improver;
  settings.schedule = { enabled: false, time: '23:59' }; settings.memory.mode = 'suggest';
  settings.memory.projects.project = false; settings.context.enabled = false;
  expect(parseConfiguration(exportConfiguration(configuration))).toEqual(configuration);
  expect(ImproverSettingsSchema.safeParse({ ...settings, schedule: { enabled: true, time: '24:00' } }).success).toBe(false);
  expect(ImproverSettingsSchema.safeParse({ ...settings, routing: { enabled: true, mode: 'apply-and-tell' } }).success).toBe(false);
  expect(ImproverSettingsSchema.safeParse({ ...settings, context: { enabled: true, mode: 'apply-and-tell' } }).success).toBe(false);
  expect(ImproverSettingsSchema.safeParse({ ...settings, memory: { ...settings.memory, projects: { 'outside/project': true } } }).success).toBe(false);
});

test('reading legacy history adds defaults without rewriting historical bytes or changing revisions', () => {
  const { revision } = saveLegacy(); const current = hub.configuration.current()!;
  expect(current).toMatchObject({ revision: 1, changedBy: author, at: revision.at, configuration: { 'x-jevellan': { schema: 2, routingProfile: revision.configuration['x-jevellan'].routingProfile } } });
  expect(hub.configuration.history()).toEqual([current]);
  expect(hub.db.prepare('SELECT document FROM configuration_revisions WHERE revision=1').get()?.document).toBe(JSON.stringify(revision));
  current.configuration['x-jevellan'].improver.memory.mode = 'suggest';
  expect(hub.configuration.put(current.configuration, 1, author).revision).toBe(2);
  expect(hub.configuration.current()?.configuration['x-jevellan'].improver.memory.mode).toBe('suggest');
});

test('a lost version-one save reply survives upgrade, restart and newer changes without replaying the write', () => {
  const { configuration, receipt } = saveLegacy(); const newer = hub.configuration.current()!.configuration;
  newer['x-jevellan'].improver.schedule.time = '04:30'; newer['x-jevellan'].guards.pauseAfterPlan = false;
  hub.configuration.put(newer, 1, author); hub.close(); hub = new HubDatabase(homes, 'hub');
  const recovered = hub.configuration.put(configuration, 0, author, undefined, receipt.id);
  expect(recovered.revision).toBe(1); expect(recovered.configuration['x-jevellan'].improver.schedule.time).toBe('03:00');
  expect(hub.configuration.put(ConfigurationSchema.parse(configuration), 0, author, undefined, receipt.id)).toEqual(recovered);
  expect(hub.configuration.current()?.configuration).toEqual(newer); expect(hub.configuration.history()).toHaveLength(2);
  expect(hub.db.prepare('SELECT document FROM configuration_requests').get()?.document).toBe(JSON.stringify(receipt));
});

test('legacy recovery still refuses changed contents, new improver settings, revision and author', () => {
  const { configuration, receipt } = saveLegacy();
  const changed = ConfigurationSchema.parse(configuration); changed['x-jevellan'].improver.schedule.time = '04:30';
  expect(() => hub.configuration.put(changed, 0, author, undefined, receipt.id)).toThrow('Settings changed elsewhere');
  expect(() => hub.configuration.put(configuration, 1, author, undefined, receipt.id)).toThrow('Settings changed elsewhere');
  expect(() => hub.configuration.put(configuration, 0, { ...author, source: 'improver' }, undefined, receipt.id)).toThrow('Settings changed elsewhere');
  const other = structuredClone(configuration); other['x-jevellan'].routingProfile = 'A different request.';
  expect(() => hub.configuration.put(other, 0, author, undefined, receipt.id)).toThrow('Settings changed elsewhere');
  expect(hub.configuration.history()).toHaveLength(1);
});

test('a mismatched legacy receipt is not treated as a successfully saved request', () => {
  const { configuration, receipt } = saveLegacy();
  hub.db.prepare('UPDATE configuration_requests SET document=?').run(JSON.stringify({ ...receipt, fingerprint: '0'.repeat(64) }));
  expect(() => hub.configuration.put(configuration, 0, author, undefined, receipt.id)).toThrow('Settings changed elsewhere');
  expect(hub.configuration.history()).toHaveLength(1);
});
