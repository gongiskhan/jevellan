import { z } from 'zod';
export const GitHubWorkflowRunSchema = z.object({ id: z.number().int().positive(), html_url: z.url(), head_sha: z.string().regex(/^[0-9a-f]{40}$/u),
  head_branch: z.string().nullable(), event: z.string(), status: z.string(), conclusion: z.string().nullable(), created_at: z.iso.datetime(), run_started_at: z.iso.datetime().nullable().optional() });
export type GitHubWorkflowRun = z.infer<typeof GitHubWorkflowRunSchema>;
export const GitHubWorkflowRunsSchema = z.object({ workflow_runs: z.array(GitHubWorkflowRunSchema).max(100) });
export const GitHubWorkflowJobsSchema = z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(z.object({ id: z.number().int().positive(), name: z.string(),
  status: z.string(), conclusion: z.string().nullable(), steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable().optional(), status: z.string() })).optional() })).max(100) });
export const GitHubWorkflowDispatchSchema = z.object({ workflow_run_id: z.number().int().positive(), html_url: z.url() });
