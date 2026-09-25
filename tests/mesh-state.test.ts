import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CheckoutClaimSchema, DeviceSchema, Homes, ProjectSchema, RiggingDisk, SecretRedactor } from '../packages/core/dist/index.js';
import { HubProtocolError, HubUnavailable, MemberHubClient, MemberState, joinHub } from '../packages/mesh/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { JevClient } from '../packages/decisions/dist/index.js';

let root: string; let app: Application; let server: Server; let base: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-shared-state-')); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'hub'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = app.hub.get('devices', app.device.deviceId, DeviceSchema)!; app.hub.put('devices', app.device.deviceId, DeviceSchema, { ...hub.document, url: base }, hub.revision);
  await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); rmSync(root, { recursive: true, force: true }); });
async function member(id: string, fetcher?: typeof fetch) {
  const redactor = new SecretRedactor();
  const joined = await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, { schema: 'join-device-v1', requestId: `join_${id}`, code: app.mesh.invite().code, device: { id, name: id, url: `http://127.0.0.1:${id === 'left' ? 9773 : 9774}`, os: 'linux', version: '0.1.0' } });
  const client = new MemberHubClient({ hubUrl: base, hubName: 'Fixture hub', deviceId: id, token: () => joined.membership.token, redactor, ...(fetcher ? { fetch: fetcher } : {}) });
  return { state: new MemberState(client, ['codex', 'claude']), redactor };
}
function project() { return ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Fixture', paths: { left: join(root, 'left-checkout'), right: join(root, 'right-checkout') }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }); }

test('project and Jev saves reconcile lost hub replies without repeating or replacing newer writes', async () => {
  let lose = '';
  const left = await member('left', async (...args) => {
    const response = await fetch(...args); const body = args[1]?.body;
    if (typeof body === 'string' && (JSON.parse(body) as { operation?: string }).operation === lose) { lose = ''; await response.body?.cancel(); throw new Error('Simulated lost reply'); }
    return response;
  });
  const right = await member('right'); const input = project(); lose = 'project-put';
  await expect(left.state.projects.put(input, 0, 'project_lost')).rejects.toBeInstanceOf(HubUnavailable);
  const original = (await right.state.projects.get(input.id))!;
  const newer = await right.state.projects.put({ ...original.project, name: 'Later project settings' }, original.revision);
  expect(await left.state.projects.put(input, 0, 'project_lost')).toEqual(original);
  expect(await left.state.projects.get(input.id)).toEqual(newer);
  await expect(left.state.projects.put({ ...input, name: 'Reused request' }, 0, 'project_lost')).rejects.toMatchObject({ status: 409 });
  const first = `fixture-${randomUUID()}`; const latest = `fixture-${randomUUID()}`; lose = 'jev-put';
  await expect(left.state.jev.put(first, 'jev_lost')).rejects.toBeInstanceOf(HubUnavailable);
  expect(await right.state.jev.credential()).toBe(first);
  const current = await right.state.jev.put(latest, 'jev_newer');
  expect(await left.state.jev.put(first, 'jev_lost')).toEqual(current);
  expect(await right.state.jev.credential()).toBe(latest);
  await expect(left.state.jev.put(latest, 'jev_lost')).rejects.toMatchObject({ status: 409 });
  const stored = JSON.stringify(app.hub.db.prepare('SELECT document FROM documents UNION ALL SELECT document FROM secrets').all());
  expect(stored).not.toContain(first); expect(stored).not.toContain(latest);
});

test('configuration retry after a lost successful HTTP reply returns its original revision without replacing newer settings', async () => {
  let lose = true;
  const left = await member('left', async (...args) => {
    const response = await fetch(...args); const body = args[1]?.body;
    if (lose && typeof body === 'string' && (JSON.parse(body) as { operation?: string }).operation === 'configuration-put') { lose = false; await response.body?.cancel(); throw new Error('Simulated lost reply'); }
    return response;
  });
  const right = await member('right'); const original = await left.state.configuration.current();
  const input = { schema: 'config-write-v1' as const, revision: original.revision, configuration: original.configuration, clientRequestId: 'save_lost' };
  await expect(left.state.configuration.put(input)).rejects.toBeInstanceOf(HubUnavailable);
  const saved = await right.state.configuration.current(); expect(saved.revision).toBe(original.revision + 1);
  const changed = structuredClone(saved.configuration); changed['x-jevellan'].guards.pauseAfterPlan = true;
  const newer = await right.state.configuration.put({ schema: 'config-write-v1', revision: saved.revision, configuration: changed });
  expect(await left.state.configuration.put(input)).toEqual(saved);
  expect(await left.state.configuration.current()).toEqual(newer);
  await expect(left.state.configuration.put({ ...input, configuration: changed })).rejects.toMatchObject({ status: 409 });
});

test('two simulated members share configuration revisions over real HTTP and reject a stale save', async () => {
  const left = await member('left'); const right = await member('right');
  const original = await left.state.configuration.current(); expect(await right.state.configuration.current()).toEqual(original);
  const configuration = structuredClone(original.configuration); configuration['x-jevellan'].guards.maxStretchesPerWork = 7;
  const saved = await left.state.configuration.put({ schema: 'config-write-v1', revision: original.revision, configuration });
  expect(saved.changedBy).toEqual({ deviceId: 'left', source: 'ui' }); expect(await right.state.configuration.current()).toEqual(saved);
  await expect(right.state.configuration.put({ schema: 'config-write-v1', revision: original.revision, configuration: original.configuration })).rejects.toMatchObject({ status: 409 });
  expect((await right.state.configuration.history()).map(entry => entry.revision)).toContain(saved.revision);
});

test('project settings cannot change under another device’s held checkout, while observed context can update', async () => {
  const left = await member('left'); const right = await member('right'); const saved = await left.state.projects.put(project(), 0);
  expect(await right.state.projects.get('project')).toEqual(saved);
  const claim = CheckoutClaimSchema.parse({ schema: 'checkout-claim-v1', deviceId: 'left', path: saved.project.paths.left, held: true, conversationId: 'conversation', conversationTitle: 'Fixture', workId: 'work', pid: process.pid, updatedAt: new Date().toISOString() });
  app.hub.put('checkout-ownership', 'fixture_claim', CheckoutClaimSchema, claim, 0);
  await expect(right.state.projects.put({ ...saved.project, name: 'Changed' }, saved.revision)).rejects.toMatchObject({ status: 409 });
  const observed = await left.state.projects.context('project', { state: 'linked', primary: 'AGENTS.md' }, saved.revision);
  expect((await right.state.projects.get('project'))?.project.context).toEqual(observed.project.context);
  app.hub.put('checkout-ownership', 'fixture_claim', CheckoutClaimSchema, { ...claim, held: false }, 1);
  await expect(right.state.projects.put({ ...saved.project, name: 'Changed' }, saved.revision)).rejects.toMatchObject({ status: 409 });
  expect((await right.state.projects.put({ ...observed.project, name: 'Changed' }, observed.revision)).project.name).toBe('Changed');
});

test('account-local promotion recovers a lost successful hub reply with one shared bundle and preserved files', async () => {
  let lose = true;
  const left = await member('left', async (...args) => {
    const response = await fetch(...args); const body = args[1]?.body;
    if (lose && typeof body === 'string' && (JSON.parse(body) as { operation?: string }).operation === 'rigging-add-captured') { lose = false; await response.body?.cancel(); throw new Error('Simulated lost reply'); }
    return response;
  });
  const right = await member('right'); const homes = new Homes(join(root, 'left-home'), join(root, 'user')); const disk = new RiggingDisk(homes, left.redactor);
  const account = { id: 'account', runtime: 'codex' }; const folder = join(homes.account('codex', account.id), 'skills/local'); mkdirSync(join(folder, 'assets'), { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), '# Fixture instructions\nUse the asset.\n'); writeFileSync(join(folder, 'assets/data.txt'), 'Fixture asset\n');
  const item = disk.list([account]).items.find(entry => entry.address.ref === 'skills/local')!;
  const input = { schema: 'rigging-promotion-input-v1', requestId: 'promote_fixture', fingerprint: item.fingerprint, name: 'Shared fixture', runtimes: { codex: true, claude: true } };
  await expect(disk.promote('codex', account.id, item.id, input, left.state.rigging)).rejects.toBeInstanceOf(HubUnavailable);
  const saved = await disk.promote('codex', account.id, item.id, input, left.state.rigging);
  expect((await right.state.rigging.list()).filter(entry => !entry.item.builtIn)).toHaveLength(1);
  expect(await right.state.rigging.get(saved.item.id)).toEqual(saved);
  expect(readFileSync(join(folder, 'assets/data.txt'), 'utf8')).toBe('Fixture asset\n'); expect(disk.list([account]).promotions).toEqual([]);
  expect((await right.state.rigging.items('claude')).find(entry => entry.id === saved.item.id)?.bundle).toBeDefined();
});

test('Jev key summaries remain masked while authenticated members receive a launch credential', async () => {
  const left = await member('left'); const right = await member('right'); expect(await left.state.jev.summary()).toMatchObject({ id: 'jev', saved: false });
  expect(await left.state.jev.credential()).toBeUndefined(); const value = `fixture-${randomUUID()}`; await left.state.jev.put(value);
  const summary = await right.state.jev.summary(); expect(summary.saved).toBe(true); expect(JSON.stringify(summary)).not.toContain(value);
  expect(await right.state.jev.credential()).toBe(value); expect(right.redactor.text(value)).not.toContain(value);
});

test('editing a local skill during delayed hub validation preserves the edit and refuses promotion', async () => {
  let entered!: () => void; let release!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; }); let delay = true;
  const left = await member('left', async (...args) => {
    const body = args[1]?.body;
    if (delay && typeof body === 'string' && (JSON.parse(body) as { operation?: string }).operation === 'rigging-validate-captured') { delay = false; entered(); await gate; }
    return fetch(...args);
  });
  const homes = new Homes(join(root, 'left-home'), join(root, 'user')); const disk = new RiggingDisk(homes, left.redactor); const account = { id: 'account', runtime: 'codex' };
  const folder = join(homes.account('codex', account.id), 'skills/local'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'SKILL.md'), '# Original fixture\n');
  const item = disk.list([account]).items.find(entry => entry.address.ref === 'skills/local')!;
  const pending = disk.promote('codex', account.id, item.id, { schema: 'rigging-promotion-input-v1', requestId: 'delayed_fixture', fingerprint: item.fingerprint, name: 'Fixture', runtimes: { codex: true } }, left.state.rigging);
  const rejected = expect(pending).rejects.toThrow('source changed');
  try { await reached; writeFileSync(join(folder, 'SKILL.md'), '# Newer local instructions\n'); } finally { release(); }
  await rejected; expect(readFileSync(join(folder, 'SKILL.md'), 'utf8')).toBe('# Newer local instructions\n');
  expect((await left.state.rigging.list()).filter(entry => !entry.item.builtIn)).toEqual([]); expect(disk.list([account]).promotions).toMatchObject([{ canCancel: true }]);
});

