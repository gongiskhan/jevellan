import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, RiggingDelivery, RiggingItemSchema, exportConfiguration, projectMemoryHooks, seedConfiguration, type ApmRunner } from '../packages/core/dist/index.js';
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
const reconciliationHooks = { Stop: [{ hooks: [{ type: 'command', command: 'echo fixture-hook', timeout: 3 }] }] };
function reconciliationApm(mode: 'matching' | 'mismatched' | 'malformed' | 'wrong-source' | 'unexpected' = 'matching'): ApmRunner {
  return async (cwd, runtime, env) => {
    await fakeApm(cwd, runtime, env);
    const folder = join(cwd, '.claude');
    writeFileSync(join(folder, 'settings.json'), JSON.stringify({ hooks: reconciliationHooks }));
    const metadata = { Stop: [{ ...reconciliationHooks.Stop[0], _apm_source: mode === 'wrong-source' ? 7 : 'fixture-package' }] };
    if (mode === 'mismatched') metadata.Stop[0]!.hooks = [{ type: 'command', command: 'echo another-hook', timeout: 3 }];
    writeFileSync(join(folder, 'apm-hooks.json'), mode === 'malformed' ? 'private malformed fixture metadata' : JSON.stringify(metadata));
    if (mode === 'unexpected') writeFileSync(join(folder, 'unexpected.json'), '{}');
  };
}
test('APM reconciliation sidecar stays in staging while matching native hooks reach the isolated account', async () => {
  const home = homes.account('claude', 'acc_sidecar');
  await new RiggingDelivery(homes, reconciliationApm()).materialise('claude', home, [item()]);
  expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toEqual({ hooks: reconciliationHooks });
  expect(existsSync(join(home, 'apm-hooks.json'))).toBe(false);
  expect(readFileSync(join(home, 'skills/fixture/SKILL.md'), 'utf8')).toBe('Installed fixture.');
});
test.each(['mismatched', 'malformed', 'wrong-source'] as const)('APM reconciliation sidecar %s data is refused before changing the account', async mode => {
  const home = homes.account('claude', 'acc_sidecar');
  await expect(new RiggingDelivery(homes, reconciliationApm(mode)).materialise('claude', home, [item()]))
    .rejects.toThrow('APM hook reconciliation metadata does not match its generated settings.');
  expect(readdirSync(home)).toEqual([]);
});
test('APM reconciliation sidecar handling still refuses an unrelated runtime file', async () => {
  const home = homes.account('claude', 'acc_sidecar');
  await expect(new RiggingDelivery(homes, reconciliationApm('unexpected')).materialise('claude', home, [item()]))
    .rejects.toThrow('APM produced an unsupported runtime file.');
  expect(readdirSync(home)).toEqual([]);
});
test('incomplete APM hook output is refused before changing the account home', async () => {
  const home = homes.account('codex', 'acc_incomplete'); const delivery = new RiggingDelivery(homes, fakeApm);
  await expect(delivery.materialise('codex', home, [{ ...item('codex'), id: 'builtin_project_memory', kind: 'hook', content: JSON.stringify(projectMemoryHooks()) }])).rejects.toThrow('required Project memory hooks');
  expect(readdirSync(home)).toEqual([]);
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

test.each(['claude', 'codex'] as const)('APM delivers %s capture hooks idempotently and disabling them preserves other hooks', async (runtime) => {
  const native = join(homes.userHome, `.${runtime}`); mkdirSync(native); writeFileSync(join(native, 'sentinel'), 'unchanged');
  const home = homes.account(runtime, 'acc_hooks'); const delivery = new RiggingDelivery(homes);
  const capture = { ...item(runtime), id: 'builtin_project_memory', kind: 'hook' as const, builtIn: true, content: JSON.stringify(projectMemoryHooks()) };
  const custom = { ...item(runtime), id: 'custom_hook', kind: 'hook' as const, content: JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo custom-hook' }] }] } }) };
  const settings = { ...item(runtime), id: 'settings_hook', kind: 'setting' as const, content: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo settings-hook' }] }] } }) };
  const file = join(home, runtime === 'claude' ? 'settings.json' : 'hooks.json');
  await delivery.materialise(runtime, home, [capture, custom, settings]);
  const first = readFileSync(file, 'utf8'); const config = JSON.parse(first) as { hooks: Record<string, unknown[]> };
  expect(Object.keys(config.hooks).sort()).toEqual(['PreCompact', 'PreToolUse', 'SessionEnd', 'Stop']);
  expect(config.hooks.Stop).toHaveLength(runtime === 'claude' ? 2 : 1); expect(first).toContain('memory-hook'); expect(first).not.toContain('JEVELLAN_STRETCH_TOKEN');
  expect(readFileSync(join(home, runtime === 'claude' ? 'settings.json' : 'config.toml'), 'utf8')).toContain('settings-hook');
  await delivery.materialise(runtime, home, [capture, custom, settings]); expect(readFileSync(file, 'utf8')).toBe(first);
  await delivery.materialise(runtime, home, [{ ...capture, enabled: false }, custom, settings]);
  const disabled = readFileSync(file, 'utf8'); expect(disabled).not.toContain('memory-hook'); expect(disabled).toContain('custom-hook');
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

/** APM's settings.json for the fixture memory hook of one application version, annotated with APM's source the way it ships. */
function annotatedApm(version: { app: string }): ApmRunner {
  return async (cwd, runtime, env) => {
    await fakeApm(cwd, runtime, env);
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${version.app}/jevellan.mjs memory-hook`, timeout: 3 }], _apm_source: 'fixture-package' }] } }, null, 2));
  };
}
/** What Claude Code does to an account's settings.json on its first interactive run: re-serializes it without APM's annotations and adds its own keys. */
function claudeCodeRewrites(path: string): void {
  const settings = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, Array<Record<string, unknown>>> };
  const hooks = Object.fromEntries(Object.entries(settings.hooks).map(([event, groups]) => [event, groups.map(({ _apm_source, ...group }) => { void _apm_source; return group; })]));
  writeFileSync(path, `${JSON.stringify({ hooks, theme: 'auto', agentPushNotifEnabled: true }, null, 2)}\n`);
}
const settingsOf = (home: string) => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }; theme?: string; agentPushNotifEnabled?: boolean };

test('Claude Code rewriting settings.json with its own keys is no conflict: managed keys compare without APM annotations and its keys are kept', async () => {
  const version = { app: '/app/0.7.1' }; const home = homes.account('claude', 'acc_bridge'); const delivery = new RiggingDelivery(homes, annotatedApm(version));
  await delivery.materialise('claude', home, [item('claude', version.app)]);
  claudeCodeRewrites(join(home, 'settings.json'));
  await delivery.materialise('claude', home, [item('claude', version.app)]);
  expect(settingsOf(home)).toMatchObject({ theme: 'auto', agentPushNotifEnabled: true });
  // A new application version rewrites the managed hooks and still keeps Claude Code's keys.
  version.app = '/app/0.7.2';
  await delivery.materialise('claude', home, [item('claude', version.app)]);
  expect(settingsOf(home)).toMatchObject({ theme: 'auto', agentPushNotifEnabled: true });
  expect(settingsOf(home).hooks.Stop[0]!.hooks[0]!.command).toBe('node /app/0.7.2/jevellan.mjs memory-hook');
  // A change to a key Rigging manages is still the owner's to resolve.
  const changed = settingsOf(home); changed.hooks.Stop[0]!.hooks[0]!.command = 'echo mine';
  writeFileSync(join(home, 'settings.json'), JSON.stringify(changed)); version.app = '/app/0.7.3';
  await expect(delivery.materialise('claude', home, [item('claude', version.app)])).rejects.toThrow('preserved local changes: settings.json');
  expect(settingsOf(home).hooks.Stop[0]!.hooks[0]!.command).toBe('echo mine');
});

test('settings.json that Claude Code wrote before Rigging ever did is merged, and one from an earlier Rigging state is recognised from its staging copy', async () => {
  const version = { app: '/app/0.7.1' }; const delivery = new RiggingDelivery(homes, annotatedApm(version));
  // The bridge ran Claude Code in a new account before its first launch.
  const fresh = homes.account('claude', 'acc_fresh'); writeFileSync(join(fresh, 'settings.json'), '{ "theme": "dark" }\n');
  await delivery.materialise('claude', fresh, [item('claude', version.app)]);
  expect(settingsOf(fresh)).toMatchObject({ theme: 'dark', hooks: { Stop: [{ hooks: [{ command: 'node /app/0.7.1/jevellan.mjs memory-hook' }] }] } });
  // An account Rigging delivered to before it recorded its keys, then rewritten by Claude Code.
  const home = homes.account('claude', 'acc_earlier');
  await delivery.materialise('claude', home, [item('claude', version.app)]);
  const statePath = homes.at('rigging', 'state', 'claude', 'acc_earlier.json'), keysPath = homes.at('rigging', 'state', 'claude', 'acc_earlier.keys.json');
  // The state stays in the format earlier versions read; the key record sits beside it.
  expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ schema: 'rigging-delivery-v1' });
  expect(JSON.parse(readFileSync(keysPath, 'utf8'))).toMatchObject({ schema: 'rigging-keys-v1', files: { 'settings.json': { keys: { hooks: expect.stringMatching(/^[a-f0-9]{64}$/u) } } } });
  rmSync(keysPath);
  claudeCodeRewrites(join(home, 'settings.json')); version.app = '/app/0.7.2';
  await delivery.materialise('claude', home, [item('claude', version.app)]);
  expect(settingsOf(home)).toMatchObject({ theme: 'auto', agentPushNotifEnabled: true, hooks: { Stop: [{ hooks: [{ command: 'node /app/0.7.2/jevellan.mjs memory-hook' }] }] } });
  expect(existsSync(keysPath)).toBe(true);
  // A version without key records rewrote the state (a rollback): the stale record no longer matches and is ignored.
  writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), files: { 'settings.json': 'f'.repeat(64) } }));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  await expect(delivery.materialise('claude', home, [item('claude', '/app/0.7.3')])).rejects.toThrow('preserved local changes: settings.json');
});

test('Codex trusting a folder in config.toml is no conflict with the settings Rigging manages there', async () => {
  const home = homes.account('codex', 'acc_codex'); const delivery = new RiggingDelivery(homes, fakeApm);
  const setting = (effort: string) => ({ ...item('codex'), id: 'settings', kind: 'setting' as const, content: JSON.stringify({ model_reasoning_effort: effort }) });
  await delivery.materialise('codex', home, [setting('high')]);
  writeFileSync(join(home, 'config.toml'), `${readFileSync(join(home, 'config.toml'), 'utf8')}\n[projects."/work/app"]\ntrust_level = "trusted"\n`);
  await delivery.materialise('codex', home, [setting('medium')]);
  const config = readFileSync(join(home, 'config.toml'), 'utf8');
  expect(config).toContain('model_reasoning_effort = "medium"'); expect(config).toContain('trust_level = "trusted"');
});
