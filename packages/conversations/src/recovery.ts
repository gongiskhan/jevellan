import { HandoffSchema, RestartRecoveryErrorSchema, UsageSchema, processStartIdentity, terminateGroup, type Stretch } from '@jevellan/core';
import { RuntimeEventSchema } from '@jevellan/runtime-contract';
import { ConversationWork } from './work.js';

export const RESTART_NOTICE = 'Jevellan restarted while this was running. Send a message to continue.';

/** Run only after acquiring exclusive daemon-home ownership. Never launches or releases a checkout. */
export async function recoverRunningWork(work: ConversationWork): Promise<{ recovered: number[]; blocked: Array<{ stretch: number; reason: string }> }> {
  const view = work.recover(); const recovered: number[] = []; const blocked: Array<{ stretch: number; reason: string }> = [];
  for (const stretch of view.stretches.filter((entry) => entry.status === 'running')) {
    try {
      if (!stretch.native) throw new Error('This step has no recorded process identity. Its cleanup must be confirmed before it can continue.');
      if (!stretch.native.startIdentity && processStartIdentity(stretch.native.pid)) throw new Error('This step has no process start identity. Refusing to stop a potentially reused process.');
      const { pid, pgid, startIdentity } = stretch.native;
      await terminateGroup({ pid, pgid, ...(startIdentity ? { startIdentity } : {}) });
    } catch (error) {
      const reason = work.ledger.redact(error instanceof Error ? error.message : 'Process cleanup could not be confirmed.');
      work.ledger.append({ type: 'error', stretch: stretch.n, data: RestartRecoveryErrorSchema.parse({ schema: 'restart-recovery-error-v1', message: reason }) });
      blocked.push({ stretch: stretch.n, reason }); continue;
    }
    const events = work.ledger.events().filter((event) => event.stretch === stretch.n);
    if (!work.ledger.handoffs().some((handoff) => handoff.stretch === stretch.n)) {
      const last = events.findLast((event) => event.type === 'tool-start');
      work.ledger.acceptHandoff(HandoffSchema.parse({ schema: 'handoff-v2', stretch: stretch.n, action: stretch.action, status: 'partial',
        summary: 'Jevellan restarted before this step settled. Its recorded output is preserved; completion has not been verified.',
        evidence: last ? [{ kind: 'command', ref: `ledger/${last.id}`, note: 'Last recorded tool before the restart.' }] : [],
        findings: [], blockers: ['Interrupted by a daemon restart.'], failedApproaches: [], proposedNext: null, changedFiles: [] }));
    }
    const usage = events.filter((event) => event.type === 'usage').map((event) => RuntimeEventSchema.parse(work.ledger.data(event)))
      .filter((event) => event.type === 'usage');
    const knownCost = usage.length > 0 && usage.every((event) => event.costUsd !== undefined);
    const total: Stretch['usage'] = UsageSchema.parse({ inputTokens: usage.reduce((sum, event) => sum + event.inputTokens, 0), outputTokens: usage.reduce((sum, event) => sum + event.outputTokens, 0),
      cacheReadTokens: usage.reduce((sum, event) => sum + (event.cacheReadTokens ?? 0), 0), cacheWriteTokens: usage.reduce((sum, event) => sum + (event.cacheWriteTokens ?? 0), 0),
      ...(knownCost ? { costUsd: usage.reduce((sum, event) => sum + event.costUsd!, 0), costSource: usage.some((event) => event.costSource === 'estimated') ? 'estimated' : 'reported' } : { costSource: 'unknown' }) });
    work.finish(stretch.n, { status: 'interrupted', usage: total }, false, false, { schema: 'work-control-v1', kind: 'pause', state: 'waiting-for-you', reason: RESTART_NOTICE });
    recovered.push(stretch.n);
  }
  return { recovered, blocked };
}
