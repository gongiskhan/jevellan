import { FirstRunReadRequestSchema, FirstRunNextRequestSchema, firstRunView, firstRunNext } from '@jevellan/core';
import type { Application } from './application.js';
/** Read only the normal managed state; this never checks, logs in or changes an account. */
export async function readFirstRun(app: Application, raw: unknown = { schema: 'first-run-read-request-v1', step: null }) {
  const input = FirstRunReadRequestSchema.parse(raw);
  const [accounts, runtimeList, projects, jev] = await Promise.all([app.accounts.list(), app.runtimeList(), app.state.projects.list(), app.state.jev.summary()]);
  return firstRunView({ schema: 'first-run-facts-v1', deviceId: app.device.deviceId, jevSaved: jev.saved,
    accounts: accounts.map(view => ({ enabled: view.account.enabled, runtime: view.account.runtime, statuses: view.statuses.map(status => ({ deviceId: status.deviceId, auth: status.auth })) })),
    runtimes: runtimeList.runtimes.map(runtime => ({ id: runtime.id, enabled: runtime.enabled })),
    projects: projects.map(({ project }) => ({ paths: project.paths, ...(project.allowedDevices ? { allowedDevices: project.allowedDevices } : {}) })) }, input.step);
}
export async function nextFirstRun(app: Application, raw: unknown) {
  const input = FirstRunNextRequestSchema.parse(raw);
  return firstRunNext(await readFirstRun(app, { schema: 'first-run-read-request-v1', step: input.step }));
}
