import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Homes, inside, type CommandResult } from '../packages/core/dist/index.js';
import { InstallationFiles } from '../packages/cli/dist/installation-files.js';
import { APM_VERSION, findExecutable, installToolchain, toolchainDirectoryName, type ToolCommand } from '../packages/cli/dist/toolchain.js';
import { UV_VERSION } from '../packages/cli/dist/uv-bootstrap.js';
import { BASIC_MEMORY_VERSION } from '../packages/memory/dist/index.js';

const roots: string[] = [], opened: InstallationFiles[] = [];
afterEach(() => { opened.splice(0).forEach(files => files.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '', timedOut: false });
function binary(path: string, version: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, version); chmodSync(path, 0o755); return path; }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-tools-'))); roots.push(root);
  const user = join(root, 'user'); mkdirSync(user);
  for (const name of ['.codex', '.claude', '.basic-memory', 'dev/garrison']) { const dir = join(user, name); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'keep'), name); }
  const homes = new Homes(join(user, '.jevellan'), user), service = join(user, 'Library/LaunchAgents/dev.jevellan.daemon.plist');
  const open = () => { const files = new InstallationFiles(homes, service); opened.push(files); return files; };
  const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
  const run: ToolCommand = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    expect(options.cwd).toBe(homes.root);
    for (const name of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_PYTHON_BIN_DIR', 'UV_CACHE_DIR', 'BASIC_MEMORY_CONFIG_DIR']) expect(inside(homes.root, options.env[name]!)).toBe(true);
    expect(options.env.CODEX_HOME).toBeUndefined(); expect(options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    if (args[0] === '--version') return ok(readFileSync(command, 'utf8'));
    expect(args.slice(0, 7)).toEqual(['tool', 'install', '--python', '3.12', '--managed-python', '--force', args[6]]);
    const [pkg, version] = args[6]!.split('=='); const name = pkg === 'apm-cli' ? 'apm' : 'basic-memory';
    const target = binary(join(options.env.UV_TOOL_DIR!, pkg!, 'bin', name), version!);
    symlinkSync(target, join(options.env.UV_TOOL_BIN_DIR!, name)); return ok();
  };
  const native = (name: string, version: string) => binary(join(user, '.local/bin', name), version);
  const bootstrap = vi.fn(async () => binary(join(homes.root, 'tools', `uv-${UV_VERSION}`, 'bin/uv'), UV_VERSION));
  const unchanged = () => { for (const name of ['.codex', '.claude', '.basic-memory', 'dev/garrison']) expect(readFileSync(join(user, name, 'keep'), 'utf8')).toBe(name); };
  return { homes, user, open, run, calls, native, bootstrap, unchanged };
}

test('reuses compatible native APM and uv read-only, but always installs private Basic Memory', async () => {
  const f = fixture(), files = f.open(); const uv = f.native('uv', UV_VERSION), apm = f.native('apm', APM_VERSION);
  const memory = f.native('basic-memory', BASIC_MEMORY_VERSION), found: string[] = [];
  const options = { run: f.run, find: (name: string) => { found.push(name); return name === 'uv' ? uv : name === 'apm' ? apm : memory; }, bootstrap: f.bootstrap };
  const tools = await installToolchain(files, options);
  expect(tools.uv).toMatchObject({ executable: uv, owned: false }); expect(tools.apm).toMatchObject({ executable: apm, owned: false });
  expect(tools.basicMemory.owned).toBe(true); expect(inside(tools.root, realpathSync(tools.basicMemory.executable))).toBe(true);
  expect(tools.path.split(':').slice(0, 2)).toEqual([join(tools.root, 'bin'), dirname(apm)]);
  expect(found).not.toContain('basic-memory'); expect(f.bootstrap).not.toHaveBeenCalled();
  expect(f.calls.filter(call => call.args[0] === 'tool')).toHaveLength(1);
  expect(files.load().pendingTools).toBeUndefined(); expect(files.load().toolchains).toEqual([tools]);
  await installToolchain(files, options); expect(f.calls.filter(call => call.args[0] === 'tool')).toHaveLength(1);
  expect(readFileSync(apm, 'utf8')).toBe(APM_VERSION); expect(readFileSync(memory, 'utf8')).toBe(BASIC_MEMORY_VERSION); f.unchanged();
});

test('incompatible native versions are left alone while Jevellan installs its pinned copies', async () => {
  const f = fixture(), files = f.open(); const native = new Map([['uv', f.native('uv', '0.1.0')], ['apm', f.native('apm', '9.0.0')]]);
  const tools = await installToolchain(files, { run: f.run, find: name => native.get(name) ?? null, bootstrap: f.bootstrap });
  expect([tools.uv.owned, tools.apm.owned, tools.basicMemory.owned]).toEqual([true, true, true]); expect(f.bootstrap).toHaveBeenCalledOnce();
  expect(f.calls.filter(call => call.args[0] === 'tool').map(call => call.args[6])).toEqual([`apm-cli==${APM_VERSION}`, `basic-memory==${BASIC_MEMORY_VERSION}`]);
  expect(readFileSync(native.get('uv')!, 'utf8')).toBe('0.1.0'); expect(readFileSync(native.get('apm')!, 'utf8')).toBe('9.0.0'); f.unchanged();
});

