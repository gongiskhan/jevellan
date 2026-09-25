import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Homes, RiggingDelivery, RiggingDeliveryStateSchema, RiggingDisk, RiggingEntrySchema, RiggingPromotionInputSchema, RiggingStore, type RiggingDiskItem } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';

let root: string; let homes: Homes; let db: HubDatabase; let disk: RiggingDisk; let store: RiggingStore;
const account = { id: 'acc_promotion', runtime: 'claude' as const };
const write = (path: string, data: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-promotion-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); db = new HubDatabase(homes, 'hub'); disk = new RiggingDisk(homes, db.redactor); store = new RiggingStore(db, db.redactor, ['claude', 'codex']); });
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
function loose(runtime: 'claude' | 'codex' = 'claude', ref = 'skills/local') {
  const home = homes.account(runtime, account.id); write(join(home, ref, 'SKILL.md'), '# Original instructions\nUse the bundled script.\n');
  write(join(home, ref, 'scripts/run.sh'), '#!/bin/sh\necho fixture\n'); chmodSync(join(home, ref, 'scripts/run.sh'), 0o700);
  write(join(home, ref, 'assets/data.bin'), Buffer.from([0, 255, 4, 8, 0, 123]));
  return disk.list([{ ...account, runtime }]).items.find((item) => item.address.ref === ref)!;
}
function input(item: RiggingDiskItem, requestId = 'promote_fixture') { return RiggingPromotionInputSchema.parse({ schema: 'rigging-promotion-input-v1', requestId, fingerprint: item.fingerprint, name: 'Managed fixture', runtimes: { claude: true, codex: true } }); }
function promote(item: RiggingDiskItem, request = input(item)) { return disk.promote(item.runtime, item.accountId, item.id, request, store); }
function statePath(runtime = 'claude') { return homes.at('rigging', 'state', runtime, `${account.id}.json`); }
function journal(runtime = 'claude', requestId = 'promote_fixture') { return homes.at('rigging', 'promotions', runtime, account.id, `${requestId}.json`); }
const captured = (runtime: string) => store.items(runtime).filter((item) => !item.builtIn);

test.each(['claude', 'codex'] as const)('real APM promotes a whole %s bundle, retains assets across edits and parks/reinstalls it', async (runtime) => {
  const original = loose(runtime, 'skills/Local_Bundle'); const request = input(original); const view = await promote(original, request); const home = homes.account(runtime, account.id);
  const native = join(homes.userHome, `.${runtime}`); write(join(native, 'sentinel'), 'untouched');
  expect(view.item.bundle).toMatchObject({ name: 'local-bundle', fileCount: 2 }); expect(JSON.stringify(view)).not.toContain('base64');
  expect(readFileSync(join(home, 'skills/Local_Bundle/SKILL.md'), 'utf8')).toBe(view.item.content);
  const delivery = new RiggingDelivery(homes); await delivery.materialise(runtime, home, captured(runtime));
  const target = join(home, 'skills/local-bundle'); expect(existsSync(join(home, 'skills/Local_Bundle'))).toBe(false);
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe(view.item.content); expect(readFileSync(join(target, 'assets/data.bin'))).toEqual(Buffer.from([0, 255, 4, 8, 0, 123]));
  expect(lstatSync(join(target, 'scripts/run.sh')).mode & 0o111).toBe(0o100);
  const edited = store.update(view.item.id, { schema: 'update-rigging-v1', revision: view.revision, name: 'Updated fixture', content: '# Updated instructions\n', runtimes: view.item.runtimes, state: 'owned' });
  await delivery.materialise(runtime, home, captured(runtime)); expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('# Updated instructions\n'); expect(readFileSync(join(target, 'scripts/run.sh'), 'utf8')).toContain('echo fixture');
  const off = store.update(view.item.id, { schema: 'update-rigging-v1', revision: edited.revision, name: edited.item.name, content: edited.item.content, runtimes: { ...edited.item.runtimes, [runtime]: false }, state: 'owned' });
  await delivery.materialise(runtime, home, captured(runtime)); expect(existsSync(target)).toBe(false);
  disk = new RiggingDisk(homes, db.redactor); expect(await promote(original, request)).toEqual(off);
  const on = store.update(view.item.id, { schema: 'update-rigging-v1', revision: off.revision, name: off.item.name, content: off.item.content, runtimes: { ...off.item.runtimes, [runtime]: true }, state: 'owned' });
  await delivery.materialise(runtime, home, captured(runtime)); expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe(on.item.content); expect(readFileSync(join(target, 'assets/data.bin'))).toEqual(Buffer.from([0, 255, 4, 8, 0, 123]));
  const otherRuntime = runtime === 'claude' ? 'codex' : 'claude'; const other = homes.account(otherRuntime, 'acc_other'); await delivery.materialise(otherRuntime, other, captured(otherRuntime)); expect(readFileSync(join(other, 'skills/local-bundle/scripts/run.sh'), 'utf8')).toContain('echo fixture');
  expect(readdirSync(native)).toEqual(['sentinel']); expect(readFileSync(join(native, 'sentinel'), 'utf8')).toBe('untouched');
}, 120_000);

