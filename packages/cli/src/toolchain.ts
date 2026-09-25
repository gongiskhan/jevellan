import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Homes, inside, resolvedPath, runOwnedCommand, type CommandResult } from '@jevellan/core';
import { BASIC_MEMORY_VERSION, memoryEnvironment } from '@jevellan/memory';
import { z } from 'zod';
import { bootstrapUv, toolDirectory, UV_VERSION } from './uv-bootstrap.js';
import type { InstallationFiles } from './installation-files.js';

export const APM_VERSION = '0.10.0';
const AbsolutePath = z.string().refine(isAbsolute);
const Version = z.string().regex(/^\d+\.\d+(?:\.\d+)?$/);
const Tool = z.strictObject({ schema: z.literal('installed-tool-v1'), executable: AbsolutePath, version: z.string().min(1), owned: z.boolean() });
export const ToolchainSchema = z.strictObject({
  schema: z.literal('toolchain-v1'), root: AbsolutePath, installedAt: z.iso.datetime(),
  uv: Tool.extend({ version: Version }), apm: Tool.extend({ version: Version }),
  basicMemory: Tool.extend({ version: Version, owned: z.literal(true) }),
  python: Version, path: z.string().min(1),
});
export type Toolchain = z.infer<typeof ToolchainSchema>;
export const ToolchainPlanSchema = z.strictObject({
  schema: z.literal('toolchain-install-v1'), root: AbsolutePath, createdAt: z.iso.datetime(),
  uv: Version, apm: Version, basicMemory: Version, python: Version,
});
const pins = { uv: UV_VERSION, apm: APM_VERSION, basicMemory: BASIC_MEMORY_VERSION, python: '3.12' };
export function toolchainDirectoryName(versions = pins): string {
  for (const value of [versions.uv, versions.apm, versions.basicMemory, versions.python]) Version.parse(value);
  return `apm-${versions.apm}_memory-${versions.basicMemory}_python-${versions.python}`;
}
export type ToolCommand = (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }) => Promise<CommandResult>;

