import { createHash } from 'node:crypto';
import { CheckpointAdoptionSchema, CheckpointBlockSchema, stableJson, type GitWorkspace } from '@jevellan/core';
import type { ConversationWork } from './work.js';

export function checkpointAdoptions(work: ConversationWork) {
  const records = new Map<string, ReturnType<typeof CheckpointAdoptionSchema.parse>>();
  for (const event of work.ledger.events().filter((entry) => entry.type === 'git')) {
    const value = CheckpointAdoptionSchema.safeParse(work.ledger.data(event));
    if (value.success) records.set(value.data.request.clientRequestId, value.data);
  }
  return [...records.values()];
}
export function checkpointBlocks(work: ConversationWork) {
  const resolved = new Set(checkpointAdoptions(work).filter((record) => record.status === 'completed').flatMap((record) => record.blocks));
  return work.ledger.events().filter((event) => event.type === 'git' && !resolved.has(event.id)).flatMap((event) => {
    const value = CheckpointBlockSchema.safeParse(work.ledger.data(event));
    return value.success ? [{ ...value.data, eventId: event.id }] : [];
  });
}
/** A review covers content, Git boundaries, the owning work, and the conversation generation. */
export async function reviewCheckpoint(work: ConversationWork, workspace: GitWorkspace, stretch: number) {
  const view = work.load(); const target = view.conversation.work ?? view.closedWorks.at(-1);
  const blocks = checkpointBlocks(work).filter((entry) => entry.workId === workspace.owner.workId);
  if (!blocks.length || !blocks.some((entry) => entry.stretch === stretch)) throw new Error('This step has no blocked changes to accept.');
  if (!target || target.id !== workspace.owner.workId || target.closedAs === 'done') throw new Error('Only the current work or its kept changes can accept these files.');
  if (view.stretches.some((step) => step.status === 'running')) throw new Error('Wait for the running step to finish before reviewing these files.');
  for (const block of workspace.project.branchPolicy === 'main' ? blocks : []) {
    if (!block.before) throw new Error('This earlier block has no recorded Git boundary. Reconcile its history before continuing.');
    await workspace.checkpointBoundary(block.before);
  }
  const before = await workspace.snapshot();
  if (workspace.project.branchPolicy === 'main' && !target.baseCommit && (blocks.some((block) => !block.before!.clean) || before.head !== before.remoteHead)) throw new Error('This work did not start from clean, published main. Reconcile its starting checkout before continuing.');
  const worktreeDigest = await workspace.workingTreeDigest(); const diff = await workspace.uncommittedDiff();
  if (stableJson(before) !== stableJson(await workspace.snapshot()) || worktreeDigest !== await workspace.workingTreeDigest()) throw new Error('The checkout changed while loading this review. Open Changes again.');
  const fingerprint = createHash('sha256').update(stableJson({ path: workspace.path, policy: workspace.project.branchPolicy, workId: target.id, stretch, generation: view.conversation.generation, blocks: blocks.map((entry) => entry.eventId), before, worktreeDigest })).digest('hex');
  return { before, worktreeDigest, diff, fingerprint, blocks: blocks.map((entry) => entry.eventId) };
}
