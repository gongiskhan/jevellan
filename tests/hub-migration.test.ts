import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AccountSchema, AccountStatusSchema, DaemonOwnership, DeviceConfigSchema, DeviceSchema, Homes, HubImportActivationSchema, HubImportReceiptSchema,
  ProjectSchema, assertHubNotMoved, readDocument, seedConfiguration, writeDocument } from '../packages/core/dist/index.js';
import { HubDatabase, UiAuth } from '../packages/mesh/dist/index.js';
import { exportHub, importHub, recoverHubImport } from '../packages/cli/dist/hub-migration.js';
import { hubCommand } from '../packages/cli/dist/hub-command.js';
import { ConversationLedger, ConversationWork } from '../packages/conversations/dist/index.js';
import { Application } from '../apps/daemon/dist/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const passphrase = 'migration fixture phrase';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-hub-migration-')); roots.push(root);
  const user = join(root, 'user'); mkdirSync(user);
  const source = new Homes(join(root, 'source'), user), destination = new Homes(join(root, 'destination'), user);
  const device = (homes: Homes, id: string) => writeDocument(homes.at('device.json'), DeviceConfigSchema, { schema: 'device-config-v1', deviceId: id,
    name: id, role: 'hub', hubUrl: `https://${id}.example.test`, url: `https://${id}.example.test`, version: '0.1.0' });
  source.ensure(); destination.ensure(); device(source, 'dev_mini'); device(destination, 'dev_pro');
  const hub = new HubDatabase(source, 'hub'); hub.configuration.put(seedConfiguration(), 0, { deviceId: 'dev_mini', source: 'install' });
  hub.put('devices', 'dev_mini', DeviceSchema, { schema: 'device-v1', id: 'dev_mini', name: 'Mini', role: 'hub', url: 'https://dev_mini.example.test', os: 'darwin', version: '0.1.0', joinedAt: new Date().toISOString() }, 0);
  const archive = join(root, 'hub.enc');
  return { root, source, destination, hub, archive };
}
test('a migrated hub replays its real conversations on the new owner and opens Project Settings without rewriting history', async () => {
  const f = fixture();
  f.hub.put('projects', 'project_local', ProjectSchema, { schema: 'project-v1', id: 'project_local', name: 'Local', paths: { dev_mini: f.source.at('checkouts', 'local') },
    branchPolicy: 'main', memory: { mode: 'device', dir: 'memory' }, context: { state: 'none' } }, 0);
  const ledger = new ConversationLedger(f.source, 'con_real'), work = new ConversationWork(ledger);
  work.create({ title: 'Retained history', projectId: 'project_local', ownerDeviceId: 'dev_mini' });
  work.message('Keep this request exactly.', 'owner_request');
  work.close('done');
  const before = work.load(); const history = readFileSync(ledger.segments()[0]!);
  const blob = ledger.putBlob({ preserved: 'historical content' }); const bytes = readFileSync(join(ledger.dir, blob.ref));
  f.hub.close();
  await exportHub({ homes: f.source, out: f.archive, destinationName: 'Pro', passphrase });
  await importHub({ homes: f.destination, archive: f.archive, passphrase });
  const app = new Application({ homes: f.destination, timers: false, runtimes: () => new Map() });
  try {
    await app.conversations.ready;
    expect((await app.conversations.projects()).projects.map(row => row.project.id)).toEqual(['project_local']);
    const after = new ConversationWork(new ConversationLedger(f.destination, 'con_real')).load();
    expect(after).toEqual({ ...before, conversation: { ...before.conversation, ownerDeviceId: 'dev_pro' } });
    expect(readFileSync(f.destination.at('conversations', 'con_real', 'ledger', '000001.jsonl')).subarray(0, history.length)).toEqual(history);
    expect(readFileSync(f.destination.at('conversations', 'con_real', blob.ref))).toEqual(bytes);
  } finally { await app.close(); }
});
test.each(['sourceDeviceId', 'destinationDeviceId'] as const)('a different migration %s cannot adopt a conversation', async field => {
  const f = fixture(); const ledger = new ConversationLedger(f.source, 'con_guard');
  new ConversationWork(ledger).create({ title: 'Keep ownership', projectId: 'project_local', ownerDeviceId: 'dev_mini' });
  const history = readFileSync(ledger.segments()[0]!); f.hub.close();
  await exportHub({ homes: f.source, out: f.archive, destinationName: 'Pro', passphrase });
  const receipt = await importHub({ homes: f.destination, archive: f.archive, passphrase });
  writeDocument(f.destination.at('hub-import.json'), HubImportReceiptSchema, { ...receipt, [field]: 'dev_other' });
  const app = new Application({ homes: f.destination, timers: false, runtimes: () => new Map() });
  try {
    await expect(app.conversations.ready).rejects.toThrow('A conversation directory belongs to another device.');
    expect(readFileSync(f.destination.at('conversations', 'con_guard', 'ledger', '000001.jsonl'))).toEqual(history);
  } finally { await app.close(); }
});
test('encrypted migration preserves the vault, sign-in, history and settings, rebinds identity, and drops Codex auth and caches', async () => {
  const f = fixture(); const login = new UiAuth(f.hub, f.hub.vault, 'dev_mini'); await login.setup({ schema: 'passphrase-input-v1', passphrase: 'ui fixture phrase' });
  f.hub.vault.put('claude_credential', 'fixture-sensitive-value');
  for (const runtime of ['claude', 'codex']) {
    const id = `acc_${runtime}`;
    f.hub.put('accounts', id, AccountSchema, { schema: 'account-v1', id, runtime, label: runtime, kind: 'subscription', enabled: true, ceilingPct: 90,
      credential: runtime === 'codex' ? 'per-device' : 'shared', ...(runtime === 'claude' ? { secretRef: 'claude_credential' } : {}) }, 0);
    f.hub.put('account-statuses', createHash('sha256').update(`${id}\0dev_mini`).digest('hex'), AccountStatusSchema,
      { schema: 'account-status-v2', accountId: id, deviceId: 'dev_mini', auth: 'ready', observedAt: new Date().toISOString() }, 0);
  }
  f.hub.put('projects', 'project_local', ProjectSchema, { schema: 'project-v1', id: 'project_local', name: 'Local', paths: { dev_mini: f.source.at('checkouts', 'local') },
    allowedDevices: ['dev_mini'], branchPolicy: 'main', memory: { mode: 'device', dir: 'memory' }, context: { state: 'none' }, testCommand: 'npm test' }, 0);
  f.hub.put('projects', 'project_external', ProjectSchema, { schema: 'project-v1', id: 'project_external', name: 'External', paths: { dev_mini: join(f.root, 'owner-checkout') },
    allowedDevices: ['dev_mini'], branchPolicy: 'main', memory: { mode: 'device', dir: 'memory' }, context: { state: 'none' } }, 0);
  const native = join(f.source.account('codex', 'acc_codex'), 'auth.json'); writeFileSync(native, 'fixture rotating login');
  const cache = f.source.ensure('homes', 'claude', 'acc_claude', 'Library', 'Caches'); writeFileSync(join(cache, 'cache'), 'browser cache');
  const history = f.source.ensure('conversations', 'con_fixture', 'ledger'); const bytes = '{"historical":"dev_mini"}\n'; writeFileSync(join(history, '000001.jsonl'), bytes);
  writeFileSync(f.destination.at('install.json'), '{"installation":"retained"}');
  writeFileSync(join(f.destination.ensure('app', '0.1.0'), 'release'), 'retained release');
  f.hub.close();
  const manifest = await exportHub({ homes: f.source, out: f.archive, destinationName: 'Pro', passphrase });
  expect(manifest.excluded.some(entry => entry.path.endsWith('auth.json'))).toBe(true);
  expect(manifest.excluded.some(entry => entry.path.endsWith('Library/Caches'))).toBe(true);
  const encrypted = readFileSync(f.archive); expect(encrypted.includes(Buffer.from('fixture-sensitive-value'))).toBe(false); expect(encrypted.includes(Buffer.from(passphrase))).toBe(false);
  expect(statSync(f.archive).mode & 0o077).toBe(0); expect(readFileSync(native, 'utf8')).toBe('fixture rotating login');
  expect(() => assertHubNotMoved(f.source)).toThrow('This hub moved to Pro.'); expect(() => assertHubNotMoved(f.source, true)).not.toThrow();
  const receipt = await importHub({ homes: f.destination, archive: f.archive, passphrase });
  expect(receipt.needsLoginAccountIds).toEqual(['acc_codex']); expect(receipt.unboundProjectIds).toEqual(['project_external']);
  expect(readDocument(f.destination.at('device.json'), DeviceConfigSchema).deviceId).toBe('dev_pro');
  expect(readFileSync(f.destination.at('install.json'), 'utf8')).toBe('{"installation":"retained"}');
  expect(readFileSync(f.destination.at('app', '0.1.0', 'release'), 'utf8')).toBe('retained release');
  expect(readFileSync(f.destination.at('conversations', 'con_fixture', 'ledger', '000001.jsonl'), 'utf8')).toBe(bytes);
  expect(existsSync(f.destination.at('homes', 'codex', 'acc_codex', 'auth.json'))).toBe(false);
  const moved = new HubDatabase(f.destination, 'hub');
  try {
    expect(moved.vault.forLaunch('claude_credential')).toBe('fixture-sensitive-value');
    expect(moved.get('devices', 'dev_mini', DeviceSchema)).toBeNull(); expect(moved.get('devices', 'dev_pro', DeviceSchema)?.document.role).toBe('hub');
    expect(moved.get('projects', 'project_local', ProjectSchema)?.document.paths.dev_pro).toBe(f.destination.at('checkouts', 'local'));
    expect(moved.get('projects', 'project_external', ProjectSchema)?.document.paths.dev_pro).toBeUndefined();
    const auth = new UiAuth(moved, moved.vault, 'dev_pro'); const token = await auth.login({ schema: 'passphrase-input-v1', passphrase: 'ui fixture phrase' }, 'fixture'); expect(auth.verify(token)).toBeTruthy();
  } finally { moved.close(); }
});
test.each(['wrong passphrase', 'damaged archive'])('an import with %s preserves the fresh installation and publishes no data', async mode => {
  const f = fixture(); f.hub.close(); await exportHub({ homes: f.source, out: f.archive, destinationName: 'Pro', passphrase });
  if (mode === 'damaged archive') { const bytes = readFileSync(f.archive); bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 1; writeFileSync(f.archive, bytes); }
  const before = readFileSync(f.destination.at('device.json'));
  await expect(importHub({ homes: f.destination, archive: f.archive, passphrase: mode === 'wrong passphrase' ? 'wrong fixture phrase' : passphrase })).rejects.toThrow('authenticated');
  expect(readFileSync(f.destination.at('device.json'))).toEqual(before); expect(existsSync(f.destination.at('hub'))).toBe(false);
  expect(existsSync(`${f.destination.root}.import-operation.json`)).toBe(false);
});
test('live daemon ownership and populated destinations refuse migration without changing data', async () => {
  const f = fixture(); f.hub.close(); const owner = new DaemonOwnership(f.source);
  try { await expect(exportHub({ homes: f.source, out: f.archive, destinationName: 'Pro', passphrase })).rejects.toThrow('Stop'); }
  finally { owner.close(); }
  await exportHub({ homes: f.source, out: f.archive, destinationName: 'Pro', passphrase });
  const destination = new HubDatabase(f.destination, 'hub'); destination.vault.put('owner_value', 'preserved'); destination.close();
  await expect(importHub({ homes: f.destination, archive: f.archive, passphrase })).rejects.toThrow('fresh installation');
  const preserved = new HubDatabase(f.destination, 'hub'); try { expect(preserved.vault.forLaunch('owner_value')).toBe('preserved'); } finally { preserved.close(); }
});
test('a failure before activation preserves the original destination and the encrypted source backup', async () => {
  const f = fixture(); f.hub.close(); await exportHub({ homes: f.source, out: f.archive, destinationName: 'Pro', passphrase });
  const before = readFileSync(f.destination.at('device.json'));
  await expect(importHub({ homes: f.destination, archive: f.archive, passphrase, beforeActivate: () => { throw new Error('simulated activation failure'); } })).rejects.toThrow('simulated activation failure');
  expect(readFileSync(f.destination.at('device.json'))).toEqual(before); expect(existsSync(f.archive)).toBe(true);
});
test('recovery after the old-home rename restores the original home and refuses unexpected recovery paths', async () => {
  const f = fixture(); f.hub.close(); const stage = `${f.destination.root}.import-stage_fixture`, backup = `${f.destination.root}.before-import-backup_fixture`;
  const before = readFileSync(f.destination.at('device.json')); mkdirSync(stage); renameSync(f.destination.root, backup);
  writeDocument(`${f.destination.root}.import-operation.json`, HubImportActivationSchema, { schema: 'hub-import-activation-v1', exportId: 'export_fixture', home: f.destination.root, stage, backup });
  expect(() => assertHubNotMoved(f.destination)).toThrow('pending'); await recoverHubImport(f.destination);
  expect(readFileSync(f.destination.at('device.json'))).toEqual(before); expect(existsSync(stage)).toBe(false);
  writeDocument(`${f.destination.root}.import-operation.json`, HubImportActivationSchema, { schema: 'hub-import-activation-v1', exportId: 'export_fixture', home: f.destination.root, stage: join(f.root, 'unrelated'), backup });
  await expect(recoverHubImport(f.destination)).rejects.toThrow('invalid'); expect(existsSync(`${f.destination.root}.import-operation.json`)).toBe(true);
});
test('the CLI accepts no passphrase argument and never prints the hidden prompt answer', async () => {
  const printed: unknown[][] = []; vi.spyOn(console, 'log').mockImplementation((...args) => { printed.push(args); });
  const prompt = vi.fn(async () => passphrase); const exported = vi.fn(async () => ({ entries: [], excluded: [] })) as unknown as typeof exportHub;
  await hubCommand(['export', '--out', '/tmp/fixture.enc', '--to', 'Pro'], { prompt, export: exported });
  expect(prompt).toHaveBeenCalledTimes(2); expect(JSON.stringify(printed)).not.toContain(passphrase);
  await expect(hubCommand(['export', '--out', '/tmp/fixture.enc', '--to', 'Pro', '--passphrase', passphrase], { prompt, export: exported })).rejects.toThrow('Usage');
});

test('a destination with local work but no hub DB is never overwritten', async () => {
  const f = fixture(); f.hub.close(); await exportHub({ homes: f.source, out: f.archive, destinationName: 'Pro', passphrase });
  writeFileSync(join(f.destination.ensure('conversations'), 'owner-work'), 'preserved');
  await expect(importHub({ homes: f.destination, archive: f.archive, passphrase })).rejects.toThrow('Existing local work was preserved');
  expect(readFileSync(f.destination.at('conversations', 'owner-work'), 'utf8')).toBe('preserved');
});
