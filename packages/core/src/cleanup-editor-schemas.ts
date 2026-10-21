import { z } from 'zod';
import { IdSchema } from './schemas.js';
const rawNumber = z.union([z.string().max(100), z.number()]);
const retention = z.strictObject({ days: rawNumber, maxGb: rawNumber });
export const CleanupEditorFieldsSchema = z.strictObject({ logs: retention, evidence: retention, worktrees: retention, workspaces: retention, freeDiskFloorGb: rawNumber });
export const CleanupSettingsSaveSchema = z.strictObject({ schema: z.literal('cleanup-settings-save-v1'), revision: z.number().int().positive(), clientRequestId: IdSchema, fields: CleanupEditorFieldsSchema });
const range = z.strictObject({ min: z.number(), max: z.number(), step: z.union([z.literal(1), z.literal('any')]) });
export const CleanupSettingsEditorSchema = z.strictObject({ schema: z.literal('cleanup-settings-editor-v1'), revision: z.number().int().positive(), fields: CleanupEditorFieldsSchema,
  title: z.string(), intro: z.string(), categories: z.array(z.strictObject({ id: z.enum(['logs', 'evidence', 'worktrees', 'workspaces']), label: z.string() })), days: range, maxGb: range, floor: range,
  floorTitle: z.string(), floorLabel: z.string(), floorHelp: z.string(), saveLabel: z.string(), savedNotice: z.string(),
  write: z.strictObject({ path: z.literal('/api/config/cleanup'), method: z.literal('PUT'), body: CleanupSettingsSaveSchema.omit({ fields: true, clientRequestId: true }) }),
});
export type CleanupEditorFields = z.infer<typeof CleanupEditorFieldsSchema>;
export type CleanupSettingsEditor = z.infer<typeof CleanupSettingsEditorSchema>;
