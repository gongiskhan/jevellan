import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AccountSchema, ConfigurationSchema, Homes, ProjectSchema, SecretRedactor, mapEffort, minimalEnvironment, newId, parseConfiguration, exportConfiguration, reconcileMenu, resolveProjectPath, seedConfiguration } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';

let root: string;
let homes: Homes;
let database: HubDatabase | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-core-'));
  mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'user', '.jevellan'), join(root, 'user'));
});
afterEach(async () => { database?.close(); database = undefined; await rm(root, { recursive: true, force: true }); });
function hub() { database = new HubDatabase(homes, 'hub'); return database; }

test('configuration revisions reject stale writers across two database connections', () => {
  const first = hub(); const second = new HubDatabase(homes, 'hub');
  try {
    const initial = first.configuration.put(seedConfiguration(), 0, { deviceId: 'first', source: 'install' });
    const changed = structuredClone(initial.configuration); changed['x-jevellan'].guards.pauseAfterPlan = false;
    second.configuration.put(changed, 1, { deviceId: 'second', source: 'ui' });
    expect(() => first.configuration.put(seedConfiguration(), 1, { deviceId: 'first', source: 'ui' })).toThrow('Settings changed elsewhere');
    expect(first.configuration.current()?.configuration['x-jevellan'].guards.pauseAfterPlan).toBe(false);
    expect(first.configuration.history().map((revision) => revision.changedBy.deviceId)).toEqual(['first', 'second']);
    first.configuration.materialise(homes);
    expect(parseConfiguration(readFileSync(homes.at('apm.yml'), 'utf8'))).toEqual(changed);
    expect(statSync(homes.at('apm.yml')).mode & 0o777).toBe(0o600);
  } finally { second.close(); }
});

test('configuration import round-trips and rejects duplicate keys, unknown secrets and unsupported versions', () => {
  const config = seedConfiguration();
  expect(parseConfiguration(exportConfiguration(config))).toEqual(config);
  expect(() => parseConfiguration('name: a\nname: b\n')).toThrow('Invalid configuration');
  expect(ConfigurationSchema.safeParse({ ...config, token: 'must-not-be-here' }).success).toBe(false);
  expect(ConfigurationSchema.safeParse({ ...config, 'x-jevellan': { ...config['x-jevellan'], schema: 99 } }).success).toBe(false);
});

test('configuration request receipts recover the original result after restart and a newer save', () => {
  const first = hub(); const author = { deviceId: 'first', source: 'ui' as const };
  const config = seedConfiguration(); const saved = first.configuration.put(config, 0, author, undefined, 'save_first');
  const newer = structuredClone(config); newer['x-jevellan'].guards.pauseAfterPlan = false;
  first.configuration.put(newer, 1, author, undefined, 'save_second');
  first.close(); database = undefined; const reopened = hub();
  expect(reopened.configuration.put(config, 0, author, undefined, 'save_first')).toEqual(saved);
  expect(reopened.configuration.current()?.configuration).toEqual(newer);
  expect(reopened.configuration.history()).toHaveLength(2);
  expect(() => reopened.configuration.put(newer, 0, author, undefined, 'save_first')).toThrow('Settings changed elsewhere');
  expect(() => reopened.configuration.put(config, 1, author, undefined, 'save_first')).toThrow('Settings changed elsewhere');
});

test('configuration receipt IDs are scoped to their device and stale writers still fail', () => {
  const store = hub(); const config = seedConfiguration(); const first = { deviceId: 'first', source: 'ui' as const }; const second = { deviceId: 'second', source: 'ui' as const };
  store.configuration.put(config, 0, first, undefined, 'same_id');
  expect(() => store.configuration.put(config, 0, second, undefined, 'same_id')).toThrow('Settings changed elsewhere');
  expect(store.configuration.put(config, 1, second, undefined, 'same_id').changedBy).toEqual(second);
  expect(() => store.configuration.put(config, 0, first)).toThrow('Settings changed elsewhere');
  expect(store.configuration.history()).toHaveLength(2);
});

