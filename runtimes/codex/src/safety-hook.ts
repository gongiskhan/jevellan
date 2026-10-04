import { z } from 'zod';
import { ActionSchema } from '@jevellan/core';
import { safetyDenial, safetyReason, SAFETY_REASON, type SafetyContext } from '@jevellan/runtime-contract';

// Stretches send their action; turns send their profile and no action.
const Context = z.strictObject({ cwd: z.string(), daemonPid: z.number().int().positive(), action: ActionSchema.optional(), profile: z.enum(['stretch', 'coordinator', 'thread']).optional() });
const Event = z.object({ hook_event_name: z.literal('PreToolUse'), tool_name: z.string(), tool_input: z.unknown() });
let context: SafetyContext | undefined;
try {
  context = Context.parse(JSON.parse(process.argv[2] ?? 'null'));
  let input = '';
  for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 2 * 1024 * 1024) throw new Error('Too large.'); }
  const event = Event.parse(JSON.parse(input));
  let reason: string | null = null;
  if (event.tool_name === 'Bash') {
    const command = z.object({ command: z.string() }).safeParse(event.tool_input);
    reason = command.success ? safetyDenial(command.data.command, context) : safetyReason(context);
  }
  process.stdout.write(`${JSON.stringify(reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {})}\n`);
} catch {
  process.stderr.write(`${context ? safetyReason(context) : SAFETY_REASON}\n`);
  process.exitCode = 2;
}
