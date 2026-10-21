import { createHash } from 'node:crypto';
import { EffortSchema, ProjectPlacementEditorPreviewSchema, ProjectPlacementEditorSchema, ProjectPlacementSettingsSchema, newId, stableJson,
  type Configuration, type ProjectWorkSettings } from '@jevellan/core';
import { projectConfigurationInfo } from './project-configuration.js';
import { SETTINGS_CHANGED } from './copy.js';

/** Readonly draft preparation; the normal settings writer remains the only mutation authority. */
export function placementEditor(settings: ProjectWorkSettings, configuration: Configuration['x-jevellan'], raw?: unknown) {
  const input = raw === undefined ? undefined : ProjectPlacementEditorPreviewSchema.parse(raw);
  if (input && input.projectId !== settings.projectId) throw Object.assign(new Error('The placement choices belong to another project.'), { status: 400 });
  if (input && input.revision !== settings.revision) throw Object.assign(new Error(SETTINGS_CHANGED), { status: 409 });
  const models = configuration.menu.filter(model => model.enabled).map(model => ({ id: model.id, label: model.label })), restrictedModelIds = models.map(model => model.id);
  const fields = input?.fields ?? { allModels: settings.placement.allowedModelIds === null, modelIds: settings.placement.allowedModelIds ?? restrictedModelIds,
    minEffort: settings.placement.minEffort ?? '', guidance: settings.placement.guidance };
  const parsed = ProjectPlacementSettingsSchema.safeParse({ allowedModelIds: fields.allModels ? null : fields.modelIds, minEffort: fields.minEffort || null, guidance: fields.guidance });
  const base = { schema: 'project-placement-editor-preview-v1' as const, projectId: settings.projectId, revision: settings.revision, clientRequestId: input?.clientRequestId ?? newId('placementform') };
  const clientRequestId = `placement_${createHash('sha256').update(stableJson({ base, fields })).digest('hex').slice(0, 40)}`;
  const { schema: _schema, projectId, revision, ...kept } = settings; void _schema;
  const path = `/api/projects/${projectId}/config/placement-editor`;
  return ProjectPlacementEditorSchema.parse({ schema: 'project-placement-editor-v1', projectId, fields, models, restrictedModelIds,
    modelsLabel: 'Models threads may use', allModelsLabel: 'All enabled models', effortLabel: 'Lowest effort for threads',
    efforts: [{ value: '', label: 'No minimum' }, ...EffortSchema.options.map(value => ({ value, label: ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[value] }))],
    guidance: { label: 'Guidance for Jev', ...projectConfigurationInfo().guidance },
    apply: { enabled: parsed.success, errors: parsed.success ? [] : parsed.error.issues.map(issue => ({ field: String(issue.path[0] ?? 'placement'), message: issue.message })).slice(0, 100) },
    patch: parsed.success ? parsed.data : null,
    saveRequest: parsed.success ? { schema: 'project-placement-editor-save-v1', projectId,
      settingsRequest: { schema: 'project-work-settings-request-v1', revision, clientRequestId, settings: { ...kept, placement: parsed.data } } } : null,
    request: { previewPath: path, savePath: `/api/projects/${projectId}/config/placement-save`, base },
  });
}
