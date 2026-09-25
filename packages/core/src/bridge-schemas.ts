import { z } from 'zod';
import { FindingSchema, HandoffSchema, IdSchema, ResultSchema } from './schemas.js';

const text = z.string().min(1);
export const MemoryNoteSchema = z.strictObject({ schema: z.literal('memory-note-v1'), title: text, permalink: text, content: z.string(), updatedAt: z.iso.datetime().optional(), unresolved: z.boolean().default(false) });
export type MemoryNote = z.infer<typeof MemoryNoteSchema>;
export const MemorySearchSchema = z.strictObject({ schema: z.literal('memory-search-v1'), notes: z.array(MemoryNoteSchema).max(20) });
export const MemoryWriteSchema = z.strictObject({ title: text.max(300), content: text.max(256_000) });
export const MemoryEditSchema = z.strictObject({ permalink: text, operation: z.enum(['append', 'prepend', 'replace']), content: text.max(256_000), find: text.optional() }).refine((value) => value.operation !== 'replace' || !!value.find, 'A replacement needs the exact text to replace.');
export const MemoryProposalInputSchema = MemoryWriteSchema.extend({ reason: text.max(2000) });
export const MemoryProposalSchema = MemoryProposalInputSchema.extend({ schema: z.literal('memory-proposal-v1'), id: IdSchema, conversationId: IdSchema, workId: IdSchema, projectId: IdSchema, stretch: z.number().int().positive(), source: z.enum(['agent', 'handoff', 'hook']).default('agent') });
export const MemoryAppliedSchema = z.strictObject({
  schema: z.literal('memory-applied-v1'), workId: IdSchema, projectId: IdSchema, commit: z.string().nullable(),
  notes: z.array(z.strictObject({ proposalId: IdSchema, title: text, permalink: text, outcome: z.enum(['written', 'existing']) })).min(1),
});
export type MemoryApplied = z.infer<typeof MemoryAppliedSchema>;
export const HandoffToolSchema = HandoffSchema.extend({ result: z.union([ResultSchema, ResultSchema.omit({ ref: true }).extend({ content: z.json() })]).optional() });
export const IntegrationCommandSchema = z.strictObject({ schema: z.literal('integration-command-v1'), command: z.enum(['start', 'continue', 'skip']) });
export const IntegrationStatusSchema = z.strictObject({ schema: z.literal('integration-status-v1'), status: z.enum(['clean', 'conflict']), conflicts: z.array(text) });
export type IntegrationRunner = (command: z.infer<typeof IntegrationCommandSchema>['command']) => Promise<z.infer<typeof IntegrationStatusSchema>>;
export const BridgeToolSchemas = {
  jevellan_finding: FindingSchema,
  jevellan_handoff: HandoffToolSchema,
  jevellan_conversation_search: z.strictObject({ query: text }),
  jevellan_conversation_read: z.strictObject({ pointer: text }),
  jevellan_integrate: IntegrationCommandSchema,
  memory_search: z.strictObject({ query: text }),
  memory_read: z.strictObject({ permalink: text }),
  memory_write: MemoryWriteSchema,
  memory_edit: MemoryEditSchema,
  memory_propose: MemoryProposalInputSchema,
};
export type BridgeTool = keyof typeof BridgeToolSchemas;
export const BridgeToolNameSchema = z.enum(Object.keys(BridgeToolSchemas) as [BridgeTool, ...BridgeTool[]]);
export const MemoryHookEventSchema = z.enum(['PreCompact', 'Stop', 'SessionEnd']);
export const BridgeRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('bridge-request-v1'), operation: z.literal('list') }),
  z.strictObject({ schema: z.literal('bridge-request-v1'), operation: z.literal('call'), name: BridgeToolNameSchema, arguments: z.json() }),
  z.strictObject({ schema: z.literal('bridge-request-v1'), operation: z.literal('memory-capture'), event: MemoryHookEventSchema }),
]);
export const BridgeResultSchema = z.strictObject({ schema: z.literal('bridge-result-v1'), result: z.json() });
export const BridgeToolsSchema = z.strictObject({ schema: z.literal('bridge-tools-v1'), tools: z.array(z.strictObject({ name: BridgeToolNameSchema, description: text, inputSchema: z.object({ type: z.literal('object') }).catchall(z.json()) })) });
export function bridgeTools(names: BridgeTool[]): z.infer<typeof BridgeToolsSchema> {
  const descriptions: Record<BridgeTool, string> = {
    jevellan_finding: 'Record a finding with a concrete pointer. Prefix durable constraints with constraint: and decisions with decision:.',
    jevellan_handoff: 'Finish this stretch exactly once with an honest handoff. Supply the full plan or other result as result.content; the daemon stores its blob. Identical retries return the original receipt.',
    jevellan_conversation_search: 'Search only this conversation and return at most 20 excerpts with ledger pointers.',
    jevellan_conversation_read: 'Read a ledger event, handoff or result blob belonging to this conversation.',
    jevellan_integrate: 'Rebase this work onto its recorded upstream with tracked Git boundaries. Start the rebase, edit the reported conflicting files, then continue. Skip only when the current commit should contribute no change. Available only during integration.',
    memory_search: 'Search this project’s memory notes.',
    memory_read: 'Read one note from this project’s memory by permalink.',
    memory_write: 'Write a project memory note under this work’s checkout ownership.',
    memory_edit: 'Edit a project memory note. For replace, provide the exact text in find.',
    memory_propose: 'Queue a proposed memory note. It does not change the checkout; Jevellan applies it later under ownership.',
  };
  return BridgeToolsSchema.parse({ schema: 'bridge-tools-v1', tools: names.map((name) => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(BridgeToolSchemas[name], { io: 'input' }) })) });
}
