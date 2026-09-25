import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CheckoutClaimSchema, CheckoutOwnership, DeviceSchema, GitWorkspace, Homes, ProjectSchema, PublicationLeaseSchema, SecretRedactor, withPublicationLease, type Project } from '../packages/core/dist/index.js';
import { HubUnavailable, MemberCheckoutStore, MemberHubClient, MemberPublicationLeases, joinHub } from '../packages/mesh/dist/index.js';
import { ConversationLedger, publishWorkspace } from '../packages/conversations/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let app: Application; let server: Server; let base: string; let origin: string; let initial: string; let project: Project;
const owner = { conversationId: 'conversation', conversationTitle: 'First work', workId: 'work' };
const other = { conversationId: 'another', conversationTitle: 'Other work', workId: 'other_work' };
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function git(cwd: string, ...args: string[]) { return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-mesh-coordination-'))); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'hub'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = app.hub.get('devices', app.device.deviceId, DeviceSchema)!;
  app.hub.put('devices', app.device.deviceId, DeviceSchema, { ...hub.document, url: base }, hub.revision);
  await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
  origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin); const left = join(root, 'left-checkout'); git(root, 'clone', origin, left);
  git(left, 'config', 'user.name', 'Fixture'); git(left, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(left, 'value.txt'), '1\n'); git(left, 'add', '-A'); git(left, 'commit', '-m', 'Seed'); git(left, 'push', '-u', 'origin', 'main'); initial = git(left, 'rev-parse', 'HEAD');
  const right = join(root, 'right-checkout'); git(root, 'clone', origin, right);
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Fixture', paths: { left, right }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); rmSync(root, { recursive: true, force: true }); });
async function member(id: string, fetcher?: typeof fetch) {
  const redactor = new SecretRedactor(); const joined = await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, { schema: 'join-device-v1', requestId: `join_${id}`, code: app.mesh.invite().code, device: { id, name: id, url: `http://127.0.0.1:${id === 'left' ? 9773 : 9774}`, os: 'linux', version: '0.1.0' } });
  const client = new MemberHubClient({ hubUrl: base, hubName: 'Fixture hub', deviceId: id, token: () => joined.membership.token, redactor, ...(fetcher ? { fetch: fetcher } : {}) });
  const homes = new Homes(join(root, `${id}-home`), join(root, 'user')); const store = new MemberCheckoutStore(client);
  return { client, homes, store, ownership: new CheckoutOwnership(store, homes, id), leases: new MemberPublicationLeases(client) };
}

