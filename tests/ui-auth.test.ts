import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Homes } from '../packages/core/dist/index.js';
import { HubDatabase, UiAuth, sessionCookie, sessionFromCookie } from '../packages/mesh/dist/index.js';

let root: string; let hub: HubDatabase; let auth: UiAuth;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-auth-')); mkdirSync(join(root, 'user')); hub = new HubDatabase(new Homes(join(root, 'user', '.jevellan'), join(root, 'user')), 'hub'); auth = new UiAuth(hub, hub.vault, 'here'); });
afterEach(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
const input = (passphrase: string) => ({ schema: 'passphrase-input-v1', passphrase });

test('setup stores a scrypt hash and concurrent setup has exactly one winner', async () => {
  const first = `fixture-${randomUUID()}`; const second = `fixture-${randomUUID()}`;
  const results = await Promise.allSettled([auth.setup(input(first)), auth.setup(input(second))]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const row = JSON.stringify(hub.db.prepare('SELECT document FROM documents').all()); expect(row).not.toContain(first); expect(row).not.toContain(second);
  expect(hub.db.prepare('SELECT count(*) AS total FROM secrets').get()?.total).toBe(1);
  expect(auth.state(undefined)).toMatchObject({ configured: true, authenticated: false });
});

test('signed sessions reject tampering, another device and logout replay', async () => {
  const passphrase = `fixture-${randomUUID()}`; const token = await auth.setup(input(passphrase));
  const cookie = sessionCookie(token, true); expect(cookie).toContain('HttpOnly; SameSite=Strict'); expect(cookie).toContain('; Secure'); expect(sessionFromCookie(cookie)).toBe(token);
  expect(auth.verify(token)?.deviceId).toBe('here');
  expect(auth.verify(`${token.slice(0, -2)}xx`)).toBeNull();
  expect(new UiAuth(hub, hub.vault, 'elsewhere').verify(token)).toBeNull();
  auth.logout(token); expect(auth.verify(token)).toBeNull();
  const fresh = await auth.login(input(passphrase), 'local'); expect(auth.verify(fresh)).not.toBeNull();
});

test('incorrect passphrases fail and repeated attempts are bounded', async () => {
  await auth.setup(input(`fixture-${randomUUID()}`));
  for (let i = 0; i < 5; i++) await expect(auth.login(input('wrong fixture passphrase'), 'same-address')).rejects.toMatchObject({ status: 401 });
  await expect(auth.login(input('wrong fixture passphrase'), 'same-address')).rejects.toMatchObject({ status: 429 });
  expect(auth.verify('invalid')).toBeNull();
});
