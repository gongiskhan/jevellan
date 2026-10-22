import { newId, healthEditor, healthEditorPreview, HealthEditorPreviewSchema, healthHistoryView } from '@jevellan/core';
import type { Application } from './application.js';
/** Read/preview only. Saved settings and the normal run request remain the only writers. */
export async function projectHealthEditor(app: Application, projectId: string, raw?: unknown) {
  const settings = (await app.projectWork.settingsView(projectId)).settings;
  const ids = Array.from({ length: 10 }, () => newId('health'));
  if (raw === undefined) return healthEditor(projectId, settings.healthChecks, ids);
  const input = HealthEditorPreviewSchema.parse(raw);
  if (input.projectId !== projectId) throw Object.assign(new Error('Health draft belongs to another project.'), { status: 400 });
  return healthEditorPreview(input, ids);
}
export async function projectHealthHistory(app: Application, projectId: string) {
  return healthHistoryView(await app.projectHealthRequest({ schema: 'project-health-request-v1', project: projectId, operation: 'list' }));
}
