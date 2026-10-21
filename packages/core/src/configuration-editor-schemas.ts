import { z } from 'zod';
import { ConfigPreviewSchema, ConfigWriteSchema } from './client-schemas.js';
import { ConfigRevisionSchema, IdSchema, TimestampSchema } from './schemas.js';
import { CONFIGURATION_EXPORT_FILENAME } from './configuration-path.js';
export { CONFIGURATION_EXPORT_FILENAME } from './configuration-path.js';

export const ConfigurationEditorViewSchema = z.strictObject({ schema: z.literal('configuration-editor-v1'), revision: z.number().int().positive(),
  rows: z.array(z.strictObject({ schema: z.literal('configuration-revision-row-v1'), revision: z.number().int().positive(), label: z.string(), at: TimestampSchema, deviceLabel: z.string(), sourceLabel: z.string(), source: ConfigRevisionSchema.shape.changedBy.shape.source })),
  title: z.string(), intro: z.string(), historyTitle: z.string(),
  yaml: z.strictObject({ readPath: z.literal('/api/config/yaml'), downloadPath: z.literal('/hub/config/export'), downloadName: z.literal(CONFIGURATION_EXPORT_FILENAME), showLabel: z.string(), hideLabel: z.string(), title: z.string() }),
  import: z.strictObject({ previewPath: z.literal('/api/config/import-preview'), openLabel: z.string(), title: z.string(), sourceLabel: z.string(), validateLabel: z.string(), cancelLabel: z.string(), applyLabel: z.string(), maxLength: z.number().int().positive() }),
});
export const ConfigurationYamlViewSchema = z.strictObject({ schema: z.literal('configuration-yaml-view-v1'), yaml: z.string() });
export const ConfigurationApplyRequestSchema = ConfigWriteSchema.extend({ clientRequestId: IdSchema });
export const ConfigurationImportViewSchema = z.strictObject({ schema: z.literal('configuration-import-view-v1'), preview: ConfigPreviewSchema, heading: z.string(), canApply: z.boolean(), savedNotice: z.string(),
  write: z.strictObject({ schema: z.literal('configuration-write-plan-v1'), path: z.literal('/hub/config'), method: z.literal('PUT'), body: ConfigWriteSchema.omit({ clientRequestId: true }) }).nullable(),
});
export type ConfigurationEditorView = z.infer<typeof ConfigurationEditorViewSchema>;
export type ConfigurationImportView = z.infer<typeof ConfigurationImportViewSchema>;
