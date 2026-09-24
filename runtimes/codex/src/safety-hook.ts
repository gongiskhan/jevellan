import { z } from 'zod';
import { ActionSchema } from '@jevellan/core';
import { safetyDenial, SAFETY_REASON } from '@jevellan/runtime-contract';

const Context = z.strictObject({ cwd: z.string(), action: ActionSchema, daemonPid: z.number().int().positive() });
const Event = z.object({ hook_event_name: z.literal('PreToolUse'), tool_name: z.string(), tool_input: z.unknown() });
try {
  const context = Context.parse(JSON.parse(process.argv[2] ?? 'null'));
  let input = '';
  for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 2 * 1024 * 1024) throw new Error('Too large.'); }
  const event = Event.parse(JSON.parse(input));
  let reason: string | null = null;
  if (event.tool_name === 'Bash') {
    const command = z.object({ command: z.string() }).safeParse(event.tool_input);
    reason = command.success ? safetyDenial(command.data.command, context) : SAFETY_REASON;
  }
  process.stdout.write(`${JSON.stringify(reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {})}\n`);
} catch {
  process.stderr.write(`${SAFETY_REASON}\n`);
  process.exitCode = 2;
}
