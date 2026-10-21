import { z } from 'zod';
import { ProjectConfigurationInfoSchema, ProjectPlacementSettingsSchema, ProjectWorkSettingsSchema, type Effort, type ProjectWorkView } from '@jevellan/core';
import { SETTINGS_CHANGED } from './copy.js';

/** Read metadata comes from the same schemas that refuse oversized writes. */
export function projectConfigurationInfo() {
  return ProjectConfigurationInfoSchema.parse({ schema: 'project-configuration-info-v1',
    instructions: { maxLength: z.toJSONSchema(ProjectWorkSettingsSchema.shape.instructions).maxLength,
      help: 'The coordinator and every new thread receive these. Threads already running keep the version they started with.' },
    guidance: { maxLength: z.toJSONSchema(ProjectPlacementSettingsSchema.shape.guidance).maxLength,
      help: "Jev reads this when it chooses model and effort for this project's threads. For example: UI work uses Opus at high effort; documentation can use Sonnet at low." },
    pauseHelp: 'Nothing new starts: no coordinator turns, no new threads or turns, no routines. Turns already running finish.',
    archiveHelp: 'Paused and hidden from the sidebar.', dailyThreadHelp: "Counted from midnight in the project's time zone.", conflictText: SETTINGS_CHANGED,
  });
}

export type SettingsForm = { modelId: string; effort: Effort; setupCommand: string;
  refill?: ProjectWorkView['settings']['refill']; nightlyWindow?: ProjectWorkView['settings']['nightlyWindow']; autoLand?: boolean; riskyAreas?: string; instructions?: string;
  sessionCheckpoints?: ProjectWorkView['settings']['sessionCheckpoints']; compactAtPercent?: number; maxRunningThreads: number; maxRunningPerDevice: number; perDeviceLimits?: Record<string, number>; threadTurnCap: number };

/** Legacy adapter, unused by the current page: preserve v5 settings and normalize only the submitted fields. */
export function settingsRequest(view: Pick<ProjectWorkView, 'settings' | 'settingsNotice'>, form: SettingsForm) {
  const { schema: _schema, projectId: _project, revision: _revision, ...settings } = view.settings; void _schema; void _project; void _revision;
  return { schema: 'project-work-settings-request-v1' as const, revision: view.settings.revision, settings: {
    ...settings, refill: form.refill ?? view.settings.refill, nightlyWindow: form.nightlyWindow ?? view.settings.nightlyWindow,
    coordinator: { ...view.settings.coordinator, modelId: form.modelId || null, effort: form.effort }, setupCommand: form.setupCommand.trim() || null,
    autoLand: form.autoLand ?? view.settings.autoLand, riskyAreas: form.riskyAreas ?? view.settings.riskyAreas, instructions: form.instructions ?? view.settings.instructions,
    sessionCheckpoints: form.sessionCheckpoints ?? view.settings.sessionCheckpoints,
    compactAtPercent: form.compactAtPercent ?? view.settings.compactAtPercent,
    perDeviceLimits: form.perDeviceLimits ?? view.settings.perDeviceLimits,
    maxRunningThreads: form.maxRunningThreads, maxRunningPerDevice: form.maxRunningPerDevice, threadTurnCap: form.threadTurnCap } };
}
