import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { c } from 'tar';
import { main } from '../packages/cli/dist/index.js';
import { DEFAULT_PORT, DeviceConfigSchema, Homes, LifecycleGate, MemberJoinPlanSchema, readDocument } from '../packages/core/dist/index.js';
import { Installer } from '../packages/cli/dist/installation.js';
import { installationArguments } from '../packages/cli/dist/installation-arguments.js';
import { HttpsService } from '../packages/cli/dist/https-service.js';
import { startDaemon } from '../apps/daemon/dist/index.js';
import { recoverHomePurges, stageHomePurge } from '../packages/cli/dist/purge.js';
import { ToolchainSchema, toolchainDirectoryName } from '../packages/cli/dist/toolchain.js';
import { UserServiceManager, serviceContents, type ServiceDefinition, type ServiceManager } from '../packages/cli/dist/service-manager.js';

const roots: string[] = [], installers: Installer[] = [], gates: LifecycleGate[] = [], releases: (() => void)[] = [], servers: Server[] = [];
const daemons: Awaited<ReturnType<typeof startDaemon>>[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map(daemon => daemon.close()));
  releases.splice(0).forEach(release => release()); gates.splice(0).forEach(gate => gate.close()); installers.splice(0).forEach(installer => installer.close());
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function file(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); return path; }
function fixture(httpsService?: HttpsService) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-installation-'))); roots.push(root);
  const user = join(root, 'user'); mkdirSync(user); const homes = new Homes(join(user, '.jevellan'), user);
  const canaries = ['.claude/settings.json', '.codex/config.toml', '.basic-memory/config.json', 'dev/garrison/reference.txt', '.zshrc'];
  for (const name of canaries) file(join(user, name), name);
  const source = (version = '0.1.0') => {
    const path = join(root, `distribution-${version}`);
    file(join(path, 'package.json'), JSON.stringify({ name: 'jevellan', version, type: 'module' }));
    file(join(path, 'bin/jevellan.mjs'), `console.log('${version}');\n`); file(join(path, 'packages/cli/dist/index.js'), 'export function main() {}\n');
    file(join(path, 'apps/web/dist/index.html'), '<!doctype html><title>Jevellan</title>'); return path;
  };
  let running = false, failStart = false, failStop = false, joinFetch: typeof fetch | undefined;
  const calls: string[] = [], messages: string[] = [];
  const native = new UserServiceManager({ platform: 'darwin', userHome: user, uid: 502, run: async () => { throw new Error('Native services must never run in installer tests.'); } });
  let onStop: () => void | Promise<void> = () => {}, onStart: () => void | Promise<void> = () => {};
  const manager: ServiceManager = {
    definition: spec => native.definition(spec),
    start: async definition => { expect(readFileSync(definition.path, 'utf8')).toBe(serviceContents(definition)); await onStart(); calls.push(`start:${definition.spec.entry}`); if (failStart) throw new Error('Simulated start failure'); running = true; },
    stop: async definition => { expect(readFileSync(definition.path, 'utf8')).toBe(serviceContents(definition)); await onStop(); calls.push(`stop:${definition.spec.entry}`); if (failStop) throw new Error('Simulated stop failure'); running = false; },
    removed: async () => { calls.push('removed'); },
  };
  const open = () => {
    const installer = new Installer({ homes, manager, alive: () => running, ready: async () => { if (!running) throw new Error('The fake service is not running.'); }, tailscale: async () => null, intervalMs: 5, progress: message => messages.push(message),
      ...(httpsService ? { httpsService } : {}),
      ...(joinFetch ? { joinFetch } : {}),
      installTools: async files => {
        const root = homes.ensure('tools', toolchainDirectoryName());
        const tool = (name: string, version: string) => ({ schema: 'installed-tool-v1', executable: file(join(root, 'bin', name), version), version, owned: true });
        const tools = ToolchainSchema.parse({ schema: 'toolchain-v1', root, installedAt: new Date().toISOString(), uv: { schema: 'installed-tool-v1', executable: process.execPath, version: '0.11.23', owned: false }, apm: tool('apm', '0.10.0'), basicMemory: tool('basic-memory', '0.22.1'), python: '3.12', path: `${join(root, 'bin')}:/usr/bin:/bin` });
        const manifest = files.load(); manifest.toolchains = [tools]; files.save(manifest); return tools;
      } }); installers.push(installer); return installer;
  };
  const workGate = () => { const gate = new LifecycleGate(homes); gates.push(gate); return gate; };
  const unchanged = () => { for (const name of canaries) expect(readFileSync(join(user, name), 'utf8')).toBe(name); };
  return { homes, source, open, workGate, calls, messages, unchanged, setJoinFetch: (value: typeof fetch) => { joinFetch = value; }, setFailStart: (value: boolean) => { failStart = value; }, setFailStop: (value: boolean) => { failStop = value; }, setCallbacks: (stop: () => void | Promise<void>, start: () => void | Promise<void>) => { onStop = stop; onStart = start; } };
}

