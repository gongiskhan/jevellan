import { createHash } from 'node:crypto';
import { EffortSchema, ProjectCoordinatorEditorSchema, ProjectCoordinatorEditorPreviewSchema, mapEffort, newId, stableJson,
  type Configuration, type ProjectWorkView } from '@jevellan/core';
import { SETTINGS_CHANGED } from './copy.js';

export function coordinatorEditor(view: ProjectWorkView, configuration: Configuration['x-jevellan'], runtimeName: (id: string) => string, raw?: unknown) {
  const input = raw === undefined ? undefined : ProjectCoordinatorEditorPreviewSchema.parse(raw);
  if (input && input.projectId !== view.project.id) throw Object.assign(new Error('The coordinator choices belong to another project.'), { status: 400 });
  if (input && input.revision !== view.settings.revision) throw Object.assign(new Error(SETTINGS_CHANGED), { status: 409 });
  const { schema: _schema, projectId: _project, revision, ...settings } = view.settings; void _schema; void _project;
  const fields = input?.fields ?? { modelId: settings.coordinator.modelId ?? '', effort: settings.coordinator.effort, fresh: false };
  const listed = configuration.menu.filter(model => model.enabled || model.id === fields.modelId), selected = listed.find(model => model.id === fields.modelId);
  const current = fields.modelId === settings.coordinator.modelId, available = selected?.enabled === true && configuration.runtimes[selected.runtime]?.enabled === true;
  const actual = selected?.efforts.length ? mapEffort(fields.effort, selected.efforts) : fields.effort;
  const freshEnabled = view.coordinator.online;
  const refusal = fields.modelId && !current && !available ? 'Choose an available model.' : fields.fresh && !freshEnabled ? 'Fresh is unavailable while the coordinator is not online.' : null;
  const base = { schema: 'project-coordinator-editor-preview-v1' as const, projectId: view.project.id, revision, clientRequestId: input?.clientRequestId ?? newId('cform'),
    ...(input?.presentation ? { presentation: input.presentation } : {}) };
  const clientRequestId = `cset_${createHash('sha256').update(stableJson({ base, fields })).digest('hex').slice(0, 40)}`;
  const path = `/api/projects/${view.project.id}/coordinator/editor`;
  return ProjectCoordinatorEditorSchema.parse({ schema: 'project-coordinator-editor-v1', projectId: view.project.id, revision, fields,
    models: [{ value: '', label: input?.presentation ? 'Automatic: first available' : 'Automatic — first available', disabled: false }, ...listed.map(model => ({ value: model.id, label: input?.presentation ? model.label : `${runtimeName(model.runtime)} ${model.label}`, disabled: !model.enabled || !configuration.runtimes[model.runtime]?.enabled })),
      ...(fields.modelId && !selected && current ? [{ value: fields.modelId, label: `${fields.modelId} (unavailable)`, disabled: true }] : [])],
    efforts: EffortSchema.options.map(value => ({ value, label: input?.presentation ? ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[value] : value })), effectiveEffort: { requested: fields.effort, actual,
      line: actual === fields.effort ? null : `${fields.effort} → ${actual}: nearest effort this model supports.` }, freshEnabled,
    help: 'These choices apply from the next turn. The current turn can finish.',
    sessionHelp: 'A model or effort change starts a fresh session when needed. The project notebook and recent messages carry over.',
    savedNotice: 'Coordinator choices saved. They apply from the next turn.', apply: { enabled: refusal === null, refusal },
    request: { previewPath: `${path}/preview`, savePath: path, base },
    saveRequest: refusal ? null : { schema: 'project-coordinator-editor-save-v1', projectId: view.project.id,
      settingsRequest: { schema: 'project-work-settings-request-v1', revision, clientRequestId,
        settings: { ...settings, coordinator: { ...settings.coordinator, modelId: fields.modelId || null, effort: fields.effort } } }, fresh: fields.fresh },
  });
}
