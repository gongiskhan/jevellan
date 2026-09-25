import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckoutOwnership, GitRewriteCapture, GitWorkspace, Homes, ProjectSchema, PublicationLeases, SecretRedactor, runOwnedCommand, type IntegrationRunner, type Project } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { ConversationLedger, publishWorkspace, verificationCounts, verifyWorkspace } from '../packages/conversations/dist/index.js';

let root: string; let homes: Homes; let db: HubDatabase; let project: Project; let workspace: GitWorkspace; let ledger: ConversationLedger; let origin: string;
const owner = { conversationId: 'conversation', conversationTitle: 'Fixture', workId: 'work' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-git-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); db = new HubDatabase(homes, 'hub');
  origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin);
  const path = join(root, 'project'); git(root, 'clone', origin, path);
  git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(path, 'value.txt'), '1\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Seed'); git(path, 'push', '-u', 'origin', 'main');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Fixture', paths: { device: path }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  const ownership = new CheckoutOwnership(db, homes, 'device'); await ownership.acquire(project, owner); workspace = new GitWorkspace(project, 'device', ownership, owner); ledger = new ConversationLedger(homes, owner.conversationId);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
test('first writing step fast-forwards clean main, then a checkpoint stays local with normal attribution', async () => {
  const second = join(root, 'second'); git(root, 'clone', origin, second); writeFileSync(join(second, 'upstream.txt'), 'Upstream\n'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Upstream'); git(second, 'push');
  const upstream = git(second, 'rev-parse', 'HEAD'); expect(await workspace.prepare()).toBe(upstream);
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n');
  const checkpoint = await workspace.checkpoint('implement', 'Support two\nNo second subject', before);
  expect(checkpoint.committed).toBe(true); expect(git(origin, 'rev-parse', 'main')).toBe(upstream); expect(await workspace.clean()).toBe(true);
  expect(git(workspace.path, 'log', '-1', '--format=%B')).toBe('implement: Support two');
  expect(git(workspace.path, 'log', '-1', '--format=%an')).toBe('Fixture'); expect(await workspace.diff(upstream, checkpoint.head)).toContain('+2');
  expect(readFileSync(join(workspace.path, 'upstream.txt'), 'utf8')).toBe('Upstream\n');
});
test('unrelated dirty files and unpublished local commits block first writing admission', async () => {
  writeFileSync(join(workspace.path, 'unrelated.txt'), 'Do not claim this\n');
  await expect(workspace.prepare()).rejects.toThrow("don't belong");
  git(workspace.path, 'add', '-A'); git(workspace.path, 'commit', '-m', 'User work');
  await expect(workspace.prepare()).rejects.toThrow("don't belong"); expect(git(origin, 'log', '-1', '--format=%s')).toBe('Seed');
});
test('checkpoint preparation preserves a tracked deletion across staging', async () => {
  const before = await workspace.snapshot(); rmSync(join(workspace.path, 'value.txt'));
  const digest = await workspace.workingTreeDigest();
  const plan = await workspace.planCheckpoint('deleted_file', before, digest, () => undefined);
  expect(await workspace.workingTreeDigest()).toBe(digest); expect(await workspace.head()).toBe(before.head);
  await workspace.applyCheckpoint(plan, () => undefined);
  expect(await workspace.checkpointApplied(plan)).toBe(true); expect(await workspace.clean()).toBe(true);
  expect(git(workspace.path, 'ls-files')).toBe(''); expect(git(origin, 'rev-parse', 'main')).toBe(before.head);
});
test('reviewed checkpoint includes untracked files and symlinks, stays local and can be recognized after a lost receipt', async () => {
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n');
  writeFileSync(join(workspace.path, 'new file.txt'), 'Reviewed addition.\n'); symlinkSync('new file.txt', join(workspace.path, 'link'));
  const diff = await workspace.uncommittedDiff(); expect(diff).toContain('Reviewed addition.'); expect(diff).toContain('+new file.txt'); expect(diff).toContain('+2');
  const plan = await workspace.planCheckpoint('accepted', before, await workspace.workingTreeDigest(), () => undefined);
  expect(await workspace.head()).toBe(before.head); expect(await workspace.checkpointApplied(plan)).toBe(false);
  await workspace.applyCheckpoint(plan, () => undefined);
  expect(await workspace.checkpointApplied(plan)).toBe(true); expect(await workspace.clean()).toBe(true);
  expect(git(origin, 'rev-parse', 'main')).toBe(before.head); expect(git(workspace.path, 'show', 'HEAD:new file.txt')).toBe('Reviewed addition.');
  expect(git(workspace.path, 'log', '-1', '--format=%an')).toBe('Fixture'); expect(git(workspace.path, 'log', '-1', '--format=%B')).toBe('implement: Accept reviewed changes');
});
test.each(['files', 'index', 'history', 'operation'])('reviewed checkpoint refuses changed %s before moving main', async (change) => {
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n');
  const plan = await workspace.planCheckpoint('accepted', before, await workspace.workingTreeDigest(), () => undefined);
  if (change === 'files') writeFileSync(join(workspace.path, 'new.txt'), 'Arrived after review.');
  if (change === 'index') git(workspace.path, 'reset', '--mixed', 'HEAD');
  if (change === 'history') git(workspace.path, 'tag', 'outside');
  if (change === 'operation') writeFileSync(join(workspace.path, '.git/MERGE_HEAD'), `${before.head}\n`);
  await expect(workspace.applyCheckpoint(plan, () => undefined)).rejects.toThrow();
  expect(await workspace.head()).toBe(before.head); expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('2\n');
});
test('accepting a restored clean tree records no empty commit', async () => {
  const before = await workspace.snapshot();
  const plan = await workspace.planCheckpoint('accepted', before, await workspace.workingTreeDigest(), () => undefined);
  expect(plan.after).toBe(before.head); await workspace.applyCheckpoint(plan, () => undefined);
  expect(await workspace.checkpointApplied(plan)).toBe(true); expect(git(workspace.path, 'rev-list', '--count', 'HEAD')).toBe('1');
});
test('post-stretch check detects agent commits, tags and remote changes before any checkpoint or push', async () => {
  const before = await workspace.snapshot(); git(workspace.path, 'tag', 'unexpected');
  await expect(workspace.checkAfterStretch(before, 'implement')).rejects.toThrow('changed git history');
  git(workspace.path, 'tag', '-d', 'unexpected'); writeFileSync(join(workspace.path, 'value.txt'), '2\n'); git(workspace.path, 'add', '-A'); git(workspace.path, 'commit', '-m', 'Agent commit');
  await expect(workspace.checkpoint('implement', 'Must not checkpoint', before)).rejects.toThrow('changed git history');
  const newBefore = await workspace.snapshot(); git(workspace.path, 'config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other');
  await expect(workspace.checkAfterStretch(newBefore, 'implement')).rejects.toThrow('changed git history');
  expect(git(origin, 'rev-parse', 'main')).toBe(before.head);
});
test('external projects perform no git mutations, and read-only actions cannot checkpoint', async () => {
  const before = await workspace.snapshot();
  await expect(workspace.checkpoint('reply', 'No edits', before)).rejects.toThrow('Read-only');
  const external = new GitWorkspace({ ...project, branchPolicy: 'external' }, 'device', workspace.ownership, owner);
  expect(await external.prepare()).toBe(before.head);
  await expect(external.checkpoint('implement', 'Leave git to me', before)).rejects.toThrow('own git rules');
  await expect(external.saveRef('undo', 1)).rejects.toThrow('own git rules');
  await expect(external.planUndo({ target: before.head, sourceTip: before.head, step: 1, published: false })).rejects.toThrow('own git rules');
  expect(await external.snapshot()).toEqual(before);
});
test('saved undo refs preserve an exact checkpoint and cannot silently overwrite an earlier save', async () => {
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n'); const checkpoint = await workspace.checkpoint('implement', 'Two', before);
  const ref = await workspace.saveRef('undo', 1); expect(git(workspace.path, 'rev-parse', ref)).toBe(checkpoint.head);
  await expect(workspace.saveRef('undo', 1)).rejects.toThrow(); expect(git(workspace.path, 'rev-parse', ref)).toBe(checkpoint.head);
});
test('unpublished undo preserves its complete code and memory tip before reset, retains earlier work and can recover a completed reset', async () => {
  const first = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n'); const prefix = await workspace.checkpoint('implement', 'Keep this earlier step', first);
  const second = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '3\n'); mkdirSync(join(workspace.path, '.jevellan/memory'), { recursive: true }); writeFileSync(join(workspace.path, '.jevellan/memory/note.md'), '# Undo this note\n');
  const tip = await workspace.checkpoint('implement', 'Code and memory to undo', second);
  const plan = await workspace.planUndo({ target: prefix.head, sourceTip: tip.head, step: 2, published: false }); expect(plan.mode).toBe('reset');
  let saved = 0;
  const result = await workspace.applyUndo(plan, () => undefined, (record) => {
    saved++; expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(tip.head); expect(git(workspace.path, 'rev-parse', record.savedRef)).toBe(tip.head);
  });
  expect(result.after).toBe(prefix.head); expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('2\n');
  expect(git(workspace.path, 'show', `${plan.savedRef}:.jevellan/memory/note.md`)).toBe('# Undo this note'); expect(git(origin, 'rev-parse', 'main')).toBe(first.head);
  expect(await workspace.applyUndo(plan, () => undefined, () => { saved++; })).toEqual(result); expect(saved).toBe(1);
  expect(await workspace.ownership.current(project)).toMatchObject({ held: true });
});

