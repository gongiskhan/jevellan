import { UiAuth } from '@jevellan/mesh';
import { TerminalCreateRequestSchema, TerminalLauncherViewRequestSchema, terminalLauncherContext, terminalLauncherView,
  terminalListRequest, terminalListReady, terminalListFailed, terminalOpenResult } from '@jevellan/core';
import type { Application } from './application.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
async function withOwner<T>(app: Application, provided: string | undefined, operation: (token: string) => Promise<T>): Promise<T> {
  if (provided) return operation(provided);
  const auth = app.auth; if (!(auth instanceof UiAuth)) throw refuse('Terminal owner tools must run through the state point.', 409);
  const token = auth.issue(); app.redactor.add(token);
  try { return await operation(token); } finally { auth.logout(token); }
}
export async function readTerminalLauncherView(app: Application, raw: unknown, viewerDeviceId = app.device.deviceId) {
  const input = TerminalLauncherViewRequestSchema.parse(raw), [roster, work] = await Promise.all([app.roster(), input.projectId ? app.projectWork.view(input.projectId) : undefined]);
  if (!roster.devices.some(row => row.device.id === viewerDeviceId && !row.revoked)) throw refuse('The viewing device is no longer in this mesh.', 409);
  return terminalLauncherView(terminalLauncherContext({ ...roster, currentDeviceId: viewerDeviceId }, { ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    ...(work?.coordinator.deviceId ? { coordinatorDeviceId: work.coordinator.deviceId } : {}), threads: work?.threads ?? [] }));
}
export async function readTerminalListView(app: Application, raw: unknown, token?: string) {
  const request = terminalListRequest(raw);
  try {
    return await withOwner(app, token, async owner => terminalListReady(request, await app.terminals.list(owner,
      request.projectId ? { projectId: request.projectId } : { deviceId: request.deviceId! })));
  } catch { return terminalListFailed(request); }
}
/** Keep creation and its fresh resource checks in the existing terminal service. Do not expose its temporary stream ticket. */
export async function createTerminalForTools(app: Application, raw: unknown) {
  const input = TerminalCreateRequestSchema.parse(raw);
  return withOwner(app, undefined, async token => terminalOpenResult((await app.terminals.create(input, token)).session));
}
