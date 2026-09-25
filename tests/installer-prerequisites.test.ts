import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Homes } from '../packages/core/dist/index.js';
import { installerPrerequisites } from '../packages/cli/dist/prerequisites.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function homes() { const root = mkdtempSync(join(tmpdir(), 'jevellan-prerequisites-')); roots.push(root); mkdirSync(join(root, 'user')); const value = new Homes(join(root, 'data'), join(root, 'user')); value.ensure(); return value; }
test.each(['--merge-base', '--[no-]merge-base'])('recognizes Git compatibility with its %s help notation', async option => {
  const result = await installerPrerequisites(homes(), async (_command, args) => ({ code: args[0] === '--version' ? 0 : 129, stdout: args[0] === '--version' ? 'git version 2.50.1' : '', stderr: args[0] === 'merge-tree' ? `usage: --write-tree ${option} <tree-ish>` : '', timedOut: false }));
  expect(result.mergeTree).toBe(true);
});
test('reports missing Git and unsupported merge behavior instead of claiming prerequisites passed', async () => {
  await expect(installerPrerequisites(homes(), async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }))).rejects.toThrow('Install Git');
  await expect(installerPrerequisites(homes(), async (_command, args) => ({ code: args[0] === '--version' ? 0 : 129, stdout: 'git version 2.0', stderr: '--trivial-merge', timedOut: false }))).rejects.toThrow('merge-tree');
});