test('published undo reverts only the selected work, preserves later upstream work, and publishes after its own verification', async () => {
  const base = await workspace.head(); await checkpoint(); const beforeMemory = await workspace.snapshot();
  mkdirSync(join(workspace.path, '.jevellan/memory'), { recursive: true }); writeFileSync(join(workspace.path, '.jevellan/memory/note.md'), '# Published note\n');
  const tip = await workspace.checkpoint('memory', 'A project note', beforeMemory); git(workspace.path, 'push');
  const second = join(root, 'second'); git(root, 'clone', origin, second); writeFileSync(join(second, 'upstream.txt'), 'Keep newer work\n'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Later upstream work'); git(second, 'push');
  const upstream = await workspace.prepare(); const plan = await workspace.planUndo({ target: base, sourceTip: tip.head, step: 1, published: true });
  expect(plan.mode).toBe('revert'); expect(plan.commits).toHaveLength(2); const result = await workspace.applyUndo(plan, () => undefined, () => undefined);
  expect(git(origin, 'rev-parse', 'main')).toBe(upstream); expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('1\n'); expect(readFileSync(join(workspace.path, 'upstream.txt'), 'utf8')).toBe('Keep newer work\n');
  expect(git(workspace.path, 'log', '--format=%s', `${upstream}..HEAD`).split('\n')).toEqual(['Revert "implement: Two"', 'Revert "memory: A project note"']); expect(git(workspace.path, 'rev-parse', plan.savedRef)).toBe(upstream);
  const reverted = new GitWorkspace({ ...project, testCommand: 'test "$(cat value.txt)" = 1' }, 'device', workspace.ownership, owner);
  const publication = await publishWorkspace(reverted, ledger, homes, new PublicationLeases(db), { nextStretch: () => 3, integrate: async () => false });
  expect(publication).toMatchObject({ status: 'published', commit: result.after }); expect(git(origin, 'rev-parse', 'main')).toBe(result.after);
  const receipt = ledger.events().find((event) => event.type === 'verification')!; expect(ledger.data(receipt)).toMatchObject({ passed: true, treeClean: true, commit: result.after });
  expect(await workspace.applyUndo(plan, () => undefined, () => { throw new Error('Already applied'); })).toEqual(result); expect(await workspace.head()).toBe(result.after);
});

test('published undo can reverse separate recorded ranges while preserving intervening commits', async () => {
  const base = await workspace.head(); const first = await checkpoint();
  writeFileSync(join(workspace.path, 'outside.txt'), 'Keep this intervening work.\n'); git(workspace.path, 'add', '-A'); git(workspace.path, 'commit', '-m', 'Intervening work');
  const between = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '4\n'); const last = await workspace.checkpoint('implement', 'A later contribution', between); git(workspace.path, 'push');
  const input = { target: base, sourceTip: last.head, step: 1, published: true, ranges: [{ before: base, after: first.head }, { before: between.head, after: last.head }] };
  const plan = await workspace.planUndo(input); expect(plan.commits).toEqual([last.head, first.head]);
  await expect(workspace.planUndo({ ...input, ranges: [{ before: base, after: first.head }, { before: base, after: last.head }] })).rejects.toThrow('same checkpoint more than once');
  await expect(workspace.applyUndo({ ...plan, mode: 'reset', resultCommit: base }, () => undefined, () => undefined)).rejects.toThrow('cannot skip checkpoint history');
  expect(await workspace.head()).toBe(last.head);
  const result = await workspace.applyUndo(plan, () => undefined, () => undefined);
  expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('1\n'); expect(readFileSync(join(workspace.path, 'outside.txt'), 'utf8')).toBe('Keep this intervening work.\n');
  expect(git(workspace.path, 'rev-list', '--count', `${last.head}..${result.after}`)).toBe('2'); expect(await workspace.clean()).toBe(true);
});