function httpsFixture() {
  const state = { hostname: 'member.tailtest.ts.net', target: '', port: '', lost: false, changes: 0 };
  const service = new HttpsService(async args => {
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${state.hostname}.` } });
    if (args[1] === 'status') return JSON.stringify(state.target ? { TCP: { [state.port]: { HTTPS: true } }, Web: { [`${state.hostname}:${state.port}`]: { Handlers: { '/': { Proxy: state.target } } } } } : {});
    state.changes++; state.port = args.find(value => value.startsWith('--https='))!.slice(8); state.target = args.at(-1) === 'off' ? '' : args.at(-1)!;
    if (state.lost) { state.lost = false; throw new Error('Simulated lost HTTPS response'); } return '';
  });
  return { state, service };
}

async function hub() {
  const f = fixture(), daemon = await startDaemon(0, { homes: f.homes, timers: false, runtimes: () => new Map(), tailscaleAddress: async () => null }); daemons.push(daemon);
  const passphrase = `fixture-${randomUUID()}`; await daemon.application.auth.setup({ schema: 'passphrase-input-v1', passphrase }); await daemon.application.conversations.ready;
  return { daemon, passphrase, target: { schema: 'installation-join-input-v1', hubUrl: daemon.addresses[0]!, code: daemon.application.mesh.invite().code } };
}

test.each(['join', 'install'] as const)('the %s command installs a joined member before starting its daemon, without a local hub', async command => {
  const h = await hub(), f = fixture(), source = f.source(), archive = join(dirname(source), 'member.tgz'); await c({ file: archive, cwd: source, prefix: 'package', gzip: true }, readdirSync(source));
  let member: Awaited<ReturnType<typeof startDaemon>> | undefined;
  f.setCallbacks(async () => { await member?.close(); }, async () => {
    const device = readDocument(f.homes.at('device.json'), DeviceConfigSchema); expect(device.role).toBe('member'); expect(existsSync(f.homes.at('device.token'))).toBe(true);
    member = await startDaemon(Number(new URL(device.url).port), { homes: f.homes, timers: false, runtimes: () => new Map(), tailscaleAddress: async () => null }); daemons.push(member); await member.application.conversations.ready;
  });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const args = command === 'join' ? ['join', h.target.hubUrl, h.target.code, '--from', archive] : ['install', '--from', archive, '--join', h.target.hubUrl, h.target.code];
  await main(args, { installer: f.open }); const device = readDocument(f.homes.at('device.json'), DeviceConfigSchema);
  expect(existsSync(f.homes.at('hub'))).toBe(false); expect((await member!.application.roster()).devices).toHaveLength(2);
  for (const name of ['device.json', 'device.token', 'ui-auth.json', 'hub-device.json']) expect(statSync(f.homes.at(name)).mode & 0o777).toBe(0o600);
  const login = await fetch(`${member!.addresses[0]}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: h.passphrase }) }); expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!; expect((await fetch(`${member!.addresses[0]}/hub/devices/roster`, { headers: { Cookie: cookie } })).status).toBe(200);
  await main(['join', h.target.hubUrl, '00000000'], { installer: f.open });
  expect(f.calls.filter(call => call.startsWith('start:'))).toHaveLength(1); expect(readDocument(f.homes.at('device.json'), DeviceConfigSchema).deviceId).toBe(device.deviceId);
  expect(JSON.stringify(output.mock.calls)).not.toContain(h.target.code); expect(readFileSync(f.homes.at('install.json'), 'utf8')).not.toContain(h.target.code); f.unchanged();
}, 30_000);

