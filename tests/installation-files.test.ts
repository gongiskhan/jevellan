import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Homes } from '../packages/core/dist/index.js';
import { InstallationFiles, applicationDigest } from '../packages/cli/dist/installation-files.js';
import { UserServiceManager, serviceContents } from '../packages/cli/dist/service-manager.js';
import { commandOnPath, commandPath, removeCommand, writeCommand, type CommandDefinition } from '../packages/cli/dist/installed-command.js';

const roots: string[] = [], opened: InstallationFiles[] = [];
afterEach(() => { opened.splice(0).forEach(files => files.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(platform: 'darwin' | 'linux' = 'darwin', userName = 'user') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-install-files-'))); roots.push(root);
  const user = join(root, userName), source = join(root, 'distribution'); mkdirSync(user);
  for (const name of ['.codex', '.claude', '.basic-memory', 'dev/garrison']) { const dir = join(user, name); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'untouched'), name); }
  for (const [name, contents] of [
    ['package.json', JSON.stringify({ name: 'jevellan', version: '0.1.0', type: 'module' })],
    ['bin/jevellan.mjs', '#!/usr/bin/env node\nconsole.log("0.1.0");\n'],
    ['packages/cli/dist/index.js', 'export function main() {}\n'],
    ['apps/web/dist/index.html', '<!doctype html><title>Jevellan</title>'],
  ]) { const path = join(source, name!); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents!); }
  chmodSync(join(source, 'bin/jevellan.mjs'), 0o755);
  mkdirSync(join(source, 'node_modules', '.bin'), { recursive: true }); symlinkSync('../../bin/jevellan.mjs', join(source, 'node_modules', '.bin', 'jevellan'));
  const homes = new Homes(join(user, '.jevellan'), user);
  const manager = new UserServiceManager({ platform, userHome: user, uid: 502, run: async () => { throw new Error('File tests must not invoke native services.'); } });
  const spec = { schema: 'service-spec-v1' as const, node: process.execPath, entry: join(homes.root, 'app', '0.1.0', 'bin', 'jevellan.mjs'), home: homes.root, path: '/usr/bin:/bin', port: 9772 };
  const definition = manager.definition(spec);
  const open = () => { const files = new InstallationFiles(homes, definition.path); opened.push(files); return files; };
  return { root, user, source, homes, manager, definition, open };
}

test('versioned copies are independent, executable and reusable only when their contents match', () => {
  const { source, user, homes, open } = fixture(); const files = open();
  const installed = files.copyApplication(source);
  expect(installed.path).toBe(join(homes.root, 'app', '0.1.0')); expect(applicationDigest(installed.path)).toBe(applicationDigest(source));
  expect(spawnSync(process.execPath, [join(installed.path, 'bin/jevellan.mjs')], { encoding: 'utf8' }).stdout.trim()).toBe('0.1.0');
  expect(lstatSync(join(installed.path, 'bin/jevellan.mjs')).mode & 0o111).toBe(0o111);
  expect(files.copyApplication(source)).toEqual(installed); expect(files.load().applications).toHaveLength(1);
  writeFileSync(join(installed.path, 'apps/web/dist/index.html'), 'An edit to the installed copy');
  expect(readFileSync(join(source, 'apps/web/dist/index.html'), 'utf8')).toContain('<title>Jevellan</title>');
  expect(() => files.copyApplication(source)).toThrow('different contents');
  for (const name of ['.codex', '.claude', '.basic-memory', 'dev/garrison']) expect(readFileSync(join(user, name, 'untouched'), 'utf8')).toBe(name);
  expect(lstatSync(join(homes.root, 'install.json')).mode & 0o777).toBe(0o600);
});

test('the executable command quotes paths, preserves arguments and binds its own installed home', () => {
  const { source, homes, user, open } = fixture('darwin', 'user with \'quotes\' $dollars `ticks`'); const files = open();
  writeFileSync(join(source, 'bin/jevellan.mjs'), 'console.log(JSON.stringify({ home: process.env.JEVELLAN_HOME, args: process.argv.slice(2) }));\n');
  const app = files.copyApplication(source), path = commandPath(files, '/usr/bin:/bin');
  writeCommand(files, { schema: 'command-definition-v1', path, node: process.execPath, entry: join(app.path, 'bin/jevellan.mjs'), home: homes.root });
  const args = ['an argument with spaces', "'quoted'", '$(exit 1)', '--version'];
  const run = spawnSync('jevellan', args, { encoding: 'utf8', cwd: user, env: { HOME: user, PATH: dirname(path), JEVELLAN_HOME: join(user, 'wrong-home') } });
  expect(run.error).toBeUndefined(); expect(run.status).toBe(0); expect(JSON.parse(run.stdout)).toEqual({ home: homes.root, args });
  expect(commandOnPath(path, dirname(path))).toBe(true); expect(commandOnPath(path, '/usr/bin:/bin')).toBe(false);
  expect(files.load().command?.definition.path).toBe(path); expect(lstatSync(path).mode & 0o111).toBe(0o111);
});

