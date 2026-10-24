import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PROJECT_ENV_NAME_MAX_LENGTH, ProjectEnvironmentPurposeSchema, ProjectEnvironmentSchema, ProjectEnvironmentEditorPreviewSchema, ProjectEnvironmentEditorSchema, ProjectEnvironmentPatchSchema,
  ProjectEnvSecretSummarySchema, ProjectRelativePathSchema, ProjectWorkSettingsSchema, newId, stableJson, type ProjectEnvironmentPurpose, type ProjectEnvSecretSummary, type ProjectWorkSettings } from '@jevellan/core';
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
export function environmentEditor(settings: ProjectWorkSettings, raw?: unknown, requestedPurpose: ProjectEnvironmentPurpose = 'work') {
  const input = raw === undefined ? undefined : ProjectEnvironmentEditorPreviewSchema.parse(raw);
  if (input && input.projectId !== settings.projectId) throw Object.assign(new Error('The environment belongs to another project.'), { status: 400 });
  if (input && input.revision !== settings.revision) throw Object.assign(new Error(SETTINGS_CHANGED), { status: 409 });
  const purpose = ProjectEnvironmentPurposeSchema.parse(input?.purpose ?? requestedPurpose), check = purpose === 'check', profile = settings.checkEnvironment;
  const fields = input?.fields ?? (check ? { enabled: Boolean(profile), setupCommand: settings.setupCommand ?? '',
    copyFiles: profile?.copyFiles.map(file => `${file.source} => ${file.target}`).join('\n') ?? '', variables: profile?.variables ?? [], secrets: profile?.secrets ?? [] }
    : { setupCommand: settings.setupCommand ?? '', copyFiles: settings.environment.copyFiles.join('\n'), variables: settings.environment.variables, secrets: settings.environment.secrets });
  const lines = fields.copyFiles.split('\n').map(line => line.trim()).filter(Boolean);
  const parsed = ProjectEnvironmentPatchSchema.safeParse(check ? { checkEnvironment: fields.enabled ? { schema: 'project-check-environment-v1',
    variables: fields.variables, secrets: fields.secrets, copyFiles: lines.map(line => { const parts = line.split('=>').map(part => part.trim()); return { source: parts[0], target: parts.length === 1 ? parts[0] : parts.slice(1).join('=>') }; }) } : null }
    : { setupCommand: fields.setupCommand || null, environment: { variables: fields.variables, secrets: fields.secrets, copyFiles: lines } });
  const base = { schema: 'project-environment-editor-preview-v1' as const, projectId: settings.projectId, revision: settings.revision, purpose, clientRequestId: input?.clientRequestId ?? newId('envform') };
  const clientRequestId = `environment_${createHash('sha256').update(stableJson({ base, fields })).digest('hex').slice(0, 40)}`;
  const { schema: _schema, projectId, revision, ...kept } = settings; void _schema;
  return ProjectEnvironmentEditorSchema.parse({ schema: 'project-environment-editor-v1', projectId, purpose, fields, limits,
    labels: check ? { title: 'Check environment', enable: 'Use a separate check environment', setup: null, setupPlaceholder: 'npm ci', copy: 'Check files', variables: 'Check variables', secrets: 'Check secrets', name: 'Name', value: 'Value',
      addVariable: 'Add check variable', addSecret: 'Add check secret', remove: 'Remove', variableName: 'Check variable name {number}', variableValue: 'Check variable value {number}', secretName: 'Check secret name {number}', secretValue: 'Check secret value {number}', removeVariable: 'Remove check variable {number}', removeSecret: 'Remove check secret {number}' }
      : { title: 'Work environment', enable: null, setup: 'Worktree setup command', setupPlaceholder: 'npm ci', copy: 'Copy these untracked files into new worktrees', variables: 'Variables', secrets: 'Secrets', name: 'Name', value: 'Value',
        addVariable: 'Add variable', addSecret: 'Add secret', remove: 'Remove', variableName: 'Variable {number} name', variableValue: 'Variable {number} value', secretName: 'Secret {number} name', secretValue: 'Secret {number} value', removeVariable: 'Remove variable {number}', removeSecret: 'Remove secret {number}' },
    canAddVariable: fields.variables.length < limits.variables, canAddSecret: fields.secrets.length < limits.secrets, newVariable: { name: '', value: '' }, newSecret: '',
    copyHelp: check ? 'Use separate test files, one source => target per line, relative to the project folder. A single path copies to the same path. Missing files block checks. Work input files are never copied into checks.' : 'One path per line, relative to the project folder, for example .env.local. Missing files are skipped. Jevellan never commits them.',
    secretHelp: check ? 'Only these variables, secrets and files reach verification and landing checks. The same setup command runs with these inputs in a fresh checkout. Save check credentials separately; work secrets are never reused.' : 'Variables and secrets reach work setup, threads and jobs. Verification and landing use the separate check environment. Secret values stay in the hub vault and are redacted from transcripts.',
    notSetStatus: { schema: 'project-env-secret-presentation-v1', parts: [{ kind: 'text', text: 'Not set' }] },
    unavailableStatus: { schema: 'project-env-secret-presentation-v1', parts: [{ kind: 'text', text: 'Secret status unavailable.' }] },
    apply: { enabled: parsed.success, errors: parsed.success ? [] : parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })).slice(0, 100) },
    patch: parsed.success ? parsed.data : null,
    saveRequest: parsed.success ? { schema: 'project-environment-editor-save-v1', projectId,
      settingsRequest: { schema: 'project-work-settings-request-v1', revision, clientRequestId, settings: { ...kept, ...parsed.data } } } : null,
    request: { previewPath: `/api/projects/${projectId}/config/environment-editor`, savePath: `/api/projects/${projectId}/config/environment-save`, base },
  });
}
