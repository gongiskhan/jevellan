import type { z } from 'zod';

/** A validation refusal that names the first field and what is wrong with it, so the caller (often an agent) can correct its input. */
export function zodFieldMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Check the submitted fields.';
  const field = issue.path.map(String).join('.');
  return `Check the submitted fields: ${field ? `${field}: ` : ''}${issue.message.trim().replace(/\.+$/, '')}.`.slice(0, 400);
}
