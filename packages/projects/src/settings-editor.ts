import { ProjectSettingsEditorBaseSchema, ProjectSettingsEditorSaveRequestSchema, ProjectSettingsEditorSavedSchema, ProjectWorkSettingsRequestSchema,
  type ProjectWorkSettings, type ProjectSettingsEditorSaved } from '@jevellan/core';
import type { z } from 'zod';
import type { ProjectWorkSettingsViewSchema, ProjectWorkViewSchema } from '@jevellan/core';

const savedNotice = 'Project settings saved.';
/** Section order and status choices belong to the server; browser draft/reset state stays local. */
export function settingsEditorBase(settingsView: z.infer<typeof ProjectWorkSettingsViewSchema>, work: z.infer<typeof ProjectWorkViewSchema>) {
  return ProjectSettingsEditorBaseSchema.parse({ schema: 'project-settings-editor-base-v1', settingsView, work,
    sections: [['general', 'General'], ['instructions', 'Instructions'], ['placement', 'Placement'], ['limits', 'Threads and limits'], ['pull-requests', 'Landing'],
      ['environment', 'Environment'], ['routines', 'Routines'], ['health', 'Health checks'], ['notifications', 'Notifications'], ['usage', 'Usage'], ['automation', 'Automation']].map(([key, label]) => ({ key, label })),
    statusOptions: [['active', 'Active'], ['paused', 'Paused'], ['archived', 'Archived']].map(([value, label]) => ({ value, label })),
    savePath: `/api/projects/${settingsView.settings.projectId}/config/editor`, backPath: `/projects/${settingsView.settings.projectId}`, savedNotice,
  });
}
export function settingsEditorRequest(projectId: string, raw: unknown) {
  const parsed = ProjectSettingsEditorSaveRequestSchema.safeParse(raw);
  if (!parsed.success) throw Object.assign(new Error(parsed.error.issues[0]?.message ?? 'Check the submitted fields.'), { status: 400 });
  const input = parsed.data, statusOnly = input.schema === 'project-settings-editor-status-v1';
  const draft = input.schema === 'project-settings-editor-status-v1' ? { ...input.base, status: input.status } : input.draft;
  if (input.base.projectId !== projectId || draft.projectId !== projectId) throw Object.assign(new Error('The settings belong to another project.'), { status: 400 });
  const { schema: _schema, projectId: _project, revision: _revision, ...settings } = draft; void _schema; void _project; void _revision;
  return { base: input.base, statusOnly, presence: input.schema === 'project-settings-editor-save-v1' ? input.secretPresence : {},
    request: ProjectWorkSettingsRequestSchema.parse({ schema: 'project-work-settings-request-v1', revision: input.base.revision, settings,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}) }) };
}
/** Plans contain names and fixed existing vault routes, never password values. Canonical settings may be newer after a replay. */
export function settingsEditorSaved(base: ProjectWorkSettings, settingsView: z.infer<typeof ProjectWorkSettingsViewSchema>, presence: Record<string, boolean>, statusOnly: boolean) {
  const saved = settingsView.settings, secretSteps: ProjectSettingsEditorSaved['secretSteps'] = [];
  const path = (name: string) => `/api/projects/${saved.projectId}/env-secrets/${encodeURIComponent(name)}`;
  if (!statusOnly) {
    for (const name of base.environment.secrets.filter(name => !saved.environment.secrets.includes(name))) secretSteps.push({ kind: 'delete', name, path: path(name), method: 'DELETE', body: { schema: 'empty-request-v1' } });
    for (const name of saved.environment.secrets) if (presence[name]) secretSteps.push({ kind: 'write', name, path: path(name), method: 'PUT', body: { schema: 'save-secret-v1' } });
  }
  return ProjectSettingsEditorSavedSchema.parse({ schema: 'project-settings-editor-saved-v1', settingsView, secretSteps,
    statusPatch: statusOnly ? { status: saved.status, revision: saved.revision } : null, backPath: `/projects/${saved.projectId}`, savedNotice });
}
