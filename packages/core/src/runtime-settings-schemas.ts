import { z } from 'zod';
import { IdSchema } from './schemas.js';
export const defaultRuntimeCacheWindow = (runtime: string): number => runtime === 'claude' ? 60 : 10;
export const RuntimeSettingsSaveSchema = z.strictObject({ schema: z.literal('runtime-settings-save-v1'), revision: z.number().int().positive(), clientRequestId: IdSchema, runtime: IdSchema,
  patch: z.strictObject({ enabled: z.boolean().optional(), useOwnSetup: z.boolean().optional(), cacheWindowMinutes: z.union([z.string().max(100), z.number()]).optional() }).refine(value => Object.keys(value).length > 0, 'Choose a runtime setting to change.'),
});
export const RuntimeSettingsRowSchema = z.strictObject({ schema: z.literal('runtime-settings-row-v1'), id: IdSchema,
  enabled: z.strictObject({ label: z.string(), ariaLabel: z.string(), checked: z.boolean() }),
  cache: z.strictObject({ label: z.string(), ariaLabel: z.string(), value: z.number().int().positive(), min: z.number(), max: z.number(), step: z.literal(1) }),
  ownSetup: z.strictObject({ label: z.string(), checked: z.boolean(), help: z.string(), inventoryTitle: z.string(), lines: z.array(z.string()) }).nullable(),
  savedNotice: z.string(), write: z.strictObject({ schema: z.literal('runtime-settings-write-plan-v1'), path: z.literal('/api/config/runtimes'), method: z.literal('PUT'), body: RuntimeSettingsSaveSchema.omit({ patch: true, clientRequestId: true }) }),
});
export const RuntimeSettingsEditorSchema = z.strictObject({ schema: z.literal('runtime-settings-editor-v1'), revision: z.number().int().positive(), rows: z.array(RuntimeSettingsRowSchema) });
export type RuntimeSettingsRow = z.infer<typeof RuntimeSettingsRowSchema>;
export type RuntimeSettingsSave = z.infer<typeof RuntimeSettingsSaveSchema>;
