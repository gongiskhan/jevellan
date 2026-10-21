import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { ProjectSettingsChangeSchema, ProjectSettingFieldSchema, ProjectSettingsUndoRequestSchema } from './project-parity-schemas.js';

export const ProjectSettingsEventPresentationSchema = z.strictObject({ schema: z.literal('project-settings-event-presentation-v1'),
  text: z.string().min(1).max(500), detail: z.string().max(40000) });
export const ProjectSettingsChangeViewRequestSchema = z.strictObject({ schema: z.literal('project-settings-change-view-request-v1'), change: ProjectSettingsChangeSchema });
export const ProjectSettingsChangeViewSchema = z.strictObject({ schema: z.literal('project-settings-change-view-v1'), projectId: IdSchema, changeId: IdSchema,
  revision: z.number().int().nonnegative(), undoLabel: z.string().min(1).max(80),
  items: z.array(z.strictObject({ field: ProjectSettingFieldSchema, line: z.string().max(40000), refusal: z.string().max(500).nullable(),
    undo: z.strictObject({ path: z.string().min(1).max(1000), body: ProjectSettingsUndoRequestSchema }).nullable() })).max(8),
});
export type ProjectSettingsChangeView = z.infer<typeof ProjectSettingsChangeViewSchema>;
