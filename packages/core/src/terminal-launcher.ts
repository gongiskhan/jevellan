import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { DevicePresenceSchema, type DeviceView } from './mesh-schemas.js';
import { TerminalCreateRequestSchema, TerminalListSchema, TerminalSessionSchema } from './terminal-schemas.js';

export const TerminalOpenInputSchema = z.strictObject({ schema: z.literal('terminal-open-input-v1'), clientRequestId: IdSchema,
  projectId: IdSchema.optional(), threadId: IdSchema.optional(), deviceId: IdSchema.optional(), cwd: TerminalCreateRequestSchema.shape.cwd.default('worktree'),
  title: TerminalCreateRequestSchema.shape.title, takeover: TerminalCreateRequestSchema.shape.takeover })
  .refine(value => !value.takeover || !!(value.threadId && value.projectId), 'Takeover needs a project thread.');
export function terminalOpenCommand(raw: unknown) {
  const input = TerminalOpenInputSchema.parse(raw);
  return TerminalCreateRequestSchema.parse({ ...input, schema: 'terminal-create-request-v1' });
}
export const TerminalOpenResultSchema = z.strictObject({ schema: z.literal('terminal-open-result-v1'), session: TerminalSessionSchema, url: z.string() })
  .refine(value => value.url === `/terminals/${value.session.id}`, 'The terminal link must belong to its session.');
export function terminalOpenResult(raw: unknown) {
  const session = TerminalSessionSchema.parse(raw);
  return TerminalOpenResultSchema.parse({ schema: 'terminal-open-result-v1', session, url: `/terminals/${session.id}` });
}
export const TerminalLauncherPolicySchema = z.strictObject({ schema: z.literal('terminal-launcher-policy-v1'), pollMs: z.number().int().positive(), listFailureNotice: z.string() });
export function terminalLauncherPolicy() { return TerminalLauncherPolicySchema.parse({ schema: 'terminal-launcher-policy-v1', pollMs: 5000, listFailureNotice: 'Open terminals are unavailable.' }); }
export const TerminalLauncherViewRequestSchema = z.strictObject({ schema: z.literal('terminal-launcher-view-request-v1'), projectId: IdSchema.optional(), deviceId: IdSchema.optional() });
export const TerminalLauncherContextSchema = z.strictObject({ schema: z.literal('terminal-launcher-context-v1'), currentDeviceId: IdSchema,
  projectId: IdSchema.optional(), deviceId: IdSchema.optional(), coordinatorDeviceId: IdSchema.optional(),
  devices: z.array(z.strictObject({ id: IdSchema, name: z.string(), status: DevicePresenceSchema, revoked: z.boolean() })),
  threads: z.array(z.strictObject({ id: IdSchema, title: z.string(), ownerDeviceId: IdSchema })) });
export function terminalLauncherContext(roster: { currentDeviceId: string; devices: DeviceView[] }, options: {
  projectId?: string; deviceId?: string; coordinatorDeviceId?: string; threads?: Array<{ id: string; title: string; ownerDeviceId: string }>;
} = {}) {
  return TerminalLauncherContextSchema.parse({ schema: 'terminal-launcher-context-v1', currentDeviceId: roster.currentDeviceId,
    ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.deviceId ? { deviceId: options.deviceId } : {}), ...(options.coordinatorDeviceId ? { coordinatorDeviceId: options.coordinatorDeviceId } : {}),
    devices: roster.devices.map(row => ({ id: row.device.id, name: row.device.name, status: row.status, revoked: row.revoked })),
    threads: (options.threads ?? []).map(row => ({ id: row.id, title: row.title, ownerDeviceId: row.ownerDeviceId })) });
}
const FolderSchema = z.union([z.literal('home'), z.literal('checkout'), z.string().regex(/^thread:[A-Za-z0-9_-]{1,128}$/u)]);
const FolderOptionSchema = z.strictObject({ value: FolderSchema, label: z.string() });
export const TerminalLauncherViewSchema = z.strictObject({ schema: z.literal('terminal-launcher-view-v1'), currentDeviceId: IdSchema,
  projectId: IdSchema.optional(), defaultDeviceId: IdSchema, defaultFolder: z.enum(['home', 'checkout']), baseFolders: z.array(FolderOptionSchema),
  deviceNames: z.record(IdSchema, z.string()), devices: z.array(z.strictObject({ id: IdSchema, label: z.string(), disabled: z.boolean(), folders: z.array(FolderOptionSchema) })), policy: TerminalLauncherPolicySchema });
