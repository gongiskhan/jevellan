import { z } from 'zod';
import { EffortSchema, IdSchema } from './schemas.js';

export const ThreadOverrideEditorFieldsSchema = z.strictObject({ mode: z.enum(['next-turn', 'restart']), isolation: z.enum(['', 'worktree']),
  modelId: z.union([z.literal(''), IdSchema]), effort: z.union([z.literal(''), EffortSchema]), deviceId: z.union([z.literal(''), IdSchema]), note: z.string().max(4000) });
export type ThreadOverrideEditorFields = z.infer<typeof ThreadOverrideEditorFieldsSchema>;
export const ThreadOverrideEditorPreviewSchema = z.strictObject({ schema: z.literal('thread-override-editor-preview-request-v1'),
  fields: ThreadOverrideEditorFieldsSchema, changed: z.enum(['mode', 'model', 'effort', 'device']).optional() });
const base = z.strictObject({ schema: z.literal('thread-override-editor-save-request-v1'), clientRequestId: IdSchema });
export const ThreadOverrideEditorSaveSchema = base.extend({ fields: ThreadOverrideEditorFieldsSchema });
const option = z.strictObject({ value: z.string(), label: z.string() });
export const ProjectThreadOverrideEditorSchema = z.strictObject({ schema: z.literal('project-thread-override-editor-v1'), projectId: IdSchema, threadId: IdSchema,
  fields: ThreadOverrideEditorFieldsSchema, choices: z.strictObject({
    modes: z.array(z.strictObject({ value: z.enum(['next-turn', 'restart']), label: z.string(), enabled: z.boolean(), help: z.string() })),
    models: z.array(option), efforts: z.array(option), devices: z.array(option.extend({ disabled: z.boolean() })),
  }), showDevice: z.boolean(), deviceNotice: z.string().nullable(), constraints: z.strictObject({ noteMax: z.number().int().positive() }),
  apply: z.strictObject({ enabled: z.boolean(), tone: z.enum(['normal', 'danger']), refusal: z.string().nullable() }),
  request: z.strictObject({ previewPath: z.string(), savePath: z.string(), base }),
});
export type ProjectThreadOverrideEditor = z.infer<typeof ProjectThreadOverrideEditorSchema>;
