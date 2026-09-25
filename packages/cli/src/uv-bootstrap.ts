import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { x } from 'tar';
import { Homes, atomicWrite, resolvedPath } from '@jevellan/core';
import { z } from 'zod';

export const UV_VERSION = '0.11.23';
export const UvReleaseSchema = z.strictObject({
  schema: z.literal('uv-release-v1'), version: z.literal(UV_VERSION),
  archive: z.string().regex(/^uv-[a-z0-9_-]+\.tar\.gz$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type UvRelease = z.infer<typeof UvReleaseSchema>;
// Release digests published in https://astral.sh/uv/0.11.23/install.sh.
const releases: Record<string, [string, string]> = {
  'darwin-arm64': ['aarch64-apple-darwin', '71ef9de85db820749b3b12b7585624ee279e9c5afcbc6f8236bc3d628c4305b0'],
  'darwin-x64': ['x86_64-apple-darwin', '7a88155033cc469bba5bd5a24212e355eb92e3e2a276320b669ec576296c1e25'],
  'linux-arm64-gnu': ['aarch64-unknown-linux-gnu', '1873a77350f6621279ae1a0d2227f2bd8b67131598f14a7eb0ba2215d3da2c98'],
  'linux-arm64-musl': ['aarch64-unknown-linux-musl', '80efb615b78c1e5721e5858135cd3499609b26741220332c843bd58936053bc6'],
  'linux-x64-gnu': ['x86_64-unknown-linux-gnu', 'e12c4cda2fe8c305510a78380a88f2c32a27e90cdcd123cefd2873388f0ebb5f'],
  'linux-x64-musl': ['x86_64-unknown-linux-musl', '6be47081100ff1ce0ac7e85ba2ac12e32f2ffa6f946d78bf7f24ee9ce3a46181'],
};
export function uvRelease(platform: string = process.platform, architecture: string = process.arch, libc?: 'gnu' | 'musl'): UvRelease {
  if (platform === 'linux' && !libc) {
    const report = z.object({ header: z.object({ glibcVersionRuntime: z.string().optional() }) }).parse(process.report.getReport());
    libc = report.header.glibcVersionRuntime ? 'gnu' : 'musl';
  }
  const target = releases[`${platform}-${architecture}${platform === 'linux' ? `-${libc}` : ''}`];
  if (!target) throw new Error('Jevellan dependency installation supports macOS and Linux on ARM64 or x64.');
  return UvReleaseSchema.parse({ schema: 'uv-release-v1', version: UV_VERSION, archive: `uv-${target[0]}.tar.gz`, sha256: target[1] });
}
export function toolDirectory(homes: Homes, ...parts: string[]): string {
  const expected = join(homes.root, 'tools', ...parts);
  if (homes.at('tools', ...parts) !== expected) throw new Error('Jevellan tool directories cannot alias another location.');
  return homes.ensure('tools', ...parts);
}

async function download(url: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`The uv download failed (HTTP ${response.status}).`);
  const maximum = 128 * 1024 * 1024, reader = response.body.getReader(), chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new Error('The uv download exceeded its expected size limit.');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); }
}

/** Uses Node for downloading/extraction; no shell installer or profile edits are needed. */
export async function bootstrapUv(homes: Homes, options: { release?: UvRelease; fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<string> {
  const release = UvReleaseSchema.parse(options.release ?? uvRelease()); options.signal?.throwIfAborted();
  const directory = `uv-${release.version}`;
  const archive = join(toolDirectory(homes, directory, 'downloads'), release.archive);
  if (resolvedPath(archive) !== archive) throw new Error('The uv archive path has changed.');
  const valid = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex') === release.sha256;
  if (!existsSync(archive) || !valid(readFileSync(archive))) {
    const bytes = await download(`https://github.com/astral-sh/uv/releases/download/${release.version}/${release.archive}`, options.fetch ?? fetch, options.signal);
    if (!valid(bytes)) throw new Error('The uv download does not match its published release digest.');
    atomicWrite(archive, bytes);
  }
  const stage = toolDirectory(homes, directory, 'bootstrap', randomUUID()), bin = toolDirectory(homes, directory, 'bin');
  const found = new Set<string>(); let invalid = false;
  try {
    await x({ file: archive, cwd: stage, strip: 1, strict: true, filter: (path, entry) => {
      const match = /^uv-[a-z0-9_-]+\/(uv|uvx)$/.exec(path); if (!match) return false;
      if (!('type' in entry) || entry.type !== 'File' || (entry.size ?? 0) > 256 * 1024 * 1024 || found.has(match[1]!)) { invalid = true; return false; }
      found.add(match[1]!); return true;
    } });
    if (invalid) throw new Error('The uv archive contains an unexpected executable entry.');
    options.signal?.throwIfAborted();
    for (const name of ['uv', 'uvx']) {
      const path = join(stage, name);
      if (!found.has(name) || !lstatSync(path).isFile()) throw new Error('The uv archive is missing an executable.');
      const target = join(bin, name);
      if (resolvedPath(target) !== target) throw new Error('An existing uv executable aliases another location.');
      chmodSync(path, 0o755);
    }
    for (const name of ['uv', 'uvx']) renameSync(join(stage, name), join(bin, name));
    return join(bin, 'uv');
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
