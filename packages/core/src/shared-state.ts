import { CleanupSettingsSaveSchema } from './cleanup-editor-schemas.js';
import { GlobalThreadLimitSaveSchema } from './project-definition-schemas.js';
import { RuntimeSettingsSaveSchema } from './runtime-settings-schemas.js';
import { z } from 'zod';
import { ProjectEnvNameSchema, ProjectEnvImportSourceSchema, ProjectEnvSecretSummarySchema, type ProjectEnvSecretSummary } from './project-parity-schemas.js';
import { AddRiggingSchema, ConfigWriteSchema, CredentialInputSchema, GitHubTokenStateSchema, RiggingEntrySchema, RiggingViewSchema, SecretStateSchema, SecretSummarySchema, UpdateRiggingSchema, type GitHubTokenState } from './client-schemas.js';
import { ProjectViewSchema } from './conversation-schemas.js';
import { ConfigRevisionSchema, IdSchema, ProjectSchema, RiggingItemSchema, type ConfigRevision, type Project, type RiggingItem } from './schemas.js';
import { DecisionsSettingsEditorSchema, DecisionsSettingsPreviewSchema, DecisionsSettingsSaveSchema, JevCheckRecordSchema, JevKeyGenerationSchema, JevConnectionViewSchema, type DecisionsSettingsEditor, type JevConnectionView } from './decisions-settings-schemas.js';
import { JevConnectionSchema } from './client-schemas.js';