test('command selection uses an existing user bin on PATH, retains that choice and reports a shadowing executable', () => {
  const { source, homes, user, root, open } = fixture(); const files = open(), app = files.copyApplication(source);
  const bin = join(user, 'bin'), other = join(root, 'earlier-bin'); mkdirSync(bin); mkdirSync(other);
  const path = commandPath(files, `${bin}:/usr/bin:/bin`); expect(path).toBe(join(bin, 'jevellan'));
  writeCommand(files, { schema: 'command-definition-v1', path, node: process.execPath, entry: join(app.path, 'bin/jevellan.mjs'), home: homes.root });
  expect(commandPath(files, join(user, '.local/bin'))).toBe(path);
  writeFileSync(join(other, 'jevellan'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  expect(commandOnPath(path, `${other}:${bin}`)).toBe(false); expect(commandOnPath(path, `${bin}:${other}`)).toBe(true);
  removeCommand(files); expect(existsSync(bin)).toBe(true); expect(existsSync(join(other, 'jevellan'))).toBe(true);
});

test('command creation recovers a lost receipt and removes only its listed file and empty created directories', () => {
  const { source, homes, user, open } = fixture(); let files = open(); const app = files.copyApplication(source), path = commandPath(files, '');
  const definition: CommandDefinition = { schema: 'command-definition-v1', path, node: process.execPath, entry: join(app.path, 'bin/jevellan.mjs'), home: homes.root };
  const save = files.save.bind(files); vi.spyOn(files, 'save').mockImplementationOnce(save).mockImplementationOnce(() => { throw new Error('Lost command receipt'); });
  expect(() => writeCommand(files, definition)).toThrow('Lost command receipt'); const ino = lstatSync(path).ino;
  expect(files.load().pendingCommand?.definition).toEqual(definition); files.close(); files = open(); writeCommand(files, definition);
  expect(lstatSync(path).ino).toBe(ino); expect(files.load().pendingCommand).toBeUndefined();
  writeFileSync(join(dirname(path), 'keep'), 'Another command');
  vi.spyOn(files, 'save').mockImplementationOnce(() => { throw new Error('Lost command removal receipt'); });
  expect(() => removeCommand(files)).toThrow('Lost command removal receipt'); expect(existsSync(path)).toBe(false);
  files.close(); files = open(); removeCommand(files);
  expect(files.load().command).toBeUndefined(); expect(readFileSync(join(dirname(path), 'keep'), 'utf8')).toBe('Another command');
  rmSync(join(dirname(path), 'keep')); removeCommand(files); expect(existsSync(join(user, '.local'))).toBe(false);
});

test.each(['file', 'link', 'dangling-link', 'parent-link'] as const)('an existing %s at the command path is never replaced', kind => {
  const { source, homes, user, root, open } = fixture(); const files = open(), app = files.copyApplication(source), path = commandPath(files, '');
  const external = join(root, 'external'); mkdirSync(external); writeFileSync(join(external, 'keep'), 'Untouched');
  if (kind === 'parent-link') { mkdirSync(join(user, '.local')); symlinkSync(external, dirname(path)); }
  else {
    mkdirSync(dirname(path), { recursive: true });
    if (kind === 'file') writeFileSync(path, 'Existing command');
    else symlinkSync(join(external, kind === 'link' ? 'keep' : 'missing'), path);
  }
  expect(() => writeCommand(files, { schema: 'command-definition-v1', path, node: process.execPath, entry: join(app.path, 'bin/jevellan.mjs'), home: homes.root })).toThrow();
  expect(files.load().command).toBeUndefined(); expect(files.load().pendingCommand).toBeUndefined(); expect(readFileSync(join(external, 'keep'), 'utf8')).toBe('Untouched');
  if (kind === 'file') expect(readFileSync(path, 'utf8')).toBe('Existing command');
  else expect(lstatSync(kind === 'parent-link' ? dirname(path) : path).isSymbolicLink()).toBe(true);
});

test('a first command write preserves a file created after preparation', () => {
  const { source, homes, open } = fixture(); const files = open(), app = files.copyApplication(source), path = commandPath(files, '');
  mkdirSync(dirname(path), { recursive: true }); const save = files.save.bind(files);
  vi.spyOn(files, 'save').mockImplementationOnce(manifest => { const saved = save(manifest); writeFileSync(path, 'Another installer won'); return saved; });
  expect(() => writeCommand(files, { schema: 'command-definition-v1', path, node: process.execPath, entry: join(app.path, 'bin/jevellan.mjs'), home: homes.root })).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('Another installer won'); expect(files.load().command).toBeUndefined();
});

test('a newer version is copied alongside the old one without switching the active service', () => {
  const { source, definition, open } = fixture(); const files = open(); const original = files.copyApplication(source); files.writeService(definition);
  const manifest = files.load(); manifest.activeVersion = original.version; files.save(manifest);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'jevellan', version: '0.2.0', type: 'module' }));
  const next = files.copyApplication(source);
  expect(files.load().applications).toHaveLength(2); expect(files.load().activeVersion).toBe('0.1.0');
  expect(readFileSync(definition.path, 'utf8')).toBe(serviceContents(definition));
  expect(existsSync(original.path)).toBe(true); expect(next.path).not.toBe(original.path);
});

