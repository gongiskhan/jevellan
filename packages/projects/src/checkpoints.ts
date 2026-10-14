import { createHash } from 'node:crypto';
import { SessionCheckpointedSchema, type SessionTurnCache, type SessionCheckpointSettings } from '@jevellan/core';
import type { StretchRun } from '@jevellan/runtime-contract';
import type { ProjectLedger } from './ledger.js';

export type ColdCheckpoint = { idleSeconds: number; previousContextTokens: number; previousSessionId: string };
export const coordinatorRestart = 'This is a fresh coordinator session: the previous one was idle long enough for its cache to expire. Continue from the notebook, the open state and the journal index below.';
export const threadRestart = (path: string): string => `You are continuing this task in a fresh session: the previous one was idle long enough for its cache to expire. Everything you reported and every message you received is in ${path}; the most recent part is below. Check git log and git diff in your worktree for the work already done, and continue from there.`;
export const sessionHash = (id: string): string => createHash('sha256').update(id).digest('hex');
export function coldCheckpoint(settings: SessionCheckpointSettings | undefined, previous: SessionTurnCache | undefined, sessionId: string | undefined,
  windowMinutes: number, now: number, tokens?: number | null): ColdCheckpoint | undefined {
  if (!settings?.enabled || !sessionId || !previous || !['thread', 'coordinator'].includes(previous.owner.kind)) return undefined;
  const idleSeconds = Math.max(0, (now - Date.parse(previous.activityAt)) / 1000), context = tokens ?? previous.contextTokensAfter;
  if (idleSeconds <= windowMinutes * 60 || context === null || context < settings.checkpointMinTokens) return undefined;
  return { idleSeconds, previousContextTokens: context, previousSessionId: sessionId };
}
/** Completion uses the existing usage stream, including unknown write counts. No additional provider call. */
export function checkpointRun(run: StretchRun, ledger: ProjectLedger, checkpoint: ColdCheckpoint, o: {
  kind: 'coordinator' | 'thread'; id: string; turn: number; digestChars: number; now(): number;
  archive(previousSessionId: string, newSessionId: string): void;
}): StretchRun {
  let archived = false, writes = 0, known = false, complete = true;
  const archive = () => { const id = run.native.sessionId; if (id && id !== checkpoint.previousSessionId && !archived) { o.archive(checkpoint.previousSessionId, id); archived = true; } };
  return { get native() { return run.native; }, done: run.done,
    events: (async function* () {
      try { for await (const event of run.events) { archive(); if (event.type === 'usage') { known = true; complete &&= event.cacheWriteTokens !== undefined; writes += event.cacheWriteTokens ?? 0; } yield event; } }
      finally { archive(); const id = run.native.sessionId;
        if (archived && id) ledger.append({ type: 'session-checkpointed', turn: o.turn, data: SessionCheckpointedSchema.parse({ schema: 'session-checkpointed-v1',
          owner: { kind: o.kind, id: o.id }, previousSessionId: sessionHash(checkpoint.previousSessionId), newSessionId: sessionHash(id), reason: 'cold',
          idleSeconds: checkpoint.idleSeconds, previousContextTokens: checkpoint.previousContextTokens, digestChars: o.digestChars,
          firstTurnCacheWriteTokens: known && complete ? writes : null, at: new Date(o.now()).toISOString() }) });
      }
    })(), interrupt: reason => run.interrupt(reason), continue: (message, timeout) => run.continue(message, timeout), terminate: () => run.terminate() };
}
