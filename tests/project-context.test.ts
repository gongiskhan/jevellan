import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectSchema, type Project } from '../packages/core/dist/index.js';
import { ProjectContext } from '../packages/memory/dist/index.js';

let root: string; let project: Project;
const owned = vi.fn();
const file = (name: string) => join(root, name);
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
const context = (native = false) => new ProjectContext(project, 'device', owned, native);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-context-')); owned.mockReset();
  git('init', '--initial-branch=main');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'project_fixture', name: 'Fixture', paths: { device: root }, branchPolicy: 'main', testCommand: 'npm test', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each(['AGENTS.md', 'CLAUDE.md'] as const)('a project with only %s gets one local link, preserving its original content', async (primary) => {
  const secondary = primary === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
  writeFileSync(file(primary), '# Original instructions\n'); git('add', primary); git('commit', '-m', 'Fixture');
  const item = context(); const linked = await item.ensure();
  expect(linked).toMatchObject({ state: 'linked', primary }); expect(readlinkSync(file(secondary))).toBe(primary);
  expect(readFileSync(file(primary), 'utf8')).toBe('# Original instructions\n');
  expect(git('status', '--porcelain')).toBe(''); expect(readFileSync(file('.git/info/exclude'), 'utf8')).toContain(`/${secondary}`);
  expect(owned).toHaveBeenCalledTimes(1);
  const exclude = readFileSync(file('.git/info/exclude'), 'utf8');
  await item.ensure(); expect(owned).toHaveBeenCalledTimes(1); expect(readFileSync(file('.git/info/exclude'), 'utf8')).toBe(exclude);
});

test('native AGENTS support needs no link and does not take ownership', async () => {
  writeFileSync(file('AGENTS.md'), 'Read this.');
  expect(await context(true).ensure()).toMatchObject({ state: 'linked', primary: 'AGENTS.md', claudeReadsAgents: true });
  expect(existsSync(file('CLAUDE.md'))).toBe(false); expect(owned).not.toHaveBeenCalled();
});

test('an empty project stays untouched until creation is selected, then has one seeded instruction file', async () => {
  const item = context(); expect((await item.ensure()).state).toBe('none'); expect(existsSync(file('AGENTS.md'))).toBe(false);
  expect((await item.ensure(true)).state).toBe('linked');
  expect(readFileSync(file('AGENTS.md'), 'utf8')).toContain('npm test'); expect(readFileSync(file('AGENTS.md'), 'utf8')).toContain('.jevellan/memory');
  expect(readlinkSync(file('CLAUDE.md'))).toBe('AGENTS.md'); expect(git('status', '--porcelain')).toBe('?? AGENTS.md\n');
});

test('two separate files wait for a choice; leaving them records the choice without filesystem edits', async () => {
  writeFileSync(file('AGENTS.md'), 'Codex instructions'); writeFileSync(file('CLAUDE.md'), 'Claude instructions');
  const item = context(); const before = await item.ensure(); expect(before.state).toBe('needs-decision');
  expect((await item.choose({ schema: 'context-choice-v1', choice: 'leave', fingerprint: before.fingerprint })).state).toBe('left-as-is');
  expect((await item.ensure()).state).toBe('left-as-is'); expect(owned).not.toHaveBeenCalled();
  expect(readFileSync(file('AGENTS.md'), 'utf8')).toBe('Codex instructions'); expect(readFileSync(file('CLAUDE.md'), 'utf8')).toBe('Claude instructions');
});

test.each(['keep-agents', 'keep-claude'] as const)('%s preserves the selected primary and records a tracked replacement as a real git change', async (choice) => {
  writeFileSync(file('AGENTS.md'), 'A'); writeFileSync(file('CLAUDE.md'), 'C'); git('add', '-A'); git('commit', '-m', 'Fixture');
  const item = context(); const before = item.inspect(); const primary = choice === 'keep-agents' ? 'AGENTS.md' : 'CLAUDE.md'; const secondary = primary === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
  expect(await item.choose({ schema: 'context-choice-v1', choice, fingerprint: before.fingerprint })).toMatchObject({ state: 'linked', primary });
  expect(readlinkSync(file(secondary))).toBe(primary); expect(readFileSync(file(primary), 'utf8')).toBe(primary === 'AGENTS.md' ? 'A' : 'C');
  expect(git('status', '--porcelain')).toBe(` T ${secondary}\n`); expect(git('diff', '--summary')).toContain('mode change 100644 => 120000');
});

