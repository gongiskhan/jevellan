import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Application, createDaemon } from '../../apps/daemon/dist/index.js';
import { DeviceConfigSchema, DeviceSchema, Homes, ProjectSchema, seedConfiguration, writeDocument } from '../../packages/core/dist/index.js';
import { ConversationLedger, ConversationWork } from '../../packages/conversations/dist/index.js';
import { HubDatabase, UiAuth } from '../../packages/mesh/dist/index.js';
import { exportHub, importHub } from '../../packages/cli/dist/hub-migration.js';
import { expect, test } from './fixtures.js';

// Real encrypted import, Git, history replay and HTTP; isolated fixture identity and no provider turns.
test('migrated conversation history and Project Settings stay usable on the new hub', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-migration-browser-'));
  const user = join(root, 'user'); mkdirSync(user);
  const source = new Homes(join(root, 'source'), user), destination = new Homes(join(root, 'destination'), user);
  const checkout = join(root, 'checkout'); mkdirSync(checkout);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(checkout, 'README.md'), 'Migration browser fixture\n'); git('add', 'README.md'); git('commit', '-m', 'Seed');
  for (const [homes, deviceId] of [[source, 'dev_before'], [destination, 'dev_after']] as const) {
    homes.ensure(); writeDocument(homes.at('device.json'), DeviceConfigSchema, { schema: 'device-config-v1', deviceId, name: deviceId,
      role: 'hub', hubUrl: `https://${deviceId}.example.test`, url: `https://${deviceId}.example.test`, version: '0.3.0' });
  }
  const hub = new HubDatabase(source, 'hub');
  hub.configuration.put(seedConfiguration(), 0, { deviceId: 'dev_before', source: 'install' });
  hub.put('devices', 'dev_before', DeviceSchema, { schema: 'device-v1', id: 'dev_before', name: 'Before', role: 'hub', url: 'https://dev_before.example.test',
    os: 'darwin', version: '0.3.0', joinedAt: new Date().toISOString() }, 0);
  hub.put('projects', 'project_fixture', ProjectSchema, { schema: 'project-v1', id: 'project_fixture', name: 'Migration fixture', paths: { dev_before: checkout },
    branchPolicy: 'main', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
  const passphrase = 'migration browser fixture passphrase';
  await new UiAuth(hub, hub.vault, 'dev_before').setup({ schema: 'passphrase-input-v1', passphrase });
  const ledger = new ConversationLedger(source, 'con_fixture'), work = new ConversationWork(ledger);
  work.create({ title: 'Retained conversation', projectId: 'project_fixture', ownerDeviceId: 'dev_before' });
  work.message('My original work stays here.', 'request_fixture'); work.close('done');
  const history = readFileSync(ledger.segments()[0]!); hub.close();
  const archive = join(root, 'migration.enc');
  await exportHub({ homes: source, out: archive, destinationName: 'After', passphrase });
  await importHub({ homes: destination, archive, passphrase, projectPaths: { project_fixture: checkout } });
  const app = new Application({ homes: destination, timers: false, runtimes: () => new Map() });
  const server = createDaemon({ application: app });
  try {
    await app.conversations.ready;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await page.goto(url); await page.getByRole('textbox', { name: 'Passphrase', exact: true }).fill(passphrase);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Migration fixture', exact: true })).toBeVisible();
    await page.goto(`${url}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'Migration fixture', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Path on dev_after')).toHaveValue(checkout);
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await page.screenshot({ path: `docs/acceptance/migrated-project-settings-${info.project.name}.png` });
    const response = await page.request.get(`${url}/api/conversations/con_fixture`);
    expect(response.ok()).toBe(true);
    expect(JSON.stringify(await response.json())).toContain('My original work stays here.');
    await page.goto(`${url}/conversations/con_fixture`);
    await expect(page.getByRole('heading', { name: 'Retained conversation', exact: true })).toBeVisible();
    await expect(page.getByLabel('Conversation timeline', { exact: true }).getByText('My original work stays here.', { exact: true })).toBeVisible();
    await page.screenshot({ path: `docs/acceptance/migrated-conversation-history-${info.project.name}.png` });
    expect(readFileSync(destination.at('conversations', 'con_fixture', 'ledger', '000001.jsonl')).subarray(0, history.length)).toEqual(history);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await app.close(); rmSync(root, { recursive: true, force: true });
  }
});
