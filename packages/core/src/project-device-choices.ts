import type { ProjectWorkView } from './project-schemas.js';
export const MAIN_NOT_AVAILABLE = 'Main isolation is not available yet.';
export const REMOTE_NOT_AVAILABLE = 'Threads run only on this device for now.';
export const deviceUnavailable = (name: string, reason: string) => `${name}: ${reason}`;
export function mainIsolationBlock(view: Pick<ProjectWorkView, 'project' | 'gates'> & Partial<Pick<ProjectWorkView, 'settings'>>): string | null { void view; return MAIN_NOT_AVAILABLE; }
export function deviceBlock(view: Pick<ProjectWorkView, 'gates'>, deviceId: string, currentDeviceId: string): string | null { return deviceId === currentDeviceId || view.gates.remoteDevices ? null : REMOTE_NOT_AVAILABLE; }
export type DeviceChoice = { id: string; label: string; disabled: boolean };
type RosterRow = { device: { id: string; name: string }; status: 'online' | 'stale' | 'offline'; revoked: boolean };
export function deviceChoices(view: Pick<ProjectWorkView, 'gates' | 'devices'> | undefined, roster: readonly RosterRow[], currentDeviceId: string, selected = ''): DeviceChoice[] {
  const name = (id: string) => roster.find(row => row.device.id === id)?.device.name ?? id;
  const choices = view?.devices ? view.devices.map(entry => ({ id: entry.deviceId, label: entry.reason ? deviceUnavailable(entry.name, entry.reason) : entry.name, disabled: !!entry.reason || deviceBlock(view, entry.deviceId, currentDeviceId) !== null }))
    : roster.filter(row => !row.revoked && (row.device.id === currentDeviceId || row.status !== 'offline')).map(row => ({ id: row.device.id, label: row.device.name, disabled: !view || deviceBlock(view, row.device.id, currentDeviceId) !== null }));
  return selected && !choices.some(choice => choice.id === selected) ? [...choices, { id: selected, label: name(selected), disabled: true }] : choices;
}
