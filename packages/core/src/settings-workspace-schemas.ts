import {DeviceManagementViewSchema} from './device-management.js';
import { z } from 'zod';
import { ConfigRevisionSchema, DeviceSchema, IdSchema } from './schemas.js';
import { AccountListSchema, ConfigWriteSchema, RiggingListSchema, RuntimeListSchema, SecretStateSchema } from './client-schemas.js';
import { DeviceRosterSchema } from './mesh-schemas.js';

export const SettingsPageIdSchema = z.enum(['runtimes', 'notifications', 'rigging', 'decisions', 'improver', 'devices', 'projects', 'git', 'ekoa', 'agents', 'cleanup', 'configuration', 'about']);
export const SettingsPageSchema = z.strictObject({ id: SettingsPageIdSchema, label: z.string(), icon: z.enum(['runtimes', 'message', 'rigging', 'decisions', 'improver', 'devices', 'projects', 'git', 'agents', 'configuration', 'about']) });
export const SettingsNavigationSchema = z.strictObject({ schema: z.literal('settings-navigation-v1'), pages: z.array(SettingsPageSchema), defaultPage: SettingsPageIdSchema });
export const SettingsWorkspaceSchema = z.strictObject({
  schema: z.literal('settings-workspace-v1'), config: ConfigRevisionSchema, accounts: AccountListSchema.shape.accounts,
  runtimes: RuntimeListSchema.shape.runtimes, runtimeSettings: RuntimeListSchema.shape.settings, offered: RuntimeListSchema.shape.offered,
  rigging: RiggingListSchema, roster: DeviceRosterSchema, devices: z.strictObject({ currentDeviceId: IdSchema, devices: z.array(DeviceSchema) }), jev: SecretStateSchema,
  navigation: SettingsNavigationSchema, deviceManagement:DeviceManagementViewSchema.optional(),
  configurationWrite: z.strictObject({ path: z.literal('/hub/config'), method: z.literal('PUT'), body: ConfigWriteSchema.omit({ configuration: true, clientRequestId: true }), savedNotice: z.string() }),
});
export type SettingsNavigation = z.infer<typeof SettingsNavigationSchema>;
export type SettingsWorkspace = z.infer<typeof SettingsWorkspaceSchema>;
