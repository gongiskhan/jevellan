import { afterEach, beforeEach, expect, test } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { Homes, RiggingDelivery, RiggingDisk, RiggingItemSchema, SecretRedactor, type RiggingDiskItem } from '../packages/core/dist/index.js';

let root: string; let homes: Homes; let disk: RiggingDisk; let home: string;
const account = { id: 'acc_one', runtime: 'claude' };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function write(path: string, contents: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-rigging-disk-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); home = homes.account('claude', account.id); disk = new RiggingDisk(homes); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function list() { return disk.list([account]); }
function named(name: string, state?: RiggingDiskItem['state']) { return list().items.find((item) => item.name === name && (!state || item.state === state))!; }
function edit(item: RiggingDiskItem, content: string) { return disk.edit(item.runtime, item.accountId, item.id, { schema: 'rigging-disk-write-v1', fingerprint: item.fingerprint, content }); }
function move(item: RiggingDiskItem, requestId: string, action: 'park' | 'restore') { return disk.transition(item.runtime, item.accountId, item.id, { schema: 'rigging-disk-transition-v1', fingerprint: item.fingerprint, action, requestId }); }
function owned(files: Record<string, string>) { write(homes.at('rigging', 'state', 'claude', `${account.id}.json`), JSON.stringify({ schema: 'rigging-delivery-v1', fingerprint: 'fixture', files: Object.fromEntries(Object.entries(files).map(([ref, content]) => [ref, sha(content)])) })); }

test('disk discovery distinguishes loose, owned and drifted items without exposing config values or touching native homes', () => {
  const native = join(homes.userHome, '.claude'); write(join(native, 'skills/native/SKILL.md'), 'Native sentinel.');
  write(join(home, 'skills/owned/SKILL.md'), 'Owned.'); write(join(home, 'skills/loose/SKILL.md'), 'Loose.'); write(join(home, 'rules/owned.md'), 'Outside edit.');
  write(join(home, 'commands/local.md'), 'A local command.'); write(join(home, 'hooks/capture.sh'), '#!/bin/sh\necho captured\n');
  write(join(home, 'settings.json'), JSON.stringify({ effort: 'high', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'private fixture command' }] }] } }));
  write(join(home, 'jevellan-mcp.json'), JSON.stringify({ schema: 'stable-mcp-v1', servers: { local: { type: 'stdio', command: 'private fixture executable' } } }));
  owned({ 'skills/owned/SKILL.md': 'Owned.', 'rules/owned.md': 'Original.' });
  const result = list(); expect(result.errors).toEqual([]); expect(named('owned')).toMatchObject({ state: 'owned', drifted: false, editable: false, canPark: false });
  expect(named('owned.md')).toMatchObject({ state: 'owned', drifted: true, editable: false, canPark: true });
  expect(named('loose')).toMatchObject({ state: 'loose', editable: true, canPark: true }); expect(new Set(result.items.map((item) => item.kind))).toEqual(new Set(['skill', 'rule', 'command', 'hook', 'setting', 'mcp']));
  expect(JSON.stringify(result)).not.toMatch(/private fixture|Native sentinel/); expect(readFileSync(join(native, 'skills/native/SKILL.md'), 'utf8')).toBe('Native sentinel.');
});

test('without a delivery record all discovered files are loose and another account stays separate', async () => {
  write(join(home, 'skills/local/SKILL.md'), 'First.'); const other = homes.account('claude', 'acc_other'); write(join(other, 'skills/local/SKILL.md'), 'Second.');
  const result = disk.list([account, { ...account, id: 'acc_other' }]); expect(result.items).toHaveLength(2); expect(result.items.every((item) => item.state === 'loose')).toBe(true);
  await edit(named('local'), 'Changed first.'); expect(readFileSync(join(other, 'skills/local/SKILL.md'), 'utf8')).toBe('Second.');
  const absent = { id: 'acc_absent', runtime: 'codex' }; expect(disk.list([absent]).items).toEqual([]); expect(existsSync(homes.at('homes', 'codex', absent.id))).toBe(false);
});

