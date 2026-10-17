import type { ProjectSettingChange } from './project-parity-schemas.js';
import { ProjectWorkSettingsSchema, type ProjectWorkSettings } from './project-schemas.js';

export function projectSettingValue(settings: ProjectWorkSettings, field: ProjectSettingChange['field']): string | number | boolean {
  switch (field) {
    case 'prAutoFix.checks': return settings.prAutoFix.checks;
    case 'prAutoFix.conflicts': return settings.prAutoFix.conflicts;
    case 'prAutoFix.comments': return settings.prAutoFix.comments;
    case 'placement.guidance': return settings.placement.guidance;
    default: return settings[field];
  }
}
export function withProjectSetting(settings: ProjectWorkSettings, field: ProjectSettingChange['field'], value: ProjectSettingChange['after']): ProjectWorkSettings {
  const next = structuredClone(settings);
  switch (field) {
    case 'prAutoFix.checks': next.prAutoFix.checks = value as boolean; break;
    case 'prAutoFix.conflicts': next.prAutoFix.conflicts = value as boolean; break;
    case 'prAutoFix.comments': next.prAutoFix.comments = value as boolean; break;
    case 'placement.guidance': next.placement.guidance = value as string; break;
    case 'instructions': next.instructions = value as string; break;
    case 'startMode': next.startMode = value as ProjectWorkSettings['startMode']; break;
    case 'maxRunningThreads': next.maxRunningThreads = value as number; break;
    case 'maxNewThreadsPerDay': next.maxNewThreadsPerDay = value as number; break;
  }
  return ProjectWorkSettingsSchema.parse(next);
}
/** Compare the actual field, preserving every unrelated setting and nested sibling. The HTTP revision fences concurrent edits. */
export function undoProjectSetting(settings: ProjectWorkSettings, change: ProjectSettingChange): ProjectWorkSettings | undefined {
  return projectSettingValue(settings, change.field) === change.after ? withProjectSetting(settings, change.field, change.before) : undefined;
}
