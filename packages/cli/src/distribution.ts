import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { x } from 'tar';
import { z } from 'zod';
import { applicationRoot, inside, resolvedPath, runOwnedCommand } from '@jevellan/core';
import { InstallationFiles, InstalledApplicationSchema } from './installation-files.js';
import { toolEnvironment, type ToolCommand } from './toolchain.js';

const Identity = z.object({ name: z.literal('jevellan'), version: InstalledApplicationSchema.shape.version, type: z.literal('module') });
const PackResult = z.strictObject({ schema: z.literal('npm-pack-result-v1'), packages: z.array(z.object({ filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/) })).length(1) });

/** Build local checkouts, or fetch the public Git distribution; package archives never run from a checkout. */
export async function prepareDistribution(files: InstallationFiles, options: { from?: string; update?: boolean; run?: ToolCommand; signal?: AbortSignal; progress?: (message: string) => void } = {}) {
  const source = options.from ? resolvedPath(options.from) : options.update ? 'github' : applicationRoot();
  if (source !== 'github' && !options.from && !existsSync(join(source, '.git')) && !inside(files.homes.root, source)) {
    Identity.parse(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))); return { path: source, cleanup: () => {} };
  }
  if (source !== 'github' && inside(files.homes.root, source)) throw new Error('Use a checkout or packed archive outside the installed Jevellan home.');
  const entry = files.createDistribution(source), run = options.run ?? runOwnedCommand;
  const env = { ...toolEnvironment(files.homes), npm_config_cache: files.homes.ensure('cache', 'npm'), npm_config_audit: 'false', npm_config_fund: 'false', GIT_TERMINAL_PROMPT: '0' };
  const execute = async (command: string, args: string[], cwd: string) => {
    const result = await run(command, args, { cwd, env, timeoutMs: 900_000, ...(options.signal ? { signal: options.signal } : {}) });
    if (result.code !== 0) throw new Error(`Application preparation failed${result.timedOut ? ' after its time limit' : ` (exit ${result.code})`}. ${result.stderr.trim().slice(-1600)}`);
    return result.stdout;
  };
  let archive: string;
  if (source !== 'github' && statSync(source).isFile()) archive = source;
  else {
    if (source !== 'github') {
      Identity.parse(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')));
      options.progress?.('Building the local Jevellan distribution.');
      if (!existsSync(join(source, 'node_modules', 'typescript'))) {
        await execute('npm', ['ci', '--ignore-scripts'], source);
        await execute('npm', ['rebuild', 'node-pty', 'esbuild', '--foreground-scripts'], source);
      }
      await execute(process.execPath, ['scripts/prepare-runtime.mjs'], source);
      await execute('npm', ['run', 'build'], source);
    } else options.progress?.('Downloading the Jevellan distribution from GitHub.');
    const output = await execute('npm', ['pack', ...(source === 'github' ? ['git+https://github.com/gongiskhan/jevellan.git'] : ['--ignore-scripts']), '--json', '--pack-destination', entry.path], source === 'github' ? entry.path : source);
    const packed = PackResult.parse({ schema: 'npm-pack-result-v1', packages: JSON.parse(output) }); archive = join(entry.path, packed.packages[0]!.filename);
  }
  options.signal?.throwIfAborted(); await x({ file: archive, cwd: entry.path, strict: true }); options.signal?.throwIfAborted();
  const path = join(entry.path, 'package'); Identity.parse(JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')));
  const manifest = files.load(); manifest.distributions.find(value => value.id === entry.id)!.ready = true; files.save(manifest);
  return { path, cleanup: () => files.removeDistribution(entry.id) };
}