type Available<T> = T | Promise<T>;
export interface SharedConfiguration {
  current(): Available<ConfigRevision>;
  history(): Available<ConfigRevision[]>;
  put(input: unknown): Available<ConfigRevision>;
  decisionsEditor(input?: unknown): Available<DecisionsSettingsEditor>;
  decisionsPut(input: unknown): Available<ConfigRevision>;
  runtimesPut(input: unknown): Available<ConfigRevision>;
  limitsPut(input: unknown): Available<ConfigRevision>;
  cleanupPut(input: unknown): Available<ConfigRevision>;
}
export interface SharedRigging {
  get(id: string): Available<z.infer<typeof RiggingViewSchema>>;
  list(): Available<z.infer<typeof RiggingViewSchema>[]>;
  add(input: unknown): Available<z.infer<typeof RiggingViewSchema>>;
  update(id: string, input: unknown): Available<z.infer<typeof RiggingViewSchema>>;
  validateCaptured(input: unknown): Available<z.infer<typeof RiggingEntrySchema>>;
  addCaptured(input: unknown): Available<z.infer<typeof RiggingViewSchema>>;
  items(runtime: string, projectId?: string): Available<RiggingItem[]>;
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
  connection(): Available<JevConnectionView>;
  checkGeneration(): Available<number>;
  recordCheck(input: unknown): Available<z.infer<typeof JevConnectionSchema>>;
}
/** The GitHub token for pull requests: summaries carry the last four characters and the save time, never the token. */
export interface SharedGitHub {
  summary(projectId?: string): Available<GitHubTokenState>;
  put(value: string, clientRequestId?: string, projectId?: string): Available<GitHubTokenState>;
  remove(clientRequestId?: string, projectId?: string): Available<GitHubTokenState>;
  credential(projectId?: string): Available<string | undefined>;
}
export interface SharedProjectEnvironment {
  summary(projectId: string, name: string): Available<ProjectEnvSecretSummary>;
  put(projectId: string, name: string, value: string): Available<ProjectEnvSecretSummary>;
  remove(projectId: string, name: string): Available<ProjectEnvSecretSummary>;
  copy(projectId: string, name: string, source: z.infer<typeof ProjectEnvImportSourceSchema>): Available<ProjectEnvSecretSummary>;
  credentials(projectId: string): Available<Record<string, string>>;
}
const base = { schema: z.literal('shared-state-request-v1') };
const runtimes = z.array(IdSchema).max(64);
export const SharedStateRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.enum(['project-env-summary', 'project-env-remove']), projectId: IdSchema, name: ProjectEnvNameSchema }),
  z.strictObject({ ...base, operation: z.literal('project-env-put'), projectId: IdSchema, name: ProjectEnvNameSchema, value: CredentialInputSchema }),
  z.strictObject({ ...base, operation: z.literal('project-env-copy'), projectId: IdSchema, name: ProjectEnvNameSchema, source: ProjectEnvImportSourceSchema }),
  z.strictObject({ ...base, operation: z.literal('project-env-credentials'), projectId: IdSchema }),
  z.strictObject({ ...base, operation: z.enum(['configuration', 'configuration-history', 'projects', 'jev-summary', 'jev-credential']) }),
  z.strictObject({ ...base, operation: z.enum(['github-summary', 'github-credential']), projectId: IdSchema.optional() }),
  z.strictObject({ ...base, operation: z.literal('configuration-put'), input: ConfigWriteSchema }),
  z.strictObject({ ...base, operation: z.literal('decisions-editor'), input: DecisionsSettingsPreviewSchema.optional() }),
  z.strictObject({ ...base, operation: z.literal('decisions-put'), input: DecisionsSettingsSaveSchema }),
  z.strictObject({ ...base, operation: z.literal('runtimes-put'), input: RuntimeSettingsSaveSchema }),
  z.strictObject({ ...base, operation: z.literal('limits-put'), input: GlobalThreadLimitSaveSchema }),
  z.strictObject({ ...base, operation: z.literal('cleanup-put'), input: CleanupSettingsSaveSchema }),
  z.strictObject({ ...base, operation: z.enum(['jev-check-generation', 'jev-connection']) }),
  z.strictObject({ ...base, operation: z.literal('jev-check-record'), input: JevCheckRecordSchema }),
  z.strictObject({ ...base, operation: z.literal('project'), id: IdSchema }),
  z.strictObject({ ...base, operation: z.literal('project-put'), clientRequestId: IdSchema.optional(), project: ProjectSchema, revision: z.number().int().nonnegative() }),
  z.strictObject({ ...base, operation: z.literal('project-context'), id: IdSchema, context: ProjectSchema.shape.context, revision: z.number().int().positive() }),
  z.strictObject({ ...base, operation: z.literal('jev-put'), clientRequestId: IdSchema.optional(), value: CredentialInputSchema }),
  z.strictObject({ ...base, operation: z.literal('github-put'), clientRequestId: IdSchema.optional(), value: CredentialInputSchema, projectId: IdSchema.optional() }),
  z.strictObject({ ...base, operation: z.literal('github-remove'), clientRequestId: IdSchema.optional(), projectId: IdSchema.optional() }),
  z.strictObject({ ...base, operation: z.literal('rigging'), runtimes }),
  z.strictObject({ ...base, operation: z.literal('rigging-get'), id: IdSchema, runtimes }),
  z.strictObject({ ...base, operation: z.literal('rigging-add'), input: AddRiggingSchema, runtimes }),
  z.strictObject({ ...base, operation: z.literal('rigging-update'), id: IdSchema, input: UpdateRiggingSchema, runtimes }),
  z.strictObject({ ...base, operation: z.enum(['rigging-validate-captured', 'rigging-add-captured']), input: RiggingEntrySchema, runtimes }),
  z.strictObject({ ...base, operation: z.literal('rigging-items'), projectId: IdSchema.optional(), runtime: IdSchema, runtimes }),
]);
export const SharedStateResultSchema = z.discriminatedUnion('schema', [
  z.strictObject({ schema: z.literal('shared-decisions-editor-v1'), editor: DecisionsSettingsEditorSchema }),
  z.strictObject({ schema: z.literal('shared-jev-generation-v1'), value: JevKeyGenerationSchema }),
  z.strictObject({ schema: z.literal('shared-jev-connection-v1'), view: JevConnectionViewSchema }),
  z.strictObject({ schema: z.literal('shared-jev-check-v1'), result: JevConnectionSchema }),
  z.strictObject({ schema: z.literal('shared-project-env-summary-v1'), summary: ProjectEnvSecretSummarySchema }),
  z.strictObject({ schema: z.literal('shared-project-env-credentials-v1'), values: z.record(ProjectEnvNameSchema, CredentialInputSchema) }),
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
  z.strictObject({ schema: z.literal('shared-github-summary-v1'), summary: GitHubTokenStateSchema }),
  z.strictObject({ schema: z.literal('shared-github-credential-v1'), value: CredentialInputSchema.nullable() }),
]);