test('local skill autosave preserves bundled assets and executable modes, and refuses stale edits', async () => {
  write(join(home, 'skills/local/SKILL.md'), '# Original'); const script = join(home, 'skills/local/scripts/run.sh'); write(script, '#!/bin/sh\necho fixture\n'); chmodSync(script, 0o700);
  const original = named('local'); const result = await edit(original, '# Edited'); expect(result.content).toBe('# Edited'); expect(result.item.fingerprint).not.toBe(original.fingerprint);
  expect(readFileSync(script, 'utf8')).toContain('echo fixture'); expect(lstatSync(script).mode & 0o777).toBe(0o700);
  await expect(edit(original, 'Stale overwrite')).rejects.toThrow('changed'); expect(readFileSync(join(home, 'skills/local/SKILL.md'), 'utf8')).toBe('# Edited');
});

test('park and restore move the complete skill, preserve bytes and mode, survive restart and deduplicate requests', async () => {
  write(join(home, 'skills/local/SKILL.md'), '# Skill'); write(join(home, 'skills/local/assets/example.bin'), '\0fixture'); chmodSync(join(home, 'skills/local/assets/example.bin'), 0o700);
  const original = named('local'); await move(original, 'park_skill', 'park'); expect(existsSync(join(home, 'skills/local'))).toBe(false);
  disk = new RiggingDisk(homes); await move(original, 'park_skill', 'park'); const parked = named('local', 'parked'); expect(parked.fileCount).toBe(2);
  expect((await edit(parked, '# Parked edit')).item.state).toBe('parked'); await move(named('local', 'parked'), 'restore_skill', 'restore');
  expect(readFileSync(join(home, 'skills/local/SKILL.md'), 'utf8')).toBe('# Parked edit'); expect(readFileSync(join(home, 'skills/local/assets/example.bin'))).toEqual(Buffer.from('\0fixture'));
  expect(lstatSync(join(home, 'skills/local/assets/example.bin')).mode & 0o777).toBe(0o700); expect(list().items.filter((item) => item.state === 'parked')).toEqual([]);
  await expect(move(original, 'park_skill', 'restore')).rejects.toThrow('already used');
});

test('restore refuses a newer destination and preserves both copies', async () => {
  write(join(home, 'rules/local.md'), 'Original.'); await move(named('local.md'), 'park_rule', 'park'); const parked = named('local.md', 'parked');
  write(join(home, 'rules/local.md'), 'New outside file.'); await expect(move(parked, 'restore_rule', 'restore')).rejects.toThrow('already exists');
  expect(readFileSync(join(home, 'rules/local.md'), 'utf8')).toBe('New outside file.'); expect(disk.detail('claude', account.id, parked.id).content).toBe('Original.');
});

test('managed copies are read-only; parking drift retains the edited copy for recovery', async () => {
  write(join(home, 'rules/managed.md'), 'Managed.'); owned({ 'rules/managed.md': 'Managed.' });
  await expect(edit(named('managed.md'), 'Override')).rejects.toThrow('read-only'); await expect(move(named('managed.md'), 'park_managed', 'park')).rejects.toThrow('managed runtime toggles');
  write(join(home, 'rules/managed.md'), 'Outside edit.'); await move(named('managed.md'), 'park_drift', 'park'); expect(existsSync(join(home, 'rules/managed.md'))).toBe(false);
  expect(disk.detail('claude', account.id, named('managed.md', 'parked').id).content).toBe('Outside edit.');
});

test('existing delivery archives are discoverable, read-only and restorable', async () => {
  const archive = homes.at('rigging', 'parked', 'claude', account.id, 'a'.repeat(64), 'skills', 'package', 'SKILL.md'); write(archive, 'From a disabled package.');
  const item = named('package', 'parked'); expect(item.editable).toBe(false); await expect(edit(item, 'Override')).rejects.toThrow('read-only');
  await move(item, 'restore_package', 'restore'); expect(named('package')).toMatchObject({ state: 'loose' }); expect(readFileSync(join(home, 'skills/package/SKILL.md'), 'utf8')).toBe('From a disabled package.');
});

