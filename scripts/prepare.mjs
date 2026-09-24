import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import './prepare-runtime.mjs';

if (existsSync('.git')) {
  const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  await mkdir('.githooks', { recursive: true });
  await writeFile('.githooks/pre-push', '#!/bin/sh\nexec node scripts/secret-scan.mjs --pre-push\n');
  await chmod('.githooks/pre-push', 0o755);
}
await chmod('bin/jevellan.mjs', 0o755);
const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
process.exit(build.status ?? 1);
