import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { projectInstructions, projectTrustOverride } from '../runtimes/codex/dist/configuration.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan.project.with.dots-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
test('project configuration preserves a dotted path as a single TOML key', () => {
  expect(parse(projectTrustOverride(root))).toEqual({ projects: { [root]: { trust_level: 'untrusted' } } });
});
test('project instructions use the authoritative file through a local context link', () => {
  expect(projectInstructions(root)).toBe('');
  writeFileSync(join(root, 'CLAUDE.md'), 'Use the project test command.'); symlinkSync('CLAUDE.md', join(root, 'AGENTS.md'));
  expect(projectInstructions(root)).toBe('Use the project test command.');
  writeFileSync(join(root, 'CLAUDE.md'), 'Updated project instructions.'); expect(projectInstructions(root)).toBe('Updated project instructions.');
});
test('unsupported context paths and oversized instructions fail explicitly', () => {
  symlinkSync(process.cwd(), join(root, 'AGENTS.md')); expect(() => projectInstructions(root)).toThrow('inside the project');
  rmSync(join(root, 'AGENTS.md')); writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(32_769)); expect(() => projectInstructions(root)).toThrow('32768');
});
