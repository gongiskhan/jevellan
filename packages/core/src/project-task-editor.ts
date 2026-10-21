import { z } from 'zod';
import { EffortSchema } from './schemas.js';
import type { DeviceRosterSchema } from './mesh-schemas.js';
import { TaskCreateRequestSchema, TaskTypeSchema } from './project-loop-schemas.js';
import type { ProjectWorkView } from './project-schemas.js';
import type { ProjectWorkTask } from './project-loop-schemas.js';
import type { ProjectCoordinatorUiSchema } from './project-page-schemas.js';
import { deviceChoices, deviceBlock, MAIN_NOT_AVAILABLE } from './project-device-choices.js';
import { ProjectTaskEditorFieldsSchema, ProjectTaskEditorPreviewSchema, ProjectTaskEditorSchema, ProjectTaskEditorSaveSchema, ProjectTaskEditorCommandSchema, type ProjectTaskEditorFields } from './project-task-editor-schemas.js';
export function taskEditorFields(): ProjectTaskEditorFields { return { title: '', task: '', isolation: '', modelId: '', effort: '', deviceId: '', type: 'feature', goalId: '', now: false, after: [], needs: '', fromBranch: '' }; }
export function taskEditorCommand(raw: ProjectTaskEditorFields, models: readonly { id: string; efforts: readonly string[] }[], command: z.infer<typeof ProjectTaskEditorCommandSchema>): ProjectTaskEditorFields {
  const fields = ProjectTaskEditorFieldsSchema.parse(raw), input = ProjectTaskEditorCommandSchema.parse(command), next = models.find(row => row.id === input.value);
  return { ...fields, modelId: input.value, ...(next && fields.effort && !next.efforts.includes(fields.effort) ? { effort: '' } : {}) };
}
function body(fields: ProjectTaskEditorFields) {
  if (fields.isolation === 'main') throw Object.assign(new Error(MAIN_NOT_AVAILABLE), { status: 400 });
  const { schema, clientRequestId, ...result } = TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: 'task_editor_preparation', title: fields.title.trim(), brief: fields.task.trim(), type: fields.type, goalId: fields.goalId || null, now: fields.now, after: fields.after, needs: fields.needs.split(',').map(value => value.trim()).filter(Boolean), ...(fields.fromBranch.trim() ? { fromBranch: fields.fromBranch.trim() } : {}),
    fixed: { ...(fields.isolation ? { isolation: fields.isolation } : {}), ...(fields.modelId ? { modelId: fields.modelId } : {}), ...(fields.effort ? { effort: fields.effort } : {}), ...(fields.deviceId ? { deviceId: fields.deviceId } : {}) } });
  void schema; void clientRequestId; return { schema: 'task-create-request-v1' as const, ...result };
}
export function prepareTaskEditorSave(raw: unknown) { const input = ProjectTaskEditorSaveSchema.parse(raw); return TaskCreateRequestSchema.parse({ ...body(input.fields), clientRequestId: input.clientRequestId }); }
export function taskEditorView(input: { work: ProjectWorkView; deviceId: string; roster: z.infer<typeof DeviceRosterSchema>; models: { id: string; label: string; efforts: z.infer<typeof EffortSchema>[] }[]; tasks: ProjectWorkTask[]; goals: { goal: { id: string; name: string; state: string } }[]; coordinator: z.infer<typeof ProjectCoordinatorUiSchema> }, raw?: unknown) {
  const preview = raw === undefined ? undefined : ProjectTaskEditorPreviewSchema.parse(raw), initial = preview?.fields ?? taskEditorFields(), fields = preview?.command ? taskEditorCommand(initial, input.models, preview.command) : initial;
  const devices = deviceChoices(input.work, input.roster.devices, input.deviceId, fields.deviceId), validation: string[] = []; let plan = null;
  try { plan = { path: `/api/projects/${input.work.project.id}/tasks`, method: 'POST' as const, body: body(fields) }; }
  catch (error) {
    const labels: Record<string, string> = { title: 'Title', brief: 'Brief', fromBranch: 'From branch', type: 'Type', goalId: 'Goal', now: 'Start now', after: 'After', needs: 'Needs', fixed: 'Placement' };
    if (error instanceof z.ZodError) validation.push(...error.issues.map(issue => `${labels[String(issue.path[0])] ?? 'Task'}: ${issue.message}`));
    else validation.push(error instanceof Error ? error.message : 'Check the task fields.');
  }
  return ProjectTaskEditorSchema.parse({ schema: 'project-task-editor-v1', projectId: input.work.project.id, currentDeviceId: input.deviceId, fields, models: input.models, efforts: input.models.find(row => row.id === fields.modelId)?.efforts ?? EffortSchema.options, devices,
    goals: input.goals.filter(row => row.goal.state !== 'done').map(row => ({ id: row.goal.id, label: row.goal.name })), afterTasks: input.tasks.filter(row => row.state !== 'done' && row.state !== 'cancelled').map(row => ({ id: row.id, label: row.title })), types: TaskTypeSchema.options,
    limits: { title: TaskCreateRequestSchema.shape.title.maxLength, task: TaskCreateRequestSchema.shape.brief.maxLength, fromBranch: TaskCreateRequestSchema.shape.fromBranch.unwrap().maxLength }, mainIsolationRefusal: MAIN_NOT_AVAILABLE,
    deviceNote: devices.map(row => deviceBlock(input.work, row.id, input.deviceId)).find(reason => reason !== null) ?? null, coordinator: input.coordinator,
    canSave: validation.length === 0 && !input.coordinator.offline, validation, savedNotice: `Queued task "${fields.title}".`, plan,
  });
}