test('automatic backups of identical active content are not shown as disabled, including reordered hooks', () => {
  write(join(home, 'skills/current/SKILL.md'), 'Current.'); const parked = homes.at('rigging/parked/claude', account.id, 'c'.repeat(64)); write(join(parked, 'skills/current/SKILL.md'), 'Current.');
  const hook = { hooks: [{ type: 'command', command: 'echo fixture' }] };
  write(join(home, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [] }, hook] } })); write(join(parked, 'settings.json'), JSON.stringify({ hooks: { Stop: [hook] } }));
  expect(list().items.filter((item) => item.state === 'parked')).toEqual([]);
  write(join(home, 'skills/current/SKILL.md'), 'New current version.'); expect(named('current', 'parked')).toBeDefined();
});

test('hook and setting edits and moves preserve unrelated configuration and append restored hooks once', async () => {
  const path = join(home, 'settings.json'); const first = { hooks: [{ type: 'command', command: 'echo first' }] }; const second = { hooks: [{ type: 'command', command: 'echo second' }] };
  write(path, JSON.stringify({ effort: 'high', theme: 'dark', hooks: { Stop: [first, second], Start: [first] } }));
  await edit(named('effort'), '"low"'); await move(named('Stop · 1'), 'park_hook', 'park');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ effort: 'low', theme: 'dark', hooks: { Stop: [second], Start: [first] } });
  const parked = named('Stop · 1', 'parked'); await move(parked, 'restore_hook', 'restore'); await move(parked, 'restore_hook', 'restore');
  expect(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop).toEqual([second, first]);
  await expect(edit(named('Start · 1'), '42')).rejects.toThrow();
});

test('Codex MCP and settings discovery edits TOML without changing other values and refuses occupied server names', async () => {
  const path = homes.account('codex', 'acc_codex'); write(join(path, 'config.toml'), 'model_reasoning_effort = "high"\n[features]\nexample = true\n[mcp_servers.local]\ncommand = "fixture"\n');
  const find = (name: string, state?: string) => disk.list([{ runtime: 'codex', id: 'acc_codex' }]).items.find((item) => item.name === name && (!state || item.state === state))!;
  await edit(find('local'), '{"command":"edited","args":["fixture"]}'); const before = parseToml(readFileSync(join(path, 'config.toml'), 'utf8'));
  expect(before).toMatchObject({ model_reasoning_effort: 'high', features: { example: true }, mcp_servers: { local: { command: 'edited' } } });
  await move(find('local'), 'park_mcp', 'park'); const parked = find('local', 'parked');
  write(join(path, 'config.toml'), 'model_reasoning_effort = "high"\n[mcp_servers.local]\ncommand = "newer"\n');
  await expect(move(parked, 'restore_mcp', 'restore')).rejects.toThrow('already exists'); expect(readFileSync(join(path, 'config.toml'), 'utf8')).toContain('newer');
});

test('a partial configuration move exposes its durable intent and resumes without duplication after restart', async () => {
  const path = join(home, 'settings.json'); const original = JSON.stringify({ theme: 'dark', effort: 'high' }); write(path, original);
  const item = named('effort'); await move(item, 'partial_move', 'park');
  const journal = homes.at('rigging', 'operations', 'claude', account.id, 'partial_move.json'); const operation = JSON.parse(readFileSync(journal, 'utf8')); operation.status = 'prepared'; write(journal, JSON.stringify(operation));
  // Reproduce loss after preserving the destination, before removing the source.
  write(path, original); disk = new RiggingDisk(homes); expect(list().pending).toMatchObject([{ requestId: 'partial_move', action: 'park' }]);
  await move(item, 'partial_move', 'park'); expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'dark' }); expect(list().pending).toEqual([]); expect(list().items.filter((entry) => entry.name === 'effort')).toHaveLength(1);
  operation.status = 'prepared'; write(journal, JSON.stringify(operation)); await move(item, 'partial_move', 'park'); expect(list().pending).toEqual([]);
});

