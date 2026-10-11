import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, ProjectSchema, SecretRedactor, WorktreeCleanupInputSchema } from '../packages/core/dist/index.js';
import { ThreadGit, WorktreeDiskService } from '../packages/projects/dist/index.js';
let root: string, homes: Homes, repo: string, service: WorktreeDiskService, retained: Set<string>, now: number;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-disk-')); const user = join(root, 'user'); mkdirSync(user); homes = new Homes(join(user, '.jevellan'), user); homes.ensure();
  repo = join(root, 'repo'); mkdirSync(repo); git('init', '-b', 'main'); writeFileSync(join(repo, 'owner.txt'), 'owner'); git('add', '.'); git('commit', '-m', 'Initial');
  now = Date.now() + 8 * 24 * 60 * 60_000; retained = new Set();
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'p', name: 'Fixture', paths: { here: repo }, branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } });
  service = new WorktreeDiskService({ homes, git: new ThreadGit({ homes, redactor: new SecretRedactor() }), deviceId: 'here', now: () => now,
    ownership: async () => [{ project, repository: repo, retained }] });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const folder = (id = 'orphan', group = '') => { const path = homes.ensure('worktrees', 'p', group, id); writeFileSync(join(path, 'file.txt'), 'data'); return path; };
const selection = async () => { const disk = await service.read(); return { schema: 'worktree-cleanup-input-v1', confirmed: true, entries: disk.entries.filter(row => row.orphan).map(({ projectId, id, kind, fingerprint }) => ({ projectId, id, kind, fingerprint })) }; };
test('usage separates thread and job trees and confirmed old orphans are removed', async () => {
  const thread = folder(), job = folder('job', 'jobs'); const disk = await service.read();
  expect(disk.threadBytes).toBeGreaterThan(0); expect(disk.jobBytes).toBeGreaterThan(0); expect(disk.entries).toHaveLength(2); expect(disk.entries.every(row => row.orphan)).toBe(true);
  const result = await service.cleanup(await selection()); expect(result.entries).toEqual([]); expect(existsSync(thread)).toBe(false); expect(existsSync(job)).toBe(false); expect(existsSync(join(repo, 'owner.txt'))).toBe(true);
});
test('recent trees and retained work never become eligible', async () => {
  folder(); retained.add('thread:orphan'); expect((await service.read()).entries[0]).toMatchObject({ orphan: false, reason: 'Retained by a work receipt.' });
  retained.clear(); now = Date.now(); expect((await service.read()).entries[0]).toMatchObject({ orphan: false, reason: 'Less than seven days old.' });
  expect(WorktreeCleanupInputSchema.safeParse({ schema: 'worktree-cleanup-input-v1', entries: [] }).success).toBe(false);
});
test('changed fingerprints and work newly retaining a selected tree refuse cleanup', async () => {
  const path = folder(), request = await selection(); writeFileSync(join(path, 'changed.txt'), 'new'); await expect(service.cleanup(request)).rejects.toThrow('changed');
  const fresh = await selection(); retained.add('thread:orphan'); await expect(service.cleanup(fresh)).rejects.toThrow('retained'); expect(existsSync(path)).toBe(true);
});
test('registered checkouts inside a candidate and duplicate selections cannot be removed', async () => {
  const path = folder(), request = await selection(), owners = await service.o.ownership();
  expect(WorktreeCleanupInputSchema.safeParse({ ...request, entries: [...request.entries, ...request.entries] }).success).toBe(false);
  const checkout = join(path, 'owner-checkout'); mkdirSync(checkout); writeFileSync(join(checkout, 'owner.txt'), 'keep');
  service.o.ownership = async () => [...owners, { project: ProjectSchema.parse({ ...owners[0]!.project, id: 'other', paths: { here: checkout } }), repository: checkout, retained: new Set() }];
  expect((await service.read()).entries[0]).toMatchObject({ orphan: false, reason: 'Registered project checkout.' });
  await expect(service.cleanup(request)).rejects.toThrow('retained'); expect(existsSync(join(checkout, 'owner.txt'))).toBe(true);
});
test('unrecovered process receipts block removal even when the folder has no work record', async () => {
  folder(); const request = await selection(), processes = homes.ensure('project-work', 'p', 'job-processes'); writeFileSync(join(processes, 'unknown.json'), '{}');
  expect((await service.read()).entries[0]).toMatchObject({ orphan: false, reason: 'Process receipts need recovery before cleanup.' }); await expect(service.cleanup(request)).rejects.toThrow('retained');
});
test('only the selected Git worktree registration is removed; owner main and other worktrees stay', async () => {
  const parent = homes.ensure('worktrees', 'p'), path = join(parent, 'orphan'); git('worktree', 'add', '--detach', path, 'HEAD');
  const outside = join(root, 'other'); git('worktree', 'add', '--detach', outside, 'HEAD');
  await service.cleanup(await selection()); expect(git('worktree', 'list', '--porcelain')).not.toContain(path); expect(git('worktree', 'list', '--porcelain')).toContain(outside);
  expect(git('branch', '--show-current')).toBe('main'); expect(git('status', '--porcelain')).toBe(''); expect(existsSync(outside)).toBe(true);
});
test('symlinked worktree leaves and parent escapes cannot be removed', async () => {
  const parent = homes.ensure('worktrees', 'p'), outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'safe'), 'owner'); symlinkSync(outside, join(parent, 'orphan'));
  await expect(service.read()).rejects.toThrow('alias'); expect(existsSync(join(outside, 'safe'))).toBe(true);
});
test('a live process cwd keeps an otherwise orphaned worktree', async () => {
  const path = folder(), request = await selection(), child = spawn('/bin/sleep', ['60'], { cwd: path, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try { await expect(service.cleanup(request)).rejects.toThrow('process is using'); expect(existsSync(path)).toBe(true); }
  finally { const ended = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await ended; }
});
