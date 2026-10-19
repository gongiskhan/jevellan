import { newId, ProjectHealthCheckSchema, ProjectHealthRunSchema, type ProjectHealthCheck, type ProjectHealthRun } from '@jevellan/core';

/** Plain HTTP only. The state point calls this around deploys and for explicit owner requests. */
export async function runHealthCheck(projectId: string, definition: ProjectHealthCheck, trigger: ProjectHealthRun['trigger'] = 'manual', deployId?: string,
  options: { fetcher?: typeof fetch; now?: () => number } = {}): Promise<ProjectHealthRun> {
  const check = ProjectHealthCheckSchema.parse(definition), now = options.now ?? Date.now;
  const run: ProjectHealthRun = { schema: 'project-health-run-v1', id: newId('health'), projectId, checkId: check.id, at: new Date(now()).toISOString(), trigger, ...(deployId ? { deployId } : {}), passed: true, steps: [] };
  for (const step of check.steps) {
    const started = now(), signal = AbortSignal.timeout(step.timeoutMs);
    let status: number | undefined, reason: string | undefined;
    try {
      const response = await (options.fetcher ?? fetch)(step.url, { method: step.method, headers: step.headers, ...(step.method === 'POST' && step.body !== null ? { body: step.body } : {}), redirect: 'manual', signal });
      status = response.status;
      if (!step.expectStatus.includes(status)) reason = `status ${status}, expected ${JSON.stringify(step.expectStatus)}`;
      else if (step.expectBody !== null && !(await firstBody(response)).includes(step.expectBody)) reason = 'the response did not contain the expected text';
      else await response.body?.cancel();
      if (reason) await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      const failure = error as { code?: string; cause?: { code?: string }; name?: string };
      reason = signal.aborted || failure.name === 'TimeoutError' || failure.name === 'AbortError'
        ? `timed out after ${step.timeoutMs} ms` : `could not connect: ${failure.cause?.code ?? failure.code ?? 'UNKNOWN'}`;
    }
    run.steps.push({ name: step.name, passed: !reason, ...(status ? { status } : {}), ms: Math.max(0, now() - started), ...(reason ? { reason } : {}) });
    if (reason) { run.passed = false; break; }
  }
  return ProjectHealthRunSchema.parse(run);
}
async function firstBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (size < 65536) {
      const part = await reader.read(); if (part.done) break;
      const bytes = part.value.subarray(0, 65536 - size); chunks.push(bytes); size += bytes.length;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