export function findExecutable(name: string, path = process.env.PATH ?? '/usr/bin:/bin'): string | null {
  for (const directory of path.split(':').filter(isAbsolute)) {
    const file = join(directory, name);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return resolvedPath(file); } catch { /* Try the next explicit directory. */ }
  }
  return null;
}
export function toolEnvironment(homes: Homes, path = process.env.PATH ?? '/usr/bin:/bin'): Record<string, string> {
  const directory = toolchainDirectoryName(), own = (...parts: string[]) => toolDirectory(homes, directory, ...parts), bin = own('bin');
  return {
    ...memoryEnvironment(homes),
    PATH: [...new Set([bin, dirname(process.execPath), ...path.split(':').filter(isAbsolute), '/usr/bin', '/bin'])].join(':'),
    HOME: own('user'), TMPDIR: own('tmp'),
    XDG_CONFIG_HOME: own('config'), XDG_DATA_HOME: own('data'), XDG_CACHE_HOME: own('cache'),
    UV_TOOL_DIR: own('python-tools'), UV_TOOL_BIN_DIR: bin,
    UV_PYTHON_INSTALL_DIR: own('python'), UV_PYTHON_BIN_DIR: bin,
    UV_CACHE_DIR: toolDirectory(homes, 'cache', 'uv'), UV_LINK_MODE: 'copy',
    UV_MANAGED_PYTHON: '1', UV_NO_CONFIG: '1', UV_NO_ENV_FILE: '1', UV_NO_PROGRESS: '1', UV_NO_MODIFY_PATH: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}
function assertOwned(root: string, executable: string): void {
  if (!inside(root, resolvedPath(executable))) throw new Error('A Jevellan tool executable points outside its owned directory.');
}
export function validateToolchain(homes: Homes, value: Toolchain): Toolchain {
  const parsed = ToolchainSchema.parse(value), directory = toolchainDirectoryName({ uv: parsed.uv.version, apm: parsed.apm.version, basicMemory: parsed.basicMemory.version, python: parsed.python }), expected = join(homes.root, 'tools', directory);
  if (parsed.root !== expected || homes.at('tools', directory) !== expected) throw new Error('This toolchain belongs to another installation.');
  for (const tool of [parsed.apm, parsed.basicMemory]) if (tool.owned) assertOwned(expected, tool.executable);
  if (parsed.uv.owned) assertOwned(join(homes.root, 'tools', `uv-${parsed.uv.version}`), parsed.uv.executable);
  return parsed;
}

/** Caller holds the installation lock. Native tools are only probed, never updated. */
export async function installToolchain(files: InstallationFiles, options: {
  run?: ToolCommand; find?: (name: string) => string | null; bootstrap?: (homes: Homes, signal?: AbortSignal) => Promise<string>;
  path?: string; signal?: AbortSignal; progress?: (message: string) => void;
} = {}): Promise<Toolchain> {
  const homes = files.homes, directory = toolchainDirectoryName(), root = join(homes.root, 'tools', directory); let manifest = files.load();
  if (homes.at('tools', directory) !== root) throw new Error('The toolchain directory cannot alias another location.');
  manifest.pendingTools = ToolchainPlanSchema.parse({ schema: 'toolchain-install-v1', root, createdAt: manifest.pendingTools?.createdAt ?? new Date().toISOString(), uv: UV_VERSION, apm: APM_VERSION, basicMemory: BASIC_MEMORY_VERSION, python: '3.12' });
  files.save(manifest);
  const env = toolEnvironment(homes, options.path), run = options.run ?? runOwnedCommand;
  const find = options.find ?? (name => findExecutable(name, options.path));
  const commandOptions = { cwd: homes.root, env, timeoutMs: 600_000, ...(options.signal ? { signal: options.signal } : {}) };
  const probe = async (executable: string | null, version: string, owned: boolean) => {
    options.signal?.throwIfAborted(); if (!executable || !existsSync(executable)) return false;
    if (owned) assertOwned(join(homes.root, 'tools'), executable);
    try {
      const result = await run(executable, ['--version'], { ...commandOptions, timeoutMs: 30_000 });
      return result.code === 0 && new RegExp(`\\b${version.replaceAll('.', '\\.')}\\b`).test(result.stdout);
    } catch (error) { if (options.signal?.aborted) throw error; return false; }
  };
  const installed = (executable: string, version: string, owned: boolean) => ({ schema: 'installed-tool-v1' as const, executable, version, owned });
  let uv = join(homes.root, 'tools', `uv-${UV_VERSION}`, 'bin', 'uv'); let uvOwned = true;
  if (!await probe(uv, UV_VERSION, true)) {
    const existing = find('uv');
    if (await probe(existing, UV_VERSION, false)) { uv = existing!; uvOwned = inside(join(homes.root, 'tools'), resolvedPath(uv)); }
    else {
      options.progress?.('Installing Jevellan’s Python package manager.');
      uv = await (options.bootstrap ?? ((home, signal) => bootstrapUv(home, { ...(signal ? { signal } : {}) })))(homes, options.signal);
      if (!await probe(uv, UV_VERSION, true)) throw new Error('The installed uv executable did not pass its version check.');
    }
  }
  const install = async (name: string, version: string, packageName: string) => {
    if (manifest.applications.some(app => app.version === manifest.activeVersion && app.toolchain === root)) throw new Error('The active dependency environment needs repair. Uninstall while keeping data, then reinstall.');
    options.progress?.(`Installing ${name} ${version} inside Jevellan.`);
    const result = await run(uv, ['tool', 'install', '--python', '3.12', '--managed-python', '--force', `${packageName}==${version}`], commandOptions);
    if (result.code !== 0) throw new Error(`${name} installation failed${result.timedOut ? ' after its time limit' : ` (exit ${result.code})`}. ${result.stderr.trim().slice(-1200)}`);
  };
  let apm = join(root, 'bin', 'apm'); let apmOwned = true;
  if (!await probe(apm, APM_VERSION, true)) {
    const existing = find('apm');
    if (await probe(existing, APM_VERSION, false)) { apm = existing!; apmOwned = inside(root, resolvedPath(apm)); }
    else { await install('APM', APM_VERSION, 'apm-cli'); if (!await probe(apm, APM_VERSION, true)) throw new Error('The installed APM did not pass its version check.'); }
  }
  const memory = join(root, 'bin', 'basic-memory');
  if (!await probe(memory, BASIC_MEMORY_VERSION, true)) { await install('Basic Memory', BASIC_MEMORY_VERSION, 'basic-memory'); if (!await probe(memory, BASIC_MEMORY_VERSION, true)) throw new Error('The installed Basic Memory did not pass its version check.'); }
  const result = validateToolchain(homes, ToolchainSchema.parse({ schema: 'toolchain-v1', root, installedAt: new Date().toISOString(), uv: installed(uv, UV_VERSION, uvOwned), apm: installed(apm, APM_VERSION, apmOwned), basicMemory: installed(memory, BASIC_MEMORY_VERSION, true), python: '3.12', path: [...new Set([join(root, 'bin'), dirname(apm), ...env.PATH!.split(':')])].join(':') }));
  manifest = files.load(); manifest.toolchains = [...manifest.toolchains.filter(entry => entry.root !== result.root), result]; delete manifest.pendingTools; files.save(manifest); return result;
}
