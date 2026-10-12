import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';

const text = z.string().min(1);
export const MemoryNoteSchema = z.strictObject({ schema: z.literal('memory-note-v1'), title: text, permalink: text, content: z.string(), updatedAt: z.iso.datetime().optional(), unresolved: z.boolean().default(false) });
export type MemoryNote = z.infer<typeof MemoryNoteSchema>;
export const MemorySearchSchema = z.strictObject({ schema: z.literal('memory-search-v1'), notes: z.array(MemoryNoteSchema).max(20) });
export const MemoryWriteSchema = z.strictObject({ title: text.max(300), content: text.max(256_000) });
export const MemoryEditSchema = z.strictObject({ permalink: text, operation: z.enum(['append', 'prepend', 'replace']), content: text.max(256_000), find: text.optional() }).refine((value) => value.operation !== 'replace' || !!value.find, 'A replacement needs the exact text to replace.');
export const ProjectMemorySettingsSchema = z.strictObject({ mode: z.enum(['hub', 'repo', 'device']),
  capture: z.boolean().default(true), dreamMode: z.enum(['apply', 'suggest']).default('apply') });
export const MemoryProvenanceSchema = z.strictObject({ source: z.enum(['owner', 'coordinator', 'thread', 'capture', 'dream']),
  runtime: z.string().min(1).max(200), model: z.string().min(1).max(200), threadId: IdSchema.optional(), taskId: IdSchema.optional() });
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;
export const MemoryFrontmatterSchema = MemoryProvenanceSchema.extend({ title: text.max(300), created: TimestampSchema, updated: TimestampSchema,
  status: z.enum(['active', 'unresolved', 'archived']), archiveReason: z.string().max(300).optional() });
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;
export const HubMemoryScopeSchema = z.strictObject({ kind: z.enum(['coordinator', 'thread', 'review', 'verification', 'memory', 'conversation', 'viewer', 'owner']),
  id: IdSchema.optional(), provenance: MemoryProvenanceSchema.optional(), stagingId: IdSchema.optional() });
export type HubMemoryScope = z.infer<typeof HubMemoryScopeSchema>;
export const MemoryRecallSchema = z.strictObject({ schema: z.literal('project-memory-recall-v1'), section: z.string().max(5000),
  source: z.enum(['jev', 'search-rank', 'unavailable']), notes: z.array(z.strictObject({ title: z.string(), permalink: z.string(), reason: z.string().max(300) })).max(6) });
export type MemoryRecall = z.infer<typeof MemoryRecallSchema>;