test('another installer cannot acquire the home until the current transaction closes', () => {
  const { open } = fixture(); const first = open();
  expect(() => open()).toThrow(/locked/); first.close(); expect(open().load().applications).toEqual([]);
});

test('a completed copy whose final manifest write failed is reconciled after restart', () => {
  const { source, open } = fixture(); let files = open(); const save = files.save.bind(files);
  vi.spyOn(files, 'save').mockImplementationOnce(save).mockImplementationOnce(() => { throw new Error('Simulated lost manifest write'); });
  expect(() => files.copyApplication(source)).toThrow('lost manifest write');
  const pending = files.load().pendingCopy!; expect(existsSync(pending.target)).toBe(true);
  files.close(); files = open(); const installed = files.copyApplication(source);
  expect(installed.path).toBe(pending.target); expect(files.load().pendingCopy).toBeUndefined(); expect(files.load().applications).toEqual([installed]);
});

test('an interrupted unstable distribution can be retried from its original bytes without removing other staging files', () => {
  const { source, homes, open } = fixture(); let files = open(); const save = files.save.bind(files);
  const file = join(source, 'apps/web/dist/index.html'), original = readFileSync(file, 'utf8');
  const other = homes.ensure('staging', 'unrelated'); writeFileSync(join(other, 'kept'), 'Another staging item');
  vi.spyOn(files, 'save').mockImplementationOnce(manifest => {
    const saved = save(manifest); writeFileSync(file, 'Source changed while the installation was preparing'); return saved;
  });
  expect(() => files.copyApplication(source)).toThrow('changed while it was copied'); const pending = files.load().pendingCopy!;
  expect(existsSync(pending.staging)).toBe(true); expect(existsSync(pending.target)).toBe(false);
  writeFileSync(file, original); files.close(); files = open();
  const installed = files.copyApplication(source); expect(readFileSync(join(installed.path, 'apps/web/dist/index.html'), 'utf8')).toBe(original);
  expect(readFileSync(join(other, 'kept'), 'utf8')).toBe('Another staging item'); expect(existsSync(pending.staging)).toBe(false);
});

test.each(['darwin', 'linux'] as const)('%s service definitions are recorded before writing and recovered without native service calls', platform => {
  const { source, definition, open } = fixture(platform); let files = open(); files.copyApplication(source);
  const save = files.save.bind(files);
  vi.spyOn(files, 'save').mockImplementationOnce(save).mockImplementationOnce(() => { throw new Error('Simulated lost service receipt'); });
  expect(() => files.writeService(definition)).toThrow('lost service receipt');
  expect(files.load().pendingService?.definition).toEqual(definition); const ino = lstatSync(definition.path).ino;
  files.close(); files = open(); files.writeService(definition);
  expect(files.load().pendingService).toBeUndefined(); expect(files.load().service?.definition).toEqual(definition); expect(lstatSync(definition.path).ino).toBe(ino);
  expect(files.load().serviceDirectories).toContain(dirname(definition.path));
  writeFileSync(definition.path, 'User changed the service');
  expect(() => files.writeService(definition)).toThrow('changed outside'); expect(readFileSync(definition.path, 'utf8')).toBe('User changed the service');
});

test('an unrecorded existing application or service is preserved', () => {
  const { source, homes, definition, open } = fixture(); const files = open();
  mkdirSync(join(homes.root, 'app', '0.1.0'), { recursive: true }); writeFileSync(join(homes.root, 'app', '0.1.0', 'keep'), 'Unrelated');
  expect(() => files.copyApplication(source)).toThrow('unrecorded application');
  expect(readFileSync(join(homes.root, 'app', '0.1.0', 'keep'), 'utf8')).toBe('Unrelated');
  rmSync(join(homes.root, 'app', '0.1.0'), { recursive: true }); files.copyApplication(source);
  mkdirSync(dirname(definition.path), { recursive: true }); writeFileSync(definition.path, 'Unrelated service');
  expect(() => files.writeService(definition)).toThrow('changed outside'); expect(readFileSync(definition.path, 'utf8')).toBe('Unrelated service');
});