test('a lost join response keeps the same device and port on installer retry and cannot become a hub', async () => {
  const h = await hub(), f = fixture(); let lost = false;
  f.setJoinFetch(async (...args) => { const response = await fetch(...args); if (String(args[0]).endsWith('/join') && !lost) { lost = true; await response.body?.cancel(); throw new Error('Simulated lost join response'); } return response; });
  const source = f.source(), first = f.open(); await expect(first.install(source, h.target)).rejects.toThrow();
  const pending = first.files.load().pendingSwitch!, plan = readDocument(f.homes.at('join-pending.json'), MemberJoinPlanSchema);
  expect(pending.join?.hubUrl).toBe(h.target.hubUrl); expect(existsSync(f.homes.at('device.json'))).toBe(false); expect(f.calls).toEqual([]);
  expect(JSON.stringify(pending)).not.toContain(h.target.code); expect(JSON.stringify(plan)).not.toContain(h.target.code);
  await expect(first.install(source)).rejects.toThrow('join is pending');
  await expect(first.install(source, { ...h.target, hubUrl: 'http://127.0.0.1:1' })).rejects.toThrow('different hub'); first.close();
  const retry = f.open(), result = (await retry.resumeJoin(h.target))!, device = readDocument(f.homes.at('device.json'), DeviceConfigSchema);
  expect(device.deviceId).toBe(plan.device.id); expect(result.port).toBe(pending.definition.spec.port); expect(device.url).toBe(plan.device.url);
  expect((await h.daemon.application.roster()).devices).toHaveLength(2); expect(retry.files.load().pendingSwitch).toBeUndefined(); expect(existsSync(f.homes.at('join-pending.json'))).toBe(false); expect(existsSync(f.homes.at('hub'))).toBe(false); f.unchanged();
});

test('a completed registration survives a failed service start and data-retaining uninstall without another invitation', async () => {
  const h = await hub(), f = fixture(); let registrations = 0;
  f.setJoinFetch(async (...args) => { if (String(args[0]).endsWith('/join')) registrations++; return fetch(...args); });
  const source = f.source(), first = f.open(); f.setFailStart(true); await expect(first.install(source, h.target)).rejects.toThrow('Simulated start failure');
  const before = readDocument(f.homes.at('device.json'), DeviceConfigSchema), token = readFileSync(f.homes.at('device.token')); first.close(); f.setFailStart(false);
  const retry = f.open(); await retry.install(source, { ...h.target, code: '00000000' }); expect(registrations).toBe(1);
  await retry.uninstall(); await retry.install(source);
  expect(readDocument(f.homes.at('device.json'), DeviceConfigSchema)).toEqual(before); expect(readFileSync(f.homes.at('device.token'))).toEqual(token); expect(registrations).toBe(1); expect(existsSync(f.homes.at('hub'))).toBe(false); f.unchanged();
});

test('joining refuses to convert an existing hub before copying another version or stopping it', async () => {
  const h = await hub(), f = fixture(), installer = f.open(); await installer.install(f.source());
  const before = readFileSync(f.homes.at('install.json')), calls = [...f.calls];
  await expect(installer.install(f.source('0.2.0'), h.target)).rejects.toThrow('cannot be converted');
  expect(readFileSync(f.homes.at('install.json'))).toEqual(before); expect(f.calls).toEqual(calls); expect(existsSync(f.homes.at('app', '0.2.0'))).toBe(false); f.unchanged();
});

test('join arguments accept both documented forms and reject invalid or repeated options before installation', async () => {
  const code = '12345678';
  expect(installationArguments('install', ['--join', 'https://hub.example/path', code, '--from', '/fixture/app']).target?.hubUrl).toBe('https://hub.example');
  const installer = vi.fn<() => Installer>();
  for (const args of [['join'], ['join', 'https://hub.example', 'bad'], ['install', '--join', 'https://hub.example', code, '--join', 'https://hub.example', code], ['update', '--join', 'https://hub.example', code], ['join', 'https://hub.example', code, '--from', '/one', '--from', '/two']]) await expect(main(args, { installer })).rejects.toThrow('Usage:');
  expect(installer).not.toHaveBeenCalled();
  expect(installationArguments('install', ['--https']).https).toBe(true); expect(installationArguments('join', ['https://hub.example', code, '--no-https']).https).toBe(false);
  for (const args of [['install', '--https', '--no-https'], ['update', '--https'], ['join', 'https://hub.example', code, '--https', '--https']]) await expect(main(args, { installer })).rejects.toThrow('Usage:');
  expect(installer).not.toHaveBeenCalled();
});

