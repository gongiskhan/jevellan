import { z } from 'zod';
import { TimestampSchema } from './schemas.js';

const positive = z.number().int().positive(), count = z.number().int().nonnegative();
const text = (max: number) => z.string().max(max), sha = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const GithubInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('runs'), workflow: z.string().min(1).max(200).optional(), branch: z.string().min(1).max(256).optional(),
    event: z.string().min(1).max(80).optional(), status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out']).optional(), limit: positive.max(20).default(10) }),
  z.strictObject({ action: z.literal('run'), runId: positive }),
  z.strictObject({ action: z.literal('job_log'), jobId: positive, tailChars: positive.max(8000).default(4000) }),
  z.strictObject({ action: z.literal('pulls'), state: z.enum(['open', 'closed']), limit: positive.max(20).default(10) }),
  z.strictObject({ action: z.literal('pull'), number: positive }),
  z.strictObject({ action: z.literal('commits'), branch: z.string().min(1).max(256).optional(), since: TimestampSchema.optional(), limit: positive.max(30).default(10) }),
]);
export type GithubInput = z.infer<typeof GithubInputSchema>;
export const GithubRunSchema = z.strictObject({ id: positive, workflow: text(200), event: text(80), branch: text(256).nullable(), headSha: sha,
  status: text(80), conclusion: text(80).nullable(), startedAt: TimestampSchema, durationSeconds: count.nullable(), url: z.url(), displayTitle: text(1000) });
export const GithubJobSchema = z.strictObject({ id: positive, name: text(300), status: text(80), conclusion: text(80).nullable(),
  steps: z.array(z.strictObject({ name: text(300), status: text(80), conclusion: text(80).nullable() })).max(100), stepsShortened: z.boolean() });
export const GithubCheckSchema = z.strictObject({ name: text(200), status: text(80), conclusion: text(80).nullable() });
export const GithubPullSchema = z.strictObject({ number: positive, title: text(300), author: text(100), branch: text(256), draft: z.boolean(),
  state: z.enum(['open', 'closed', 'merged']), headSha: sha, checks: z.enum(['none', 'pending', 'passing', 'failing']), mergeable: z.enum(['clean', 'conflict', 'unknown']), updatedAt: TimestampSchema, url: z.url() });
export const GithubRunsResultSchema = z.strictObject({ schema: z.literal('github-runs-v1'), runs: z.array(GithubRunSchema).max(20) });
export const GithubRunResultSchema = z.strictObject({ schema: z.literal('github-run-v1'), run: GithubRunSchema, jobs: z.array(GithubJobSchema).max(100), jobsShortened: z.boolean() });
export const GithubJobLogResultSchema = z.strictObject({ schema: z.literal('github-job-log-v1'), jobId: positive, output: text(8000) });
export const GithubPullsResultSchema = z.strictObject({ schema: z.literal('github-pulls-v1'), pulls: z.array(GithubPullSchema).max(20) });
export const GithubPullResultSchema = z.strictObject({ schema: z.literal('github-pull-v1'), pull: GithubPullSchema, checks: z.array(GithubCheckSchema).max(200), checksShortened: z.boolean(),
  files: z.array(z.strictObject({ path: text(4096), additions: count, deletions: count })).max(200), filesShortened: z.boolean() });
export const GithubCommitsResultSchema = z.strictObject({ schema: z.literal('github-commits-v1'), branch: text(256), commits: z.array(z.strictObject({
  sha, author: text(300), at: TimestampSchema, subject: text(500), mergedPull: positive.nullable() })).max(30) });
export const GithubResultSchema = z.discriminatedUnion('schema', [GithubRunsResultSchema, GithubRunResultSchema, GithubJobLogResultSchema,
  GithubPullsResultSchema, GithubPullResultSchema, GithubCommitsResultSchema]);
export type GithubResult = z.infer<typeof GithubResultSchema>;
