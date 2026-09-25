import { z } from 'zod';
import { AddRiggingSchema, ConfigWriteSchema, CredentialInputSchema, RiggingEntrySchema, RiggingViewSchema, SecretStateSchema, SecretSummarySchema, UpdateRiggingSchema } from './client-schemas.js';
import { ProjectViewSchema } from './conversation-schemas.js';
import { ConfigRevisionSchema, IdSchema, ProjectSchema, RiggingItemSchema, type ConfigRevision, type Project, type RiggingItem } from './schemas.js';

type Available<T> = T | Promise<T>;
export interface SharedConfiguration {
  current(): Available<ConfigRevision>;
  history(): Available<ConfigRevision[]>;
  put(input: unknown): Available<ConfigRevision>;
}
export interface SharedRigging {
  get(id: string): Available<z.infer<typeof RiggingViewSchema>>;
  list(): Available<z.infer<typeof RiggingViewSchema>[]>;
  add(input: unknown): Available<z.infer<typeof RiggingViewSchema>>;
  update(id: string, input: unknown): Available<z.infer<typeof RiggingViewSchema>>;
  validateCaptured(input: unknown): Available<z.infer<typeof RiggingEntrySchema>>;
  addCaptured(input: unknown): Available<z.infer<typeof RiggingViewSchema>>;
  items(runtime: string): Available<RiggingItem[]>;
}
export interface SharedProjects {
  get(id: string): Available<z.infer<typeof ProjectViewSchema> | null>;
  list(): Available<z.infer<typeof ProjectViewSchema>[]>;
  put(project: Project, revision: number, clientRequestId?: string): Available<z.infer<typeof ProjectViewSchema>>;
  context(id: string, context: Project['context'], revision: number): Available<z.infer<typeof ProjectViewSchema>>;
}
export interface SharedJev {
  summary(): Available<z.infer<typeof SecretStateSchema>>;
  put(value: string, clientRequestId?: string): Available<z.infer<typeof SecretSummarySchema>>;
  credential(): Available<string | undefined>;
}
const base = { schema: z.literal('shared-state-request-v1') };
const runtimes = z.array(IdSchema).max(64);
export const SharedStateRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.enum(['configuration', 'configuration-history', 'projects', 'jev-summary', 'jev-credential']) }),
  z.strictObject({ ...base, operation: z.literal('configuration-put'), input: ConfigWriteSchema }),
  z.strictObject({ ...base, operation: z.literal('project'), id: IdSchema }),
  z.strictObject({ ...base, operation: z.literal('project-put'), clientRequestId: IdSchema.optional(), project: ProjectSchema, revision: z.number().int().nonnegative() }),
  z.strictObject({ ...base, operation: z.literal('project-context'), id: IdSchema, context: ProjectSchema.shape.context, revision: z.number().int().positive() }),
  z.strictObject({ ...base, operation: z.literal('jev-put'), clientRequestId: IdSchema.optional(), value: CredentialInputSchema }),
  z.strictObject({ ...base, operation: z.literal('rigging'), runtimes }),
  z.strictObject({ ...base, operation: z.literal('rigging-get'), id: IdSchema, runtimes }),
  z.strictObject({ ...base, operation: z.literal('rigging-add'), input: AddRiggingSchema, runtimes }),
  z.strictObject({ ...base, operation: z.literal('rigging-update'), id: IdSchema, input: UpdateRiggingSchema, runtimes }),
  z.strictObject({ ...base, operation: z.enum(['rigging-validate-captured', 'rigging-add-captured']), input: RiggingEntrySchema, runtimes }),
  z.strictObject({ ...base, operation: z.literal('rigging-items'), runtime: IdSchema, runtimes }),
]);
export const SharedStateResultSchema = z.discriminatedUnion('schema', [
  z.strictObject({ schema: z.literal('shared-configuration-v1'), revision: ConfigRevisionSchema }),
  z.strictObject({ schema: z.literal('shared-configuration-history-v1'), revisions: z.array(ConfigRevisionSchema) }),
  z.strictObject({ schema: z.literal('shared-project-v1'), project: ProjectViewSchema.nullable() }),
  z.strictObject({ schema: z.literal('shared-projects-v1'), projects: z.array(ProjectViewSchema) }),
  z.strictObject({ schema: z.literal('shared-rigging-v1'), items: z.array(RiggingViewSchema) }),
  z.strictObject({ schema: z.literal('shared-rigging-view-v1'), item: RiggingViewSchema }),
  z.strictObject({ schema: z.literal('shared-rigging-entry-v1'), item: RiggingEntrySchema }),
  z.strictObject({ schema: z.literal('shared-rigging-items-v1'), items: z.array(RiggingItemSchema) }),
  z.strictObject({ schema: z.literal('shared-jev-summary-v1'), summary: SecretStateSchema }),
  z.strictObject({ schema: z.literal('shared-jev-credential-v1'), value: CredentialInputSchema.nullable() }),
]);
