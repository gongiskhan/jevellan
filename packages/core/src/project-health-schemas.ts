import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';

export const HealthStepSchema = z.strictObject({
  name: z.string().min(1).max(80), method: z.enum(['GET', 'POST']),
  url: z.string().url().max(500).superRefine((value, ctx) => {
    let url: URL; try { url = new URL(value); } catch { return; }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
      ctx.addIssue({ code: 'custom', message: 'Health checks use https (http only for localhost).' });
    if (url.username || url.password) ctx.addIssue({ code: 'custom', message: 'Health checks never sign in.' });
  }),
  headers: z.record(z.string().min(1).max(80), z.string().max(500)).default({}).superRefine((headers, ctx) => {
    for (const header of Object.keys(headers)) if (/^(authorization|cookie|proxy-authorization)$/iu.test(header) || /key|token/iu.test(header))
      ctx.addIssue({ code: 'custom', message: `Health checks never sign in. Remove the ${header} header.` });
  }),
  body: z.string().max(2000).nullable().default(null),
  expectStatus: z.array(z.number().int().min(100).max(599)).min(1).max(5),
  expectBody: z.string().min(1).max(200).nullable().default(null),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
});
export const ProjectHealthCheckSchema = z.strictObject({ id: IdSchema, name: z.string().min(1).max(80), enabled: z.boolean().default(true), steps: z.array(HealthStepSchema).min(1).max(5) });
export const ProjectHealthChecksSchema = z.array(ProjectHealthCheckSchema).max(10).default([]).refine(checks => new Set(checks.map(check => check.id)).size === checks.length, 'Each health check needs its own id.');
export const HealthStepResultSchema = z.strictObject({ name: z.string().min(1).max(80), passed: z.boolean(), status: z.number().int().min(100).max(599).optional(), ms: z.number().nonnegative(), reason: z.string().max(500).optional() });
export const ProjectHealthRunSchema = z.strictObject({ schema: z.literal('project-health-run-v1'), id: IdSchema, projectId: IdSchema, checkId: IdSchema, at: TimestampSchema,
  trigger: z.enum(['manual', 'deploy-before', 'deploy-after']), deployId: IdSchema.optional(), passed: z.boolean(), steps: z.array(HealthStepResultSchema).min(1).max(5) });
export const ProjectHealthRequestSchema = z.strictObject({ schema: z.literal('project-health-request-v1'), project: z.string().min(1).max(200), operation: z.enum(['list', 'run']),
  trigger: z.enum(['manual', 'deploy-before', 'deploy-after']).optional(), deployId: IdSchema.optional(), check: z.string().min(1).max(200).optional(), definition: ProjectHealthCheckSchema.optional() });
export const ProjectHealthViewSchema = z.strictObject({ schema: z.literal('project-health-view-v1'), projectId: IdSchema, runs: z.array(ProjectHealthRunSchema).max(5000) });
export type HealthStep = z.infer<typeof HealthStepSchema>;
export type ProjectHealthCheck = z.infer<typeof ProjectHealthCheckSchema>;
export type ProjectHealthRun = z.infer<typeof ProjectHealthRunSchema>;
export type ProjectHealthRequest = z.infer<typeof ProjectHealthRequestSchema>;

/** Only these public validation sentences cross the API; unrelated schema errors retain the normal envelope. */
export function healthRefusal(error: unknown): string | undefined {
  return error instanceof z.ZodError ? error.issues.find(issue => /^Health checks (?:never sign in|use https)/u.test(issue.message))?.message : undefined;
}
