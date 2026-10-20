import { z } from 'zod';
import { OwnerProjectSettingsSchema, ProjectDeploySettingsSchema, ProjectRoutineSettingsViewSchema, ProjectWorkSettingsSchema, type OwnerProjectSettings, type ProjectJob } from '@jevellan/core';

const range = (schema: z.ZodNumber) => { const json = z.toJSONSchema(schema); return { min: json.minimum, max: json.maximum }; };
const nightly = ProjectWorkSettingsSchema.shape.nightlyWindow.removeDefault(), time = z.toJSONSchema(nightly.shape.time), timezone = z.toJSONSchema(nightly.shape.timezone);
const constraints = { debounceMinutes: range(OwnerProjectSettingsSchema.shape.deploy.shape.debounceMinutes), catchUpHours: range(OwnerProjectSettingsSchema.shape.night.shape.catchUpHours) };
const modeLabels = { approve: 'Owner approval', nightly: "After the night's full suite", automatic: 'Automatic' } as const;
const slots = [['jobId', 'Deploy job'], ['desktopJobId', 'Desktop build job'], ['suiteJobId', 'Full suite job']] as const;
export function projectRoutineJobChoices(projectId: string, jobs: readonly ProjectJob[], key: typeof slots[number][0]) {
  return [{ value: '', label: 'None', disabled: false, patch: { [key]: null as string | null } },
    ...jobs.filter(job => job.projectId === projectId && job.run.kind === 'command').map(job => ({ value: job.id, label: job.name, disabled: false, patch: { [key]: job.id } }))];
}

/** Server metadata for the existing pending settings form; preferences keep their own state-point revision. */
export function projectRoutineSettings(projectId: string, jobs: readonly ProjectJob[], owner: OwnerProjectSettings, ownerRevision: number, missedNights: string[]) {
  return ProjectRoutineSettingsViewSchema.parse({ schema: 'project-routine-settings-view-v1', projectId,
    deploy: { modes: ProjectDeploySettingsSchema.shape.mode.removeDefault().options.map(mode => ({ value: mode, label: modeLabels[mode], disabled: mode !== 'approve', patch: { mode } })),
      modeNotice: "Change through config when you're ready.",
      slots: slots.map(([key, label]) => ({ key, label, choices: projectRoutineJobChoices(projectId, jobs, key) })) },
    routines: { refill: range(ProjectWorkSettingsSchema.shape.refill.removeDefault().shape.minIntervalMinutes), timePattern: time.pattern, timezoneMaxLength: timezone.maxLength },
    automation: { revision: ownerRevision, fields: { deployPaused: owner.deploy.paused, debounceMinutes: String(owner.deploy.debounceMinutes), catchUpHours: String(owner.night.catchUpHours) }, constraints,
      request: { path: `/api/projects/${projectId}/routine-settings`, base: { schema: 'project-routine-settings-save-v1', expectedRevision: ownerRevision } } }, missedNights,
  });
}
