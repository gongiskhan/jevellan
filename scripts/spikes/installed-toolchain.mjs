import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Homes, inside, runOwnedCommand, writeDocument } from '../../packages/core/dist/index.js';
import { InstallationFiles } from '../../packages/cli/dist/installation-files.js';
import { installToolchain, ToolchainSchema } from '../../packages/cli/dist/toolchain.js';

const Result = z.strictObject({
  schema: z.literal('installed-toolchain-check-v1'), at: z.iso.datetime(), passed: z.literal(true),
  source: z.literal('live-dependency-install'), root: z.string(), toolchain: ToolchainSchema,
  initialInstallCommands: z.literal(2), repeatedInstallCommands: z.literal(0),
  nativeFixtureCanariesPreserved: z.literal(true), nativeServicesInvoked: z.literal(false),
});
const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-installed-toolchain-'))), user = join(root, 'user'); mkdirSync(user);
const canaries = ['.claude', '.codex', '.basic-memory', '.zshrc', 'dev/garrison/reference'];
for (const name of canaries) { const path = join(user, name); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'untouched'), name); }
const homes = new Homes(join(user, '.jevellan'), user), files = new InstallationFiles(homes, join(user, 'Library/LaunchAgents/dev.jevellan.daemon.plist'));
let installs = 0;
const run = async (command, args, options) => {
  if (args[0] === 'tool' && args[1] === 'install') installs++;
  for (const name of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_PYTHON_BIN_DIR', 'UV_CACHE_DIR', 'BASIC_MEMORY_CONFIG_DIR']) {
    if (!inside(homes.root, options.env[name])) throw new Error(`The dependency environment escaped Jevellan: ${name}`);
  }
  return runOwnedCommand(command, args, options);
};
try {
  console.log(`Disposable dependency install: ${root}`);
  const options = { run, find: () => null, progress: message => console.log(message) };
  const toolchain = await installToolchain(files, options), initialInstallCommands = installs;
  await installToolchain(files, options);
  for (const name of canaries) if (readFileSync(join(user, name, 'untouched'), 'utf8') !== name) throw new Error('A native-home fixture changed.');
  if (files.load().pendingTools || files.load().toolchains.length !== 1) throw new Error('Dependency installation did not reconcile its receipt.');
  writeDocument(join(root, 'result.json'), Result, {
    schema: 'installed-toolchain-check-v1', at: new Date().toISOString(), passed: true,
    source: 'live-dependency-install', root, toolchain, initialInstallCommands,
    repeatedInstallCommands: installs - initialInstallCommands,
    nativeFixtureCanariesPreserved: true, nativeServicesInvoked: false,
  });
  console.log(`Verified isolated installation and repeat: ${join(root, 'result.json')}`);
} finally { files.close(); }
