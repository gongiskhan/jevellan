import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CheckoutOwnership, GitWorkspace, Homes, MemoryNoteSchema, ProjectSchema, SecretRedactor, StretchSchema, type MemoryNote } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { ConversationLedger, ConversationWork, MemoryQueue, queueMemory, recallBySearchRank, type ProjectMemory, type QueuedMemory } from '../packages/conversations/dist/index.js';

let root: string; let homes: Homes; let work: ConversationWork; let hub: HubDatabase; let queue: MemoryQueue; let workspace: GitWorkspace; let memory: QueuedMemory;
const notes = new Map<string, MemoryNote>(); const signal = () => new AbortController().signal;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-memory-queue-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user'));
  hub = new HubDatabase(homes, 'hub'); const path = join(root, 'project'); mkdirSync(path); git(path, 'init', '-b', 'main'); git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(path, 'fixture.txt'), 'Seed'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Seed');
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Fixture', paths: { device: path }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  work = new ConversationWork(new ConversationLedger(homes, 'conversation', { redactor: new SecretRedactor() })); work.create({ title: 'Fixture', projectId: project.id, ownerDeviceId: 'device' }); work.message('Review the project.', 'first');
  const view = work.load(); workspace = new GitWorkspace(project, 'device', new CheckoutOwnership(hub, homes, 'device'), { conversationId: work.ledger.id, conversationTitle: 'Fixture', workId: view.conversation.work!.id });
  work.start(StretchSchema.parse({ schema: 'stretch-v2', n: 1, workId: view.conversation.work!.id, action: 'review', modelId: 'model', runtime: 'fake', model: 'fixture', effortRequested: 'high', effortEffective: 'high', accountId: 'account', deviceId: 'device', decisionId: 'decision', startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }), view.conversation.generation);
  queue = new MemoryQueue(work); notes.clear();
  memory = {
    assertOwnership: async () => { await workspace.ownership.assert(project, workspace.owner); },
    findTitle: vi.fn(async (title) => notes.get(title) ?? null),
    write: vi.fn(async ({ title, content }) => {
      const note = MemoryNoteSchema.parse({ schema: 'memory-note-v1', title, content, permalink: `${title}.md` });
      if (notes.has(title)) throw new Error('Existing note must not be overwritten.');
      mkdirSync(join(path, project.memory.dir), { recursive: true }); writeFileSync(join(path, project.memory.dir, note.permalink), content); notes.set(title, note); return note;
    }),
  };
});
afterEach(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
function end(findings: Array<{ claim: string; pointer: string }> = []) {
  work.ledger.acceptHandoff({ schema: 'handoff-v2', stretch: 1, action: 'review', status: 'done', summary: 'Review complete.', evidence: [], findings, blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [] });
  queue.captureHandoff(1);
  work.finish(1, { status: 'completed', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }, false);
}
function propose() { return queueMemory(work, 1, { title: 'Vitest convention', content: 'Tests use globals.', reason: 'Future tests need this.' }); }
async function acquire() { await workspace.ownership.acquire(workspace.project, workspace.owner); }
async function checkpoint(summary: string) { return (await workspace.checkpoint('memory', summary, await workspace.snapshot())).head; }

test('read-only proposals change nothing until a settled boundary with ownership, then get a memory checkpoint', async () => {
  const proposal = propose(); expect(propose()).toEqual(proposal); expect(await workspace.clean()).toBe(true);
  await expect(queue.apply(workspace.owner.workId, memory, checkpoint, signal())).rejects.toThrow('settled boundary');
  end(); await workspace.ownership.acquire(workspace.project, { conversationId: 'other', conversationTitle: 'Other', workId: 'other' });
  await expect(queue.apply(workspace.owner.workId, memory, checkpoint, signal())).rejects.toThrow('does not own'); expect(memory.write).not.toHaveBeenCalled();
  await workspace.ownership.release(workspace.project, { conversationId: 'other', conversationTitle: 'Other', workId: 'other' }, { processesGone: true, commits: 'unchanged' }); await acquire();
  const applied = await queue.apply(workspace.owner.workId, memory, checkpoint, signal());
  expect(applied).toMatchObject({ commit: await workspace.head(), notes: [{ proposalId: proposal.id, outcome: 'written' }] });
  expect(git(workspace.path, 'log', '-1', '--format=%s')).toBe('memory: Capture 1 project note'); expect(await workspace.clean()).toBe(true);
  expect(queue.pending(workspace.owner.workId)).toEqual([]); expect(await queue.apply(workspace.owner.workId, memory, checkpoint, signal())).toBeNull();
});

test('handoff capture is repeatable, links its conversation and preserves notes that already have the title', async () => {
  end([{ claim: 'memory: Existing rule', pointer: 'src/existing.ts:2' }, { claim: 'memory: New rule', pointer: 'src/new.ts:3' }, { claim: 'constraint: Keep API', pointer: 'src/api.ts:1' }]);
  queue.captureHandoff(1); expect(queue.pending(workspace.owner.workId)).toHaveLength(2);
  notes.set('Existing rule', MemoryNoteSchema.parse({ schema: 'memory-note-v1', title: 'Existing rule', permalink: 'existing.md', content: 'Original note.' }));
  await acquire(); const applied = await queue.apply(workspace.owner.workId, memory, checkpoint, signal());
  expect(applied?.notes.map((note) => note.outcome)).toEqual(['existing', 'written']); expect(memory.write).toHaveBeenCalledOnce();
  expect(notes.get('Existing rule')?.content).toBe('Original note.'); expect(notes.get('New rule')?.content).toContain('[Conversation](/conversations/conversation)');
});

test('recovery after a written note but failed checkpoint neither duplicates nor overwrites the note', async () => {
  propose(); end(); await acquire();
  await expect(queue.apply(workspace.owner.workId, memory, async () => { throw new Error('Simulated checkpoint interruption'); }, signal())).rejects.toThrow('checkpoint interruption');
  expect(queue.pending(workspace.owner.workId)).toHaveLength(1); expect(await workspace.clean()).toBe(false);
  queue = new MemoryQueue(new ConversationWork(new ConversationLedger(homes, work.ledger.id)));
  expect((await queue.apply(workspace.owner.workId, memory, checkpoint, signal()))?.notes[0]?.outcome).toBe('existing');
  expect(memory.write).toHaveBeenCalledOnce(); expect(await workspace.clean()).toBe(true); expect(readdirSync(join(workspace.path, '.jevellan/memory'))).toHaveLength(1);
});

test('a lost application receipt is recovered from existing notes and does not make a duplicate commit', async () => {
  propose(); end(); await acquire(); const append = work.ledger.append.bind(work.ledger); let lose = true;
  vi.spyOn(work.ledger, 'append').mockImplementation((input) => { if (input.type === 'git' && lose) { lose = false; throw new Error('Simulated lost receipt'); } return append(input); });
  await expect(queue.apply(workspace.owner.workId, memory, checkpoint, signal())).rejects.toThrow('lost receipt'); const committed = await workspace.head();
  await queue.apply(workspace.owner.workId, memory, checkpoint, signal()); expect(await workspace.head()).toBe(committed); expect(memory.write).toHaveBeenCalledOnce();
  expect(queue.pending(workspace.owner.workId)).toEqual([]);
});

test('concurrent boundary requests apply a queue once, and abort leaves unapplied proposals durable', async () => {
  propose(); end(); await acquire(); const controller = new AbortController(); controller.abort();
  await expect(queue.apply(workspace.owner.workId, memory, checkpoint, controller.signal)).rejects.toThrow(); expect(queue.pending(workspace.owner.workId)).toHaveLength(1);
  const results = await Promise.all([queue.apply(workspace.owner.workId, memory, checkpoint, signal()), queue.apply(workspace.owner.workId, memory, checkpoint, signal())]);
  expect(results[0]?.notes).toHaveLength(1); expect(results[1]).toBeNull(); expect(memory.write).toHaveBeenCalledOnce();
});

test('manual recall records the top twelve candidates and top five notes with short unresolved excerpts', async () => {
  const notes = Array.from({ length: 15 }, (_, n) => MemoryNoteSchema.parse({ schema: 'memory-note-v1', title: `Note ${n}`, permalink: `${n}.md`, content: 'x'.repeat(400), unresolved: n === 0 }));
  const search = vi.fn<ProjectMemory['search']>(async () => ({ schema: 'memory-search-v1' as const, notes }));
  const result = await recallBySearchRank({ search }, { request: 'Original objective', latestMessage: 'Latest detail', action: 'test' }, signal());
  expect(search.mock.calls[0]?.[0]).toBe('original OR objective OR latest OR detail OR test');
  expect(result.candidates).toHaveLength(12); expect(result.chosen).toEqual(['0.md', '1.md', '2.md', '3.md', '4.md']); expect(result.excerpts[0]).toMatchObject({ unresolved: true, excerpt: 'x'.repeat(300) });
});
