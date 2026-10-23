import {deviceManagementView} from './device-management.js';
import { SettingsNavigationSchema, SettingsWorkspaceSchema, type SettingsNavigation } from './settings-workspace-schemas.js';
import type { z } from 'zod';
import type { AccountListSchema, RiggingListSchema, RuntimeListSchema, SecretStateSchema } from './client-schemas.js';
import type { DeviceRosterSchema } from './mesh-schemas.js';
import type { ConfigRevision } from './schemas.js';

export function settingsNavigation() {
  return SettingsNavigationSchema.parse({ schema: 'settings-navigation-v1', defaultPage: 'runtimes', pages: [
    { id: 'runtimes', label: 'Runtimes', icon: 'runtimes' }, { id: 'notifications', label: 'Notifications', icon: 'message' },
    { id: 'rigging', label: 'Rigging', icon: 'rigging' }, { id: 'decisions', label: 'Decisions', icon: 'decisions' },
    { id: 'jev', label: 'Jev', icon: 'decisions' }, { id: 'improver', label: 'Improver', icon: 'improver' }, { id: 'devices', label: 'Devices', icon: 'devices' },
    { id: 'projects', label: 'Projects', icon: 'projects' }, { id: 'git', label: 'Git', icon: 'git' },
    { id: 'ekoa', label: 'Ekoa', icon: 'projects' }, { id: 'agents', label: 'Agents', icon: 'agents' },
    { id: 'cleanup', label: 'Cleanup', icon: 'configuration' }, { id: 'configuration', label: 'Configuration', icon: 'configuration' },
    { id: 'about', label: 'About', icon: 'about' },
  ] });
}
export function settingsPage(navigation: SettingsNavigation, id: string) {
  return navigation.pages.find(row => row.id === id) ?? navigation.pages.find(row => row.id === navigation.defaultPage)!;
}
export function settingsWorkspace(input: { config: ConfigRevision; accounts: z.infer<typeof AccountListSchema>['accounts']; runtimeList: z.infer<typeof RuntimeListSchema>; rigging: z.infer<typeof RiggingListSchema>; roster: z.infer<typeof DeviceRosterSchema>; jev: z.infer<typeof SecretStateSchema> }) {
  return SettingsWorkspaceSchema.parse({ schema: 'settings-workspace-v1', config: input.config, accounts: input.accounts,
    runtimes: input.runtimeList.runtimes, runtimeSettings: input.runtimeList.settings, offered: input.runtimeList.offered, rigging: input.rigging,
    roster: input.roster, devices: { currentDeviceId: input.roster.currentDeviceId, devices: input.roster.devices.map(row => row.device) }, jev: input.jev,
    deviceManagement:deviceManagementView({schema:'device-management-facts-v1',roster:input.roster,now:Date.now()}),
    navigation: settingsNavigation(), configurationWrite: { path: '/hub/config', method: 'PUT', body: { schema: 'config-write-v1', revision: input.config.revision }, savedNotice: 'Settings saved.' },
  });
}
