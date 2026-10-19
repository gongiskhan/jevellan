import { z } from 'zod';

export const EnvironmentReferenceSchema = z.strictObject({ schema: z.literal('environment-reference-v1'), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/u), kind: z.enum(['secret', 'variable']), source: z.string().min(1).max(500), line: z.number().int().positive() });
export type EnvironmentReference = z.infer<typeof EnvironmentReferenceSchema>;
/** References only: values and defaults never enter the inventory parser's output. */
export function workflowEnvironmentReferences(source: string, text: string): EnvironmentReference[] {
  const rows: EnvironmentReference[] = [];
  for (const [index, line] of text.split('\n').entries()) for (const match of line.matchAll(/\b(secrets|vars)(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/gu))
    rows.push(EnvironmentReferenceSchema.parse({ schema: 'environment-reference-v1', name: match[2] ?? match[3], kind: match[1] === 'secrets' ? 'secret' : 'variable', source, line: index + 1 }));
  return rows;
}
