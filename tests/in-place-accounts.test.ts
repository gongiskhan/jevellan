import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSchema, DoctorControlSchema, Homes, RiggingDelivery, RiggingItemSchema, doctorControlPath, hasInteractiveClaudeLogin, readDocument } from '../packages/core/dist/index.js';
import { FakeRuntime } from '../packages/runtime-contract/dist/index.js';
import { probeClaude } from '../runtimes/claude/dist/control.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { ATTACH_MENU, named } from './helpers/attach-cli.js';

let root: string; let homes: Homes; let folder: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-in-place-'))); mkdirSync(join(root, 'user')); mkdirSync(join(root, 'folder'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); folder = join(root, 'folder');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const service = (dir: string) => `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;

test('an in-place folder is registered, resolved and kept apart from Jevellan-owned homes', () => {
  expect(homes.inPlace('claude', 'acc_one')).toBeUndefined();
  expect(homes.registerInPlace('claude', 'acc_one', folder)).toBe(folder);
  expect(homes.inPlace('claude', 'acc_one')).toBe(folder); expect(homes.account('claude', 'acc_one')).toBe(folder);
  expect(homes.inPlace('claude', 'acc_two')).toBeUndefined(); expect(homes.inPlace('codex', 'acc_one')).toBeUndefined();
  expect(homes.account('claude', 'acc_two')).toBe(join(homes.root, 'homes', 'claude', 'acc_two'));
  expect(JSON.parse(readFileSync(join(homes.root, 'homes', 'in-place.json'), 'utf8'))).toEqual({ schema: 'in-place-homes-v1', homes: { 'claude/acc_one': folder } });
  // A second registration keeps the first, and a new Homes over the same root reads it back.
  const other = join(root, 'other'); mkdirSync(other); homes.registerInPlace('codex', 'acc_one', other);
  expect(homes.inPlace('claude', 'acc_one')).toBe(folder); expect(new Homes(join(root, 'data'), join(root, 'user')).inPlace('codex', 'acc_one')).toBe(other);
});

test('registering an in-place account never creates or changes the folder, and a symlink resolves to its target', () => {
  writeFileSync(join(folder, 'marker'), 'kept'); const before = readdirSync(folder);
  const link = join(root, 'link'); symlinkSync(folder, link);
  expect(homes.registerInPlace('claude', 'acc_one', link)).toBe(folder); expect(homes.account('claude', 'acc_one')).toBe(folder);
  expect(readdirSync(folder)).toEqual(before); expect(readFileSync(join(folder, 'marker'), 'utf8')).toBe('kept');
  expect(existsSync(join(homes.root, 'homes', 'claude', 'acc_one'))).toBe(false);
});

test('registration refuses relative paths, missing folders, files, and folders in, around or equal to the Jevellan home and the user home', () => {
  const file = join(root, 'a-file'); writeFileSync(file, 'x'); homes.ensure('homes');
  expect(() => homes.registerInPlace('claude', 'acc_one', 'relative/folder')).toThrow('must be an absolute path');
  expect(() => homes.registerInPlace('claude', 'acc_one', join(root, 'missing'))).toThrow('is not a folder');
  expect(() => homes.registerInPlace('claude', 'acc_one', file)).toThrow('is not a folder');
  expect(() => homes.registerInPlace('claude', 'acc_one', homes.root)).toThrow('outside the Jevellan home');
  expect(() => homes.registerInPlace('claude', 'acc_one', join(homes.root, 'homes'))).toThrow('outside the Jevellan home');
  expect(() => homes.registerInPlace('claude', 'acc_one', root)).toThrow('outside the Jevellan home'); // contains the Jevellan home
  expect(() => homes.registerInPlace('claude', 'acc_one', homes.userHome)).toThrow('outside the Jevellan home');
  expect(() => homes.registerInPlace('../claude', 'acc_one', folder)).toThrow(); expect(() => homes.registerInPlace('claude', 'a/b', folder)).toThrow();
  expect(homes.inPlace('claude', 'acc_one')).toBeUndefined(); expect(existsSync(join(homes.root, 'homes', 'in-place.json'))).toBe(false);
});