test('HTTPS keeps one registered address through update, rollback, uninstall and retained-data reinstall', async () => {
  const proxy = httpsFixture(), f = fixture(proxy.service), installer = f.open(), source = f.source();
  const installed = await installer.install(source, undefined, true); expect(installed.url).toBe('https://member.tailtest.ts.net');
  expect(installer.files.load().https).toMatchObject({ state: 'active', port: 443, localPort: installed.port });
  expect(readDocument(f.homes.at('device.json'), DeviceConfigSchema).hubUrl).toBe(installed.url);
  expect((await installer.update(f.source('0.2.0'))).url).toBe(installed.url); expect((await installer.rollback()).url).toBe(installed.url); expect(proxy.state.changes).toBe(1);
  await installer.uninstall(); expect(proxy.state.target).toBe(''); expect(installer.files.load().https?.state).toBe('removed');
  expect((await installer.install(source)).url).toBe(installed.url); expect(proxy.state.target).toBe(`http://127.0.0.1:${installed.port}`);
  await installer.purge(f.homes.root); expect(proxy.state.target).toBe(''); expect(existsSync(f.homes.root)).toBe(false); f.unchanged();
});

test('HTTPS setup recovers a lost reply and an externally changed route prevents stopping or removing the service', async () => {
  const proxy = httpsFixture(), f = fixture(proxy.service), source = f.source(); let installer = f.open(); proxy.state.lost = true;
  await expect(installer.install(source, undefined, true)).rejects.toThrow('lost HTTPS response');
  expect(installer.files.load().https?.state).toBe('pending'); expect(installer.files.load().pendingSwitch?.targetVersion).toBe('0.1.0'); expect(existsSync(f.homes.at('device.json'))).toBe(false);
  installer.close(); installer = f.open(); await installer.install(source); expect(proxy.state.changes).toBe(1); expect(installer.files.load().https?.state).toBe('active');
  const own = proxy.state.target; proxy.state.target = 'http://127.0.0.1:9999'; const calls = [...f.calls];
  await expect(installer.update(f.source('0.2.0'))).rejects.toThrow('another service'); await expect(installer.purge(f.homes.root)).rejects.toThrow('changed outside');
  expect(f.calls).toEqual(calls); expect(proxy.state.target).toBe('http://127.0.0.1:9999');
  proxy.state.target = own; await installer.uninstall(); proxy.state.target = 'http://127.0.0.1:9999';
  await installer.purge(f.homes.root); expect(proxy.state.target).toBe('http://127.0.0.1:9999'); f.unchanged();
});

test('a member joins with its HTTPS address before service start and retains it on repeat and reinstall', async () => {
  const h = await hub(), proxy = httpsFixture(), f = fixture(proxy.service), installer = f.open(), source = f.source();
  f.setCallbacks(() => {}, () => { expect(readDocument(f.homes.at('device.json'), DeviceConfigSchema).url).toBe('https://member.tailtest.ts.net'); });
  const installed = await installer.install(source, h.target, true), before = readDocument(f.homes.at('device.json'), DeviceConfigSchema);
  expect((await h.daemon.application.roster()).devices.find(row => row.device.id === before.deviceId)?.device.url).toBe(installed.url);
  await installer.resumeJoin({ ...h.target, code: '00000000' }); expect(f.calls.filter(call => call.startsWith('start:'))).toHaveLength(1);
  await installer.uninstall(); await installer.install(source); expect(readDocument(f.homes.at('device.json'), DeviceConfigSchema)).toEqual(before); f.unchanged();
});

