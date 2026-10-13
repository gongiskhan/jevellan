import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { writeSandbox } from '../scripts/live/sandbox.mjs';

const node20 = process.env.JEVELLAN_TEST_NODE20;

// Opt in on a host with Node 20; do not silently substitute Jevellan's Node 22.
test.skipIf(!node20)('the generated sandbox installs and runs its own tools under the CI Node 20 version', { timeout: 240000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'jevellan-sandbox-node20-'));
  try {
    writeSandbox(folder);
    const executable = node20!;
    expect(execFileSync(executable, ['--version'], { encoding: 'utf8' })).toMatch(/^v20\./u);
    const env: Record<string, string> = { PATH: `${dirname(executable)}:${process.env.PATH ?? ''}`, TZ: 'UTC', SANDBOX_DATA_DIR: join(folder, 'data') };
    for (const name of ['HOME', 'USER', 'LANG', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name]!;
    const run = (args: string[]) => execFileSync(executable, args, { cwd: folder, env, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    const npm = resolve(dirname(executable), '../lib/node_modules/npm/bin/npm-cli.js');
    run([npm, 'install', '--package-lock-only', '--engine-strict', '--ignore-scripts']);
    run([npm, 'ci', '--engine-strict', '--ignore-scripts']);
    run([join(folder, 'node_modules/typescript/bin/tsc'), '--noEmit']);
    expect(run([join(folder, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1'])).toContain('3 passed');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