export type TerminalLauncherView = z.infer<typeof TerminalLauncherViewSchema>;
export function terminalLauncherView(raw: unknown): TerminalLauncherView {
  const source = TerminalLauncherContextSchema.parse(raw), baseFolders = [...(source.projectId ? [{ value: 'checkout' as const, label: 'Project checkout' }] : []), { value: 'home' as const, label: 'Home' }];
  return TerminalLauncherViewSchema.parse({ schema: 'terminal-launcher-view-v1', currentDeviceId: source.currentDeviceId,
    ...(source.projectId ? { projectId: source.projectId } : {}), defaultDeviceId: source.deviceId ?? source.coordinatorDeviceId ?? source.currentDeviceId,
    defaultFolder: source.projectId ? 'checkout' : 'home', baseFolders, deviceNames: Object.fromEntries(source.devices.map(row => [row.id, row.name])), policy: terminalLauncherPolicy(),
    devices: source.devices.filter(row => !row.revoked).map(row => ({ id: row.id, label: row.name, disabled: row.status === 'offline' && row.id !== source.currentDeviceId,
      folders: [...baseFolders, ...source.threads.filter(thread => thread.ownerDeviceId === row.id).map(thread => ({ value: `thread:${thread.id}`, label: `${thread.title} · Worktree` }))] })) });
}
export const TerminalLauncherChoiceSchema = z.strictObject({ schema: z.literal('terminal-launcher-choice-v1'), deviceId: IdSchema, folder: FolderSchema });
export type TerminalLauncherChoice = z.infer<typeof TerminalLauncherChoiceSchema>;
export function terminalLauncherSelection(view: TerminalLauncherView): TerminalLauncherChoice { return { schema: 'terminal-launcher-choice-v1', deviceId: view.defaultDeviceId, folder: view.defaultFolder }; }
export function terminalLauncherDeviceChoice(view: TerminalLauncherView, deviceId: string): TerminalLauncherChoice { return TerminalLauncherChoiceSchema.parse({ schema: 'terminal-launcher-choice-v1', deviceId, folder: view.defaultFolder }); }
export function terminalLauncherFolderChoice(current: TerminalLauncherChoice, folder: string): TerminalLauncherChoice { return TerminalLauncherChoiceSchema.parse({ ...current, folder }); }
export function terminalLauncherFolders(view: TerminalLauncherView, choice: TerminalLauncherChoice) { return view.devices.find(row => row.id === choice.deviceId)?.folders ?? view.baseFolders; }
export const TerminalLaunchAttemptSchema = z.strictObject({ schema: z.literal('terminal-launch-attempt-v1'), signature: z.string(), command: TerminalCreateRequestSchema });
export type TerminalLaunchAttempt = z.infer<typeof TerminalLaunchAttemptSchema>;
export function terminalLaunchAttempt(previous: TerminalLaunchAttempt | null, view: TerminalLauncherView, rawChoice: unknown, candidateId: string): TerminalLaunchAttempt {
  const choice = TerminalLauncherChoiceSchema.parse(rawChoice), signature = JSON.stringify([view.projectId ?? null, choice.deviceId, choice.folder]);
  if (previous?.signature === signature) return previous;
  const threadId = choice.folder.startsWith('thread:') ? choice.folder.slice(7) : undefined;
  return TerminalLaunchAttemptSchema.parse({ schema: 'terminal-launch-attempt-v1', signature, command: { schema: 'terminal-create-request-v1', clientRequestId: candidateId,
    deviceId: choice.deviceId, ...(view.projectId ? { projectId: view.projectId } : {}), ...(threadId ? { threadId } : {}), cwd: threadId ? 'worktree' : choice.folder, takeover: false } });
}
export const TerminalListRequestSchema = z.strictObject({ schema: z.literal('terminal-list-request-v1'), projectId: IdSchema.optional(), deviceId: IdSchema.optional() })
  .refine(value => !!(value.projectId || value.deviceId), 'Choose a project or device for the terminal list.');
