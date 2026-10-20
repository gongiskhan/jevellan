import { z } from 'zod';
import { EffortSchema, ProjectThreadOverrideEditorSchema, ThreadOverrideEditorPreviewSchema, ThreadOverrideEditorSaveSchema, ThreadOverrideRequestSchema, newId, mapEffort,
  type Effort, type Isolation, type ModelOption, type ProjectWorkView, type ThreadView, type ThreadOverrideEditorFields } from '@jevellan/core';
import { REMOTE_NOT_AVAILABLE, THREAD_ENDED } from './copy.js';

export const NEXT_TURN_HELP = 'The model and effort change for the next turn; a running turn finishes as it started.';
export const RESTART_HELP = 'This thread stops and its worktree is removed. A new thread with the same title and task starts with these choices.';
export const RESTART_HELP_MAIN = 'This thread stops, and commits it has not published are saved under refs/jevellan/discard. A new thread with the same title and task starts with these choices.';
export const RESTART_HELP_MANUAL = 'This thread stops and its edits stay in your checkout. A new thread starts with the same title and task. Git is left to you.';
export function restartHelp(view: Pick<ThreadView, 'thread' | 'canOverride'>, branchPolicy: 'main' | 'external'): string {
  return !view.canOverride.restart ? view.canOverride.restartReason ?? THREAD_ENDED : branchPolicy === 'external' ? RESTART_HELP_MANUAL : view.thread.isolation === 'main' ? RESTART_HELP_MAIN : RESTART_HELP;
}
export function overrideOffered(view: Pick<ThreadView, 'canOverride'>): boolean { return view.canOverride.nextTurn || view.canOverride.restart; }
export function nearestEffort(requested: Effort, supported: readonly Effort[]): Effort { return supported.length ? mapEffort(requested, [...supported]) : requested; }
export function effortChoices(supported: readonly Effort[] | undefined, requested: Effort): Array<{ effort: Effort; runsAs?: Effort }> {
  return EffortSchema.options.filter(effort => !supported || supported.includes(effort) || effort === requested)
    .map(effort => !supported || supported.includes(effort) ? { effort } : { effort, runsAs: nearestEffort(effort, supported) });
}
export type OverrideMode = 'next-turn' | 'restart';
export type OverrideForm = { mode: OverrideMode; isolation: '' | Isolation; modelId: string; effort: '' | Effort; deviceId: string; note: string };
export function overrideForm(view: Pick<ThreadView, 'thread' | 'placement' | 'canOverride'>): OverrideForm {
  return { mode: view.canOverride.nextTurn ? 'next-turn' : 'restart', isolation: 'worktree', modelId: view.placement.modelId,
    effort: view.placement.effortRequested, deviceId: view.thread.ownerDeviceId, note: '' };
}
export function overrideRequest(view: Pick<ThreadView, 'placement'>, form: OverrideForm) {
  const note = form.note.trim(), base = { schema: 'thread-override-request-v1' as const, mode: form.mode, ...(note ? { note: note.slice(0, 400) } : {}) };
  return form.mode === 'next-turn' ? { ...base, ...(form.modelId && form.modelId !== view.placement.modelId ? { modelId: form.modelId } : {}),
    ...(form.effort && form.effort !== view.placement.effortRequested ? { effort: form.effort } : {}) }
    : { ...base, ...(form.isolation ? { isolation: form.isolation } : {}), ...(form.modelId ? { modelId: form.modelId } : {}), ...(form.effort ? { effort: form.effort } : {}), ...(form.deviceId ? { deviceId: form.deviceId } : {}) };
}
export function overrideReady(view: Pick<ThreadView, 'placement' | 'canOverride'>, form: OverrideForm): boolean {
  if (form.mode === 'restart') return view.canOverride.restart;
  const request = overrideRequest(view, form); return view.canOverride.nextTurn && ('modelId' in request || 'effort' in request);
}
/** Mode/model transitions are engine rules; the browser supplies only the explicit changed control. */
function normalize(view: ThreadView, menu: readonly ModelOption[], fields: ThreadOverrideEditorFields, changed?: string) {
  let next = { ...fields };
  if (changed === 'mode' && next.mode === 'next-turn') next = { ...next,
    modelId: menu.some(entry => entry.id === next.modelId && entry.runtime === view.placement.runtime) ? next.modelId : view.placement.modelId,
    effort: next.effort || view.placement.effortRequested };
  const model = menu.find(entry => entry.id === next.modelId);
  if (next.effort && model && !effortChoices(model.efforts, view.placement.effortRequested).some(choice => choice.effort === next.effort)) next.effort = nearestEffort(next.effort, model.efforts);
  return next;
}
type Roster = readonly { device: { id: string; name: string }; status: 'online' | 'stale' | 'offline'; revoked: boolean }[];
function devices(work: ProjectWorkView, roster: Roster, here: string, selected: string) {
  const block = (id: string) => id === here || work.gates.remoteDevices ? null : REMOTE_NOT_AVAILABLE;
  const choices = work.devices ? work.devices.map(entry => ({ value: entry.deviceId, label: entry.reason ? `${entry.name}: ${entry.reason}` : entry.name, disabled: !!entry.reason || block(entry.deviceId) !== null }))
    : roster.filter(row => !row.revoked && (row.device.id === here || row.status !== 'offline')).map(row => ({ value: row.device.id, label: row.device.name, disabled: block(row.device.id) !== null }));
  if (selected && !choices.some(row => row.value === selected)) choices.push({ value: selected, label: roster.find(row => row.device.id === selected)?.device.name ?? selected, disabled: true });
  return { choices, notice: choices.map(row => block(row.value)).find(reason => reason !== null) ?? null };
}
export function overrideEditorView(projectId: string, view: ThreadView, work: ProjectWorkView, menu: readonly ModelOption[], roster: Roster, here: string,
  modelName: (id: string) => string, raw?: unknown) {
  const preview = raw === undefined ? null : ThreadOverrideEditorPreviewSchema.parse(raw);
  const fields = normalize(view, menu, preview?.fields ?? { ...overrideForm(view), isolation: 'worktree' }, preview?.changed), restart = fields.mode === 'restart';
  const listed = menu.filter(entry => entry.enabled || entry.id === view.placement.modelId), device = devices(work, roster, here, fields.deviceId);
  const enabled = overrideReady(view, fields), path = `/api/projects/${projectId}/threads/${view.thread.id}/override-editor`;
  const noteMax = (z.toJSONSchema(ThreadOverrideRequestSchema.shape.note, { io: 'input' }) as { maxLength: number }).maxLength;
  return ProjectThreadOverrideEditorSchema.parse({ schema: 'project-thread-override-editor-v1', projectId, threadId: view.thread.id, fields,
    choices: { modes: [{ value: 'next-turn', label: 'From the next turn', enabled: view.canOverride.nextTurn, help: view.canOverride.nextTurn ? NEXT_TURN_HELP : THREAD_ENDED },
      { value: 'restart', label: 'Restart with these choices', enabled: view.canOverride.restart, help: restartHelp(view, work.project.branchPolicy) }],
      models: [...(restart ? [{ value: '', label: 'Automatic' }] : []), ...listed.filter(entry => restart || entry.runtime === view.placement.runtime).map(entry => ({ value: entry.id, label: modelName(entry.id) }))],
      efforts: [...(restart ? [{ value: '', label: 'Automatic' }] : []), ...effortChoices(menu.find(entry => entry.id === fields.modelId)?.efforts, view.placement.effortRequested).map(choice => ({ value: choice.effort, label: choice.runsAs ? `${choice.effort} (runs as ${choice.runsAs})` : choice.effort }))],
      devices: [{ value: '', label: 'Automatic', disabled: false }, ...device.choices] }, showDevice: restart, deviceNotice: device.notice, constraints: { noteMax },
    apply: { enabled, tone: restart ? 'danger' : 'normal', refusal: enabled ? null : restart ? view.canOverride.restartReason ?? THREAD_ENDED : view.canOverride.nextTurn ? 'Choose a different model or effort.' : THREAD_ENDED },
    request: { previewPath: `${path}/preview`, savePath: path, base: { schema: 'thread-override-editor-save-request-v1', clientRequestId: newId('oform') } } });
}
/** The canonical writer handles resources and retries even after the editor's old eligibility has changed. */
export function overrideEditorRequest(view: ThreadView, menu: readonly ModelOption[], raw: unknown) {
  const input = ThreadOverrideEditorSaveSchema.parse(raw), fields = normalize(view, menu, input.fields);
  return ThreadOverrideRequestSchema.parse({ ...overrideRequest(view, fields), clientRequestId: input.clientRequestId });
}
