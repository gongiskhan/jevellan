import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { projectInstructions, projectInstructionFile, projectInstructionPrompt, projectTrustOverride } from '../runtimes/codex/dist/configuration.js';

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

test('CLAUDE-only projects use the fallback filename, while AGENTS takes precedence', () => {
  expect(projectInstructionFile(root)).toBeNull();
  writeFileSync(join(root, 'CLAUDE.md'), 'Claude rules');
  expect(projectInstructionFile(root)).toEqual({ filename: 'CLAUDE.md', text: 'Claude rules' });
  expect(projectInstructionPrompt(root)).toBe('# Project instructions: CLAUDE.md\nClaude rules\n\n');
  writeFileSync(join(root, 'AGENTS.md'), 'Codex rules');
  expect(projectInstructionFile(root)).toEqual({ filename: 'AGENTS.md', text: 'Codex rules' });
});
test('an existing invalid AGENTS file never falls back, including dangling links', () => {
  writeFileSync(join(root, 'CLAUDE.md'), 'Fallback must not apply');
  symlinkSync('missing', join(root, 'AGENTS.md'));
  expect(() => projectInstructionFile(root)).toThrow();
  rmSync(join(root, 'AGENTS.md')); mkdirSync(join(root, 'AGENTS.md'));
  expect(() => projectInstructionFile(root)).toThrow('must be a file');
});
test('each turn rereads instructions and catches changes and invalid fallback paths', () => {
  writeFileSync(join(root, 'CLAUDE.md'), 'First turn rules');
  expect(projectInstructionPrompt(root)).toContain('First turn rules');
  writeFileSync(join(root, 'CLAUDE.md'), 'Resumed turn rules');
  expect(projectInstructionPrompt(root)).toContain('Resumed turn rules');
  expect(projectInstructionPrompt(root)).not.toContain('First turn rules');
  writeFileSync(join(root, 'CLAUDE.md'), 'x'.repeat(32_769));
  expect(() => projectInstructionPrompt(root)).toThrow('32768');
  rmSync(join(root, 'CLAUDE.md')); symlinkSync(process.cwd(), join(root, 'CLAUDE.md'));
  expect(() => projectInstructionPrompt(root)).toThrow('inside the project');
});
