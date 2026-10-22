import { z } from 'zod';

export const NATIVE_SESSION_HISTORY_MS = 5 * 86_400_000;
export const CURSOR_FOLLOWUP_MS = 7 * 60 * 60_000;
export const NativeRuntimePresentationSchema = z.strictObject({ schema: z.literal('native-runtime-presentation-v1'),
  runtime: z.string(), label: z.string(), canCompose: z.boolean(), readOnlyLabel: z.string().nullable() });
export function nativeRuntimePresentation(runtime?: string) {
  const canCompose = runtime === undefined || runtime === 'cursor';
  return NativeRuntimePresentationSchema.parse({ schema: 'native-runtime-presentation-v1', runtime: runtime ?? 'cursor',
    label: runtime === 'claude' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : 'Cursor', canCompose, readOnlyLabel: canCompose ? null : 'Read only' });
}
export const NativeConversationPolicySchema = z.strictObject({ schema: z.literal('native-conversation-policy-v1'),
  historyDays: z.number().int().positive(), historyMs: z.number().int().positive(), followupHours: z.number().int().positive(),
  followupMs: z.number().int().positive(), hookStopTimeoutSeconds: z.number().int().positive(),
  description: z.string(), hookDescription: z.string(), runtimes: z.array(NativeRuntimePresentationSchema),
}).refine(value => value.historyMs === value.historyDays * 86_400_000 && value.followupMs === value.followupHours * 3_600_000
  && value.hookStopTimeoutSeconds === value.followupMs / 1000 + 60, 'Native policy durations must agree.');
export type NativeConversationPolicy = z.infer<typeof NativeConversationPolicySchema>;

/** The same limits drive discovery, hook delivery and the UI's explanation. Each reader gets its own document. */
export function nativeConversationPolicy(): NativeConversationPolicy {
  return NativeConversationPolicySchema.parse({ schema: 'native-conversation-policy-v1',
    historyDays: NATIVE_SESSION_HISTORY_MS / 86_400_000, historyMs: NATIVE_SESSION_HISTORY_MS,
    followupHours: CURSOR_FOLLOWUP_MS / 3_600_000, followupMs: CURSOR_FOLLOWUP_MS, hookStopTimeoutSeconds: CURSOR_FOLLOWUP_MS / 1000 + 60,
    description: 'Cursor, Claude Code and Codex sessions from the last five days appear alongside your conversations, with formatted history and activity indicators. Claude Code and Codex are read-only.',
    hookDescription: 'This configuration connects existing desktop conversations. Steering arrives after a tool call; queued messages become new turns when Cursor finishes. A completed session stays available for follow-up messages for up to seven hours. Existing hooks must be preserved when enabling this connection.',
    runtimes: ['cursor', 'claude', 'codex'].map(nativeRuntimePresentation) });
}
