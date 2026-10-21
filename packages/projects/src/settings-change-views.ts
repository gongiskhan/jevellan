import { createHash } from 'node:crypto';
import { ProjectSettingsChangeViewSchema, ProjectSettingsEventPresentationSchema, stableJson, undoProjectSetting,
  type ProjectSettingsChange, type ProjectWorkSettings } from '@jevellan/core';
import { settingLabel } from './copy.js';

const settingValueText = (value: unknown) => value === true ? 'on' : value === false ? 'off' : value === 'start' ? 'start right away' : value === 'propose' ? 'propose first' : String(value);
/** Full historical before/after copy, without the coordinator prompt's 400-character clipping. */
export function settingChangeLine(change: { field: string; before: unknown; after: unknown; append?: string | undefined }): string {
  if (change.append !== undefined) return change.field === 'instructions' ? `Added to project instructions: "${change.append}"` : `Added to guidance for Jev: "${change.append}"`;
  return `Changed ${settingLabel(change.field)} from ${settingValueText(change.before)} to ${settingValueText(change.after)}.`;
}
export function settingsEventPresentation(event: { changes: readonly { field: string; from: string; to: string }[] }) {
  return ProjectSettingsEventPresentationSchema.parse({ schema: 'project-settings-event-presentation-v1', text: 'Project settings changed',
    detail: event.changes.map(change => `${settingLabel(change.field)}: ${change.from} → ${change.to}`).join('; ') });
}
export function settingsChangeView(settings: ProjectWorkSettings, change: ProjectSettingsChange) {
  if (change.projectId !== settings.projectId) throw Object.assign(new Error('The settings change belongs to another project.'), { status: 400 });
  return ProjectSettingsChangeViewSchema.parse({ schema: 'project-settings-change-view-v1', projectId: settings.projectId, changeId: change.id, revision: settings.revision, undoLabel: 'Undo',
    items: change.changes.map(value => {
      const restored = undoProjectSetting(settings, value), clientRequestId = `undo_${createHash('sha256').update(stableJson({ projectId: settings.projectId, revision: settings.revision, changeId: change.id, value })).digest('hex').slice(0, 40)}`;
      return { field: value.field, line: settingChangeLine(value), refusal: restored ? null : 'Changed again since.',
        undo: restored ? { path: `/api/projects/${settings.projectId}/work-settings/undo`, body: { schema: 'project-settings-undo-request-v1', expectedRevision: settings.revision, clientRequestId, change: value } } : null };
    }),
  });
}