// Adapted from Garrison's claude-md.test.ts never-clobber cases, now covering both files.
test('a context merge refuses stale content and applies only the exact reviewed draft', async () => {
  writeFileSync(file('AGENTS.md'), 'A'); writeFileSync(file('CLAUDE.md'), 'C');
  const item = context(); const before = item.inspect(); writeFileSync(file('CLAUDE.md'), 'External edit');
  await expect(item.choose({ schema: 'context-choice-v1', choice: 'merge', content: 'A + C', fingerprint: before.fingerprint })).rejects.toThrow('Context files changed');
  expect(readFileSync(file('AGENTS.md'), 'utf8')).toBe('A'); expect(readFileSync(file('CLAUDE.md'), 'utf8')).toBe('External edit');
  const current = item.inspect();
  await item.choose({ schema: 'context-choice-v1', choice: 'merge', content: 'Reviewed merge\nA\nExternal edit', fingerprint: current.fingerprint });
  expect(readFileSync(file('AGENTS.md'), 'utf8')).toBe('Reviewed merge\nA\nExternal edit'); expect(readlinkSync(file('CLAUDE.md'))).toBe('AGENTS.md');
});

test('ownership is checked before links or edits, and an edit during ownership acquisition is preserved', async () => {
  writeFileSync(file('AGENTS.md'), 'A'); owned.mockImplementationOnce(() => { throw new Error('Checkout is in use.'); });
  await expect(context().ensure()).rejects.toThrow('in use'); expect(existsSync(file('CLAUDE.md'))).toBe(false);
  owned.mockImplementationOnce(() => { writeFileSync(file('CLAUDE.md'), 'Appeared while waiting'); });
  await expect(context().ensure()).rejects.toThrow('Context files changed'); expect(readFileSync(file('CLAUDE.md'), 'utf8')).toBe('Appeared while waiting');
});

test('external projects get local links but no tracked replacement or merged content', async () => {
  project.branchPolicy = 'external'; writeFileSync(file('AGENTS.md'), 'A'); writeFileSync(file('CLAUDE.md'), 'C'); git('add', '-A'); git('commit', '-m', 'Fixture');
  const item = context(); const before = item.inspect();
  for (const choice of ['keep-agents', 'keep-claude', 'merge'] as const) {
    const input = choice === 'merge' ? { schema: 'context-choice-v1' as const, choice, fingerprint: before.fingerprint, content: 'A+C' } : { schema: 'context-choice-v1' as const, choice, fingerprint: before.fingerprint };
    await expect(item.choose(input)).rejects.toThrow('own git rules');
  }
  expect(git('status', '--porcelain')).toBe('');
  git('rm', '--cached', 'CLAUDE.md'); git('commit', '-m', 'Remove tracked secondary');
  await item.choose({ schema: 'context-choice-v1', choice: 'keep-agents', fingerprint: item.inspect().fingerprint });
  expect(readlinkSync(file('CLAUDE.md'))).toBe('AGENTS.md'); expect(git('status', '--porcelain')).toBe('');
});

test('external seed files remain local and an intentionally deleted tracked file is not replaced', async () => {
  project.branchPolicy = 'external'; await context().ensure(true); expect(git('status', '--porcelain')).toBe('');
  git('add', '-f', 'CLAUDE.md'); git('commit', '-m', 'Tracked link fixture'); rmSync(file('CLAUDE.md'));
  await expect(context().ensure()).rejects.toThrow('tracked context'); expect(existsSync(file('CLAUDE.md'))).toBe(false);
});

test('context inspection rejects outside, dangling and circular links without reading their target', () => {
  symlinkSync('../outside', file('CLAUDE.md')); expect(() => context().inspect()).toThrow('other instruction file'); rmSync(file('CLAUDE.md'));
  symlinkSync('AGENTS.md', file('CLAUDE.md')); expect(() => context().inspect()).toThrow('broken or circular');
  symlinkSync('CLAUDE.md', file('AGENTS.md')); expect(() => context().inspect()).toThrow('broken or circular');
});