test('previous successful reads never become authority when the hub is unavailable', async () => {
  let offline = false; const left = await member('left', async (...args) => { if (offline) throw new Error('Simulated network outage'); return fetch(...args); });
  await left.state.configuration.current(); await left.state.projects.put(project(), 0); await left.state.rigging.list(); offline = true;
  for (const read of [() => left.state.configuration.current(), () => left.state.projects.get('project'), () => left.state.rigging.list(), () => left.state.jev.credential()]) await expect(read()).rejects.toBeInstanceOf(HubUnavailable);
});

test('a hub credential outage prevents a provider call and remains distinct from an absent Jev key', async () => {
  let offline = false; const left = await member('left', async (...args) => { if (offline) throw new Error('Simulated outage'); return fetch(...args); });
  const provider = vi.fn<typeof fetch>(async () => Response.json({ models: [{ name: 'jev-fixture', description: 'Simulated model', release_date: '2026-09-24' }] }));
  const client = new JevClient({ key: () => left.state.jev.credential(), timeoutMs: 1000, fetch: provider });
  await expect(client.models()).rejects.toMatchObject({ kind: 'no-key' }); expect(provider).not.toHaveBeenCalled();
  await left.state.jev.put(`fixture-${randomUUID()}`); await client.models(); expect(provider).toHaveBeenCalledTimes(1);
  offline = true; await expect(client.models()).rejects.toMatchObject({ status: 503, message: 'The credential source is unavailable. Retry when it reconnects.' }); expect(provider).toHaveBeenCalledTimes(1);
});

