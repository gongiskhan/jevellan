import { z } from 'zod';
import { IdSchema } from './schemas.js';

export type PlanNode = { kind: 'markdown'; text: string } | { kind: 'muted'; text: string } | { kind: 'value'; text: string }
  | { kind: 'list'; ordered: boolean; items: PlanNode[] }
  | { kind: 'fields'; topLevel: boolean; title: PlanNode | null; sections: PlanSection[] };
export type PlanSection = { key: string; heading: string | null; headingLevel: 3 | 4 | null; value: PlanNode };
export const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('markdown'), text: z.string() }), z.strictObject({ kind: z.literal('muted'), text: z.string() }), z.strictObject({ kind: z.literal('value'), text: z.string() }),
  z.strictObject({ kind: z.literal('list'), ordered: z.boolean(), items: z.array(PlanNodeSchema) }),
  z.strictObject({ kind: z.literal('fields'), topLevel: z.boolean(), title: PlanNodeSchema.nullable(), sections: z.array(z.strictObject({ key: z.string(), heading: z.string().nullable(), headingLevel: z.union([z.literal(3), z.literal(4)]).nullable(), value: PlanNodeSchema })) }),
]));
export const PlanContentViewSchema = z.strictObject({ schema: z.literal('plan-content-view-v1'), root: PlanNodeSchema });
export type PlanContentView = z.infer<typeof PlanContentViewSchema>;
export const ConversationPlanReadRequestSchema = z.strictObject({ schema: z.literal('conversation-plan-read-request-v1'), pointer: z.string().min(1) });
export const ConversationPlanReadSchema = z.strictObject({ schema: z.literal('conversation-plan-read-v1'), projectId: IdSchema, conversationId: IdSchema, pointer: z.string().min(1), view: PlanContentViewSchema });
export type ConversationPlanRead = z.infer<typeof ConversationPlanReadSchema>;

const planFieldLabel = (key: string) => key.replace(/([a-z\d])([A-Z])/g, (_, left: string, right: string) => `${left} ${right.toLowerCase()}`).replace(/[_-]+/g, ' ').replace(/^./, letter => letter.toUpperCase());
const planFieldPriority = ['title', 'goal', 'summary', 'overview', 'scope', 'steps', 'phases', 'architecture', 'affectedFiles', 'checks', 'tests', 'risks', 'decisionsNeeded', 'questions'];
function planFieldEntries(value: object) {
  return Object.entries(value).sort(([a], [b]) => (planFieldPriority.includes(a) ? planFieldPriority.indexOf(a) : planFieldPriority.length) - (planFieldPriority.includes(b) ? planFieldPriority.indexOf(b) : planFieldPriority.length));
}
export function decodePlan(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  const text = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  if (/^[{[]/.test(text)) {
    try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object') return value; } catch { /* Existing Markdown remains readable as written. */ }
  }
  return content;
}

/** Explicit plan-purpose projection; generic ledger reads retain their ordinary response. */
export function planContentView(content: unknown): PlanContentView {
  const render = (value: unknown, depth = 0, ordered = false): PlanNode => {
    if (typeof value === 'string') return { kind: 'markdown', text: value };
    if (value === null || value === undefined) return { kind: 'muted', text: 'Not specified' };
    if (typeof value !== 'object') return { kind: 'value', text: typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value) };
    if (Array.isArray(value)) return value.length ? { kind: 'list', ordered, items: value.map(item => render(item, depth + 1)) } : { kind: 'muted', text: 'None' };
    const fields = planFieldEntries(value);
    const title = depth > 0 ? fields.find(([key, item]) => ['title', 'name'].includes(key) && typeof item === 'string') : undefined;
    const sections: PlanSection[] = fields.filter(([key]) => key !== title?.[0]).map(([key, item]) => ({ key,
      heading: depth === 0 || !['details', 'description'].includes(key) ? planFieldLabel(key) : null,
      headingLevel: depth === 0 ? 3 : !['details', 'description'].includes(key) ? 4 : null,
      value: render(item, depth + 1, ['steps', 'phases', 'tasks'].includes(key)) }));
    return { kind: 'fields', topLevel: depth === 0, title: title ? render(title[1], depth + 1) : null, sections };
  };
  return PlanContentViewSchema.parse({ schema: 'plan-content-view-v1', root: render(decodePlan(content)) });
}
