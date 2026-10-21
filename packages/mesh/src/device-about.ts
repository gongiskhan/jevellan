import { DeviceAboutViewSchema, INSTALLATION_COMMANDS, type DeviceRosterSchema } from '@jevellan/core';
import type { z } from 'zod';

/** Exact caller identity is retained even when that device is absent from the roster. */
export function deviceAboutView(roster: z.infer<typeof DeviceRosterSchema>, deviceId = roster.currentDeviceId) {
  return DeviceAboutViewSchema.parse({ schema: 'device-about-view-v1', currentDeviceId: deviceId,
    currentVersion: roster.devices.find(row => row.device.id === deviceId)?.device.version ?? null, commands: INSTALLATION_COMMANDS });
}
