import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { DeployRollbackRequestSchema } from './project-deploy-schemas.js';

export const ProjectDeploySummarySchema = z.strictObject({
  schema: z.literal('project-deploy-summary-v1'), projectId: IdSchema,
  current: z.strictObject({ source: z.enum(['baseline', 'deploy', 'rollback']), commit: z.string().regex(/^[a-f0-9]{40}$/u).nullable(), at: TimestampSchema, label: z.string().max(300) }).nullable(),
  healthLines: z.array(z.string().max(4000)).max(20), desktopLine: z.string().max(1200).nullable(), toolLine: z.string().max(12000).nullable(),
  rollback: z.strictObject({ deployId: IdSchema, enabled: z.boolean(), pending: z.boolean(), refusal: z.string().max(1200).nullable(),
    label: z.string().max(200), confirmation: z.string().max(500), detail: z.string().max(1000),
    path: z.string().max(1000), body: DeployRollbackRequestSchema,
  }).nullable(),
});
export type ProjectDeploySummary = z.infer<typeof ProjectDeploySummarySchema>;
