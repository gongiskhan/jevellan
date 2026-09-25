import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretRedactor } from '../packages/core/dist/index.js';
import { MAX_FILE_BYTES, readProjectFile } from '../packages/conversations/dist/index.js';
import { decodeReference, filePointer, remarkFilePaths, storedPointer } from '../apps/web/src/evidence-refs.js';

let root: string; let project: string; let before: string; let after: string;
const redactor = new SecretRedactor(); redactor.add('fixture-secret-for-file-reader');
const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-file-evidence-')); project = join(root, 'project'); mkdirSync(join(project, 'docs'), { recursive: true });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(project, 'value.ts'), 'export const value = 1;\n'); writeFileSync(join(project, 'deleted.txt'), 'Original deleted file\n');
  writeFileSync(join(project, 'docs', 'a note.md'), '# Recorded guide\n\n- First\n- Second\n'); writeFileSync(join(project, 'pixel.png'), pixel);
  writeFileSync(join(project, 'redacted.txt'), 'A fixture-secret-for-file-reader value\n');
  git('add', '-A'); git('commit', '-m', 'Before'); before = git('rev-parse', 'HEAD');
  writeFileSync(join(project, 'value.ts'), 'export const value = 2;\n'); rmSync(join(project, 'deleted.txt'));
  git('add', '-A'); git('commit', '-m', 'After'); after = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const read = (ref: string, commit?: string) => readProjectFile({ root: project, ref, redactor, ...(commit ? { commit, before } : {}) });

test('recorded file evidence remains tied to its checkpoint; working copy is explicit and reading changes nothing', async () => {
  writeFileSync(join(project, 'value.ts'), 'export const value = 3;\n'); const status = git('status', '--porcelain=v1'); const refs = git('show-ref');
  expect(await read('value.ts:1:8', before)).toMatchObject({ content: 'export const value = 1;\n', commit: before, source: 'checkpoint', line: 1, kind: 'text' });
  expect(await read(join(project, 'value.ts') + '#L1', after)).toMatchObject({ content: 'export const value = 2;\n', path: 'value.ts', commit: after });
  expect(await read('value.ts')).toMatchObject({ content: 'export const value = 3;\n', source: 'working-tree' });
  expect(git('status', '--porcelain=v1')).toBe(status); expect(git('show-ref')).toBe(refs);
});
test('deleted files open at the recorded before version and absent files do not silently use another version', async () => {
  expect(await read('deleted.txt', after)).toMatchObject({ content: 'Original deleted file\n', source: 'before-step', commit: before });
  writeFileSync(join(project, 'new.txt'), 'Only in working copy');
  await expect(read('new.txt', after)).rejects.toMatchObject({ status: 404 });
  await expect(read('deleted.txt')).rejects.toMatchObject({ status: 404 });
});
test('renders Markdown and encoded-space references, and preserves screenshot bytes from a saved checkpoint', async () => {
  const ref = decodeReference('docs/a%20note.md'); expect(await read(ref, after)).toMatchObject({ path: 'docs/a note.md', kind: 'markdown', content: '# Recorded guide\n\n- First\n- Second\n' });
  rmSync(join(project, 'pixel.png')); expect(await read('pixel.png', after)).toMatchObject({ kind: 'image', mime: 'image/png', encoding: 'base64', content: pixel.toString('base64'), bytes: pixel.length });
});
test('redacts known credentials in working and recorded text before returning them', async () => {
  for (const commit of [undefined, after]) { const result = await read('redacted.txt', commit); expect(result.content).not.toContain('fixture-secret-for-file-reader'); expect(result.content).toContain('[redacted]'); }
});
test('keeps each project confined and refuses credential files by direct and recorded path', async () => {
  writeFileSync(join(root, 'other.txt'), 'Outside');
  for (const ref of ['../other.txt', join(root, 'other.txt'), 'docs/../value.ts', 'x\0y', 'C:\\outside', '.git/config', '.env', '.env.local', '.npmrc', 'nested/credentials.json', 'auth.json', 'private.pem']) {
    for (const commit of [undefined, after]) await expect(read(ref, commit), ref).rejects.toMatchObject({ status: 403 });
  }
});
test('refuses symbolic links and directories instead of following another project or home', async () => {
  writeFileSync(join(root, 'other.txt'), 'Outside'); symlinkSync(join(root, 'other.txt'), join(project, 'outside.txt')); symlinkSync(root, join(project, 'other')); symlinkSync('value.ts', join(project, 'alias.ts'));
  for (const ref of ['outside.txt', 'other/other.txt', 'alias.ts']) await expect(read(ref)).rejects.toMatchObject({ status: 403 });
  git('add', '-A'); git('commit', '-m', 'Links'); const links = git('rev-parse', 'HEAD'); await expect(read('outside.txt', links)).rejects.toMatchObject({ status: 415 });
  await expect(read('docs')).rejects.toMatchObject({ status: 415 });
});
test('bounds text and image reads and refuses unsupported binary data', async () => {
  writeFileSync(join(project, 'large.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 65)); writeFileSync(join(project, 'binary.dat'), Buffer.from([255, 254, 0, 1]));
  git('add', '-A'); git('commit', '-m', 'Boundaries'); const commit = git('rev-parse', 'HEAD');
  for (const version of [undefined, commit]) { await expect(read('large.txt', version)).rejects.toMatchObject({ status: 413 }); await expect(read('binary.dat', version)).rejects.toMatchObject({ status: 415 }); }
});
test('file links keep line references, spaces and stored pointers distinct from commands and URLs', () => {
  for (const ref of ['src/value.ts:2:7', '/project/docs/a note.md', 'docs/README.md#L2-L4']) expect(filePointer(ref)).toBe(true);
  expect(filePointer('npm test')).toBe(false); expect(filePointer('0.25')).toBe(false); expect(filePointer('1.2.3')).toBe(false); expect(filePointer('https://example.test/file.ts')).toBe(false); expect(storedPointer('handoffs/1')).toBe(true); expect(storedPointer('../handoffs/1')).toBe(false); expect(decodeReference('100%complete.md')).toBe('100%complete.md');
});
test('bare absolute paths in prose become local references; fenced code and existing links stay intact', () => {
  const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'See /project/docs/report.md and /project/screens/shot.png.' }] }, { type: 'code', value: '/project/code.ts' }, { type: 'link', url: 'https://example.test', children: [{ type: 'text', value: '/project/label.ts' }] }] };
  const code = structuredClone(tree.children[1]); const link = structuredClone(tree.children[2]); remarkFilePaths()(tree);
  expect(tree.children[0]!.children?.filter((node) => node.type === 'link')).toHaveLength(2); expect(tree.children[1]).toEqual(code); expect(tree.children[2]).toEqual(link);
});
