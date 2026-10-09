import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSecrets, scanWorkingTree } from '../scripts/secret-scan.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'jevellan-scan-')); dirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  return { dir, git: (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, stdio: 'ignore' }) };
}
test('blocks token patterns in earlier commits even after removal', () => {
  const { dir, git } = repository();
  writeFileSync(join(dir, 'file'), ['ghp', '_', 'A'.repeat(36)].join(''));
  git('add', '.'); git('commit', '-m', 'first');
  writeFileSync(join(dir, 'file'), 'clean'); git('add', '.'); git('commit', '-m', 'second');
  expect(scanSecrets(dir, ['HEAD'], {})).toEqual([expect.objectContaining({ reason: 'token or private-key pattern' })]);
});
test('blocks exact test environment values in binary blobs without exposing them', () => {
  const { dir, git } = repository();
  const secret = ['fixture', 'private', 'value'].join('-');
  writeFileSync(join(dir, 'binary'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(secret)]));
  git('add', '.'); git('commit', '-m', 'fixture');
  const result = scanSecrets(dir, ['HEAD'], { JEVELLAN_TEST_JEV_KEY: secret });
  expect(result).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(secret);
});
test('allows only the exact documented fixture expression', () => {
  const { dir, git } = repository();
  const fixture = ['`sk', "-ant-oat01-${randomBytes(40).toString('base64url')}`"].join('');
  writeFileSync(join(dir, 'fixture.mjs'), `await setCredential(${fixture});\n`);
  git('add', '.'); git('commit', '-m', 'fixture');
  expect(scanSecrets(dir, ['HEAD'], {})).toEqual([]);
  writeFileSync(join(dir, 'fixture.mjs'), `await setCredential(${fixture});\nconst key = '${['sk', 'ant', 'oat01', 'A'.repeat(40)].join('-')}';\n`);
  git('add', '.'); git('commit', '-m', 'token');
  expect(scanSecrets(dir, ['HEAD'], {})).toEqual([expect.objectContaining({ reason: 'token or private-key pattern' })]);
});
test('passes a clean history', () => {
  const { dir, git } = repository();
  writeFileSync(join(dir, 'readme'), 'A clean project.'); git('add', '.'); git('commit', '-m', 'initial');
  expect(scanSecrets(dir, ['HEAD'], {})).toEqual([]);
});
test('blocks external agent capabilities in working files and historical commits', () => {
  const { dir, git } = repository();
  const token = ['jva', '_agent_fixture.', 'A'.repeat(43)].join('');
  writeFileSync(join(dir, 'connection'), token);
  expect(scanWorkingTree(dir, {})).toEqual([expect.objectContaining({ file: 'connection', reason: 'token or private-key pattern' })]);
  git('add', '.'); git('commit', '-m', 'fixture');
  writeFileSync(join(dir, 'connection'), 'removed'); git('add', '.'); git('commit', '-m', 'removed');
  const results = scanSecrets(dir, ['HEAD'], {}); expect(results).toHaveLength(1); expect(JSON.stringify(results)).not.toContain(token);
});
test('scans modified and untracked publishable files without following links or printing secrets', () => {
  const { dir, git } = repository();
  writeFileSync(join(dir, 'tracked'), 'clean'); git('add', '.'); git('commit', '-m', 'initial');
  const secret = ['fixture', 'pending', 'credential'].join('-');
  writeFileSync(join(dir, 'tracked'), secret); writeFileSync(join(dir, 'untracked'), secret);
  writeFileSync(join(dir, '.gitignore'), 'ignored\n'); writeFileSync(join(dir, 'ignored'), secret);
  symlinkSync('ignored', join(dir, 'link'));
  const results = scanWorkingTree(dir, { JEVELLAN_TEST_JEV_KEY: secret });
  expect(results.map((entry: { file: string }) => entry.file).sort()).toEqual(['tracked', 'untracked']);
  expect(JSON.stringify(results)).not.toContain(secret);
});
