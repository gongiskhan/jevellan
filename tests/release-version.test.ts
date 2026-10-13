import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('the actual CLI advertises the version declared by the release it ships in', () => {
  const fixtureHome = mkdtempSync(join(tmpdir(), 'jevellan-release-version-'));
  try {
    const release = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const output = execFileSync(process.execPath, ['bin/jevellan.mjs', '--version'], {
      cwd: new URL('..', import.meta.url), env: { HOME: fixtureHome, PATH: process.env.PATH }, encoding: 'utf8', timeout: 30_000,
    });
    expect(output.trim()).toBe(release.version);
  } finally { rmSync(fixtureHome, { recursive: true, force: true }); }
});
