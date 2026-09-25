import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ServiceSpecSchema, UserServiceManager, serviceContents, type ServiceCommand, type ServiceSpec } from '../packages/cli/dist/service-manager.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(platform: 'darwin' | 'linux', run: ServiceCommand) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-service-'))); roots.push(root);
  const manager = new UserServiceManager({ platform, userHome: root, uid: 502, run });
  const spec: ServiceSpec = { schema: 'service-spec-v1', node: '/some Node/bin/node', entry: join(root, 'app', '0.1.0', 'bin', 'jevellan.mjs'), home: join(root, '.jevellan'), path: '/some Node/bin:/usr/bin:/bin', port: 9772 };
  const definition = manager.definition(spec); mkdirSync(dirname(definition.path), { recursive: true }); writeFileSync(definition.path, serviceContents(definition));
  return { root, manager, spec, definition };
}

test.each(['darwin', 'linux'] as const)('%s service lifecycle uses only the owned service and propagates failures', async platform => {
  const calls: { command: string; args: readonly string[] }[] = []; let fail = false; let loaded = false;
  const { manager, definition } = fixture(platform, async (command, args) => {
    calls.push({ command, args });
    if (fail) return 7;
    if (args[0] === 'print') return loaded ? 0 : 113;
    if (args[0] === 'bootstrap') loaded = true;
    return 0;
  });
  await manager.start(definition); await manager.start(definition); await manager.stop(definition); await manager.removed();
  expect(calls.every(call => call.command === (platform === 'darwin' ? '/bin/launchctl' : 'systemctl'))).toBe(true);
  if (platform === 'darwin') {
    expect(calls.filter(call => call.args[0] === 'bootstrap')).toEqual([{ command: '/bin/launchctl', args: ['bootstrap', 'gui/502', definition.path] }]);
    expect(calls.filter(call => call.args[0] === 'kickstart')).toEqual(Array.from({ length: 2 }, () => ({ command: '/bin/launchctl', args: ['kickstart', 'gui/502/dev.jevellan.daemon'] })));
    expect(calls.at(-1)?.args).toEqual(['bootout', 'gui/502/dev.jevellan.daemon']);
  } else {
    expect(calls.map(call => call.args)).toEqual([
      ['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'jevellan.service'],
      ['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'jevellan.service'],
      ['--user', 'disable', '--now', 'jevellan.service'], ['--user', 'daemon-reload'],
    ]);
  }
  fail = true; await expect(manager.start(definition)).rejects.toThrow('service manager failed');
  await expect(manager.stop(definition)).rejects.toThrow('service manager failed');
  expect(readFileSync(definition.path, 'utf8')).toBe(serviceContents(definition));
});

test.each(['darwin', 'linux'] as const)('%s refuses a changed, foreign or aliased service before invoking its manager', async platform => {
  let invoked = false;
  const { root, manager, definition } = fixture(platform, async () => { invoked = true; return 0; });
  writeFileSync(definition.path, 'Unrelated user service');
  await expect(manager.start(definition)).rejects.toThrow('changed outside');
  await expect(manager.stop(definition)).rejects.toThrow('changed outside');
  await expect(manager.start({ ...definition, path: join(root, 'other.service') })).rejects.toThrow('does not belong');
  const original = serviceContents(definition); const other = join(root, 'original'); writeFileSync(other, original);
  rmSync(definition.path); symlinkSync(other, definition.path);
  await expect(manager.start(definition)).rejects.toThrow('does not belong');
  expect(invoked).toBe(false); expect(readFileSync(other, 'utf8')).toBe(original);
});

test('macOS service file preserves paths with spaces and XML characters as literal arguments', () => {
  const { manager, spec } = fixture('darwin', async () => { throw new Error('No native services in tests.'); });
  const definition = manager.definition({ ...spec, node: '/Node & Tools/bin/node', entry: join(spec.home, 'app', 'name <one>', 'bin', 'jevellan.mjs') });
  writeFileSync(definition.path, serviceContents(definition));
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', definition.path], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ Label: 'dev.jevellan.daemon', ProgramArguments: [definition.spec.node, definition.spec.entry, 'start', '--port', '9772'], EnvironmentVariables: { JEVELLAN_HOME: spec.home, PATH: spec.path }, RunAtLoad: true, KeepAlive: true });
  } else expect(serviceContents(definition)).toContain('Node &amp; Tools');
});

test('Linux service preserves literal variable and specifier characters without a shell', () => {
  const { manager, spec } = fixture('linux', async () => { throw new Error('No native services in tests.'); });
  const definition = manager.definition({ ...spec, node: '/node %h/$BIN/node', home: '/data/100%/$HOME', path: '/bin/"quoted":/usr/bin' });
  const content = serviceContents(definition);
  expect(content).toContain('ExecStart=:"/node %%h/$BIN/node"');
  expect(content).toContain('Environment="JEVELLAN_HOME=/data/100%%/$HOME" "PATH=/bin/\\"quoted\\":/usr/bin"');
  expect(content).toContain('Type=exec');
  expect(ServiceSpecSchema.safeParse({ ...spec, path: '/usr/bin\nInjected=yes' }).success).toBe(false);
  expect(ServiceSpecSchema.safeParse({ ...spec, entry: 'relative/path' }).success).toBe(false);
});

test('an already unloaded macOS service is accepted only when the user domain remains reachable', async () => {
  const calls: string[][] = []; let targetCode = 113;
  const { manager, definition } = fixture('darwin', async (_command, args) => {
    calls.push([...args]);
    if (args[0] === 'bootout') return 3;
    if (args[1] === 'gui/502') return 0;
    return targetCode;
  });
  await manager.stop(definition);
  expect(calls).toEqual([['bootout', 'gui/502/dev.jevellan.daemon'], ['print', 'gui/502'], ['print', 'gui/502/dev.jevellan.daemon']]);
  targetCode = 0; await expect(manager.stop(definition)).rejects.toThrow('Could not stop');
});