test('published undo uses the original checkpoint range even after publication rebased its commits', async () => {
  const base = await workspace.head(); const original = await checkpoint();
  const second = join(root, 'second'); git(root, 'clone', origin, second); writeFileSync(join(second, 'upstream.txt'), 'Preserve this upstream addition\n'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Upstream'); git(second, 'push');
  await workspace.fetch(); expect(await workspace.rebase()).toBe('clean'); git(workspace.path, 'push'); const published = await workspace.head(); expect(published).not.toBe(original.head);
  const plan = await workspace.planUndo({ target: base, sourceTip: original.head, step: 1, published: true }); expect(plan.commits).toEqual([original.head]);
  const result = await workspace.applyUndo(plan, () => undefined, () => undefined);
  expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('1\n'); expect(readFileSync(join(workspace.path, 'upstream.txt'), 'utf8')).toBe('Preserve this upstream addition\n');
  expect(git(workspace.path, 'rev-parse', 'HEAD^')).toBe(published); expect(result.after).not.toBe(published); expect(git(origin, 'rev-parse', 'main')).toBe(published);
});

test.each(['clean', 'conflict', 'drop', 'skip'] as const)('native rewrite tracking preserves the actual %s publication boundaries for undo', async (kind) => {
  const base = await workspace.head(); const original = await checkpoint();
  const second = join(root, 'second'); git(root, 'clone', origin, second);
  writeFileSync(join(second, 'upstream.txt'), 'Preserve upstream work\n');
  if (kind !== 'clean') writeFileSync(join(second, 'value.txt'), kind === 'drop' ? '2\n' : '3\n');
  git(second, 'add', '-A'); git(second, 'commit', '-m', 'Upstream'); git(second, 'push'); await workspace.fetch();
  const upstream = await workspace.upstream(); const config = readFileSync(join(workspace.path, '.git/config'), 'utf8');
  const tracking = await workspace.prepareRebaseTracking(homes, `rewrite_${kind}`);
  expect(tracking.plan).toMatchObject({ before: original.head, base, upstream, commits: [original.head] });
  const result = await workspace.rebase({ tracking, ...(kind === 'conflict' ? { resolveConflicts: async () => [{ schema: 'git-conflict-resolution-v1' as const, path: 'value.txt', content: '5\n', mode: '100644' as const }] } : {}) });
  if (kind === 'skip') { expect(result).toBe('conflict'); git(workspace.path, ...tracking.options, 'rebase', '--skip'); }
  else expect(result).toBe('clean');
  const receipt = await workspace.finishRebaseTracking(tracking);
  expect(receipt.pairs).toEqual([{ before: original.head, after: receipt.after }]);
  expect(await workspace.finishRebaseTracking(GitRewriteCapture.recover(homes, tracking.plan.id))).toEqual(receipt);
  expect(git(workspace.path, 'rev-parse', tracking.plan.savedRef)).toBe(original.head);
  expect(readFileSync(join(workspace.path, '.git/config'), 'utf8')).toBe(config);
  git(workspace.path, 'push');
  const undo = await workspace.planUndo({ target: upstream, sourceTip: receipt.after, step: 1, published: true });
  expect(undo.commits).toEqual(kind === 'drop' || kind === 'skip' ? [] : [receipt.after]);
  await workspace.applyUndo(undo, () => undefined, () => undefined);
  expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe(kind === 'clean' ? '1\n' : kind === 'drop' ? '2\n' : '3\n');
  expect(readFileSync(join(workspace.path, 'upstream.txt'), 'utf8')).toBe('Preserve upstream work\n');
}, 30_000);

test('rewrite capture forwards existing hooks with their original path, arguments, stdin and exit behavior', async () => {
  await checkpoint();
  const preserved = await workspace.head(); git(workspace.path, 'branch', 'user-history', preserved); git(workspace.path, 'config', 'rebase.updateRefs', 'true');
  const hooks = join(root, "owner's hooks"); mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-rebase'), '#!/bin/sh\nprintf "%s\\n" "$0" "$@" > .git/pre-rebase-seen\n', { mode: 0o700 });
  writeFileSync(join(hooks, 'post-rewrite'), '#!/bin/sh\nprintf "%s\\n" "$0" "$@" > .git/post-rewrite-seen\ncat > .git/post-rewrite-input\nexit 7\n', { mode: 0o700 });
  git(workspace.path, 'config', 'core.hooksPath', hooks);
  const second = join(root, 'second'); git(root, 'clone', origin, second); writeFileSync(join(second, 'upstream.txt'), 'Upstream\n'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Upstream'); git(second, 'push'); await workspace.fetch();
  const config = readFileSync(join(workspace.path, '.git/config'), 'utf8');
  const capture = await workspace.prepareRebaseTracking(homes, 'hooks');
  expect(await workspace.rebase({ tracking: capture })).toBe('clean');
  const receipt = await workspace.finishRebaseTracking(capture);
  expect(readFileSync(join(workspace.path, '.git/pre-rebase-seen'), 'utf8')).toBe(`${realpathSync(join(hooks, 'pre-rebase'))}\nrefs/remotes/origin/main\n`);
  expect(readFileSync(join(workspace.path, '.git/post-rewrite-seen'), 'utf8')).toBe(`${realpathSync(join(hooks, 'post-rewrite'))}\nrebase\n`);
  expect(readFileSync(join(workspace.path, '.git/post-rewrite-input'), 'utf8')).toBe(`${capture.plan.before} ${receipt.after}\n`);
  expect(readFileSync(join(workspace.path, '.git/config'), 'utf8')).toBe(config);
  expect(git(workspace.path, 'rev-parse', 'user-history')).toBe(preserved);
}, 30_000);

test('an existing pre-rebase hook can reject tracked integration without moving the checkout', async () => {
  await checkpoint();
  const second = join(root, 'second'); git(root, 'clone', origin, second); writeFileSync(join(second, 'upstream.txt'), 'Upstream\n'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Upstream'); git(second, 'push'); await workspace.fetch();
  writeFileSync(join(workspace.path, '.git/hooks/pre-rebase'), '#!/bin/sh\nexit 8\n', { mode: 0o700 });
  const capture = await workspace.prepareRebaseTracking(homes, 'rejected');
  await expect(workspace.rebase({ tracking: capture })).rejects.toThrow();
  expect(await workspace.head()).toBe(capture.plan.before); expect(await workspace.clean()).toBe(true);
  expect(capture.pairs()).toBeUndefined();
});

test('missing or incomplete native rewrite evidence cannot authorize undo of guessed commits', async () => {
  await checkpoint(); const second = join(root, 'second'); git(root, 'clone', origin, second);
  writeFileSync(join(second, 'upstream.txt'), 'Upstream\n'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Upstream'); git(second, 'push'); await workspace.fetch();
  const capture = await workspace.prepareRebaseTracking(homes, 'missing');
  expect(await workspace.rebase()).toBe('clean'); const after = await workspace.head();
  await expect(workspace.finishRebaseTracking(capture)).rejects.toThrow('complete ordered mapping');
  writeFileSync(join(capture.directory, 'rewrites.json'), JSON.stringify({ schema: 'git-rewrite-event-v1', id: capture.plan.id, kind: 'rebase', pairs: [] }));
  await expect(workspace.finishRebaseTracking(capture)).rejects.toThrow('complete ordered mapping');
  expect(await workspace.head()).toBe(after); expect(await workspace.clean()).toBe(true);
});

test('a dropped checkpoint in the middle maps to the preceding boundary and is not reverted twice', async () => {
  let before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'first.txt'), 'Local first\n'); const first = await workspace.checkpoint('implement', 'First', before);
  const dropped = await checkpoint(); before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'last.txt'), 'Local last\n'); const last = await workspace.checkpoint('implement', 'Last', before);
  const second = join(root, 'second'); git(root, 'clone', origin, second); writeFileSync(join(second, 'value.txt'), '2\n'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Upstream already contains the middle change'); git(second, 'push'); await workspace.fetch();
  const capture = await workspace.prepareRebaseTracking(homes, 'dropped_middle');
  expect(await workspace.rebase({ tracking: capture })).toBe('clean'); const receipt = await workspace.finishRebaseTracking(capture);
  expect(receipt.pairs.map((entry) => entry.before)).toEqual([first.head, dropped.head, last.head]);
  expect(receipt.pairs[1]!.after).toBe(receipt.pairs[0]!.after);
  git(workspace.path, 'push');
  const undo = await workspace.planUndo({ target: capture.plan.upstream, sourceTip: receipt.after, step: 1, published: true }); expect(undo.commits).toHaveLength(2);
  await workspace.applyUndo(undo, () => undefined, () => undefined);
  expect(git(workspace.path, 'ls-files')).toBe('value.txt'); expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('2\n');
}, 30_000);

test('a conflicting published undo is detected before changing any code, memory or main history', async () => {
  const base = await workspace.head(); await checkpoint(); const memoryBefore = await workspace.snapshot();
  mkdirSync(join(workspace.path, '.jevellan/memory'), { recursive: true }); writeFileSync(join(workspace.path, '.jevellan/memory/note.md'), '# Keep on failed undo\n'); const tip = await workspace.checkpoint('memory', 'Note', memoryBefore);
  writeFileSync(join(workspace.path, 'value.txt'), '3\n'); git(workspace.path, 'add', '-A'); git(workspace.path, 'commit', '-m', 'Later work with overlapping changes'); git(workspace.path, 'push'); const before = await workspace.head();
  await expect(workspace.planUndo({ target: base, sourceTip: tip.head, step: 1, published: true })).rejects.toThrow('checkout has not changed');
  expect(await workspace.head()).toBe(before); expect(await workspace.clean()).toBe(true); expect(git(origin, 'rev-parse', 'main')).toBe(before);
  expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('3\n'); expect(readFileSync(join(workspace.path, '.jevellan/memory/note.md'), 'utf8')).toBe('# Keep on failed undo\n');
});

test('undo refuses stale checkout state and does not mutate HEAD when saving its durable intent fails', async () => {
  const base = await workspace.head(); const tip = await checkpoint(); const plan = await workspace.planUndo({ target: base, sourceTip: tip.head, step: 1, published: false });
  writeFileSync(join(workspace.path, 'unrelated.txt'), 'Uncommitted user work\n'); await expect(workspace.applyUndo(plan, () => undefined, () => undefined)).rejects.toThrow('clean');
  expect(readFileSync(join(workspace.path, 'unrelated.txt'), 'utf8')).toBe('Uncommitted user work\n'); rmSync(join(workspace.path, 'unrelated.txt'));
  await expect(workspace.applyUndo(plan, () => undefined, () => { throw new Error('Ledger unavailable'); })).rejects.toThrow('Ledger unavailable');
  expect(await workspace.head()).toBe(tip.head); expect(git(workspace.path, 'rev-parse', plan.savedRef)).toBe(tip.head);
  await expect(workspace.applyUndo(plan, () => { throw new Error('Generation changed'); }, () => undefined)).rejects.toThrow('Generation changed'); expect(await workspace.head()).toBe(tip.head);
  expect((await workspace.applyUndo(plan, () => undefined, () => undefined)).after).toBe(base);
});

test('prepared revert recovery identifies its exact completed result without changing refs or repeating commits', async () => {
  const base = await workspace.head(); const tip = await checkpoint(); git(workspace.path, 'push');
  const plan = await workspace.planUndo({ target: base, sourceTip: tip.head, step: 1, published: true });
  expect(plan.resultCommit).toBeDefined(); expect(await workspace.head()).toBe(tip.head); expect(await workspace.clean()).toBe(true);
  expect(git(workspace.path, 'show', `${plan.resultCommit}:value.txt`)).toBe('1'); expect(git(workspace.path, 'rev-parse', `${plan.resultCommit}^`)).toBe(tip.head);
  expect(git(workspace.path, 'show', '-s', '--format=%an <%ae>', plan.resultCommit!)).toBe('Fixture <fixture@example.invalid>');
  expect((await workspace.inspectUndo(plan)).status).toBe('ready');
  const applied = await workspace.applyUndo(plan, () => undefined, () => undefined); const refs = git(workspace.path, 'show-ref');
  expect(await workspace.inspectUndo(plan)).toMatchObject({ status: 'completed', result: applied }); expect(git(workspace.path, 'show-ref')).toBe(refs);
  expect(await workspace.applyUndo(plan, () => { throw new Error('Should not run'); }, () => { throw new Error('Should not write'); })).toEqual(applied);
  writeFileSync(join(workspace.path, 'outside.txt'), 'Keep my file.'); expect((await workspace.inspectUndo(plan)).status).toBe('blocked'); expect(readFileSync(join(workspace.path, 'outside.txt'), 'utf8')).toBe('Keep my file.');
  git(workspace.path, 'add', '-A'); git(workspace.path, 'commit', '-m', 'Later work'); const newer = await workspace.head();
  expect((await workspace.inspectUndo(plan)).status).toBe('blocked'); expect(await workspace.head()).toBe(newer);
});

test('prepared revert validation rejects another descendant before applying an unrelated tree', async () => {
  const base = await workspace.head(); const tip = await checkpoint(); git(workspace.path, 'push');
  const plan = await workspace.planUndo({ target: base, sourceTip: tip.head, step: 1, published: true });
  const tree = git(workspace.path, 'rev-parse', `${tip.head}^{tree}`);
  const unrelated = git(workspace.path, 'commit-tree', tree, '-p', tip.head, '-m', 'Different change', '-m', `This reverts commit ${tip.head}.`);
  await expect(workspace.applyUndo({ ...plan, resultCommit: unrelated }, () => undefined, () => undefined)).rejects.toThrow('does not match its recorded change');
  expect(await workspace.head()).toBe(tip.head); expect(await workspace.clean()).toBe(true);
});

test('a checkpoint published after undo planning cannot be reset, and replanning selects revert without trusting a stale published flag', async () => {
  const base = await workspace.head(); const tip = await checkpoint(); const plan = await workspace.planUndo({ target: base, sourceTip: tip.head, step: 1, published: false }); expect(plan.mode).toBe('reset');
  git(workspace.path, 'push'); await expect(workspace.applyUndo(plan, () => undefined, () => undefined)).rejects.toThrow('published after'); expect(await workspace.head()).toBe(tip.head);
  const current = await workspace.planUndo({ target: base, sourceTip: tip.head, step: 1, published: false }); expect(current.mode).toBe('revert');
  const result = await workspace.applyUndo(current, () => undefined, () => undefined); expect(git(workspace.path, 'rev-parse', 'HEAD^')).toBe(tip.head); expect(result.after).not.toBe(base);
});
test('undo and discard leave an unfinished cherry-pick intact even when git status reports a clean tree', async () => {
  const base = await workspace.head(); const tip = await checkpoint(); const input = { target: base, sourceTip: tip.head, step: 1, published: false };
  const plan = await workspace.planUndo(input);
  expect(() => git(workspace.path, 'cherry-pick', 'HEAD')).toThrow(); expect(await workspace.clean()).toBe(true);
  const cherry = git(workspace.path, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD');
  await expect(workspace.planUndo(input)).rejects.toThrow('Git operation in progress');
  await expect(workspace.applyUndo(plan, () => undefined, () => undefined)).rejects.toThrow('Git operation in progress');
  await expect(workspace.discard(base, tip.head, 1, () => undefined)).rejects.toThrow('Git operation in progress');
  expect(git(workspace.path, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD')).toBe(cherry); expect(await workspace.head()).toBe(tip.head); expect(await workspace.clean()).toBe(true);
});
test.each(['unchanged', 'changed-ref', 'different-ref', 'later-change'] as const)('resuming discard requires its exact preserved recovery ref: %s', async change => {
  const base = await workspace.head(); const tip = await checkpoint(); const saved = await workspace.saveRef('discard', 1);
  let resume = saved; let checks = 0;
  if (change === 'changed-ref') git(workspace.path, 'update-ref', saved, base);
  if (change === 'different-ref') resume = await workspace.saveRef('discard', 2);
  const discard = workspace.discard(base, tip.head, 1, () => { if (++checks === 2 && change === 'later-change') git(workspace.path, 'update-ref', saved, base); }, () => undefined, resume);
  if (change === 'unchanged') {
    await expect(discard).resolves.toBe(saved); expect(await workspace.head()).toBe(base); expect(git(workspace.path, 'rev-parse', saved)).toBe(tip.head);
  } else {
    await expect(discard).rejects.toThrow('saved discard checkpoint changed'); expect(await workspace.head()).toBe(tip.head); expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('2\n');
  }
  expect(git(origin, 'rev-parse', 'main')).toBe(base); expect(await workspace.clean()).toBe(true);
});
test('verification runs the configured command on the exact clean checkpoint and stores its own receipt', async () => {
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n'); const checkpoint = await workspace.checkpoint('implement', 'Two', before);
  const receipt = await verifyWorkspace(workspace, ledger, homes, 'done-gate');
  expect(receipt).toMatchObject({ passed: true, exitCode: 0, treeClean: true, headStable: true, commit: checkpoint.head });
  expect(verificationCounts(receipt, await workspace.head(), await workspace.clean())).toBe(true);
  expect(ledger.read(receipt.outputRef)).toMatchObject({ stdout: '', stderr: '', timedOut: false });
  writeFileSync(join(workspace.path, 'value.txt'), '3\n');
  expect(verificationCounts(receipt, await workspace.head(), await workspace.clean())).toBe(false);
  await expect(verifyWorkspace(workspace, ledger, homes, 'done-gate')).rejects.toThrow('clean checkpoint');
});
test('agent-reported success cannot replace verification after a later edit or for a different commit', async () => {
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '3\n'); const checkpoint = await workspace.checkpoint('implement', 'Changed after agent tests', before);
  const receipt = await verifyWorkspace(workspace, ledger, homes, 'done-gate');
  expect(receipt.passed).toBe(false); expect(receipt.commit).toBe(checkpoint.head); expect(verificationCounts(receipt, before.head, true)).toBe(false);
});
test('a test that dirties the checkout is recorded but its success does not satisfy the done gate', async () => {
  const mutation = new GitWorkspace({ ...project, testCommand: 'printf changed > value.txt' }, 'device', workspace.ownership, owner);
  const receipt = await verifyWorkspace(mutation, ledger, homes, 'done-gate');
  expect(receipt.passed).toBe(true); expect(receipt.treeClean).toBe(false); expect(verificationCounts(receipt, await mutation.head(), true)).toBe(false);
});
test('verification environment strips test credentials and output redaction covers known secrets', async () => {
  const secret = ['fixture', 'sensitive', 'output'].join('-'); const redactor = new SecretRedactor(); redactor.add(secret);
  const result = await runOwnedCommand(process.execPath, ['-e', 'process.stdout.write(process.env.VALUE); process.stderr.write("details")'], { cwd: root, env: { VALUE: secret }, redactor });
  expect(result.stdout).toBe('[redacted]'); expect(result.stderr).toBe('details');
  const check = new GitWorkspace({ ...project, testCommand: 'test -z "$JEVELLAN_TEST_JEV_KEY" && test -z "$JEVELLAN_TEST_CLAUDE_TOKEN"' }, 'device', workspace.ownership, owner);
  expect((await verifyWorkspace(check, ledger, homes, 'done-gate')).passed).toBe(true);
});
test('owned command timeout stops a shell descendant before returning', async () => {
  const marker = join(root, 'child.txt');
  const program = 'const fs=require("node:fs"); const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); fs.writeFileSync(process.env.MARKER,String(child.pid)); setInterval(()=>{},1000);';
  const result = await runOwnedCommand(process.execPath, ['-e', program], { cwd: root, env: { MARKER: marker }, timeoutMs: 700 });
  const pid = Number(readFileSync(marker, 'utf8')); expect(result.timedOut).toBe(true); expect(result.code).not.toBe(0);
  expect(() => process.kill(pid, 0)).toThrow();
});
async function checkpoint() {
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n'); return workspace.checkpoint('implement', 'Two', before);
}
const noIntegration = { nextStretch: () => 2, integrate: async () => { throw new Error('Unexpected integration stretch'); } };
test.each(['retained', 'missing'])('publication retry handles a lost ledger receipt with %s native rewrite evidence', async (evidence) => {
  await checkpoint(); const remoteBefore = git(origin, 'rev-parse', 'main');
  const second = join(root, 'second'); git(root, 'clone', origin, second); writeFileSync(join(second, 'upstream.txt'), 'Preserve upstream\n'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Upstream'); git(second, 'push');
  const upstream = git(origin, 'rev-parse', 'main'); expect(upstream).not.toBe(remoteBefore);
  const append = ledger.append.bind(ledger);
  const interrupted = vi.spyOn(ledger, 'append').mockImplementation((input) => {
    const data = input.data as { schema?: string; plan?: { id: string } };
    if (data.schema === 'git-rewrite-receipt-v1') {
      if (evidence === 'missing') rmSync(homes.at('integrations', data.plan!.id, 'rewrites.json'));
      throw new Error('Simulated crash before the ledger receipt');
    }
    return append(input);
  });
  await expect(publishWorkspace(workspace, ledger, homes, new PublicationLeases(db), noIntegration)).rejects.toThrow('Simulated crash'); interrupted.mockRestore();
  const rebased = await workspace.head(); expect(rebased).not.toBe(upstream); expect(git(origin, 'rev-parse', 'main')).toBe(upstream);
  const restarted = new GitWorkspace(project, 'device', workspace.ownership, owner);
  const retried = publishWorkspace(restarted, ledger, homes, new PublicationLeases(db), noIntegration);
  if (evidence === 'retained') {
    expect(await retried).toMatchObject({ status: 'published', commit: rebased });
    expect(ledger.events().filter((event) => event.type === 'git' && (ledger.data(event) as { schema: string }).schema === 'git-rewrite-receipt-v1')).toHaveLength(1);
    expect(git(origin, 'rev-parse', 'main')).toBe(rebased);
  } else {
    await expect(retried).rejects.toThrow('complete ordered mapping'); expect(git(origin, 'rev-parse', 'main')).toBe(upstream);
  }
  expect(await workspace.head()).toBe(rebased); expect(await workspace.clean()).toBe(true);
}, 30_000);
test('publication verifies and pushes a clean checkpoint under its lease', async () => {
  const local = await checkpoint(); const result = await publishWorkspace(workspace, ledger, homes, new PublicationLeases(db), noIntegration);
  expect(result).toMatchObject({ status: 'published', attempts: 1, commit: local.head }); expect(result.verificationId).toBeDefined();
  expect(git(origin, 'rev-parse', 'main')).toBe(local.head);
  expect((await workspace.ownership.current(project))?.held).toBe(true); // Closing the work settles ownership separately.
});
test('clean upstream integration requires a new verification receipt for the rebased commit', async () => {
  const second = join(root, 'second'); git(root, 'clone', origin, second);
  const local = await checkpoint(); const firstReceipt = await verifyWorkspace(workspace, ledger, homes, 'done-gate');
  writeFileSync(join(second, 'upstream.txt'), 'Upstream'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Concurrent work'); git(second, 'push');
  const result = await publishWorkspace(workspace, ledger, homes, new PublicationLeases(db), noIntegration);
  expect(result.status).toBe('published'); expect(result.commit).not.toBe(local.head); expect(result.verificationId).not.toBe(firstReceipt.id);
  expect(git(origin, 'show', 'main:upstream.txt')).toBe('Upstream'); expect(git(origin, 'show', 'main:value.txt')).toBe('2');
  expect(ledger.events().filter((event) => event.type === 'verification')).toHaveLength(2);
});
test('a conflict is aborted, saved, delegated to integrate, then verified and published', async () => {
  writeFileSync(join(workspace.path, 'message.txt'), 'Seed\n'); git(workspace.path, 'add', '-A'); git(workspace.path, 'commit', '-m', 'Message seed'); git(workspace.path, 'push');
  const second = join(root, 'second'); git(root, 'clone', origin, second);
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n'); writeFileSync(join(workspace.path, 'message.txt'), 'Local\n');
  const local = await workspace.checkpoint('implement', 'Local intent', before);
  writeFileSync(join(second, 'message.txt'), 'Remote\n'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Remote intent'); git(second, 'push');
  const integrate = vi.fn(async ({ savedRef, run }: { savedRef: string; upstream: string; run: IntegrationRunner }) => {
    expect(await workspace.rebaseInProgress()).toBe(false); expect(git(workspace.path, 'rev-parse', savedRef)).toBe(local.head);
    expect(await run('start')).toMatchObject({ status: 'conflict', conflicts: ['message.txt'] }); writeFileSync(join(workspace.path, 'message.txt'), 'Local\nRemote\n');
    expect(await run('continue')).toMatchObject({ status: 'clean' }); return true;
  });
  const result = await publishWorkspace(workspace, ledger, homes, new PublicationLeases(db), { nextStretch: () => 2, integrate });
  expect(result.status).toBe('published'); expect(integrate).toHaveBeenCalledOnce(); expect(result.savedRef).toBe('refs/jevellan/pre-integration/conversation/2');
  expect(git(origin, 'show', 'main:message.txt')).toBe('Local\nRemote'); expect(result.verificationId).toBeDefined();
});
test('a real rejected push is retried after fresh integration and verification', async () => {
  const second = join(root, 'second'); git(root, 'clone', origin, second); await checkpoint();
  const push = workspace.push.bind(workspace); let raced = false;
  vi.spyOn(workspace, 'push').mockImplementation(async (head, assertLease) => {
    if (!raced) { raced = true; writeFileSync(join(second, 'race.txt'), 'Concurrent writer'); git(second, 'add', '-A'); git(second, 'commit', '-m', 'Racing publish'); git(second, 'push'); }
    return push(head, assertLease);
  });
  const result = await publishWorkspace(workspace, ledger, homes, new PublicationLeases(db), noIntegration);
  expect(result).toMatchObject({ status: 'published', attempts: 2 }); expect(git(origin, 'show', 'main:race.txt')).toBe('Concurrent writer');
  expect(ledger.events().filter((event) => event.type === 'verification')).toHaveLength(2);
});
test('three simulated push rejections leave checkpoints local and work blocked', async () => {
  const original = git(origin, 'rev-parse', 'main'); await checkpoint(); const push = vi.spyOn(workspace, 'push').mockResolvedValue('rejected');
  const result = await publishWorkspace(workspace, ledger, homes, new PublicationLeases(db), noIntegration);
  expect(result).toMatchObject({ status: 'blocked', attempts: 3 }); expect(push).toHaveBeenCalledTimes(3); expect(git(origin, 'rev-parse', 'main')).toBe(original);
});
test('a failed verification blocks publication before fetching or acquiring a publication lease', async () => {
  const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '3\n'); await workspace.checkpoint('implement', 'Failing change', before);
  const leases = new PublicationLeases(db); const acquire = vi.spyOn(leases, 'acquire'); const fetch = vi.spyOn(workspace, 'fetch');
  const result = await publishWorkspace(workspace, ledger, homes, leases, noIntegration);
  expect(result).toMatchObject({ status: 'blocked', attempts: 0 }); expect(acquire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

test.each(['prepare', 'apply'])('reviewed checkpoints recheck files after asynchronous resource checks during %s', async stage => {
  await workspace.prepare(); const before = await workspace.snapshot(); writeFileSync(join(workspace.path, 'value.txt'), '2\n'); const digest = await workspace.workingTreeDigest();
  const changeDuringCheck = async () => { await Promise.resolve(); writeFileSync(join(workspace.path, 'value.txt'), 'Outside edit.\n'); };
  if (stage === 'prepare') await expect(workspace.planCheckpoint('asynchronous_review', before, digest, changeDuringCheck)).rejects.toThrow('files changed');
  else {
    const plan = await workspace.planCheckpoint('asynchronous_review', before, digest, () => undefined);
    await expect(workspace.applyCheckpoint(plan, changeDuringCheck)).rejects.toThrow('files changed');
  }
  expect(await workspace.head()).toBe(before.head); expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('Outside edit.\n'); expect(git(origin, 'rev-parse', 'main')).toBe(before.head);
});
