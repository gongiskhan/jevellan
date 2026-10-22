import { FirstRunReadRequestSchema, FirstRunNextRequestSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { projectDefinitionDeviceOperation } from './project-definition-device.js';
import { readFirstRun, nextFirstRun } from './first-run-view.js';
export async function firstRunDeviceOperation(app: Application, deviceId: string, operation: 'view' | 'next', raw?: unknown) {
  if (operation === 'view') {
    const input = FirstRunReadRequestSchema.parse(raw ?? { schema: 'first-run-read-request-v1', step: null });
    return deviceId === app.device.deviceId ? readFirstRun(app, input) : projectDefinitionDeviceOperation(app, deviceId, { schema: 'project-definition-peer-request-v1', operation: 'first-run-view', input });
  }
  const input = FirstRunNextRequestSchema.parse(raw);
  return deviceId === app.device.deviceId ? nextFirstRun(app, input) : projectDefinitionDeviceOperation(app, deviceId, { schema: 'project-definition-peer-request-v1', operation: 'first-run-next', input });
}
