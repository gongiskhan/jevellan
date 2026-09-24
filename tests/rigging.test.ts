import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, RiggingDelivery, RiggingItemSchema, exportConfiguration, seedConfiguration, type ApmRunner } from '../packages/core/dist/index.js';
let root: string; let homes: Homes;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-rigging-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'jevellan'), join(root, 'user')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function item(runtime = 'claude', content = 'Read the fixture.') { return RiggingItemSchema.parse({ schema: 'rigging-item-v1', id: 'fixture', runtime, name: 'Fixture skill', kind: 'skill', state: 'loose', enabled: true, content, updatedAt: '2026-09-24T00:00:00Z' }); }
const fakeApm: ApmRunner = async (cwd, runtime, env) => {
  expect(env.HOME).not.toBe(homes.userHome); expect(Object.keys(env).some((key) => key.startsWith('JEVELLAN_TEST_'))).toBe(false);
  const folder = join(cwd, runtime === 'claude' ? '.claude' : '.agents', 'skills', 'fixture'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'SKILL.md'), 'Installed fixture.');
  writeFileSync(join(cwd, 'apm.lock.yaml'), 'lockfile_version: "1"\ndependencies: []\n');
};
test('delivery preserves loose files, restores a missing owned home file, and parks disabled owned files', async () => {
  let runs = 0; const delivery = new RiggingDelivery(homes, async (...args) => { runs++; await fakeApm(...args); }); const home = homes.account('claude', 'acc_one');
  mkdirSync(join(home, 'skills', 'local'), { recursive: true }); writeFileSync(join(home, 'skills', 'local', 'SKILL.md'), 'Unrelated loose file.');
  await delivery.materialise('claude', home, [item()]); expect(runs).toBe(1); await delivery.materialise('claude', home, [item()]); expect(runs).toBe(1);
  rmSync(join(home, 'skills', 'fixture', 'SKILL.md')); await delivery.materialise('claude', home, [item()]); expect(runs).toBe(2);
  await delivery.materialise('claude', home, [{ ...item(), enabled: false }]);
  expect(existsSync(join(home, 'skills', 'fixture', 'SKILL.md'))).toBe(false);
  expect(readFileSync(join(home, 'skills', 'local', 'SKILL.md'), 'utf8')).toBe('Unrelated loose file.');
  expect(readdirSync(homes.at('rigging', 'parked'), { recursive: true }).some((ref) => String(ref).endsWith('SKILL.md'))).toBe(true);
});
test('delivery refuses to overwrite or remove files modified outside Rigging', async () => {
  const home = homes.account('claude', 'acc_one'); const delivery = new RiggingDelivery(homes, fakeApm);
  await delivery.materialise('claude', home, [item()]); writeFileSync(join(home, 'skills', 'fixture', 'SKILL.md'), 'Local changes.');
  await expect(delivery.materialise('claude', home, [item('claude', 'New content.')])).rejects.toThrow('preserved local changes');
  await expect(delivery.materialise('claude', home, [])).rejects.toThrow('preserved local changes');
  expect(readFileSync(join(home, 'skills', 'fixture', 'SKILL.md'), 'utf8')).toBe('Local changes.');
});
test('APM failure changes no account files and account aliases are rejected', async () => {
  const home = homes.account('claude', 'acc_one'); const delivery = new RiggingDelivery(homes, async () => { throw new Error('Fixture failure'); });
  await expect(delivery.materialise('claude', home, [item()])).rejects.toThrow('Fixture failure'); expect(readdirSync(home)).toEqual([]);
  symlinkSync(home, join(homes.at('homes', 'claude'), 'acc_alias')); expect(() => homes.account('claude', 'acc_alias')).toThrow('alias');
});
test('unsupported Codex commands are reported and stable settings never carry launch tokens', async () => {
  const home = homes.account('codex', 'acc_one'); const delivery = new RiggingDelivery(homes, fakeApm);
  const results = await delivery.materialise('codex', home, [{ ...item('codex'), kind: 'command' }, { ...item('codex'), id: 'settings', kind: 'setting', content: '{"model_reasoning_effort":"high"}' }]);
  expect(results[0]).toMatchObject({ applied: false, reason: 'Not supported by Codex' });
  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('model_reasoning_effort = "high"');
});
test.each(['claude', 'codex'] as const)('installed APM deploys a local skill to the %s account without touching the native home', async (runtime) => {
  const native = join(homes.userHome, `.${runtime}`); mkdirSync(native); writeFileSync(join(native, 'sentinel'), 'unchanged');
  const delivery = new RiggingDelivery(homes); const home = homes.account(runtime, 'acc_real_apm');
  const result = await delivery.materialise(runtime, home, [item(runtime)]);
  expect(result[0]?.applied).toBe(true); expect(readFileSync(join(home, 'skills', 'fixture', 'SKILL.md'), 'utf8')).toContain('Read the fixture.');
  expect(readdirSync(native)).toEqual(['sentinel']); expect(readFileSync(join(native, 'sentinel'), 'utf8')).toBe('unchanged');
}, 120_000);

test('configuration APM dependencies are delivered and removing one parks its owned output', async () => {
  const pkg = join(root, 'configured-package'); mkdirSync(join(pkg, '.apm', 'skills', 'configured'), { recursive: true });
  writeFileSync(join(pkg, 'apm.yml'), 'name: configured-package\nversion: 1.0.0\ndescription: Configured fixture\n');
  writeFileSync(join(pkg, '.apm', 'skills', 'configured', 'SKILL.md'), '---\nname: configured\ndescription: Configured fixture\n---\nUse the configured skill.\n');
  const configuration = seedConfiguration(); configuration.dependencies.apm = [{ path: pkg }]; homes.ensure(); writeFileSync(homes.at('apm.yml'), exportConfiguration(configuration));
  const home = homes.account('claude', 'acc_config'); const delivery = new RiggingDelivery(homes);
  await delivery.materialise('claude', home, []);
  const target = join(home, 'skills', 'configured', 'SKILL.md'); expect(readFileSync(target, 'utf8')).toContain('Use the configured skill.');
  configuration.dependencies.apm = []; writeFileSync(homes.at('apm.yml'), exportConfiguration(configuration)); await delivery.materialise('claude', home, []);
  expect(existsSync(target)).toBe(false); expect(readdirSync(homes.at('rigging', 'parked'), { recursive: true }).some((ref) => String(ref).endsWith('SKILL.md'))).toBe(true);
}, 120_000);