test.each(['rule', 'command'] as const)('real APM promotes a local %s and preserves an unrelated sibling', async (kind) => {
  const home = homes.account('claude', account.id); const ref = `${kind === 'rule' ? 'rules' : 'commands'}/original.md`;
  write(join(home, ref), '# Captured text\nKeep this exact instruction.\n'); write(join(home, 'rules/sibling.md'), 'Keep sibling.');
  const item = disk.list([account]).items.find((item) => item.address.ref === ref)!;
  const view = await promote(item, { ...input(item), runtimes: { claude: true, codex: false } }); await new RiggingDelivery(homes).materialise('claude', home, captured('claude'));
  const installed = disk.list([account]).items.filter((item) => item.state === 'owned'); expect(installed.some((item) => item.kind === kind)).toBe(true);
  expect(installed.some((item) => disk.detail('claude', account.id, item.id).content.includes('Keep this exact instruction.'))).toBe(true);
  expect(readFileSync(join(home, 'rules/sibling.md'), 'utf8')).toBe('Keep sibling.'); expect(view.item.content).toContain('Captured text');
}, 120_000);

test('simultaneous retries create one managed item, and conflicting requests and unsupported runtime choices are rejected', async () => {
  const item = loose(); const request = input(item); const [one, two] = await Promise.all([promote(item, request), promote(item, request)]); expect(one).toEqual(two); expect(store.list().filter((view) => !view.item.builtIn)).toHaveLength(1);
  await expect(promote(item, { ...request, name: 'Different request' })).rejects.toThrow('already used');
  const home = homes.account('claude', account.id); write(join(home, 'commands/local.md'), 'Command.'); const command = disk.list([account]).items.find((entry) => entry.kind === 'command')!;
  await expect(promote(command, input(command, 'command_request'))).rejects.toThrow('not supported');
  const next = loose('claude', 'skills/next'); await expect(promote(next, { ...input(next, 'next'), runtimes: { codex: true } })).rejects.toThrow('source runtime');
});

test('stale input, symlinks and credentials in bundled assets are rejected before capture', async () => {
  const item = loose(); const home = homes.account('claude', account.id); write(join(home, 'skills/local/assets/new.txt'), 'New outside file.'); await expect(promote(item)).rejects.toThrow('changed');
  const current = disk.list([account]).items.find((entry) => entry.id === item.id)!; const secret = `fixture-private-${crypto.randomUUID()}`; db.redactor.add(secret); write(join(home, 'skills/local/assets/private.txt'), secret);
  await expect(promote(disk.list([account]).items.find((entry) => entry.id === item.id)!)).rejects.toThrow('credentials'); expect(existsSync(journal())).toBe(false);
  rmSync(join(home, 'skills/local/assets/private.txt')); symlinkSync(join(home, 'skills/local/assets/new.txt'), join(home, 'skills/local/assets/alias.txt'));
  await expect(promote(current)).rejects.toThrow('no longer exists'); expect(existsSync(journal())).toBe(false); expect(store.list().filter((view) => !view.item.builtIn)).toEqual([]);
});