test('two HTTP claims for one checkout have one winner, while separate device checkouts remain independent', async () => {
  const left = await member('left'); const right = await member('right');
  const competing = new CheckoutOwnership(left.store, left.homes, 'left');
  const results = await Promise.allSettled([left.ownership.acquire(project, owner), competing.acquire(project, other)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const winning = results[0]!.status === 'fulfilled' ? owner : other;
  await left.ownership.assert(project, winning); await right.ownership.acquire(project, owner);
  expect(app.hub.list('checkout-ownership', CheckoutClaimSchema)).toHaveLength(2);
  await expect(left.ownership.release(project, winning, { processesGone: true, commits: 'kept' })).rejects.toThrow('Unpublished');
  await left.ownership.release(project, winning, { processesGone: true, commits: 'unchanged' }); await competing.acquire(project, winning === owner ? other : owner);
  expect(existsSync(left.homes.at('hub'))).toBe(false); expect(existsSync(right.homes.at('hub'))).toBe(false);
});

test('lost claim and release replies retain the reservation and reconcile only the exact local owner on retry', async () => {
  let lose: boolean | undefined = true;
  const left = await member('left', async (...args) => {
    const response = await fetch(...args); const body = args[1]?.body;
    if (String(args[0]).endsWith('/checkout') && typeof body === 'string') {
      const request = JSON.parse(body) as { operation: string; claim?: { held: boolean } };
      if (request.operation === 'put' && request.claim?.held === lose) { lose = undefined; await response.body?.cancel(); throw new Error('Fixture lost reply'); }
    }
    return response;
  });
  await expect(left.ownership.acquire(project, owner)).rejects.toBeInstanceOf(HubUnavailable);
  expect((await left.ownership.current(project))?.held).toBe(true); expect(existsSync(left.homes.at('locks'))).toBe(false);
  await expect(left.ownership.acquire(project, other)).rejects.toThrow('First work');
  await left.ownership.acquire(project, owner); await left.ownership.assert(project, owner); lose = false;
  await expect(left.ownership.release(project, owner, { processesGone: true, commits: 'unchanged' })).rejects.toBeInstanceOf(HubUnavailable);
  expect((await left.ownership.current(project))?.held).toBe(false); expect(readdirSync(left.homes.at('locks'))).toHaveLength(1);
  await left.ownership.release(project, owner, { processesGone: true, commits: 'unchanged' }); expect(readdirSync(left.homes.at('locks'))).toHaveLength(0);
  await left.ownership.acquire(project, other);
  await expect(left.ownership.release(project, owner, { processesGone: true, commits: 'unchanged' })).rejects.toThrow('does not own'); await left.ownership.assert(project, other);
});

test('checkout HTTP refuses a different device, mismatched path keys, unrelated namespaces and stale revisions', async () => {
  const left = await member('left'); const right = await member('right'); const claim = await left.ownership.acquire(project, owner); const id = hash(`left\0${claim.path}`);
  await expect(right.store.get('checkout-ownership', id, CheckoutClaimSchema)).rejects.toMatchObject({ status: 403 });
  await expect(right.store.put('checkout-ownership', id, CheckoutClaimSchema, claim, 1)).rejects.toMatchObject({ status: 403 });
  await expect(left.store.put('checkout-ownership', hash('wrong-path'), CheckoutClaimSchema, claim, 0)).rejects.toMatchObject({ status: 403 });
  await expect(left.store.get('accounts', id, CheckoutClaimSchema)).rejects.toThrow('only for checkout');
  await expect(left.store.put('checkout-ownership', id, CheckoutClaimSchema, claim, 0)).rejects.toMatchObject({ status: 409 });
  await expect(left.store.put('checkout-ownership', id, CheckoutClaimSchema, { ...claim, ...other }, 1)).rejects.toMatchObject({ status: 409 });
  await left.ownership.assert(project, owner);
});

test('publication uses one hub clock, binds the member owner and rejects old leases after expiry and reacquisition', async () => {
  const left = await member('left'); const right = await member('right');
  const lease = await left.leases.acquire(origin, 'same_work');
  expect(Date.parse(lease.expiresAt) - Date.now()).toBeGreaterThan(110_000);
  await expect(right.leases.acquire(origin, 'same_work')).rejects.toThrow('Another work');
  await expect(right.leases.renew(lease)).rejects.toThrow('lost'); await expect(right.leases.release(lease)).rejects.toThrow('lost');
  const renewed = await left.leases.renew({ ...lease, expiresAt: '2100-01-01T00:00:00Z' });
  expect(Date.parse(renewed.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);
  const row = app.hub.get('publication-leases', hash(origin), PublicationLeaseSchema)!;
  app.hub.put('publication-leases', hash(origin), PublicationLeaseSchema, { ...row.document, expiresAt: new Date(Date.now() - 1).toISOString() }, row.revision);
  await expect(left.leases.assert({ ...renewed, expiresAt: '2100-01-01T00:00:00Z' })).rejects.toThrow('lost');
  const next = await right.leases.acquire(origin, 'same_work'); expect(next.token).not.toBe(lease.token);
  await expect(left.leases.renew(renewed)).rejects.toThrow('lost'); await expect(left.leases.release(renewed)).rejects.toThrow('lost'); await right.leases.assert(next); await right.leases.release(next);
  const results = await Promise.allSettled([left.leases.acquire(origin, 'left_work'), right.leases.acquire(origin, 'right_work')]); expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
});

test('a hub outage blocks checkout and publication effects, preserving the last local ownership file', async () => {
  let offline = false; const left = await member('left', async (...args) => { if (offline) throw new Error('Fixture offline'); return fetch(...args); });
  await left.ownership.acquire(project, owner); const lease = await left.leases.acquire(origin, owner.workId); offline = true;
  await expect(left.ownership.assert(project, owner)).rejects.toBeInstanceOf(HubUnavailable);
  await expect(left.ownership.release(project, owner, { processesGone: true, commits: 'unchanged' })).rejects.toBeInstanceOf(HubUnavailable);
  await expect(left.leases.assert(lease)).rejects.toBeInstanceOf(HubUnavailable); await expect(left.leases.acquire('another-remote', owner.workId)).rejects.toBeInstanceOf(HubUnavailable);
  expect(readdirSync(left.homes.at('locks'))).toHaveLength(1); offline = false; await left.ownership.assert(project, owner); await left.leases.assert(lease);
});

async function checkpoint(left: Awaited<ReturnType<typeof member>>) {
  await left.ownership.acquire(project, owner); const workspace = new GitWorkspace(project, 'left', left.ownership, owner); await workspace.prepare();
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n'); const checkpoint = await workspace.checkpoint('implement', 'Use two', before);
  return { workspace, checkpoint, ledger: new ConversationLedger(left.homes, owner.conversationId) };
}

test('real local Git verification and publication use member HTTP ownership and leases with no member hub database', async () => {
  const left = await member('left'); const { workspace, checkpoint: saved, ledger } = await checkpoint(left);
  expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  const result = await publishWorkspace(workspace, ledger, left.homes, left.leases, { nextStretch: () => 2, integrate: async () => false });
  expect(result).toMatchObject({ status: 'published', commit: saved.head }); expect(git(origin, 'rev-parse', 'main')).toBe(saved.head);
  expect(ledger.events().filter(event => event.type === 'verification').map(event => ledger.data(event))).toEqual([expect.objectContaining({ passed: true, treeClean: true, commit: saved.head })]);
  expect(await workspace.clean()).toBe(true); expect(existsSync(left.homes.at('hub'))).toBe(false);
  await left.ownership.release(project, owner, { processesGone: true, commits: 'published' });
}, 60_000);

test('losing the hub after fetch prevents the real publication path from pushing the already verified checkpoint', async () => {
  let offline = false; const left = await member('left', async (...args) => { if (offline) throw new Error('Fixture offline'); return fetch(...args); });
  const { workspace, checkpoint: saved, ledger } = await checkpoint(left); const fetchUpstream = workspace.fetch.bind(workspace);
  vi.spyOn(workspace, 'fetch').mockImplementationOnce(async () => { await fetchUpstream(); offline = true; }); const push = vi.spyOn(workspace, 'push');
  await expect(publishWorkspace(workspace, ledger, left.homes, left.leases, { nextStretch: () => 2, integrate: async () => false })).rejects.toBeInstanceOf(HubUnavailable);
  expect(push).not.toHaveBeenCalled(); expect(git(origin, 'rev-parse', 'main')).toBe(initial); expect(await workspace.head()).toBe(saved.head);
  expect(ledger.events().some(event => event.type === 'verification')).toBe(true);
}, 60_000);

test('a failed HTTP renewal remains a publication barrier even after the connection recovers', async () => {
  const failed = deferred(); let failRenewal = true;
  const left = await member('left', async (...args) => {
    const body = args[1]?.body;
    if (failRenewal && String(args[0]).endsWith('/publication') && typeof body === 'string' && (JSON.parse(body) as { operation: string }).operation === 'renew') { failed.resolve(); throw new Error('Fixture renewal failed'); }
    return fetch(...args);
  });
  let pushed = false;
  await expect(withPublicationLease(left.leases, origin, owner.workId, async assertLease => { await failed.promise; failRenewal = false; await assertLease(); pushed = true; }, 10)).rejects.toBeInstanceOf(HubUnavailable);
  expect(pushed).toBe(false); expect(app.hub.get('publication-leases', hash(origin), PublicationLeaseSchema)?.document.held).toBe(true);
});
