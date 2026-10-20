import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { MergeCorrectionInputSchema } from './merge-schemas.js';
import { LandingCorrectionInputSchema } from './project-landing-schemas.js';

const commit = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const ProjectMergeWhyRequestSchema = z.strictObject({ schema: z.literal('project-merge-why-request-v1'), commit });
export const ProjectRouteCorrectionRequestSchema = z.discriminatedUnion('schema', [LandingCorrectionInputSchema, MergeCorrectionInputSchema]);
export const RouteWhyPollPolicySchema = z.strictObject({ schema: z.literal('route-why-poll-policy-v1'), mergeMs: z.number().int().positive() });
/** Published transport policy also governs retries before the first successful view. */
export const routeWhyPollPolicy = Object.freeze(RouteWhyPollPolicySchema.parse({ schema: 'route-why-poll-policy-v1', mergeMs: 60000 }));
export const ProjectRouteWhyViewSchema = z.strictObject({ schema: z.literal('project-route-why-view-v1'), projectId: IdSchema, threadId: IdSchema,
  kind: z.enum(['landing', 'merge']), commit: commit.nullable(), title: z.string(), emptyText: z.string(), pollHintMs: z.number().int().positive().nullable(), shadowLine: z.string().nullable(), savedNotice: z.string().nullable(),
  route: z.strictObject({ id: IdSchema, routeLabel: z.string(), sourceLabel: z.string(), stateLabel: z.string(), reason: z.string().nullable(), checkedCommit: commit,
    changeLine: z.string().nullable(), riskyLine: z.string(), summary: z.string(), checks: z.array(z.strictObject({ name: z.string(), resultLabel: z.string() })),
    files: z.array(z.strictObject({ path: z.string(), detail: z.string() })), probabilities: z.array(z.string()), corrections: z.array(z.string()),
  }).nullable(),
  verifications: z.array(z.strictObject({ id: IdSchema, summary: z.string(), note: z.string(), commands: z.array(z.string()), failures: z.array(z.strictObject({ what: z.string(), output: z.string() })) })),
  correctionActions: z.array(z.strictObject({ id: z.enum(['should-have-asked', 'did-not-need-asking']), label: z.string(), request: z.strictObject({ path: z.string(), body: ProjectRouteCorrectionRequestSchema }) })),
});
export type ProjectRouteWhyView = z.infer<typeof ProjectRouteWhyViewSchema>;
export type ProjectRouteCorrectionAction = ProjectRouteWhyView['correctionActions'][number];