test('an interactive Claude login is a credentials file, or on macOS a keychain entry named for the folder, and nothing else', () => {
  const keychain = vi.fn<(service: string) => boolean>(() => false);
  expect(hasInteractiveClaudeLogin(folder, 'linux', keychain)).toBe(false); expect(hasInteractiveClaudeLogin(folder, 'darwin', () => true)).toBe(true);
  writeFileSync(join(folder, '.credentials.json'), '{}'); expect(hasInteractiveClaudeLogin(folder, 'linux', keychain)).toBe(true);
  expect(hasInteractiveClaudeLogin(folder, 'darwin', keychain)).toBe(true); expect(keychain).not.toHaveBeenCalled(); // the file settles it
  rmSync(join(folder, '.credentials.json'));
  const hit = vi.fn((name: string) => name === service(folder));
  expect(hasInteractiveClaudeLogin(folder, 'darwin', hit)).toBe(true); expect(hit).toHaveBeenCalledExactlyOnceWith(service(folder));
  expect(hasInteractiveClaudeLogin(folder, 'linux', hit)).toBe(false); expect(hit).toHaveBeenCalledTimes(1); // linux never asks the keychain
  const miss = vi.fn(() => false); expect(hasInteractiveClaudeLogin(folder, 'darwin', miss)).toBe(false); expect(miss).toHaveBeenCalledTimes(1);
  expect(service(folder)).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/u); expect(service(folder)).not.toBe(service(join(root, 'user')));
});

const skill = () => RiggingItemSchema.parse({ schema: 'rigging-item-v1', id: 'local', runtime: 'claude', name: 'Local', kind: 'skill', state: 'owned', enabled: true, content: 'Skill body.', updatedAt: '2026-09-24T00:00:00Z' });
const SKIPPED = [{ itemId: 'local', applied: false, reason: 'This account uses your own folder in place.' }];

test('Rigging leaves an in-place folder alone and reports why, while a Jevellan-owned home still receives it', async () => {
  const runner = vi.fn(async (cwd: string) => { mkdirSync(join(cwd, '.claude/skills/local'), { recursive: true }); writeFileSync(join(cwd, '.claude/skills/local/SKILL.md'), 'Skill body.'); writeFileSync(join(cwd, 'apm.lock.yaml'), 'lockfile_version: "1"\ndependencies: []\n'); });
  const delivery = new RiggingDelivery(homes, runner);
  const own = join(root, 'acc_one'); mkdirSync(own); writeFileSync(join(own, 'marker'), 'kept'); homes.registerInPlace('claude', 'acc_one', own);
  expect(await delivery.materialise('claude', homes.account('claude', 'acc_one'), [skill()])).toEqual(SKIPPED);
  expect(readdirSync(own)).toEqual(['marker']); expect(runner).not.toHaveBeenCalled(); expect(existsSync(homes.at('rigging', 'state', 'claude', 'acc_one.json'))).toBe(false);
  const results = await delivery.materialise('claude', homes.account('claude', 'acc_two'), [skill()]);
  expect(results).toEqual([{ itemId: 'local', applied: true }]); expect(runner).toHaveBeenCalledTimes(1); expect(readFileSync(join(homes.account('claude', 'acc_two'), 'skills/local/SKILL.md'), 'utf8')).toBe('Skill body.');
});

// Adapters call materialiseRigging(home, items) with the folder only, so an in-place folder is recognised by its path, whatever it is called.
test('Rigging skips an in-place folder whatever the folder is called', async () => {
  const delivery = new RiggingDelivery(homes, vi.fn(async () => undefined));
  writeFileSync(join(folder, 'marker'), 'kept'); homes.registerInPlace('claude', 'acc_one', folder);
  expect(await delivery.materialise('claude', homes.account('claude', 'acc_one'), [skill()])).toEqual(SKIPPED); expect(readdirSync(folder)).toEqual(['marker']);
});

const subscription = (home: string, env: Record<string, string> = {}) => ({
  account: AccountSchema.parse({ schema: 'account-v2', id: 'acc_one', runtime: 'claude', label: 'Own', kind: 'subscription', enabled: true, credential: 'per-device', ceilingPct: 90 }), home, env });
