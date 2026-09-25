import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { applicationRoot, projectMemoryHooks } from '../packages/core/dist/index.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
test.each(['packages/core', 'node_modules/@jevellan/core'])('application assets resolve outside a checkout from %s', location => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-app-paths-'))); roots.push(root);
  mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'bin', 'jevellan.mjs'), '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'jevellan', version: '0.1.0' }));
  const modulePath = join(root, location, 'dist', 'app-paths.js'); mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(join(root, location, 'package.json'), JSON.stringify({ name: '@jevellan/core', version: '0.1.0' }));
  expect(applicationRoot(pathToFileURL(modulePath).href)).toBe(root);
  rmSync(join(root, 'bin', 'jevellan.mjs'));
  expect(() => applicationRoot(pathToFileURL(modulePath).href)).toThrow('could not be located');
});

test('project memory invokes the root command with correctly quoted application paths', () => {
  expect(JSON.stringify(projectMemoryHooks())).toContain(join(applicationRoot(), 'bin', 'jevellan.mjs'));
  expect(projectMemoryHooks('/Node tools/node', "/App's files/bin/jevellan.mjs").hooks.Stop?.[0]?.hooks[0]?.command).toBe("'/Node tools/node' '/App'\\''s files/bin/jevellan.mjs' memory-hook");
});
