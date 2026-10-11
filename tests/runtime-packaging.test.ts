import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareRuntime } from '../scripts/prepare-runtime.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-runtime-pack-')); roots.push(root);
  const dependency = join(root, 'node_modules/node-pty');
  mkdirSync(join(root, 'runtimes/codex/bin'), { recursive: true });
  writeFileSync(join(root, 'runtimes/codex/bin/launch.mjs'), '', { mode: 0o600 });
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
  return { root, dependency };
}
it('keeps the compiled Linux terminal addon and helper in the packable prebuild directory', () => {
  const { root, dependency } = fixture(); const build = join(dependency, 'build/Release');
  mkdirSync(build, { recursive: true });
  const bytes = Buffer.from([0, 255, 127, 42]); writeFileSync(join(build, 'pty.node'), bytes);
  writeFileSync(join(build, 'spawn-helper'), 'fixture-helper', { mode: 0o755 });
  prepareRuntime(root, 'linux', 'x64');
  expect(readFileSync(join(dependency, 'prebuilds/linux-x64/pty.node'))).toEqual(bytes);
  expect(readFileSync(join(build, 'pty.node'))).toEqual(bytes);
  expect(statSync(join(dependency, 'prebuilds/linux-x64/spawn-helper')).mode & 0o111).toBe(0o111);
  expect(statSync(join(root, 'runtimes/codex/bin/launch.mjs')).mode & 0o111).toBe(0o111);
});
it('refuses to prepare a Linux archive without a compiled or prebuilt terminal addon', () => {
  const { root } = fixture(); expect(() => prepareRuntime(root, 'linux', 'arm64')).toThrow('terminal addon is missing');
});
it('preserves a supplied Linux prebuild and repairs only the installation macOS helper permissions', () => {
  const { root, dependency } = fixture();
  mkdirSync(join(dependency, 'prebuilds/linux-arm64'), { recursive: true });
  writeFileSync(join(dependency, 'prebuilds/linux-arm64/pty.node'), 'existing-addon');
  prepareRuntime(root, 'linux', 'arm64');
  expect(readFileSync(join(dependency, 'prebuilds/linux-arm64/pty.node'), 'utf8')).toBe('existing-addon');
  mkdirSync(join(dependency, 'prebuilds/darwin-arm64'), { recursive: true });
  const helper = join(dependency, 'prebuilds/darwin-arm64/spawn-helper'); writeFileSync(helper, 'helper', { mode: 0o600 });
  prepareRuntime(root, 'darwin', 'arm64');
  expect(statSync(helper).mode & 0o111).toBe(0o111);
});