test('configuration revisions and their request receipts roll back together', () => {
  const store = hub(); const config = seedConfiguration(); const author = { deviceId: 'first', source: 'ui' as const };
  store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON configuration_requests BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect(() => store.configuration.put(config, 0, author, undefined, 'save_first')).toThrow('fixture failure');
  expect(store.configuration.current()).toBeNull();
  store.db.exec('DROP TRIGGER fail_receipt');
  expect(store.configuration.put(config, 0, author, undefined, 'save_first').revision).toBe(1);
  const receipts = store.db.prepare('SELECT document FROM configuration_requests').all().map(row => JSON.parse(String(row.document)));
  expect(receipts).toEqual([{ schema: 'configuration-request-v1', id: 'save_first', deviceId: 'first', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), revision: 1 }]);
});

test('hub documents are validated on every read and use revision checks', () => {
  const store = hub();
  const account = AccountSchema.parse({ schema: 'account-v1', id: 'acc_test', runtime: 'codex', label: 'Test', kind: 'subscription', enabled: true, credential: 'per-device' });
  store.put('accounts', account.id, AccountSchema, account, 0);
  expect(() => store.put('accounts', account.id, AccountSchema, account, 0)).toThrow('changed');
  store.db.prepare('UPDATE documents SET document=? WHERE namespace=?').run('{}', 'accounts');
  expect(() => store.get('accounts', account.id, AccountSchema)).toThrow();
});

test('member devices cannot create or open a hub database', () => {
  expect(() => new HubDatabase(homes, 'member')).toThrow('hub HTTP API');
  expect(readdirSync(join(root, 'user'))).toEqual([]);
});

test('vault encrypts secrets with random nonces and never returns them in summaries', () => {
  const store = hub(); const secret = `fixture-${randomUUID()}-sensitive`;
  const summary = store.vault.put('key_one', secret);
  store.vault.put('key_two', secret);
  expect(summary).toEqual({ schema: 'secret-summary-v1', id: 'key_one', saved: true, lastFour: secret.slice(-4) });
  expect(store.vault.forLaunch('key_one')).toBe(secret);
  const rows = store.db.prepare('SELECT document FROM secrets ORDER BY id').all().map((row) => String(row.document));
  expect(rows.every((row) => !row.includes(secret))).toBe(true);
  expect(rows[0]).not.toBe(rows[1]);
  expect(store.redactor.text(`a ${secret} b`)).toBe('a [redacted] b');
  expect(statSync(homes.at('hub', 'secret.key')).mode & 0o777).toBe(0o600);
  expect(statSync(homes.at('hub', 'jevellan.db')).mode & 0o777).toBe(0o600);
});

test('vault rejects tampered ciphertext and swapped identities without revealing data', () => {
  const store = hub(); store.vault.put('key_one', `fixture-${randomUUID()}`);
  const row = store.db.prepare('SELECT document FROM secrets WHERE id=?').get('key_one')!;
  const envelope = JSON.parse(String(row.document)) as { ciphertext: string };
  envelope.ciphertext = Buffer.from('damaged').toString('base64');
  store.db.prepare('UPDATE secrets SET document=? WHERE id=?').run(JSON.stringify(envelope), 'key_one');
  expect(() => store.vault.forLaunch('key_one')).toThrow('could not be authenticated');
  store.db.prepare('UPDATE secrets SET id=? WHERE id=?').run('key_other', 'key_one');
  expect(() => store.vault.forLaunch('key_other')).toThrow('identity does not match');
});

test('a reopened vault keeps its key and refuses to invent a replacement for a lost one', () => {
  const secret = `fixture-${randomUUID()}`;
  const store = hub(); store.vault.put('retained', secret); store.close(); database = undefined;
  const reopened = hub(); expect(reopened.vault.forLaunch('retained')).toBe(secret);
  reopened.close(); database = undefined;
  unlinkSync(homes.at('hub', 'secret.key'));
  expect(() => new HubDatabase(homes, 'hub')).toThrow('vault key is missing');
  expect(readdirSync(homes.at('hub'))).not.toContain('secret.key');
});

test.each(['.claude', '.codex', '.cursor', '.gemini', '.basic-memory'])('native %s homes and aliases are refused before writes', (name) => {
  const native = join(root, 'user', name); mkdirSync(native);
  writeFileSync(join(native, 'sentinel'), 'unchanged');
  const alias = join(root, 'alias'); symlinkSync(native, alias);
  expect(() => new Homes(native, join(root, 'user'))).toThrow('native');
  expect(() => new Homes(join(alias, 'nested'), join(root, 'user'))).toThrow('native');
  expect(readFileSync(join(native, 'sentinel'), 'utf8')).toBe('unchanged');
  expect(readdirSync(native)).toEqual(['sentinel']);
});