test('installation offers HTTPS once before first startup and explicit choices do not prompt', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const choice of [undefined, '--https', '--no-https']) {
    const proxy = httpsFixture(), f = fixture(proxy.service), installer = f.open(), source = f.source(), archive = join(dirname(source), 'https-fixture.tgz');
    await c({ file: archive, cwd: source, prefix: 'package', gzip: true }, readdirSync(source));
    vi.spyOn(installer, 'canOfferHttps').mockResolvedValue(true); const offer = vi.fn(async () => true);
    await main(['install', '--from', archive, ...(choice ? [choice] : [])], { installer: () => installer, offerHttps: offer });
    expect(offer).toHaveBeenCalledTimes(choice ? 0 : 1);
    const reopened = f.open(); expect(Boolean(reopened.files.load().https)).toBe(choice !== '--no-https'); expect(await reopened.canOfferHttps()).toBe(false); f.unchanged();
  }
}, 30_000);

test('install skips the occupied default port and starts an owned copy without changing its neighbour', async () => {
  const f = fixture(), installer = f.open(), neighbour = createServer((_request, response) => response.end('Fake Garrison')); servers.push(neighbour);
  await new Promise<void>((resolve, reject) => { neighbour.once('error', reject); neighbour.listen(DEFAULT_PORT, '127.0.0.1', resolve); });
  const distribution = f.source(), result = await installer.install(distribution);
  expect(result.changedPort).toBe(true); expect(result.port).toBeGreaterThan(DEFAULT_PORT);
  expect(result.url).toBe(`http://127.0.0.1:${result.port}`); expect(await (await fetch(`http://127.0.0.1:${DEFAULT_PORT}`)).text()).toBe('Fake Garrison');
  const manifest = installer.files.load(); expect(manifest.activeVersion).toBe('0.1.0'); expect(manifest.pendingSwitch).toBeUndefined();
  expect(manifest.service!.definition.spec.entry).toBe(join(f.homes.root, 'app/0.1.0/bin/jevellan.mjs'));
  rmSync(distribution, { recursive: true }); expect(existsSync(manifest.service!.definition.spec.entry)).toBe(true); f.unchanged();
});

test('update prepares alongside the running version, waits for work, switches under the gate and supports rollback', async () => {
  const f = fixture(), installer = f.open(); const installed = await installer.install(f.source()); const gate = f.workGate();
  const work = gate.enter({ kind: 'conversation', id: 'conversation_a', title: 'In progress' }); releases.push(work);
  const commandVersion = () => execFileSync(installed.command, ['--version'], { encoding: 'utf8' }).trim(); expect(commandVersion()).toBe('0.1.0');
  const update = installer.update(f.source('0.2.0')); await vi.waitFor(() => expect(f.messages).toContain('Waiting for 1 running conversations to finish'));
  expect(installer.files.load().activeVersion).toBe('0.1.0'); expect(existsSync(join(f.homes.root, 'app/0.2.0/bin/jevellan.mjs'))).toBe(true);
  expect(f.calls.filter(call => call.startsWith('stop:'))).toHaveLength(0);
  expect(commandVersion()).toBe('0.1.0');
  f.setCallbacks(() => expect(() => gate.enter({ kind: 'request' })).toThrow('being updated'), () => { const admitted = gate.enter({ kind: 'startup' }); admitted(); });
  work(); const result = await update; expect(result.version).toBe('0.2.0');
  expect(installer.files.load()).toMatchObject({ activeVersion: '0.2.0', previousVersion: '0.1.0' });
  expect(commandVersion()).toBe('0.2.0');
  await installer.rollback(); expect(installer.files.load()).toMatchObject({ activeVersion: '0.1.0', previousVersion: '0.2.0' });
  expect(commandVersion()).toBe('0.1.0');
  expect(installer.files.load().applications).toHaveLength(2); f.unchanged();
});

test('uninstall lists running work, then removes only recorded service/app files and retains data', async () => {
  const f = fixture(), installer = f.open(); await installer.install(f.source()); const gate = f.workGate();
  const work = gate.enter({ kind: 'conversation', id: 'conversation_a', title: 'Build a page' }); releases.push(work);
  const data = file(join(f.homes.root, 'conversations/retained.txt'), 'Retained work'), other = file(join(f.homes.root, 'app/unlisted/keep.txt'), 'Unlisted');
  await expect(installer.uninstall()).rejects.toThrow('Build a page'); expect(f.calls.filter(call => call.startsWith('stop:'))).toHaveLength(0);
  const definition = installer.files.load().service!.definition; work();
  expect(await installer.uninstall()).toBe(f.homes.root); expect(existsSync(definition.path)).toBe(false); expect(existsSync(join(f.homes.root, 'app/0.1.0'))).toBe(false);
  expect(readFileSync(data, 'utf8')).toBe('Retained work'); expect(readFileSync(other, 'utf8')).toBe('Unlisted');
  await installer.uninstall(); expect(installer.files.load().applications).toEqual([]); f.unchanged();
});

