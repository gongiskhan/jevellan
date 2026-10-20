import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { ProjectDeploySettingsSchema } from './project-deploy-schemas.js';
import { OwnerProjectSettingsSchema } from './owner-tool-schemas.js';

export const RoutineAutomationFieldsSchema = z.strictObject({ deployPaused: z.boolean(), debounceMinutes: z.string().trim().min(1).max(40), catchUpHours: z.string().trim().min(1).max(40) });
export const RoutineAutomationPatchSchema = z.strictObject({ deployPaused: OwnerProjectSettingsSchema.shape.deploy.shape.paused.optional(),
  debounceMinutes: OwnerProjectSettingsSchema.shape.deploy.shape.debounceMinutes.optional(), catchUpHours: OwnerProjectSettingsSchema.shape.night.shape.catchUpHours.optional() });
export const ProjectRoutineSettingsSaveSchema = z.strictObject({ schema: z.literal('project-routine-settings-save-v1'), expectedRevision: z.number().int().nonnegative(), fields: RoutineAutomationFieldsSchema });
const deploy = ProjectDeploySettingsSchema.shape;
// Each choice changes exactly one field. Removing defaults is essential: a slot choice must not reset mode.
const patch = z.union([z.strictObject({ mode: deploy.mode.removeDefault() }), z.strictObject({ jobId: deploy.jobId.removeDefault() }),
  z.strictObject({ desktopJobId: deploy.desktopJobId.removeDefault() }), z.strictObject({ suiteJobId: deploy.suiteJobId.removeDefault() })]);
const choice = z.strictObject({ value: z.string().max(200), label: z.string().max(200), disabled: z.boolean(), patch });
const range = z.strictObject({ min: z.number().int(), max: z.number().int() });
export const ProjectRoutineSettingsViewSchema = z.strictObject({ schema: z.literal('project-routine-settings-view-v1'), projectId: IdSchema,
  deploy: z.strictObject({ modes: z.array(choice).length(3), modeNotice: z.string().max(1000), slots: z.array(z.strictObject({ key: z.enum(['jobId', 'desktopJobId', 'suiteJobId']), label: z.string().max(200), choices: z.array(choice).max(10001) })).length(3) }),
  routines: z.strictObject({ refill: range, timePattern: z.string().max(200), timezoneMaxLength: z.number().int().positive() }),
  automation: z.strictObject({ revision: z.number().int().nonnegative(), fields: RoutineAutomationFieldsSchema,
    constraints: z.strictObject({ debounceMinutes: range, catchUpHours: range }),
    request: z.strictObject({ path: z.string().max(1000), base: ProjectRoutineSettingsSaveSchema.omit({ fields: true }) }),
  }), missedNights: z.array(z.string().max(1000)).max(100),
});
export type ProjectRoutineSettingsView = z.infer<typeof ProjectRoutineSettingsViewSchema>;
export type RoutineAutomationFields = z.infer<typeof RoutineAutomationFieldsSchema>;