test('account homes are private and reject traversal and symlink escapes', () => {
  const account = homes.account('codex', 'acc_test');
  expect(statSync(account).mode & 0o777).toBe(0o700);
  expect(() => homes.account('codex', '../outside')).toThrow();
  const external = join(root, 'outside'); mkdirSync(external);
  symlinkSync(external, homes.at('alias'));
  expect(() => homes.ensure('alias', 'child')).toThrow('escapes');
  expect(readdirSync(external)).toEqual([]);
});

test('project validation never falls back to another directory or accepts a nested project root', () => {
  const repo = join(root, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Example', paths: { here: repo }, branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } });
  expect(resolveProjectPath(project, 'here')).toBe(realpathSync(repo));
  expect(() => resolveProjectPath(project, 'elsewhere')).toThrow("isn't checked out");
  expect(() => resolveProjectPath({ ...project, paths: { here: join(root, 'missing') } }, 'here')).toThrow("isn't checked out");
  mkdirSync(join(repo, 'nested'));
  expect(() => resolveProjectPath({ ...project, paths: { here: join(repo, 'nested') } }, 'here')).toThrow("isn't checked out");
});

test('minimal runtime environment drops test variables and ambient credentials', () => {
  const base = { PATH: '/usr/bin', HOME: '/fixture', USER: 'fixture', JEVELLAN_TEST_JEV_KEY: 'excluded', JEVELLAN_TEST_OPENAI_KEY: 'excluded', ANTHROPIC_API_KEY: 'ambient', CODEX_HOME: '/native', AWS_SECRET_ACCESS_KEY: 'excluded' };
  expect(minimalEnvironment('codex', '/isolated', {}, { JEVELLAN_STRETCH_TOKEN: 'scope' }, base)).toEqual({ PATH: '/usr/bin', HOME: '/isolated', USER: 'fixture', CODEX_HOME: '/isolated', JEVELLAN_STRETCH_TOKEN: 'scope' });
  expect(minimalEnvironment('claude', '/isolated', { CLAUDE_CODE_OAUTH_TOKEN: 'intended' }, {}, base)).toEqual({ PATH: '/usr/bin', HOME: '/isolated', USER: 'fixture', CLAUDE_CONFIG_DIR: '/isolated', CLAUDE_CODE_OAUTH_TOKEN: 'intended' });
  expect(() => minimalEnvironment('claude', '/isolated', { OPENAI_API_KEY: 'wrong' }, {}, base)).toThrow();
  expect(() => minimalEnvironment('codex', '/isolated', {}, { JEVELLAN_TEST_JEV_KEY: 'excluded' }, base)).toThrow();
});

test('redaction handles nested values and secrets requiring JSON escaping', () => {
  const secret = `quoted"${randomUUID()}\nsecret`; const redactor = new SecretRedactor(); redactor.add(secret);
  expect(redactor.document({ nested: [secret, { text: `before ${secret} after` }] })).toEqual({ nested: ['[redacted]', { text: 'before [redacted] after' }] });
});

test('effort mapping rounds up and unavailable models stay disabled', () => {
  expect(mapEffort('high', ['low', 'xhigh', 'max'])).toBe('xhigh');
  expect(mapEffort('max', ['low', 'high'])).toBe('high');
  const menu = seedConfiguration()['x-jevellan'].menu;
  const reconciled = reconcileMenu(menu, 'codex', [{ id: 'gpt-fixture', label: 'Fixture', efforts: ['low', 'high'] }]);
  expect(reconciled.find((model) => model.id === 'codex-gpt')).toMatchObject({ model: 'gpt-fixture', enabled: true, efforts: ['low', 'high'] });
  expect(reconcileMenu(menu, 'claude', []).filter((model) => model.runtime === 'claude').every((model) => !model.enabled && model.unavailableReason)).toBe(true);
  expect(newId('acc')).toMatch(/^acc_[0-9A-HJKMNP-TV-Z]{26}$/);
});
