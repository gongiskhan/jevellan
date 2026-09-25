import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { CheckoutOwnership, GitWorkspace, Homes, MemoryConflictMergeSchema, ProjectSchema, PublicationLeases, type GitConflict, type IntegrationRunner, type Project } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { ConversationLedger, publishWorkspace } from '../packages/conversations/dist/index.js';
import { memoryConflictResolutions } from '../packages/memory/dist/index.js';

const note = '.jevellan/memory/rule.md';
const projectDefinition = { schema: 'project-v1', id: 'project', name: 'Fixture', paths: { device: '/fixture' }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } };
const owner = { conversationId: 'conversation', conversationTitle: 'Fixture', workId: 'work' };
const at = '2026-09-24T08:00:00Z';
function conflict(upstream: string, local: string, path = note): GitConflict {
  const side = (content: string) => ({ content, mode: '100644', oid: 'a'.repeat(40) });
  return { schema: 'git-conflict-v1', path, base: side('Base\n'), upstream: side(upstream), local: side(local) };
}
function metadata(content: string): Record<string, unknown> { return parse(/^---\n([\s\S]*?)\n---\n/.exec(content)![1]!) as Record<string, unknown>; }

describe('authored memory conflict content', () => {
  const project = ProjectSchema.parse(projectDefinition);
  test('retains upstream metadata, comments and body, and appends the full local document', () => {
    const upstream = '---\ntitle: "Shared convention"\npermalink: shared-convention\n# Preserve this explanation\nstatus: resolved\ntags: [tests, "with spaces"]\ncustom:\n  nested: true\n---\nUpstream body.\n';
    const local = '---\ntitle: Local convention\nstatus: draft\n---\nLocal body.\n';
    const merged = memoryConflictResolutions(project, [conflict(upstream, local)], 'device', at)![0]!.content;
    expect(metadata(merged)).toEqual({ title: 'Shared convention', permalink: 'shared-convention', status: 'unresolved', tags: ['tests', 'with spaces'], custom: { nested: true } });
    expect(merged).toContain('# Preserve this explanation'); expect(merged).toContain('Upstream body.\n\n## Merged from device on 2026-09-24\n\n'); expect(merged.endsWith(local)).toBe(true);
  });
  test.each(['No metadata\r\nBody without final newline', '---\ntitle: [invalid\n---\nRaw body\n', '---\n- non-map\n---\nRaw body\n'])('retains unstructured or invalid source text: %s', (upstream) => {
    const local = 'Full local\r\nbody\r\n'; const merged = memoryConflictResolutions(project, [conflict(upstream, local)], 'device', at)![0]!.content;
    expect(metadata(merged).status).toBe('unresolved'); expect(merged).toContain(upstream); expect(merged.endsWith(local)).toBe(true);
  });
  test.each(['.jevellan/memory-other/rule.md', 'src/rule.md', '.jevellan/memory/blob.bin'])('leaves non-note conflicts for integration: %s', (path) => {
    expect(memoryConflictResolutions(project, [conflict('A', 'B'), conflict('C', 'D', path)], 'device', at)).toBeNull();
  });
  test('does not automate device-only memory, nontext blobs or symlinks', () => {
    expect(memoryConflictResolutions({ ...project, memory: { ...project.memory, mode: 'device' } }, [conflict('A', 'B')], 'device', at)).toBeNull();
    for (const side of [{ content: null, mode: '100644' }, { content: 'target', mode: '120000' }]) {
      const input = conflict('A', 'B'); input.local = { ...input.local!, ...side };
      expect(memoryConflictResolutions(project, [input], 'device', at)).toBeNull();
    }
  });
  test('an invalid memory root cannot make the entire checkout eligible for automatic note merging', () => {
    for (const dir of ['.', '..', '../outside', '/outside']) expect(memoryConflictResolutions({ ...project, memory: { mode: 'repo', dir } }, [conflict('A', 'B')], 'device', at)).toBeNull();
  });
});

