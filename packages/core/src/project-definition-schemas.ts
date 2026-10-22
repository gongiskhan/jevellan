import {FirstRunReadRequestSchema, FirstRunNextRequestSchema} from './first-run.js';
import { z } from 'zod';
import { IdSchema, ProjectSchema } from './schemas.js';
import { ProjectViewSchema, ProjectWriteSchema } from './conversation-schemas.js';
export const GlobalThreadLimitSaveSchema = z.strictObject({ schema: z.literal('global-thread-limit-save-v1'), revision: z.number().int().positive(), value: z.string().or(z.number()), clientRequestId: IdSchema });
export const GlobalThreadLimitEditorSchema = z.strictObject({ schema: z.literal('global-thread-limit-editor-v1'), revision: z.number().int().positive(), title: z.string(), help: z.string(), savedNotice: z.string(), input: z.strictObject({ label: z.string(), value: z.number(), min: z.number(), max: z.number(), step: z.literal(1) }), write: z.strictObject({ path: z.literal('/api/config/limits'), method: z.literal('PUT'), body: GlobalThreadLimitSaveSchema.omit({ value: true, clientRequestId: true }) }) });
export const ProjectDefinitionContextSchema = z.strictObject({ schema: z.literal('project-definition-context-v1'), mode: z.enum(['create', 'edit']), projectId: IdSchema, revision: z.number().int().nonnegative(), projectContext: ProjectSchema.shape.context,
  reference: z.strictObject({ public: z.boolean(), remoteUrl: z.string(), localPath: z.string() }) });
export const ProjectDefinitionFieldsSchema = z.strictObject({ name: z.string(), nameFollowsFolder: z.boolean(), remoteUrl: z.string(), testCommand: z.string(), paths: z.record(IdSchema, z.string()), branchPolicy: ProjectSchema.shape.branchPolicy, memory: z.strictObject({ mode: ProjectSchema.shape.memory.shape.mode, dir: z.string() }), requireProjectToken: z.boolean(), allowedDevices: z.array(IdSchema).nullable(), createContext: z.boolean(), restore: z.boolean() });
export const ProjectDefinitionCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('name'), value: z.string() }), z.strictObject({ type: z.literal('path'), deviceId: IdSchema, value: z.string() }),
  z.strictObject({ type: z.literal('github-token'), checked: z.boolean() }),
  z.strictObject({ type: z.literal('branch-policy'), value: ProjectSchema.shape.branchPolicy }), z.strictObject({ type: z.literal('device'), deviceId: IdSchema, checked: z.boolean() }),
]);
export const ProjectDefinitionReadSchema = z.strictObject({ schema: z.literal('project-definition-read-v1'), projectId: IdSchema.optional() });
export const ProjectDefinitionPreviewSchema = z.strictObject({ schema: z.literal('project-definition-preview-v1'), context: ProjectDefinitionContextSchema, fields: ProjectDefinitionFieldsSchema, command: ProjectDefinitionCommandSchema.optional() });
export const ProjectDefinitionSaveSchema = z.strictObject({ schema: z.literal('project-definition-save-v1'), context: ProjectDefinitionContextSchema, fields: ProjectDefinitionFieldsSchema, clientRequestId: IdSchema });
export const ProjectDefinitionEditorSchema = z.strictObject({ schema: z.literal('project-definition-editor-v1'), currentDeviceId: IdSchema, context: ProjectDefinitionContextSchema, fields: ProjectDefinitionFieldsSchema,
  devices: z.array(z.strictObject({ id: IdSchema, name: z.string(), required: z.boolean(), checked: z.boolean() })), canSave: z.boolean(), validation: z.array(z.string()), title: z.string(), showCreateContext: z.boolean(), showMainNotice: z.boolean(), showMemoryDirectory: z.boolean(), publicMemoryNotice: z.boolean(), restorable: z.boolean(), restoreText: z.string(),
  branchChoices: z.array(z.strictObject({ value: ProjectSchema.shape.branchPolicy, label: z.string() })), memoryChoices: z.array(z.strictObject({ value: ProjectSchema.shape.memory.shape.mode, label: z.string() })),
  plan: z.strictObject({ path: z.literal('/hub/projects'), method: z.literal('PUT'), body: ProjectWriteSchema.omit({ clientRequestId: true }), restorePath: z.string().nullable() }).nullable(),
});
export const ProjectVaultPresentationSchema = z.strictObject({ schema: z.literal('project-vault-presentation-v1'), label: z.string(), blocked: z.boolean(), remoteLine: z.string(), lastSyncAt: z.string().nullable(), lastError: z.string().nullable() });
export const ProjectDefinitionsViewSchema = z.strictObject({ schema: z.literal('project-definitions-view-v1'), currentDeviceId: IdSchema, projects: z.array(z.strictObject({ schema: z.literal('project-definition-row-v1'), view: ProjectViewSchema, checkedOutHere: z.boolean(), path: z.string(), canContext: z.boolean(), publicMemoryNotice: z.boolean(), chips: z.array(z.strictObject({ label: z.string(), tone: z.enum(['normal', 'dim', 'blocked']) })) })), vault: ProjectVaultPresentationSchema.nullable() });
export type ProjectDefinitionFields = z.infer<typeof ProjectDefinitionFieldsSchema>;
export type ProjectDefinitionCommand = z.infer<typeof ProjectDefinitionCommandSchema>;
export type ProjectDefinitionEditor = z.infer<typeof ProjectDefinitionEditorSchema>;
export type ProjectDefinitionsView = z.infer<typeof ProjectDefinitionsViewSchema>;
export const ProjectDefinitionPeerRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('project-definition-peer-request-v1'), operation: z.literal('first-run-view'), input: FirstRunReadRequestSchema }),
  z.strictObject({ schema: z.literal('project-definition-peer-request-v1'), operation: z.literal('first-run-next'), input: FirstRunNextRequestSchema }),
  z.strictObject({ schema: z.literal('project-definition-peer-request-v1'), operation: z.literal('setup-view'), projectId: IdSchema }),
  z.strictObject({ schema: z.literal('project-definition-peer-request-v1'), operation: z.literal('view') }),
  z.strictObject({ schema: z.literal('project-definition-peer-request-v1'), operation: z.literal('read'), input: ProjectDefinitionReadSchema }),
  z.strictObject({ schema: z.literal('project-definition-peer-request-v1'), operation: z.literal('preview'), input: ProjectDefinitionPreviewSchema }),
  z.strictObject({ schema: z.literal('project-definition-peer-request-v1'), operation: z.literal('save'), input: ProjectDefinitionSaveSchema }),
]);
