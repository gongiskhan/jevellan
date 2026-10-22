import { z } from 'zod';

const timestampSource = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z`;
const timestamp = new RegExp(`^${timestampSource}$`, 'u');
const DisplayPartSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), value: z.string() }),
  z.strictObject({ kind: z.literal('time'), value: z.string() }),
]);
export const ProjectThreadDisplayTextSchema = z.strictObject({
  schema: z.literal('project-thread-display-text-v1'), text: z.string(), parts: z.array(DisplayPartSchema),
}).refine(value => value.parts.map(part => part.value).join('') === value.text, 'Display parts must preserve their source text.');
export type ProjectThreadDisplayText = z.infer<typeof ProjectThreadDisplayTextSchema>;

/** Preserve the legacy ISO-shaped tokens; the browser still owns locale and invalid-date formatting. */
export function threadDisplayText(rawText: unknown): ProjectThreadDisplayText {
  const text = z.string().parse(rawText), parts: ProjectThreadDisplayText['parts'] = [];
  let end = 0;
  for (const match of text.matchAll(new RegExp(timestampSource, 'gu'))) {
    if (match.index > end) parts.push({ kind: 'text', value: text.slice(end, match.index) });
    parts.push({ kind: 'time', value: match[0] });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ kind: 'text', value: text.slice(end) });
  return ProjectThreadDisplayTextSchema.parse({ schema: 'project-thread-display-text-v1', text, parts });
}

/** Old views use the same projector. Later redaction may turn a time token into literal text. */
export function threadDisplayValue(text: string, rawDisplay: unknown, format: (at: string) => string): string {
  const supplied = ProjectThreadDisplayTextSchema.safeParse(rawDisplay);
  const display = supplied.success && supplied.data.text === text ? supplied.data : threadDisplayText(text);
  return display.parts.map(part => part.kind === 'time' && timestamp.test(part.value) ? format(part.value) : part.value).join('');
}
