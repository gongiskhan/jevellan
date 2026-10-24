import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { projectInstructions, projectInstructionFile, projectInstructionPrompt, projectTrustOverride } from '../runtimes/codex/dist/configuration.js';
import { projectInstructionBudget, codexInstructionRefusal, ProjectInstructionBudgetSchema } from '../packages/core/dist/index.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan.project.with.dots-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
test('placement metadata applies the managed launch bound without reading or leaking instruction contents', () => {
  expect(codexInstructionRefusal(undefined)).toContain('not been reported');
  expect(projectInstructionBudget(root)).toMatchObject({ state: 'none', filename: null, bytes: null, maxBytes: 262144 });
  writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(41737));
  const ready = projectInstructionBudget(root);
  expect(ready).toMatchObject({ state: 'ready', filename: 'AGENTS.md', bytes: 41737, maxBytes: 262144 });
  expect(codexInstructionRefusal(ready)).toBeUndefined();
  expect(codexInstructionRefusal({ ...ready, maxBytes: 32768 })).toContain('41737 bytes; Codex accepts at most 32768');
  writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(262145));
  expect(codexInstructionRefusal(projectInstructionBudget(root))).toContain('262145 bytes');
  rmSync(join(root, 'AGENTS.md')); symlinkSync(join(root, 'missing'), join(root, 'AGENTS.md'));
  writeFileSync(join(root, 'CLAUDE.md'), 'must not become the fallback');
  expect(projectInstructionBudget(root)).toMatchObject({ state: 'unreadable', filename: 'AGENTS.md' });
  expect(codexInstructionRefusal(projectInstructionBudget(root))).toContain('cannot be read');
  rmSync(join(root, 'AGENTS.md')); symlinkSync(process.cwd(), join(root, 'AGENTS.md'));
  const outside = projectInstructionBudget(root);
  expect(outside.state).toBe('outside-project'); expect(JSON.stringify(outside)).not.toContain(process.cwd());
  expect(ProjectInstructionBudgetSchema.safeParse({ ...outside, text: 'must not travel' }).success).toBe(false);
});
test('project configuration preserves a dotted path as a single TOML key', () => {
  expect(parse(projectTrustOverride(root))).toEqual({ projects: { [root]: { trust_level: 'untrusted' } } });
});
test('project instructions preserve a complete UTF-8 file above the native default document budget', () => {
  const instructions = 'Keep every instruction.\n' + 'ç'.repeat(21_000) + '\nFINAL_PROJECT_RULE';
  writeFileSync(join(root, 'AGENTS.md'), instructions);
  expect(Buffer.byteLength(instructions)).toBeGreaterThan(32_768);
  expect(projectInstructions(root) === instructions).toBe(true);
  expect(projectInstructionPrompt(root).includes('\nFINAL_PROJECT_RULE\n\n')).toBe(true);
});
test('project instructions use the authoritative file through a local context link', () => {
  expect(projectInstructions(root)).toBe('');
  writeFileSync(join(root, 'CLAUDE.md'), 'Use the project test command.'); symlinkSync('CLAUDE.md', join(root, 'AGENTS.md'));
  expect(projectInstructions(root)).toBe('Use the project test command.');
  writeFileSync(join(root, 'CLAUDE.md'), 'Updated project instructions.'); expect(projectInstructions(root)).toBe('Updated project instructions.');
});
test('unsupported context paths and oversized instructions fail explicitly', () => {
  symlinkSync(process.cwd(), join(root, 'AGENTS.md')); expect(() => projectInstructions(root)).toThrow('inside the project');
  rmSync(join(root, 'AGENTS.md')); writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(262_145)); expect(() => projectInstructions(root)).toThrow('262144');
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
  writeFileSync(join(root, 'CLAUDE.md'), 'x'.repeat(262_145));
  expect(() => projectInstructionPrompt(root)).toThrow('262144');
  rmSync(join(root, 'CLAUDE.md')); symlinkSync(process.cwd(), join(root, 'CLAUDE.md'));
  expect(() => projectInstructionPrompt(root)).toThrow('inside the project');
});
