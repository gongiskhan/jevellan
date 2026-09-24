import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, chmodSync } from 'node:fs';

chmodSync(new URL('../runtimes/codex/bin/launch.mjs', import.meta.url), 0o755);

// node-pty 1.1.0's macOS prebuilt helper is published without its executable bit.
// Repair only this installation's dependency, never a global or native agent copy.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/darwin-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const path = join(root, relative);
    if (existsSync(path)) chmodSync(path, 0o755);
  }
}
