import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, chmodSync, cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function prepareRuntime(root = dirname(dirname(fileURLToPath(import.meta.url))), platform = process.platform, arch = process.arch) {
  chmodSync(join(root, 'runtimes/codex/bin/launch.mjs'), 0o755);
  const require = createRequire(join(root, 'package.json'));
  const dependency = dirname(require.resolve('node-pty/package.json'));
  // node-pty excludes build/ from npm packs. Preserve the locally compiled Linux addon in its published prebuild path.
  if (platform === 'linux') {
    const target = join(dependency, `prebuilds/linux-${arch}`);
    for (const name of ['pty.node', 'spawn-helper']) {
      const source = join(dependency, 'build/Release', name);
      if (existsSync(source)) { mkdirSync(target, { recursive: true }); cpSync(source, join(target, name)); }
    }
    if (!existsSync(join(target, 'pty.node'))) throw new Error('The Linux terminal addon is missing. Run npm rebuild node-pty before packing Jevellan.');
  }
  // The macOS prebuilt helper is published without its executable bit. Touch only this installation's dependency.
  if (platform === 'darwin') {
    for (const relative of [`prebuilds/darwin-${arch}/spawn-helper`, 'build/Release/spawn-helper']) {
      const path = join(dependency, relative);
      if (existsSync(path)) chmodSync(path, 0o755);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) prepareRuntime();