describe('publication through real Git conflicts', () => {
  let root: string; let origin: string; let other: string; let homes: Homes; let db: HubDatabase; let project: Project; let workspace: GitWorkspace; let ledger: ConversationLedger; let base: string;
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  function write(cwd: string, name: string, value: string | Buffer) { mkdirSync(dirname(join(cwd, name)), { recursive: true }); writeFileSync(join(cwd, name), value); }
  function commit(cwd: string, message = 'Fixture checkpoint') { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); }
  function remote(value: string | Buffer | null, extra?: () => void) {
    if (value === null) rmSync(join(other, note)); else write(other, note, value);
    extra?.(); const head = commit(other, 'Upstream work'); git(other, 'push'); return head;
  }
  function publish(integrate: Parameters<typeof publishWorkspace>[4]['integrate'] = vi.fn(async () => false), assertCurrent?: () => void) {
    return publishWorkspace(workspace, ledger, homes, new PublicationLeases(db), { baseCommit: base, nextStretch: () => 3, integrate, ...(assertCurrent ? { assertCurrent } : {}) });
  }
  const mergedReceipts = () => ledger.events().flatMap((event) => { const parsed = MemoryConflictMergeSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; });
  const verifications = () => ledger.events().filter((event) => event.type === 'verification').map((event) => ledger.data(event));
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'jevellan-memory-conflict-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); db = new HubDatabase(homes, 'hub');
    origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin); const path = join(root, 'project'); git(root, 'clone', origin, path);
    git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid'); git(path, 'config', 'commit.gpgsign', 'false');
    write(path, 'value.txt', '1\n'); write(path, note, '# Convention\n\nBase rule.\n'); base = commit(path, 'Seed'); git(path, 'push', '-u', 'origin', 'main');
    other = join(root, 'upstream'); git(root, 'clone', origin, other);
    project = ProjectSchema.parse({ ...projectDefinition, paths: { device: path } }); const ownership = new CheckoutOwnership(db, homes, 'device'); await ownership.acquire(project, owner);
    workspace = new GitWorkspace(project, 'device', ownership, owner); ledger = new ConversationLedger(homes, owner.conversationId);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  test('preserves both note versions, re-verifies a code change at the rebased HEAD, then publishes', async () => {
    const local = '# Convention\n\nLocal rule.\n'; write(workspace.path, note, local); write(workspace.path, 'value.txt', '2\n'); const checkpoint = commit(workspace.path);
    const upstreamText = '---\ntitle: Convention\npermalink: convention\ntags: [shared]\n---\nUpstream rule.\n'; const upstream = remote(upstreamText, () => write(other, 'upstream.txt', 'Preserve this upstream code.\n'));
    const integrate = vi.fn(async () => false); const result = await publish(integrate); const head = await workspace.head();
    expect(result).toMatchObject({ status: 'published', commit: head }); expect(result.verificationExemption).toBeUndefined(); expect(integrate).not.toHaveBeenCalled();
    expect(head).not.toBe(checkpoint); expect(git(origin, 'rev-parse', 'main')).toBe(head); expect(await workspace.contains(upstream)).toBe(true); expect(await workspace.clean()).toBe(true); expect(await workspace.rebaseInProgress()).toBe(false);
    const merged = readFileSync(join(workspace.path, note), 'utf8'); expect(metadata(merged)).toMatchObject({ title: 'Convention', permalink: 'convention', tags: ['shared'], status: 'unresolved' }); expect(merged).toContain('Upstream rule.'); expect(merged.endsWith(local)).toBe(true);
    expect(readFileSync(join(workspace.path, 'upstream.txt'), 'utf8')).toBe('Preserve this upstream code.\n');
    expect(verifications()).toEqual([expect.objectContaining({ commit: checkpoint, passed: true, trigger: 'done-gate' }), expect.objectContaining({ commit: head, passed: true, trigger: 'publication' })]);
    expect(mergedReceipts()).toEqual([expect.objectContaining({ commit: head, upstream, files: [expect.objectContaining({ path: note })] })]);
  }, 60_000);

  test('publishes memory-only conflicts without running a deliberately failing project command', async () => {
    write(workspace.path, note, 'Local rule.\n'); commit(workspace.path); remote('Upstream rule.\n', () => write(other, 'upstream.txt', 'Unrelated upstream code.\n'));
    const result = await publish(); expect(result).toMatchObject({ status: 'published', verificationExemption: 'memory-only' }); expect(verifications()).toEqual([]);
    expect(git(origin, 'show', `main:${note}`)).toContain('Local rule.'); expect(git(origin, 'show', `main:${note}`)).toContain('Upstream rule.'); expect(readFileSync(join(workspace.path, 'value.txt'), 'utf8')).toBe('1\n');
  }, 30_000);

  test('does not exempt mixed code and memory changes from verification', async () => {
    write(workspace.path, note, 'Local rule.\n'); write(workspace.path, 'value.txt', '3\n'); const checkpoint = commit(workspace.path);
    expect(await publish()).toMatchObject({ status: 'blocked', attempts: 0, commit: checkpoint }); expect(verifications()).toEqual([expect.objectContaining({ passed: false, commit: checkpoint })]); expect(git(origin, 'rev-parse', 'main')).toBe(base);
  }, 30_000);

  test('memory attachments share the exemption, and a rename into memory cannot hide a code deletion', async () => {
    write(workspace.path, '.jevellan/memory/attachment.bin', Buffer.from([0, 1, 2])); commit(workspace.path);
    expect(await publish()).toMatchObject({ status: 'published', verificationExemption: 'memory-only' }); expect(verifications()).toEqual([]);
    git(workspace.path, 'mv', 'value.txt', '.jevellan/memory/value.md'); commit(workspace.path);
    expect(await publish()).toMatchObject({ status: 'blocked' }); expect(verifications()).toHaveLength(1);
  }, 30_000);

  test.each(['upstream', 'local'] as const)('preserves the surviving note when %s deleted it', async (deleted) => {
    if (deleted === 'local') rmSync(join(workspace.path, note)); else write(workspace.path, note, 'Local surviving rule.\n'); commit(workspace.path);
    remote(deleted === 'upstream' ? null : 'Upstream surviving rule.\n');
    expect(await publish()).toMatchObject({ status: 'published', verificationExemption: 'memory-only' });
    const merged = readFileSync(join(workspace.path, note), 'utf8'); expect(metadata(merged).status).toBe('unresolved'); expect(merged).toContain(deleted === 'upstream' ? 'Local surviving rule.' : 'Upstream surviving rule.'); expect(merged).toContain(deleted === 'upstream' ? 'deleted upstream' : 'This device deleted');
  }, 30_000);

  test('handles add/add and repeated conflicts with literal filenames without losing earlier versions', async () => {
    const name = ".jevellan/memory/O'Clock $(touch UNEXPECTED)/café.md";
    write(workspace.path, note, 'First local rule.\n'); write(workspace.path, name, 'New local note.\n'); commit(workspace.path);
    write(workspace.path, note, 'Second local rule.\n'); commit(workspace.path);
    remote('Upstream rule.\n', () => write(other, name, 'New upstream note.\n'));
    expect(await publish()).toMatchObject({ status: 'published', verificationExemption: 'memory-only' });
    const merged = readFileSync(join(workspace.path, note), 'utf8'); for (const text of ['First local rule.', 'Second local rule.', 'Upstream rule.']) expect(merged).toContain(text);
    const added = readFileSync(join(workspace.path, name), 'utf8'); expect(added).toContain('New local note.'); expect(added).toContain('New upstream note.'); expect(metadata(added).status).toBe('unresolved');
    expect(mergedReceipts()[0]?.files).toHaveLength(3); expect(existsSync(join(workspace.path, 'UNEXPECTED'))).toBe(false); expect(await workspace.clean()).toBe(true);
  }, 60_000);

  test.each([false, true])('mixed conflicts roll back every tentative memory merge before integration (separate commits: %s)', async (separate) => {
    write(workspace.path, note, 'Original local note.\n'); if (separate) commit(workspace.path);
    write(workspace.path, 'value.txt', '2\n'); const checkpoint = commit(workspace.path); const upstream = remote('Original upstream note.\n', () => write(other, 'value.txt', '3\n'));
    const integrate = vi.fn(async () => {
      expect(await workspace.head()).toBe(checkpoint); expect(await workspace.rebaseInProgress()).toBe(false); expect(await workspace.clean()).toBe(true);
      expect(readFileSync(join(workspace.path, note), 'utf8')).toBe('Original local note.\n'); return false;
    });
    const result = await publish(integrate); expect(result).toMatchObject({ status: 'blocked', savedRef: 'refs/jevellan/pre-integration/conversation/3' }); expect(integrate).toHaveBeenCalledOnce(); expect(mergedReceipts()).toEqual([]);
    expect(git(workspace.path, 'rev-parse', result.savedRef!)).toBe(checkpoint); expect(git(origin, 'rev-parse', 'main')).toBe(upstream); expect(git(origin, 'show', `main:${note}`)).toBe('Original upstream note.');
  }, 60_000);

  test.each(['binary', 'invalid-utf8', 'symlink'] as const)('leaves a %s conflict intact for integration', async (kind) => {
    if (kind === 'symlink') { rmSync(join(workspace.path, note)); symlinkSync('local-target', join(workspace.path, note)); }
    else write(workspace.path, note, kind === 'binary' ? Buffer.from([0, 1]) : Buffer.from([0xff, 1]));
    const checkpoint = commit(workspace.path);
    if (kind === 'symlink') { rmSync(join(other, note)); symlinkSync('upstream-target', join(other, note)); commit(other); git(other, 'push'); }
    else remote(kind === 'binary' ? Buffer.from([0, 2]) : Buffer.from([0xff, 2]));
    const integrate = vi.fn(async () => false); expect(await publish(integrate)).toMatchObject({ status: 'blocked' }); expect(integrate).toHaveBeenCalledOnce(); expect(mergedReceipts()).toEqual([]);
    expect(await workspace.head()).toBe(checkpoint); expect(await workspace.rebaseInProgress()).toBe(false); expect(await workspace.clean()).toBe(true);
  }, 30_000);

  test('code introduced by an integration stretch revokes the memory-only exemption', async () => {
    write(workspace.path, note, Buffer.from([0, 1])); const checkpoint = commit(workspace.path); const upstream = remote(Buffer.from([0, 2]));
    const integrate = vi.fn(async ({ run }: { run: IntegrationRunner }) => {
      expect(await run('start')).toMatchObject({ status: 'conflict' }); write(workspace.path, note, 'Integrated note.\n'); expect(await run('continue')).toMatchObject({ status: 'clean' });
      write(workspace.path, 'value.txt', '3\n'); commit(workspace.path, 'Integration changed code'); return true;
    });
    expect(await publish(integrate)).toMatchObject({ status: 'blocked' }); expect(verifications()).toEqual([expect.objectContaining({ trigger: 'publication', passed: false })]);
    expect(git(origin, 'rev-parse', 'main')).toBe(upstream); expect(git(workspace.path, 'rev-parse', 'refs/jevellan/pre-integration/conversation/3')).toBe(checkpoint);
  }, 60_000);

  test('an already-upstream memory patch can become empty without acquiring a code test requirement', async () => {
    write(workspace.path, note, 'The same rule.\n'); commit(workspace.path); const upstream = remote('The same rule.\n', () => write(other, 'upstream.txt', 'Keep unrelated upstream code.\n'));
    expect(await publish()).toMatchObject({ status: 'published', commit: upstream, verificationExemption: 'memory-only' }); expect(verifications()).toEqual([]);
  }, 30_000);

  test('a failed push after rebase retains the exact memory-only classification for a later publication retry', async () => {
    write(workspace.path, note, 'Local rule.\n'); commit(workspace.path); const upstream = remote('Upstream rule.\n', () => write(other, 'upstream-code.txt', 'Code changed by another work.\n'));
    const push = vi.spyOn(workspace, 'push').mockRejectedValueOnce(new Error('Simulated connection lost before push'));
    await expect(publish()).rejects.toThrow('connection lost'); push.mockRestore(); const rebased = await workspace.head();
    expect(git(origin, 'rev-parse', 'main')).toBe(upstream); expect(rebased).not.toBe(upstream);
    ledger = new ConversationLedger(homes, owner.conversationId); workspace = new GitWorkspace(project, 'device', workspace.ownership, owner);
    expect(await publish()).toMatchObject({ status: 'published', commit: rebased, verificationExemption: 'memory-only' }); expect(verifications()).toEqual([]); expect(git(origin, 'rev-parse', 'main')).toBe(rebased);
    write(workspace.path, 'value.txt', '3\n'); commit(workspace.path);
    expect(await publish()).toMatchObject({ status: 'blocked' }); expect(verifications()).toEqual([expect.objectContaining({ passed: false })]); expect(git(origin, 'rev-parse', 'main')).toBe(rebased);
  }, 60_000);

  test('a stale work generation during conflict handling aborts the rebase and never pushes', async () => {
    write(workspace.path, note, 'Local rule.\n'); const checkpoint = commit(workspace.path); const upstream = remote('Upstream rule.\n');
    await expect(publish(undefined, () => { if (existsSync(join(workspace.path, '.git/rebase-merge'))) throw new Error('Work generation changed'); })).rejects.toThrow('Work generation changed');
    expect(await workspace.head()).toBe(checkpoint); expect(await workspace.rebaseInProgress()).toBe(false); expect(await workspace.clean()).toBe(true); expect(git(origin, 'rev-parse', 'main')).toBe(upstream); expect(mergedReceipts()).toEqual([]); expect(await workspace.ownership.current(project)).toMatchObject({ held: true });
  }, 30_000);
});
