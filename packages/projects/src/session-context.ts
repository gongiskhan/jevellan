import { existsSync } from 'node:fs';
import { ProjectSessionContextSchema, SessionCompactedSchema, type Homes, type ProjectSessionContext } from '@jevellan/core';
import type { RuntimeEvent, TurnInput } from '@jevellan/runtime-contract';
import type { ProjectLedger } from './ledger.js';

/** Test thresholds are available only in an explicitly test-only, uninstalled daemon. */
export function compactPercent(configured: number, homes: Homes, environment: NodeJS.ProcessEnv = process.env): number {
  const override = environment.JEVELLAN_TEST_COMPACT_PERCENT;
  if (override === undefined) return configured;
  if (environment.NODE_ENV !== 'test' || existsSync(homes.at('install.json'))) {
    throw new Error('JEVELLAN_TEST_COMPACT_PERCENT is refused in production installations.');
  }
  const percent = Number(override);
  if (!/^\d+$/u.test(override) || !Number.isInteger(percent) || percent < 15 || percent > 49) {
    throw new Error('JEVELLAN_TEST_COMPACT_PERCENT must be an integer from 15 to 49.');
  }
  return percent;
}
/** A short sandbox night uses the same explicit uninstalled-test fence as compaction. */
export function nightlyFixMinutes(homes: Homes, environment: NodeJS.ProcessEnv = process.env): number {
  const override = environment.JEVELLAN_TEST_NIGHTLY_FIX_MINUTES;
  if (override === undefined) return 150;
  if (environment.NODE_ENV !== 'test' || existsSync(homes.at('install.json'))) throw new Error('JEVELLAN_TEST_NIGHTLY_FIX_MINUTES is refused in production installations.');
  if (override !== '30') throw new Error('JEVELLAN_TEST_NIGHTLY_FIX_MINUTES must be 30.');
  return 30;
}

export function sessionContext(previous: ProjectSessionContext | undefined, percent: number, notice?: string): ProjectSessionContext {
  const context = ProjectSessionContextSchema.parse(previous ?? { schema: 'project-session-context-v1', tokens: null, contextWindow: null,
    thresholdPercent: percent, compactions: [], lastCompactionAt: null, needsFreshContext: false });
  delete context.notice;
  return { ...context, thresholdPercent: percent, ...(notice ? { notice } : {}) };
}

/** The native session stays unchanged; this receipt asks the next turn to refresh its context. */
export function contextEvent(previous: ProjectSessionContext, event: RuntimeEvent, owner: TurnInput['owner'], runtime: string,
  model: string, ledger: ProjectLedger, turn: number, at = new Date().toISOString()): ProjectSessionContext {
  if (event.type === 'context') return { ...previous, tokens: event.tokens, contextWindow: event.contextWindow ?? previous.contextWindow };
  if (event.type !== 'compacted') return previous;
  const contextWindow = event.contextWindow ?? previous.contextWindow;
  ledger.append({ type: 'session-compacted', turn, data: SessionCompactedSchema.parse({ schema: 'session-compacted-v1', owner: { kind: owner.kind, id: owner.id },
    runtime, model, at, beforeTokens: event.beforeTokens, afterTokens: event.afterTokens, contextWindow, thresholdPercent: previous.thresholdPercent }) });
  return { ...previous, tokens: event.afterTokens, contextWindow, needsFreshContext: true, lastCompactionAt: at,
    compactions: [...previous.compactions, at].slice(-500) };
}
