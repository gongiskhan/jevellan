import { z } from 'zod';
import { DeviceSchema, IdSchema } from './schemas.js';

export const INSTALLATION_COMMANDS = { schema: 'installation-commands-v1', update: 'jevellan update', uninstall: 'jevellan uninstall' } as const;
export const InstallationCommandsSchema = z.strictObject({ schema: z.literal(INSTALLATION_COMMANDS.schema), update: z.literal(INSTALLATION_COMMANDS.update), uninstall: z.literal(INSTALLATION_COMMANDS.uninstall) });
export const DeviceAboutViewSchema = z.strictObject({ schema: z.literal('device-about-view-v1'), currentDeviceId: IdSchema, currentVersion: DeviceSchema.shape.version.nullable(), commands: InstallationCommandsSchema });
export type DeviceAboutView = z.infer<typeof DeviceAboutViewSchema>;