test('a valid document with the wrong requested identity is rejected', async () => {
  let changed = false; const left = await member('left', async (...args) => {
    const response = await fetch(...args);
    if (changed && response.ok && String(args[0]).endsWith('/state')) { const body = await response.json() as { project?: { project: { id: string } } }; if (body.project) body.project.project.id = 'unrelated'; return Response.json(body); }
    return response;
  });
  await left.state.projects.put(project(), 0); changed = true;
  await expect(left.state.projects.get('project')).rejects.toBeInstanceOf(HubProtocolError);
});

test('Rigging saves recover committed replies without duplicate items or overwriting newer content', async () => {
  let lose = true;
  const left = await member('left', async (...args) => {
    const response = await fetch(...args); const body = args[1]?.body;
    if (lose && typeof body === 'string' && ['rigging-add', 'rigging-update'].includes((JSON.parse(body) as { operation: string }).operation)) { lose = false; await response.body?.cancel(); throw new Error('Simulated lost reply'); }
    return response;
  });
  const input = { schema: 'add-rigging-v1', name: 'Recoverable skill', kind: 'skill', runtimes: { claude: true }, content: 'Original content.', clientRequestId: 'rigging_add' };
  await expect(left.state.rigging.add(input)).rejects.toBeInstanceOf(HubUnavailable);
  const created = (await left.state.rigging.list()).find(row => row.item.name === input.name)!;
  const right = await member('right');
  const changed = await right.state.rigging.update(created.item.id, { schema: 'update-rigging-v1', revision: created.revision, name: 'Later name', content: 'Later content.', runtimes: created.item.runtimes, state: 'owned' });
  expect(await left.state.rigging.add(input)).toEqual(changed); expect((await left.state.rigging.list()).filter(row => !row.item.builtIn)).toHaveLength(1);
  const update = { schema: 'update-rigging-v1', revision: changed.revision, name: changed.item.name, content: 'Requested edit.', runtimes: changed.item.runtimes, state: 'owned', clientRequestId: 'rigging_update' }; lose = true;
  await expect(left.state.rigging.update(created.item.id, update)).rejects.toBeInstanceOf(HubUnavailable);
  const applied = await left.state.rigging.get(created.item.id); const latest = await right.state.rigging.update(created.item.id, { ...update, revision: applied.revision, content: 'Newer content.', clientRequestId: 'rigging_newer' });
  expect(await left.state.rigging.update(created.item.id, update)).toEqual(latest);
  await expect(left.state.rigging.update(created.item.id, { ...update, content: 'Changed captured request.' })).rejects.toMatchObject({ status: 409 });
});
