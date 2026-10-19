import { readFileSync } from 'node:fs';
import { Homes, ProjectHealthCheckSchema, ProjectHealthViewSchema } from '@jevellan/core';
import { localRequest } from './local-request.js';
import type { z } from 'zod';
export type HealthRequester = typeof localRequest<z.infer<typeof ProjectHealthViewSchema>>;

export async function healthCommand(args: string[], homes = new Homes(), request: HealthRequester = localRequest): Promise<number> {
  const positional: string[] = []; let file: string | undefined, json = false;
  for (let n = 0; n < args.length; n++) {
    const arg = args[n]!;
    if (arg === '--json') json = true;
    else if (arg === '--file') { file = args[++n]; if (!file) throw new Error('--file needs a path.'); }
    else if (arg.startsWith('--')) throw new Error(`Unknown health option: ${arg}`);
    else positional.push(arg);
  }
  if (positional[0] !== 'run' || !positional[1] || positional.length > 3) throw new Error('Usage: jevellan health run <project> [<check name>] [--file <path>] [--json]');
  const parsed = file ? ProjectHealthCheckSchema.safeParse(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
  if (parsed && !parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check the health definition.');
  const definition = parsed?.data;
  const result = await request(homes, '/api/local/health', { schema: 'project-health-request-v1', project: positional[1], operation: 'run', ...(positional[2] ? { check: positional[2] } : {}), ...(definition ? { definition } : {}) }, ProjectHealthViewSchema,
    { timeoutMs: 1_600_000, unanswered: 'The running Jevellan daemon could not run the health checks.', tooLarge: 'The health check results exceeded their limit.', daemonErrors: true });
  if (json) console.log(JSON.stringify(result));
  else for (const run of result.runs) for (const step of run.steps) console.log(`${step.passed ? 'PASS' : 'FAIL'} ${step.name}: ${step.reason ?? `status ${step.status}`} (${step.ms} ms)`);
  return result.runs.every(run => run.passed) ? 0 : 1;
}