test('protected distribution files and links outside the copy are refused before staging', () => {
  const { source, root, open } = fixture(); const files = open();
  writeFileSync(join(source, 'BRIEF.md'), 'Local specification'); expect(() => files.copyApplication(source)).toThrow('protected path'); rmSync(join(source, 'BRIEF.md'));
  writeFileSync(join(root, 'outside'), 'Outside the distribution'); symlinkSync('../../outside', join(source, 'bin', 'outside'));
  expect(() => files.copyApplication(source)).toThrow('inside the installed copy'); expect(files.load().pendingCopy).toBeUndefined(); expect(files.load().applications).toEqual([]);
});

test('service definitions cannot run from a checkout or claim another user service', () => {
  const { source, definition, open } = fixture(); const files = open(); files.copyApplication(source);
  expect(() => files.writeService({ ...definition, spec: { ...definition.spec, entry: join(source, 'bin/jevellan.mjs') } })).toThrow('recorded installed application');
  expect(() => files.writeService({ ...definition, path: join(dirname(definition.path), 'another.plist') })).toThrow('does not belong');
  expect(existsSync(definition.path)).toBe(false);
});

test('file removal preserves data, unlisted applications and another service in a created directory', () => {
  const { source, homes, definition, open } = fixture(); const files = open(); const installed = files.copyApplication(source); files.writeService(definition);
  const other = join(dirname(definition.path), 'other.plist'); writeFileSync(other, 'Another service');
  const data = homes.ensure('conversations'); writeFileSync(join(data, 'kept'), 'Conversation data');
  const unlisted = homes.ensure('app', 'unlisted'); writeFileSync(join(unlisted, 'kept'), 'Unlisted application');
  expect(() => files.removeApplications()).toThrow('stopped service');
  files.removeServiceDefinition(); files.removeApplications();
  expect(existsSync(definition.path)).toBe(false); expect(existsSync(installed.path)).toBe(false);
  expect(readFileSync(other, 'utf8')).toBe('Another service'); expect(readFileSync(join(data, 'kept'), 'utf8')).toBe('Conversation data'); expect(readFileSync(join(unlisted, 'kept'), 'utf8')).toBe('Unlisted application');
  expect(files.load().applications).toEqual([]); expect(files.load().dataRoot.retainedOnUninstall).toBe(true);
});

test('removal checks every recorded application before deleting any changed copy', () => {
  const { source, open } = fixture(); const files = open(); const first = files.copyApplication(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'jevellan', version: '0.2.0', type: 'module' })); const second = files.copyApplication(source);
  writeFileSync(join(second.path, 'keep'), 'Added after installation');
  expect(() => files.removeApplications()).toThrow('changed outside'); expect(existsSync(first.path)).toBe(true); expect(readFileSync(join(second.path, 'keep'), 'utf8')).toBe('Added after installation');
});

test('file removal recovers after a successful deletion loses its manifest receipt', () => {
  const { source, definition, open } = fixture(); let files = open(); const installed = files.copyApplication(source); files.writeService(definition);
  vi.spyOn(files, 'save').mockImplementationOnce(() => { throw new Error('Simulated lost removal receipt'); });
  expect(() => files.removeServiceDefinition()).toThrow('lost removal receipt'); expect(existsSync(definition.path)).toBe(false);
  files.close(); files = open(); files.removeServiceDefinition();
  vi.spyOn(files, 'save').mockImplementationOnce(() => { throw new Error('Simulated lost removal receipt'); });
  expect(() => files.removeApplications()).toThrow('lost removal receipt'); expect(existsSync(installed.path)).toBe(false);
  files.close(); files = open(); files.removeApplications(); expect(files.load().applications).toEqual([]);
});

test('a first service write never replaces a service created after preparation', () => {
  const { source, definition, open } = fixture(); const files = open(); files.copyApplication(source);
  mkdirSync(dirname(definition.path), { recursive: true }); const save = files.save.bind(files);
  vi.spyOn(files, 'save').mockImplementationOnce(manifest => {
    const saved = save(manifest); writeFileSync(definition.path, 'A different installation claimed the service'); return saved;
  });
  expect(() => files.writeService(definition)).toThrow();
  expect(readFileSync(definition.path, 'utf8')).toBe('A different installation claimed the service');
  expect(files.load().service).toBeUndefined(); expect(files.load().pendingService).toBeDefined();
});