test('missing APM bundle files fail before changing the account; retry keeps the captured assets', async () => {
  const item = loose(); await promote(item); const home = homes.account('claude', account.id);
  const delivery = new RiggingDelivery(homes, async (stage) => { write(join(stage, 'apm.lock.yaml'), 'lockfile_version: "1"\ndependencies: []\n'); });
  await expect(delivery.materialise('claude', home, captured('claude'))).rejects.toThrow('every file');
  expect(readFileSync(join(home, 'skills/local/SKILL.md'), 'utf8')).toContain('Original instructions'); expect(readFileSync(join(home, 'skills/local/assets/data.bin'))).toEqual(Buffer.from([0, 255, 4, 8, 0, 123]));
  await new RiggingDelivery(homes).materialise('claude', home, captured('claude')); expect(disk.list([account]).items.find((entry) => entry.id === item.id)).toMatchObject({ state: 'owned', drifted: false });
}, 120_000);

test('interruption after claiming is visible, blocks delivery, and recovers without resetting later edits', async () => {
  const item = loose(); const request = input(item); const save = vi.spyOn(store, 'addCaptured').mockImplementationOnce(() => { throw new Error('Simulated process interruption'); });
  await expect(promote(item, request)).rejects.toThrow('interruption'); save.mockRestore(); expect(disk.list([account]).promotions).toMatchObject([{ canCancel: false, request }]);
  await expect(new RiggingDelivery(homes).materialise('claude', homes.account('claude', account.id), [])).rejects.toThrow('promotion needs to finish');
  await expect(disk.cancelPromotion('claude', account.id, item.id, { schema: 'rigging-disk-cancel-v1', requestId: request.requestId })).rejects.toThrow('already claimed');
  disk = new RiggingDisk(homes, db.redactor); const view = await promote(item, request); expect(disk.list([account]).promotions).toEqual([]);
  const edited = store.update(view.item.id, { schema: 'update-rigging-v1', revision: view.revision, name: 'Later edit', content: 'Retain this edit.', state: 'owned', runtimes: { claude: false, codex: false } });
  const saved = JSON.parse(readFileSync(journal(), 'utf8')); write(journal(), JSON.stringify({ ...saved, status: 'prepared' }));
  expect(await promote(item, request)).toEqual(edited); expect(disk.list([account]).promotions).toEqual([]);
});

test('a prepared but unclaimed capture refuses newer files and can be cancelled without changing them', async () => {
  const item = loose(); const request = input(item); const result = await promote(item, request);
  const saved = JSON.parse(readFileSync(journal(), 'utf8')); write(journal(), JSON.stringify({ ...saved, status: 'prepared' }));
  db.db.prepare('DELETE FROM documents WHERE namespace=? AND id=?').run('rigging', result.item.id); rmSync(statePath());
  const primary = join(homes.account('claude', account.id), 'skills/local/SKILL.md'); write(primary, 'Newer outside text.');
  await expect(promote(item, request)).rejects.toThrow('source changed'); expect(disk.list([account]).promotions).toMatchObject([{ canCancel: true }]);
  await disk.cancelPromotion('claude', account.id, item.id, { schema: 'rigging-disk-cancel-v1', requestId: request.requestId }); expect(disk.list([account]).promotions).toEqual([]); expect(readFileSync(primary, 'utf8')).toBe('Newer outside text.');
  await expect(promote(item, request)).rejects.toThrow('cancelled'); expect(db.get('rigging', result.item.id, RiggingEntrySchema)).toBeNull();
});

test('source edits made after a durable claim survive recovery and require attention at delivery', async () => {
  const item = loose(); const save = vi.spyOn(store, 'addCaptured').mockImplementationOnce(() => { throw new Error('Interrupted'); });
  await expect(promote(item)).rejects.toThrow('Interrupted'); save.mockRestore(); const home = homes.account('claude', account.id); write(join(home, 'skills/local/SKILL.md'), 'New outside version.');
  const view = await promote(item); expect(view.item.content).toContain('Original instructions');
  await expect(new RiggingDelivery(homes).materialise('claude', home, captured('claude'))).rejects.toThrow('preserved local changes'); expect(readFileSync(join(home, 'skills/local/SKILL.md'), 'utf8')).toBe('New outside version.');
  expect(Object.values(RiggingDeliveryStateSchema.parse(JSON.parse(readFileSync(statePath(), 'utf8'))).claims).every((claim) => !claim.pending)).toBe(true);
}, 120_000);
