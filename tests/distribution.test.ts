import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { c } from 'tar';
import { afterEach, expect, test } from 'vitest';
import { Homes, inside } from '../packages/core/dist/index.js';
import { InstallationFiles } from '../packages/cli/dist/installation-files.js';
import { prepareDistribution } from '../packages/cli/dist/distribution.js';
import type { ToolCommand } from '../packages/cli/dist/toolchain.js';

const roots: string[] = [], opened: InstallationFiles[] = [];
afterEach(() => { opened.splice(0).forEach(files => files.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-distribution-'))); roots.push(root);
  const user = join(root, 'user'); mkdirSync(user); const homes = new Homes(join(user, '.jevellan'), user);
  const files = new InstallationFiles(homes, join(user, 'Library/LaunchAgents/dev.jevellan.daemon.plist')); opened.push(files);
  const source = join(root, 'source');
  for (const [name, text] of [['package.json', JSON.stringify({ name: 'jevellan', version: '0.1.0', type: 'module' })], ['bin/jevellan.mjs', 'console.log("0.1.0");'], ['packages/cli/dist/index.js', 'export function main() {}'], ['apps/web/dist/index.html', '<title>Jevellan</title>']]) {
    const path = join(source, name!); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text!);
  }
  const pack = async (file = join(root, 'jevellan-0.1.0.tgz')) => { await c({ file, cwd: source, prefix: 'package', gzip: true }, ['package.json', 'bin', 'packages', 'apps']); return file; };
  return { root, homes, files, source, pack };
}

test('a packed archive is extracted into a recorded private directory and copied independently', async () => {
  const f = fixture(), archive = await f.pack(); const prepared = await prepareDistribution(f.files, { from: archive });
  expect(f.files.load().distributions).toMatchObject([{ source: archive, ready: true }]);
  const app = f.files.copyApplication(prepared.path); prepared.cleanup();
  expect(existsSync(prepared.path)).toBe(false); expect(f.files.load().distributions).toEqual([]);
  expect(readFileSync(join(app.path, 'bin/jevellan.mjs'), 'utf8')).toContain('0.1.0');
});

test('a local checkout is built and packed with isolated caches before copying the distribution', async () => {
  const f = fixture(), calls: string[][] = [];
  const run: ToolCommand = async (command, args, options) => {
    calls.push([command, ...args]); expect(options.cwd).toBe(f.source); expect(inside(f.homes.root, options.env.HOME!)).toBe(true); expect(inside(f.homes.root, options.env.npm_config_cache!)).toBe(true);
    let stdout = '';
    if (args[0] === 'pack') { const target = args[args.indexOf('--pack-destination') + 1]!; await f.pack(join(target, 'jevellan-0.1.0.tgz')); stdout = JSON.stringify([{ filename: 'jevellan-0.1.0.tgz' }]); }
    return { code: 0, stdout, stderr: '', timedOut: false };
  };
  const prepared = await prepareDistribution(f.files, { from: f.source, run });
  expect(calls.map(call => call.slice(1, 3))).toEqual([['ci', '--ignore-scripts'], ['rebuild', 'node-pty'], ['scripts/prepare-runtime.mjs'], ['run', 'build'], ['pack', '--ignore-scripts']]);
  const app = f.files.copyApplication(prepared.path); prepared.cleanup(); expect(app.path).not.toBe(f.source);
});

test('a local checkout packs with real npm although npm runs its prepare script, which prints to stdout', { timeout: 120_000 }, async () => {
  const f = fixture();
  // npm pack runs `prepare` even with --ignore-scripts, in the foreground by default; its output must not reach the --json result.
  writeFileSync(join(f.source, 'package.json'), JSON.stringify({ name: 'jevellan', version: '0.1.0', type: 'module', files: ['bin', 'packages', 'apps'],
    scripts: { build: 'node -e ""', prepare: 'node -e "console.log(\'vite v8.3.0 building client environment for production...\')"' } }));
  mkdirSync(join(f.source, 'node_modules/typescript'), { recursive: true }); mkdirSync(join(f.source, 'scripts')); writeFileSync(join(f.source, 'scripts/prepare-runtime.mjs'), '');
  const prepared = await prepareDistribution(f.files, { from: f.source });
  expect(JSON.parse(readFileSync(join(prepared.path, 'package.json'), 'utf8'))).toMatchObject({ name: 'jevellan', version: '0.1.0' });
  expect(readFileSync(join(prepared.path, 'bin/jevellan.mjs'), 'utf8')).toContain('0.1.0');
  prepared.cleanup(); expect(f.files.load().distributions).toEqual([]);
});

test('an interrupted checkout build keeps its recorded staging directory without claiming a ready application', async () => {
  const f = fixture();
  await expect(prepareDistribution(f.files, { from: f.source, run: async () => ({ code: 1, stdout: '', stderr: 'Simulated unavailable package download', timedOut: false }) })).rejects.toThrow('unavailable package download');
  expect(f.files.load().distributions).toMatchObject([{ source: f.source, ready: false }]); expect(f.files.load().applications).toEqual([]);
});

test('only a completed recorded distribution may serve as a source inside the installed home', () => {
  const f = fixture(), entry = f.files.createDistribution(f.source);
  const source = join(entry.path, 'package'); mkdirSync(source);
  expect(() => f.files.copyApplication(source)).toThrow('must be separate');
  expect(() => f.files.copyApplication(f.homes.root)).toThrow('must be separate');
});