test('a missing command is repaired without restarting, while external edits prevent update or uninstall from stopping the service', async () => {
  const f = fixture(), installer = f.open(), source = f.source(); const installed = await installer.install(source);
  const contents = readFileSync(installed.command, 'utf8'); rmSync(installed.command); await installer.install(source);
  expect(readFileSync(installed.command, 'utf8')).toBe(contents); expect(f.calls.filter(call => call.startsWith('start:'))).toHaveLength(1);
  writeFileSync(installed.command, 'Edited by its owner');
  await expect(installer.update(f.source('0.2.0'))).rejects.toThrow('changed outside Jevellan'); await expect(installer.uninstall()).rejects.toThrow('changed outside Jevellan');
  expect(f.calls.filter(call => call.startsWith('stop:'))).toHaveLength(0); expect(installer.files.load().activeVersion).toBe('0.1.0'); expect(readFileSync(installed.command, 'utf8')).toBe('Edited by its owner');
  writeFileSync(installed.command, contents); await installer.uninstall(); expect(existsSync(installed.command)).toBe(false); f.unchanged();
});

test('a failed service start retains the original previous version and can resume after installer restart', async () => {
  const f = fixture(); let installer = f.open(); await installer.install(f.source()); const source = f.source('0.2.0'); f.setFailStart(true);
  await expect(installer.update(source)).rejects.toThrow('start failure');
  expect(installer.files.load()).toMatchObject({ activeVersion: '0.2.0', previousVersion: '0.1.0', pendingSwitch: { fromVersion: '0.1.0', targetVersion: '0.2.0' } });
  installer.close(); installer = f.open(); f.setFailStart(false); await installer.update(source);
  expect(installer.files.load()).toMatchObject({ activeVersion: '0.2.0', previousVersion: '0.1.0' }); expect(installer.files.load().pendingSwitch).toBeUndefined(); f.unchanged();
});

test('rollback can recover from a new version that failed to start', async () => {
  const f = fixture(), installer = f.open(); await installer.install(f.source()); f.setFailStart(true);
  await expect(installer.update(f.source('0.2.0'))).rejects.toThrow('start failure'); f.setFailStart(false);
  const result = await installer.rollback(); expect(result.version).toBe('0.1.0'); expect(installer.files.load().pendingSwitch).toBeUndefined(); f.unchanged();
});

test('stop failure preserves the old active definition and retries the same prepared switch', async () => {
  const f = fixture(), installer = f.open(); await installer.install(f.source()); const source = f.source('0.2.0');
  const old: ServiceDefinition = installer.files.load().service!.definition; f.setFailStop(true);
  await expect(installer.update(source)).rejects.toThrow('stop failure');
  expect(installer.files.load().activeVersion).toBe('0.1.0'); expect(readFileSync(old.path, 'utf8')).toBe(serviceContents(old));
  f.setFailStop(false); await installer.update(source); expect(installer.files.load().previousVersion).toBe('0.1.0'); f.unchanged();
});

test('repeated install of the active version does not restart it', async () => {
  const f = fixture(), installer = f.open(), source = f.source(); await installer.install(source); const calls = [...f.calls];
  await installer.install(source); expect(f.calls).toEqual(calls); f.unchanged();
});