test('a failed dependency install retains a retryable plan and does not reinstall completed tools', async () => {
  const f = fixture(); let files = f.open(); let failed = false;
  const run: ToolCommand = async (command, args, options) => {
    if (args[6]?.startsWith('basic-memory==') && !failed) { failed = true; return { code: 1, stdout: '', stderr: 'Simulated download interrupted', timedOut: false }; }
    return f.run(command, args, options);
  };
  const options = { run, find: () => null, bootstrap: f.bootstrap };
  await expect(installToolchain(files, options)).rejects.toThrow('download interrupted');
  expect(files.load().toolchains).toEqual([]); const pending = files.load().pendingTools!;
  expect(pending.root).toBe(join(f.homes.root, 'tools', toolchainDirectoryName()));
  files.close(); files = f.open(); await installToolchain(files, options);
  expect(files.load().pendingTools).toBeUndefined(); expect(f.bootstrap).toHaveBeenCalledOnce();
  expect(f.calls.filter(call => call.args[6]?.startsWith('apm-cli=='))).toHaveLength(1); f.unchanged();
});

test('a lost completion receipt is recovered from installed executable versions', async () => {
  const f = fixture(); let files = f.open(); const save = files.save.bind(files);
  vi.spyOn(files, 'save').mockImplementationOnce(save).mockImplementationOnce(() => { throw new Error('Simulated lost completion receipt'); });
  const options = { run: f.run, find: () => null, bootstrap: f.bootstrap };
  await expect(installToolchain(files, options)).rejects.toThrow('lost completion receipt');
  expect(files.load().pendingTools).toBeDefined(); files.close(); files = f.open();
  await installToolchain(files, options); expect(files.load().toolchains).toHaveLength(1); expect(files.load().pendingTools).toBeUndefined();
  expect(f.calls.filter(call => call.args[0] === 'tool')).toHaveLength(2); f.unchanged();
});

test('previous application tool environments remain recorded and usable for rollback', async () => {
  const f = fixture(), files = f.open(); const current = await installToolchain(files, { run: f.run, find: () => null, bootstrap: f.bootstrap });
  const versions = { uv: UV_VERSION, apm: '0.9.0', basicMemory: '0.21.0', python: '3.12' }, root = join(f.homes.root, 'tools', toolchainDirectoryName(versions));
  const old = { ...current, root, apm: { ...current.apm, version: versions.apm, executable: binary(join(root, 'bin/apm'), versions.apm) }, basicMemory: { ...current.basicMemory, version: versions.basicMemory, executable: binary(join(root, 'bin/basic-memory'), versions.basicMemory) }, path: join(root, 'bin') };
  const manifest = files.load(); manifest.toolchains.push(old); files.save(manifest);
  await installToolchain(files, { run: f.run, find: () => null, bootstrap: f.bootstrap });
  expect(files.load().toolchains).toHaveLength(2); expect(files.load().toolchains.find(value => value.root === old.root)).toEqual(old);
  expect(readFileSync(old.basicMemory.executable, 'utf8')).toBe('0.21.0');
});

test('cancellation leaves an explicit pending install and starts no later dependency commands', async () => {
  const f = fixture(), files = f.open(), signal = AbortSignal.abort();
  await expect(installToolchain(files, { signal, run: f.run, find: () => null, bootstrap: f.bootstrap })).rejects.toThrow();
  expect(files.load().pendingTools).toBeDefined(); expect(f.calls).toHaveLength(0); expect(f.bootstrap).not.toHaveBeenCalled(); f.unchanged();
});

test('an owned dependency link cannot claim a native executable', async () => {
  const f = fixture(), files = f.open(), native = f.native('apm', APM_VERSION), bin = f.homes.ensure('tools', toolchainDirectoryName(), 'bin');
  symlinkSync(native, join(bin, 'apm'));
  await expect(installToolchain(files, { run: f.run, find: () => null, bootstrap: f.bootstrap })).rejects.toThrow('outside its owned directory');
  expect(readFileSync(native, 'utf8')).toBe(APM_VERSION); f.unchanged();
});

test('executable lookup skips relative paths, non-executable files and directories', () => {
  const f = fixture(), first = join(f.user, 'first'), second = join(f.user, 'second'); mkdirSync(join(first, 'uv'), { recursive: true });
  const path = binary(join(second, 'uv'), UV_VERSION); expect(findExecutable('uv', `.:${first}:${second}`)).toBe(path);
  chmodSync(path, 0o600); expect(findExecutable('uv', `${first}:${second}`)).toBeNull(); expect(existsSync(join(first, 'uv'))).toBe(true);
});

test('dependency repair cannot replace a tool environment selected by the active application', async () => {
  const f = fixture(), files = f.open(); const options = { run: f.run, find: () => null, bootstrap: f.bootstrap };
  const tools = await installToolchain(files, options), manifest = files.load();
  manifest.applications.push({ schema: 'installed-application-v1', version: '0.1.0', path: join(f.homes.root, 'app/0.1.0'), digest: '0'.repeat(64), installedAt: new Date().toISOString(), toolchain: tools.root });
  manifest.activeVersion = '0.1.0'; files.save(manifest); writeFileSync(tools.basicMemory.executable, '0.0.0');
  const count = f.calls.filter(call => call.args[0] === 'tool').length;
  await expect(installToolchain(files, options)).rejects.toThrow('active dependency environment needs repair');
  expect(f.calls.filter(call => call.args[0] === 'tool')).toHaveLength(count); expect(readFileSync(tools.basicMemory.executable, 'utf8')).toBe('0.0.0');
});
