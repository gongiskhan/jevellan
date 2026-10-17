import { z } from 'zod';
import { ProjectSettingsChangeSchema, ProjectSettingsUpdateSchema, ProjectWorkSettingsSchema, projectSettingValue, withProjectSetting,
  type ProjectSettingChange, type ProjectSettingsChange, type ProjectWorkSettings } from '@jevellan/core';
import { GUIDANCE_TOO_LONG, INSTRUCTIONS_TOO_LONG } from './copy.js';

export const SettingsChangePlanSchema = z.strictObject({ schema: z.literal('project-settings-change-plan-v1'), change: ProjectSettingsChangeSchema,
  settings: ProjectWorkSettingsSchema, expectedRevision: z.number().int().nonnegative() });
export function settingsChangePlan(current: ProjectWorkSettings, raw: unknown, id: string, at: string): z.infer<typeof SettingsChangePlanSchema> {
  const input = ProjectSettingsUpdateSchema.parse(raw), changes: ProjectSettingsChange['changes'] = [];
  let settings = current;
  const change = (field: ProjectSettingChange['field'], after: ProjectSettingChange['after'], append?: string) => {
    const before = projectSettingValue(current, field);
    if (before === after) return;
    settings = withProjectSetting(settings, field, after);
    changes.push({ field, before, after, ...(append ? { append } : {}) });
  };
  for (const field of ['maxRunningThreads', 'maxNewThreadsPerDay', 'startMode'] as const) if (input[field] !== undefined) change(field, input[field]);
  for (const field of ['checks', 'conflicts', 'comments'] as const) if (input.prAutoFix?.[field] !== undefined) change(`prAutoFix.${field}`, input.prAutoFix[field]);
  for (const [key, field, max, error] of [['instructionsAppend', 'instructions', 16000, INSTRUCTIONS_TOO_LONG], ['guidanceAppend', 'placement.guidance', 2000, GUIDANCE_TOO_LONG]] as const) {
    const append = input[key]; if (!append) continue;
    const before = String(projectSettingValue(current, field)), after = before ? `${before}\n${append}` : append;
    if (after.length > max) throw Object.assign(new Error(error), { status: 400 });
    change(field, after, append);
  }
  return SettingsChangePlanSchema.parse({ schema: 'project-settings-change-plan-v1', settings, expectedRevision: current.revision,
    change: { schema: 'project-settings-change-v1', id, projectId: current.projectId, at, ownerWords: input.ownerWords, changes } });
}