test('a subscription account without a token is ready when its folder holds an interactive login, and needs a login otherwise', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
  expect(await probeClaude(subscription(folder), fetcher)).toEqual({ auth: 'needs-login' });
  writeFileSync(join(folder, '.credentials.json'), '{}');
  expect(await probeClaude(subscription(folder), fetcher)).toEqual({ auth: 'ready' }); expect(fetcher).not.toHaveBeenCalled();
  // An interactive login does not excuse an API-key account, which still needs its key.
  const apiKey = { ...subscription(folder), account: AccountSchema.parse({ schema: 'account-v2', id: 'acc_key', runtime: 'claude', label: 'Key', kind: 'api-key', enabled: true, credential: 'shared', ceilingPct: 90, secretRef: 'key_secret', paidUse: 'never' }) };
  expect(await probeClaude(apiKey, fetcher)).toEqual({ auth: 'needs-login' });
});

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const addInPlace = async (body: Record<string, unknown>) => {
  const control = readDocument(doctorControlPath(f!.homes), DoctorControlSchema);
  const response = await fetch(`${control.origin}/api/local/accounts/in-place`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'owner-in-place-account-request-v1', ...body }) });
  return { status: response.status, body: await response.json() as { ok: boolean; text: string } };
};

test('POST /api/local/accounts/in-place adds a per-device account that runs in the folder, and refuses a folder with no login', async () => {
  f = await projectFixture({ control: true, menu: ATTACH_MENU, runtimes: { fake: new FakeRuntime(), claude: named('claude') } });
  const own = join(f.homes.userHome, 'own-claude'); mkdirSync(own); const dir = realpathSync(own);
  const empty = await addInPlace({ label: 'own', runtime: 'claude', folder: dir });
  expect(empty).toEqual({ status: 200, body: { schema: 'owner-in-place-account-result-v1', ok: false, text: expect.stringContaining('has no Claude login') } });
  expect((await f.app.accounts.list()).some(row => row.account.label === 'own')).toBe(false);
  writeFileSync(join(dir, '.credentials.json'), '{}');
  const added = await addInPlace({ label: 'own', runtime: 'claude', folder: dir });
  expect(added.status).toBe(200); expect(added.body).toMatchObject({ schema: 'owner-in-place-account-result-v1', ok: true }); expect(added.body.text).toMatch(new RegExp(`^Added account own \\(claude\\) using ${dir} in place: `, 'u'));
  const row = (await f.app.accounts.list()).find(candidate => candidate.account.label === 'own')!;
  expect(row.account).toMatchObject({ runtime: 'claude', kind: 'subscription', credential: 'per-device', enabled: true });
  expect(f.homes.account('claude', row.account.id)).toBe(dir); expect(f.homes.inPlace('claude', row.account.id)).toBe(dir);
  expect(readdirSync(dir)).toEqual(['.credentials.json']); // nothing written into the owner's folder
  expect((await addInPlace({ label: 'OWN', runtime: 'claude', folder: dir })).body).toEqual({ schema: 'owner-in-place-account-result-v1', ok: false, text: 'There is already an account OWN.' });
  await expect(f.app.accounts.beginLogin(row.account.id, 'in_place_login')).rejects.toMatchObject({ status: 409 });
  await expect(f.app.ownerLogins.start('project', 'own', false)).rejects.toMatchObject({ code: 'in_place' });
});

test('a Codex folder needs an auth file, and a folder inside the Jevellan home is refused', async () => {
  f = await projectFixture({ control: true, menu: ATTACH_MENU, runtimes: { fake: new FakeRuntime(), claude: named('claude'), codex: named('codex') } });
  const own = join(f.homes.userHome, 'own-codex'); mkdirSync(own); const dir = realpathSync(own);
  expect(await addInPlace({ label: 'cx', runtime: 'codex', folder: dir })).toMatchObject({ body: { ok: false, text: expect.stringContaining('has no Codex login') } });
  writeFileSync(join(dir, 'auth.json'), '{}'); expect((await addInPlace({ label: 'cx', runtime: 'codex', folder: dir })).body.ok).toBe(true);
  const inside = join(f.homes.root, 'inside'); mkdirSync(inside); writeFileSync(join(inside, '.credentials.json'), '{}');
  const refused = await addInPlace({ label: 'inside', runtime: 'claude', folder: inside });
  expect(refused.status).toBeGreaterThanOrEqual(400); expect(JSON.stringify(refused.body)).toContain('outside the Jevellan home');
});