test('the public commands install a packed archive, update, roll back and uninstall through the injected service manager', async () => {
  const f = fixture(), output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const archive = async (version: string) => { const source = f.source(version), file = join(dirname(source), `jevellan-${version}.tgz`); await c({ file, cwd: source, prefix: 'package', gzip: true }, ['package.json', 'bin', 'packages', 'apps']); return file; };
  await main(['install', '--from', await archive('0.1.0')], { installer: f.open });
  await main(['update', '--from', await archive('0.2.0')], { installer: f.open });
  await main(['rollback'], { installer: f.open });
  await main(['uninstall'], { installer: f.open });
  expect(output.mock.calls.flat().some(value => String(value).includes('Jevellan 0.2.0 is running at'))).toBe(true);
  expect(output.mock.calls.flat().some(value => String(value).includes('Your data remains at'))).toBe(true);
  const installer = f.open(); expect(installer.files.load().applications).toEqual([]); expect(installer.files.load().distributions).toEqual([]); f.unchanged();
}, 30_000);

test('purge requires the exact home, refuses running work, and never follows links to native fixture files', async () => {
  const f = fixture(), installer = f.open(); await installer.install(f.source()); const calls = [...f.calls];
  await expect(installer.purge(`${f.homes.root}/`)).rejects.toThrow('Nothing was removed'); expect(f.calls).toEqual(calls);
  const gate = f.workGate(), work = gate.enter({ kind: 'conversation', id: 'active', title: 'Still running' }); releases.push(work);
  await expect(installer.purge(f.homes.root)).rejects.toThrow('Still running'); work(); gate.close();
  symlinkSync(join(f.homes.userHome, '.basic-memory'), join(f.homes.root, 'external-link'));
  await installer.purge(f.homes.root);
  expect(existsSync(f.homes.root)).toBe(false); expect(readdirSync(f.homes.userHome).some(name => name.includes('.purge-'))).toBe(false); f.unchanged();
});

test('an interrupted purge cleans only its recorded old home, even after a new installation was created', async () => {
  const f = fixture(), installer = f.open(); await installer.install(f.source()); await installer.uninstall();
  const gate = f.workGate(), release = gate.tryMaintenance()!; releases.push(release);
  const plan = stageHomePurge(installer.files); release(); gate.close(); installer.close();
  expect(existsSync(f.homes.root)).toBe(false); expect(existsSync(plan.marker)).toBe(true);
  // A partial deletion may have removed the manifest inside the old home. The separate receipt survives.
  rmSync(join(plan.path, 'install.json'));
  const next = f.open(), id = next.files.load().id; file(join(f.homes.root, 'new-data.txt'), 'New installation');
  recoverHomePurges(f.homes);
  expect(existsSync(plan.path)).toBe(false); expect(existsSync(plan.marker)).toBe(false);
  expect(next.files.load().id).toBe(id); expect(readFileSync(join(f.homes.root, 'new-data.txt'), 'utf8')).toBe('New installation'); f.unchanged();
});

test('the purge command presents the recorded path and removes the home only after it is typed', async () => {
  const f = fixture(), installer = f.open(); await installer.install(f.source()); installer.close();
  const confirm = vi.fn(async (path: string) => { expect(path).toBe(f.homes.root); return path; }); vi.spyOn(console, 'log').mockImplementation(() => {});
  await main(['uninstall', '--purge'], { installer: f.open, confirmPurge: confirm });
  expect(confirm).toHaveBeenCalledOnce(); expect(existsSync(f.homes.root)).toBe(false); f.unchanged();
});

test('data-retaining uninstall also removes recorded unfinished application preparation', async () => {
  const f = fixture(), installer = f.open(); await installer.install(f.source());
  const prepared = installer.files.createDistribution('fixture source'); file(join(prepared.path, 'partial.tgz'), 'Partial archive');
  const id = randomUUID(), manifest = installer.files.load(), staging = join(f.homes.root, 'staging', id);
  manifest.pendingCopy = { schema: 'application-copy-v1', id, version: '0.2.0', staging, target: join(f.homes.root, 'app/0.2.0'), digest: '0'.repeat(64) }; installer.files.save(manifest);
  file(join(staging, 'partial.js'), 'Partial application copy'); const kept = file(join(f.homes.root, 'conversations/kept.txt'), 'Saved conversation');
  await installer.uninstall(); expect(existsSync(prepared.path)).toBe(false); expect(existsSync(staging)).toBe(false);
  expect(installer.files.load().pendingCopy).toBeUndefined(); expect(installer.files.load().distributions).toEqual([]);
  expect(readFileSync(kept, 'utf8')).toBe('Saved conversation'); f.unchanged();
});
