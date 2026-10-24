import {projectSettingsSetupMetadata} from '@jevellan/core';
import { ProjectSettingsEditorBaseSchema, ProjectSettingsEditorSaveRequestSchema, ProjectSettingsEditorSavedSchema, ProjectWorkSettingsRequestSchema,
  ProjectSettingsControlsSchema, ProjectSettingsRiggingSchema, ProjectWorkSettingsSchema, ProjectPrAutoFixSettingsSchema, SessionCheckpointSettingsSchema,
  DeviceRosterSchema, type ProjectWorkSettings, type ProjectSettingsEditorSaved } from '@jevellan/core';
import { z } from 'zod';
import type { ProjectWorkSettingsViewSchema, ProjectWorkViewSchema, RiggingViewSchema } from '@jevellan/core';

const savedNotice = 'Project settings saved.';
/** Match the existing project summary: owned scope applies independently of runtime enablement. */
export function settingsEditorRigging(projectId: string, rows: readonly z.infer<typeof RiggingViewSchema>[]) {
  const names = rows.filter(row => row.item.state === 'owned' && (!row.item.projects?.length || row.item.projects.includes(projectId))).map(row => row.item.name);
  return ProjectSettingsRiggingSchema.parse({ schema: 'project-settings-rigging-v1', names,
    message: names.length ? `Rigging for this project: ${names.join(', ')}` : 'No rigging items apply to this project.', editPath: '/settings/rigging' });
}
/** Resource offers and HTML affordances derive from the canonical writer's schemas. */
export function settingsEditorControls(roster: z.infer<typeof DeviceRosterSchema>) {
  const shape = ProjectWorkSettingsSchema.shape;
  const number = (label: string, schema: z.ZodNumber) => { const json = z.toJSONSchema(schema); return { label, min: json.minimum, max: json.maximum, step: 1 }; };
  return ProjectSettingsControlsSchema.parse({ schema: 'project-settings-controls-v1', numbers: {
    maxRunningThreads: number('Max running threads', shape.maxRunningThreads), maxRunningPerDevice: number('Max per device', shape.maxRunningPerDevice),
    threadTurnCap: number('Turn limit per thread', shape.threadTurnCap), maxNewThreadsPerDay: number('New threads per day', shape.maxNewThreadsPerDay.removeDefault()),
    compactAtPercent: number('Thread compaction at (%)', shape.compactAtPercent.removeDefault()), coordinatorHandoffAtPercent: number('Coordinator session reset at (%)', shape.coordinatorHandoffAtPercent.removeDefault()),
    checkpointMinTokens: number('Checkpoint minimum context tokens', SessionCheckpointSettingsSchema.shape.checkpointMinTokens),
    perDeviceLimit: number('Per-device limit', shape.perDeviceLimits.removeDefault().valueType), maxRounds: number('Automatic fixes per pull request', ProjectPrAutoFixSettingsSchema.shape.maxRounds),
  }, startModes: [{ value: 'start', label: 'Start threads right away' }, { value: 'propose', label: 'Propose threads and wait for me' }],
    devices: roster.devices.filter(row => !row.revoked && row.device.workPolicy?.mode !== 'apps-only').map(row => ({ id: row.device.id, label: `Limit on ${row.device.name}` })),
    defaultLimitPrefix: 'Default: ', automaticFixes: [{ key: 'checks', label: 'Fix failing checks automatically' }, { key: 'conflicts', label: 'Resolve conflicts automatically' }, { key: 'comments', label: 'Address review comments automatically' }],
    riskyAreasMaxLength: z.toJSONSchema(shape.riskyAreas.removeDefault()).maxLength,
  });
}
/** Section order and status choices belong to the server; browser draft/reset state stays local. */
export function settingsEditorBase(settingsView: z.infer<typeof ProjectWorkSettingsViewSchema>, work: z.infer<typeof ProjectWorkViewSchema>, roster: z.infer<typeof DeviceRosterSchema>) {
  return ProjectSettingsEditorBaseSchema.parse({ schema: 'project-settings-editor-base-v1', settingsView, work,
    sections: [['general', 'General'], ['instructions', 'Instructions'], ['placement', 'Placement'], ['limits', 'Threads and limits'], ['pull-requests', 'Landing'],
      ['environment', 'Environment'], ['routines', 'Routines'], ['health', 'Health checks'], ['notifications', 'Notifications'], ['usage', 'Usage'], ['automation', 'Automation']].map(([key, label]) => ({ key, label })),
    statusOptions: [['active', 'Active'], ['paused', 'Paused'], ['archived', 'Archived']].map(([value, label]) => ({ value, label })),
    savePath: `/api/projects/${settingsView.settings.projectId}/config/editor`, backPath: `/projects/${settingsView.settings.projectId}`, savedNotice, controls: settingsEditorControls(roster), specialSetup: projectSettingsSetupMetadata(work.project.id, work.project.name),
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
    checkPresence: input.schema === 'project-settings-editor-save-v1' ? input.checkSecretPresence : {},
    request: ProjectWorkSettingsRequestSchema.parse({ schema: 'project-work-settings-request-v1', revision: input.base.revision, settings,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}) }) };
}
/** Plans contain names and fixed existing vault routes, never password values. Canonical settings may be newer after a replay. */
export function settingsEditorSaved(base: ProjectWorkSettings, settingsView: z.infer<typeof ProjectWorkSettingsViewSchema>, presence: Record<string, boolean>, statusOnly: boolean, checkPresence: Record<string, boolean> = {}) {
  const saved = settingsView.settings, secretSteps: ProjectSettingsEditorSaved['secretSteps'] = [];
  const path = (name: string) => `/api/projects/${saved.projectId}/env-secrets/${encodeURIComponent(name)}`;
  if (!statusOnly) {
    for (const name of base.environment.secrets.filter(name => !saved.environment.secrets.includes(name))) secretSteps.push({ kind: 'delete', name, path: path(name), method: 'DELETE', body: { schema: 'empty-request-v1' } });
    for (const name of saved.environment.secrets) if (presence[name]) secretSteps.push({ kind: 'write', name, path: path(name), method: 'PUT', body: { schema: 'save-secret-v1' } });
    const checkNames = saved.checkEnvironment?.secrets ?? [];
    for (const name of base.checkEnvironment?.secrets ?? []) if (!checkNames.includes(name)) secretSteps.push({ kind: 'delete', purpose: 'check', name, path: path(name) + '?purpose=check', method: 'DELETE', body: { schema: 'empty-request-v1' } });
    for (const name of checkNames) if (checkPresence[name]) secretSteps.push({ kind: 'write', purpose: 'check', name, path: path(name) + '?purpose=check', method: 'PUT', body: { schema: 'save-secret-v1' } });
  }
  return ProjectSettingsEditorSavedSchema.parse({ schema: 'project-settings-editor-saved-v1', settingsView, secretSteps,
    statusPatch: statusOnly ? { status: saved.status, revision: saved.revision } : null, backPath: `/projects/${saved.projectId}`, savedNotice });
}