test('a changed source during recovery retains both copies and stays pending', async () => {
  const path = join(home, 'settings.json'); write(path, '{"effort":"high","theme":"dark"}'); const item = named('effort'); await move(item, 'changed_move', 'park');
  const journal = homes.at('rigging', 'operations', 'claude', account.id, 'changed_move.json'); const operation = JSON.parse(readFileSync(journal, 'utf8')); operation.status = 'prepared'; write(journal, JSON.stringify(operation));
  write(path, '{"effort":"newer","theme":"light"}'); await expect(move(item, 'changed_move', 'park')).rejects.toThrow('source changed');
  expect(JSON.parse(readFileSync(path, 'utf8')).effort).toBe('newer'); expect(disk.detail('claude', account.id, named('effort', 'parked').id).content).toContain('high'); expect(list().pending).toHaveLength(1);
  await disk.cancel(item.runtime, item.accountId, item.id, { schema: 'rigging-disk-cancel-v1', requestId: 'changed_move' }); expect(list().pending).toEqual([]);
  expect(JSON.parse(readFileSync(path, 'utf8')).effort).toBe('newer'); expect(disk.detail('claude', account.id, named('effort', 'parked').id).content).toContain('high');
  await expect(move(item, 'changed_move', 'park')).rejects.toThrow('cancelled');
});

test('links are not followed, malformed configuration stays visible, and redacted content cannot be edited or archived', async () => {
  const outside = join(root, 'outside'); write(outside, 'Unchanged outside.'); mkdirSync(join(home, 'rules')); symlinkSync(outside, join(home, 'rules/link.md'));
  write(join(home, 'settings.json'), 'private fixture invalid json'); expect(JSON.stringify(list())).not.toMatch(/Unchanged outside|private fixture invalid/); expect(list().errors.length).toBeGreaterThan(0); expect(named('settings.json')).toMatchObject({ editable: false, canPark: true });
  const redactor = new SecretRedactor(); const secret = 'fixture-owned-private-value'; redactor.add(secret); disk = new RiggingDisk(homes, redactor); write(join(home, 'rules/private.md'), `Keep ${secret} private.`);
  const item = named('private.md'); const detail = disk.detail('claude', account.id, item.id); expect(detail.redacted).toBe(true); expect(detail.content).not.toContain(secret);
  await expect(edit(item, 'Replace redacted contents')).rejects.toThrow('read-only'); await expect(move(item, 'park_secret', 'park')).rejects.toThrow('credentials'); expect(existsSync(homes.at('rigging', 'parked'))).toBe(false);
  expect(readFileSync(outside, 'utf8')).toBe('Unchanged outside.');
});

test('delivery and account-local edits serialize so a newly installed copy cannot be overwritten by an old loose edit', async () => {
  write(join(home, 'skills/local/SKILL.md'), 'Loose.'); const loose = named('local'); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }); const wait = new Promise<void>((resolve) => { release = resolve; });
  const delivery = new RiggingDelivery(homes, async (cwd) => { entered(); await wait; write(join(cwd, '.claude/skills/local/SKILL.md'), 'Loose.'); write(join(cwd, 'apm.lock.yaml'), 'lockfile_version: "1"\ndependencies: []\n'); });
  const item = RiggingItemSchema.parse({ schema: 'rigging-item-v1', id: 'local', runtime: 'claude', name: 'Local', kind: 'skill', state: 'owned', enabled: true, content: 'Loose.', updatedAt: '2026-09-24T00:00:00Z' });
  const installing = delivery.materialise('claude', home, [item]); await started; const saving = edit(loose, 'Old outside edit'); const rejected = expect(saving).rejects.toThrow('changed'); release(); await installing; await rejected;
  expect(readFileSync(join(home, 'skills/local/SKILL.md'), 'utf8')).toBe('Loose.'); expect(readdirSync(home)).toEqual(['skills']);
});
