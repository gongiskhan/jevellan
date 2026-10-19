import { deviceResourceRefusal, liveWork, type DeviceView, type Project, type ProjectJobRun, type ThreadIndex } from '@jevellan/core';

/** Jobs use declared resources, never a semantic routing decision. */
export function placeCommandJob(project: Project, needs: readonly string[], devices: readonly DeviceView[], threads: readonly ThreadIndex[], runs: readonly ProjectJobRun[], runId?: string): { deviceId?: string; reason?: string } {
  const reasons: string[] = [], candidates: Array<{ id: string; name: string; count: number }> = [];
  for (const view of devices) {
    const { device } = view;
    let reason = view.revoked || view.status !== 'online' ? 'offline' : device.workPolicy?.mode === 'apps-only' ? 'apps only'
      : project.allowedDevices && !project.allowedDevices.includes(device.id) ? 'not allowed for this project' : !project.paths[device.id] && !project.paths[device.name] ? 'no project path'
      : needs.some(tag => !device.tags?.includes(tag)) ? 'missing tags' : !view.heartbeat?.facts ? 'resource facts unavailable' : deviceResourceRefusal(device.name, view.heartbeat.facts);
    const jobs = runs.filter(run => run.id !== runId && run.deviceId === device.id && !run.conclusion && run.phase !== 'waiting');
    if (!reason && (jobs.length || view.heartbeat?.facts?.runningJobRuns.some(id => id !== runId))) reason = 'another job is running';
    if (reason) reasons.push(`${device.name}: ${reason}`);
    else {
      const running = new Set([...threads.filter(thread => thread.ownerDeviceId === device.id && liveWork(thread.state)).map(thread => thread.id), ...(view.heartbeat?.facts?.runningThreads ?? [])]);
      candidates.push({ id: device.id, name: device.name, count: running.size + jobs.length });
    }
  }
  candidates.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return candidates[0] ? { deviceId: candidates[0].id } : { reason: `Waiting for a device with ${needs.join(', ') || 'project access'}: ${reasons.join('; ') || 'no devices are registered'}.` };
}
