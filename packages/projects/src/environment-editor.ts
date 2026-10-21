import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PROJECT_ENV_NAME_MAX_LENGTH, ProjectEnvironmentSchema, ProjectEnvironmentEditorPreviewSchema, ProjectEnvironmentEditorSchema, ProjectEnvironmentPatchSchema,
  ProjectEnvSecretSummarySchema, ProjectRelativePathSchema, ProjectWorkSettingsSchema, newId, stableJson, type ProjectEnvSecretSummary, type ProjectWorkSettings } from '@jevellan/core';
import { SETTINGS_CHANGED } from './copy.js';

/** Adds display parts to a value-free vault acknowledgement; older plain summaries remain valid. */
export function environmentSecretSummary(summary: ProjectEnvSecretSummary) {
  return ProjectEnvSecretSummarySchema.parse({ ...summary, presentation: { schema: 'project-env-secret-presentation-v1', parts: summary.saved
    ? summary.updatedAt ? [{ kind: 'text', text: 'Saved · updated ' }, { kind: 'time', at: summary.updatedAt }] : [{ kind: 'text', text: 'Saved' }]
    : [{ kind: 'text', text: 'Not set' }] } });
}
const limits = { variables: Number(z.toJSONSchema(ProjectEnvironmentSchema.shape.variables).maxItems), secrets: Number(z.toJSONSchema(ProjectEnvironmentSchema.shape.secrets).maxItems),
  copyFiles: Number(z.toJSONSchema(ProjectEnvironmentSchema.shape.copyFiles).maxItems), name: PROJECT_ENV_NAME_MAX_LENGTH,
  value: Number(z.toJSONSchema(ProjectEnvironmentSchema.shape.variables.element.shape.value).maxLength),
  setupCommand: Number(z.toJSONSchema(ProjectWorkSettingsSchema.shape.setupCommand.unwrap()).maxLength), copyPath: Number(z.toJSONSchema(ProjectRelativePathSchema).maxLength) };
/** Normalizes raw form text only; secret password values never enter this protocol. */
export function environmentEditor(settings: ProjectWorkSettings, raw?: unknown) {
  const input = raw === undefined ? undefined : ProjectEnvironmentEditorPreviewSchema.parse(raw);
  if (input && input.projectId !== settings.projectId) throw Object.assign(new Error('The environment belongs to another project.'), { status: 400 });
  if (input && input.revision !== settings.revision) throw Object.assign(new Error(SETTINGS_CHANGED), { status: 409 });
  const fields = input?.fields ?? { setupCommand: settings.setupCommand ?? '', copyFiles: settings.environment.copyFiles.join('\n'), variables: settings.environment.variables, secrets: settings.environment.secrets };
  const parsed = ProjectEnvironmentPatchSchema.safeParse({ setupCommand: fields.setupCommand || null, environment: {
    variables: fields.variables, secrets: fields.secrets, copyFiles: fields.copyFiles.split('\n').map(line => line.trim()).filter(Boolean) } });
  const base = { schema: 'project-environment-editor-preview-v1' as const, projectId: settings.projectId, revision: settings.revision, clientRequestId: input?.clientRequestId ?? newId('envform') };
  const clientRequestId = `environment_${createHash('sha256').update(stableJson({ base, fields })).digest('hex').slice(0, 40)}`;
  const { schema: _schema, projectId, revision, ...kept } = settings; void _schema;
  return ProjectEnvironmentEditorSchema.parse({ schema: 'project-environment-editor-v1', projectId, fields, limits,
    canAddVariable: fields.variables.length < limits.variables, canAddSecret: fields.secrets.length < limits.secrets, newVariable: { name: '', value: '' }, newSecret: '',
    copyHelp: 'One path per line, relative to the project folder, for example .env.local. Missing files are skipped. Jevellan never commits them.',
    secretHelp: 'Variables and secrets reach the setup command, threads, verification and jobs. Secret values stay in the hub vault and are redacted from transcripts.',
    notSetStatus: { schema: 'project-env-secret-presentation-v1', parts: [{ kind: 'text', text: 'Not set' }] },
    unavailableStatus: { schema: 'project-env-secret-presentation-v1', parts: [{ kind: 'text', text: 'Secret status unavailable.' }] },
    apply: { enabled: parsed.success, errors: parsed.success ? [] : parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })).slice(0, 100) },
    patch: parsed.success ? parsed.data : null,
    saveRequest: parsed.success ? { schema: 'project-environment-editor-save-v1', projectId,
      settingsRequest: { schema: 'project-work-settings-request-v1', revision, clientRequestId, settings: { ...kept, ...parsed.data } } } : null,
    request: { previewPath: `/api/projects/${projectId}/config/environment-editor`, savePath: `/api/projects/${projectId}/config/environment-save`, base },
  });
}
