import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c } from 'tar';
import { afterEach, expect, test, vi } from 'vitest';
import { Homes } from '../packages/core/dist/index.js';
import { bootstrapUv, uvRelease, UV_VERSION } from '../packages/cli/dist/uv-bootstrap.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
async function fixture(names = ['uv', 'uvx']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-uv-'))); roots.push(root);
  const source = join(root, 'source'), folder = 'uv-aarch64-apple-darwin'; mkdirSync(join(source, folder), { recursive: true });
  for (const name of names) writeFileSync(join(source, folder, name), `fixture ${name}`);
  const archive = join(root, 'fixture.tar.gz'); await c({ file: archive, cwd: source, gzip: true }, [folder]);
  const bytes = readFileSync(archive), release = { ...uvRelease('darwin', 'arm64'), sha256: createHash('sha256').update(bytes).digest('hex') };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes));
  const user = join(root, 'user'); mkdirSync(user); const homes = new Homes(join(user, '.jevellan'), user);
  return { homes, bytes, release, fetcher };
}

test('downloads a pinned archive, verifies it, extracts executable copies and reuses its cache', async () => {
  const f = await fixture(); const executable = await bootstrapUv(f.homes, { release: f.release, fetch: f.fetcher });
  expect(executable).toBe(join(f.homes.root, 'tools', `uv-${UV_VERSION}`, 'bin/uv'));
  expect(readFileSync(executable, 'utf8')).toBe('fixture uv'); expect(lstatSync(executable).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(executable, '../uvx'), 'utf8')).toBe('fixture uvx');
  expect(f.fetcher.mock.calls[0]![0]).toBe(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${f.release.archive}`);
  expect(readdirSync(join(f.homes.root, 'tools', `uv-${UV_VERSION}`, 'bootstrap'))).toEqual([]);
  await bootstrapUv(f.homes, { release: f.release, fetch: f.fetcher }); expect(f.fetcher).toHaveBeenCalledOnce();
});

test('a mismatched release digest installs nothing and a later good download succeeds', async () => {
  const f = await fixture(); f.fetcher.mockResolvedValueOnce(new Response('incomplete download'));
  await expect(bootstrapUv(f.homes, { release: f.release, fetch: f.fetcher })).rejects.toThrow('published release digest');
  expect(existsSync(join(f.homes.root, 'tools', `uv-${UV_VERSION}`, 'bin/uv'))).toBe(false);
  await bootstrapUv(f.homes, { release: f.release, fetch: f.fetcher }); expect(f.fetcher).toHaveBeenCalledTimes(2);
});

test('a damaged cached download is replaced before extraction', async () => {
  const f = await fixture(); await bootstrapUv(f.homes, { release: f.release, fetch: f.fetcher });
  writeFileSync(join(f.homes.root, 'tools', `uv-${UV_VERSION}`, 'downloads', f.release.archive), 'partial');
  await bootstrapUv(f.homes, { release: f.release, fetch: f.fetcher }); expect(f.fetcher).toHaveBeenCalledTimes(2);
});

test('an incomplete archive leaves no partially published tool', async () => {
  const f = await fixture(['uv']);
  await expect(bootstrapUv(f.homes, { release: f.release, fetch: f.fetcher })).rejects.toThrow('missing an executable');
  expect(readdirSync(join(f.homes.root, 'tools', `uv-${UV_VERSION}`, 'bin'))).toEqual([]);
  expect(readdirSync(join(f.homes.root, 'tools', `uv-${UV_VERSION}`, 'bootstrap'))).toEqual([]);
});

test('download errors and cancellation do not create an executable', async () => {
  const f = await fixture(); f.fetcher.mockResolvedValueOnce(new Response('', { status: 503 }));
  await expect(bootstrapUv(f.homes, { release: f.release, fetch: f.fetcher })).rejects.toThrow('HTTP 503');
  await expect(bootstrapUv(f.homes, { release: f.release, fetch: f.fetcher, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(existsSync(join(f.homes.root, 'tools', `uv-${UV_VERSION}`, 'bin/uv'))).toBe(false);
});

test('release selection covers supported macOS and Linux architectures and libc variants', () => {
  const releases = [uvRelease('darwin', 'arm64'), uvRelease('darwin', 'x64'), uvRelease('linux', 'arm64', 'gnu'), uvRelease('linux', 'arm64', 'musl'), uvRelease('linux', 'x64', 'gnu'), uvRelease('linux', 'x64', 'musl')];
  expect(new Set(releases.map(release => release.sha256)).size).toBe(6);
  expect(releases[3]!.archive).toBe('uv-aarch64-unknown-linux-musl.tar.gz');
  expect(() => uvRelease('win32', 'x64')).toThrow('macOS and Linux');
});