export type TerminalListRequest = z.infer<typeof TerminalListRequestSchema>;
export function terminalListRequest(raw: unknown): TerminalListRequest {
  const input = TerminalListRequestSchema.parse(raw);
  return { schema: 'terminal-list-request-v1', ...(input.projectId ? { projectId: input.projectId } : { deviceId: input.deviceId! }) };
}
export function terminalLauncherListRequest(view: TerminalLauncherView, choice: TerminalLauncherChoice): TerminalListRequest {
  return terminalListRequest({ schema: 'terminal-list-request-v1', ...(view.projectId ? { projectId: view.projectId } : { deviceId: choice.deviceId }) });
}
export function terminalListReadUrl(raw: unknown) {
  const request = terminalListRequest(raw), query = new URLSearchParams(request.projectId ? { projectId: request.projectId } : { deviceId: request.deviceId! });
  return `/api/terminals/list-view?${query}`;
}
export const TerminalListReadViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schema: z.literal('terminal-list-read-view-v1'), kind: z.literal('ready'), request: TerminalListRequestSchema, list: TerminalListSchema, policy: TerminalLauncherPolicySchema }),
  z.strictObject({ schema: z.literal('terminal-list-read-view-v1'), kind: z.literal('failed'), request: TerminalListRequestSchema, error: z.strictObject({ schema: z.literal('terminal-list-error-v1'), message: z.string() }), policy: TerminalLauncherPolicySchema }),
]).refine(frame => frame.kind !== 'ready' || frame.list.sessions.every(session => frame.request.projectId ? session.projectId === frame.request.projectId : session.deviceId === frame.request.deviceId), 'The terminal list must belong to its requested scope.');
export type TerminalListReadView = z.infer<typeof TerminalListReadViewSchema>;
export function terminalListReady(request: unknown, list: unknown): TerminalListReadView { return TerminalListReadViewSchema.parse({ schema: 'terminal-list-read-view-v1', kind: 'ready', request: terminalListRequest(request), list, policy: terminalLauncherPolicy() }); }
export function terminalListFailed(request: unknown): TerminalListReadView { const policy = terminalLauncherPolicy(); return TerminalListReadViewSchema.parse({ schema: 'terminal-list-read-view-v1', kind: 'failed', request: terminalListRequest(request), error: { schema: 'terminal-list-error-v1', message: policy.listFailureNotice }, policy }); }
export const TerminalListReadingStateSchema = z.strictObject({ schema: z.literal('terminal-list-reading-state-v1'), request: TerminalListRequestSchema, list: TerminalListSchema, error: z.string(), policy: TerminalLauncherPolicySchema });
export type TerminalListReadingState = z.infer<typeof TerminalListReadingStateSchema>;
/** A filter change keeps the displayed rows until its first read, as the existing launcher does. */
export function terminalListInitial(request: unknown, previous?: TerminalListReadingState): TerminalListReadingState {
  return { schema: 'terminal-list-reading-state-v1', request: terminalListRequest(request), list: previous?.list ?? { schema: 'terminal-list-v1', sessions: [] }, error: previous?.error ?? '', policy: previous?.policy ?? terminalLauncherPolicy() };
}
export function applyTerminalListRead(current: TerminalListReadingState, frame: TerminalListReadView): TerminalListReadingState {
  if (JSON.stringify(terminalListRequest(current.request)) !== JSON.stringify(terminalListRequest(frame.request))) throw Object.assign(new Error('The terminal list belongs to another scope.'), { status: 409 });
  // The prior launcher leaves its warning visible after a later successful refresh.
  return { ...current, list: frame.kind === 'ready' ? frame.list : current.list, error: frame.kind === 'failed' ? frame.error.message : current.error, policy: frame.policy };
}
export const TerminalLauncherRowSchema = z.strictObject({ schema: z.literal('terminal-launcher-row-v1'), session: TerminalSessionSchema, deviceName: z.string(), url: z.string() });
export function terminalLauncherRows(view: TerminalLauncherView, list: z.infer<typeof TerminalListSchema>) {
  return list.sessions.map(session => TerminalLauncherRowSchema.parse({ schema: 'terminal-launcher-row-v1', session, deviceName: view.deviceNames[session.deviceId] ?? '', url: `/terminals/${session.id}` }));
}
