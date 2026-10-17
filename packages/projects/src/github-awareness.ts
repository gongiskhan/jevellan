import { createHash } from 'node:crypto';
import { PullCommentSchema, parseGitHubPullUrl, type Thread, type PullComment, GithubInputSchema, GithubResultSchema, mapMergeable, parseGitHubRemote, stableJson,
  type GitHubAwarenessPullResponseSchema, type GitHubClient, type GitHubRepository, type GitHubWorkflowRun, type GithubInput,
  type GithubResult, type Project, type SecretRedactor, type ThreadIndex } from '@jevellan/core';
import type { z } from 'zod';
import type { ProjectScope } from './bridge-tools.js';
import type { GitHubAccess } from './publication.js';

const refused = () => Object.assign(new Error('A thread can read only its own pull request and runs and job logs on its current head commit.'), { status: 403 });
type CacheEntry = { until: number; value: Promise<unknown> };
export type ProjectGithubOptions = { github: GitHubAccess; redactor: SecretRedactor; now(): number;
  project(id: string): Promise<Project>; thread(id: string): Promise<ThreadIndex | undefined>; baseBranch(project: Project): Promise<string>;
  repository?(project: Project): Promise<GitHubRepository | null> };

/** The project bridge's GitHub reader: no mutations; a shared 60-second request cache, including concurrent requests and scope checks on cache hits. */
export class ProjectGithub {
  readonly #cache = new Map<string, CacheEntry>();
  constructor(private readonly o: ProjectGithubOptions) {}
  async reviewComments(thread: Thread, since: string): Promise<PullComment[]> {
    const repository = thread.pr && parseGitHubPullUrl(thread.pr.url); if (!repository) return [];
    const token = await this.o.github.token(thread.projectId), client = this.o.github.client(token ?? '');
    if (token) this.o.redactor.add(token);
    const root = `${thread.projectId}:${repository.owner}/${repository.repo}:${createHash('sha256').update(token ?? '').digest('hex')}:`;
    const cached = <T>(key: string, load: () => Promise<T>) => this.#cached(root + key, load);
    const n = thread.pr!.number, [reviews, inline, issues] = await Promise.all([
      cached(`reviews:${n}`, () => client.pullReviews(repository, n)), cached(`comments:${n}:${since}`, () => client.pullComments(repository, n, since)), cached(`issues:${n}:${since}`, () => client.issueComments(repository, n, since))]);
    const rows = [
      ...reviews.filter(row => ['COMMENTED', 'CHANGES_REQUESTED'].includes(row.state) && row.submitted_at && row.body?.trim()).map(row => ({ id: `review_${row.id}`, author: row.user?.login ?? '(unknown)', body: row.body!, at: row.submitted_at! })),
      ...inline.filter(row => row.body.trim()).map(row => ({ id: `inline_${row.id}`, author: row.user?.login ?? '(unknown)', body: row.body, at: row.created_at, path: row.path, ...((row.line ?? row.original_line) ? { line: row.line ?? row.original_line! } : {}) })),
      ...issues.filter(row => row.body.trim()).map(row => ({ id: `issue_${row.id}`, author: row.user?.login ?? '(unknown)', body: row.body, at: row.created_at }))];
    return rows.filter(row => row.at >= since).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(0, 3000).map(row => PullCommentSchema.parse({ ...row, author: this.o.redactor.text(row.author).slice(0, 120), body: this.o.redactor.text(row.body).slice(0, 1000), ...('path' in row && typeof row.path === 'string' ? { path: this.o.redactor.text(row.path).slice(0, 1024) } : {}) }));
  }
  async #cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const current = this.#cache.get(key);
    if (current && current.until > this.o.now()) return current.value as Promise<T>;
    this.#cache.delete(key);
    for (const [id, entry] of this.#cache) if (entry.until <= this.o.now()) this.#cache.delete(id);
    if (this.#cache.size >= 256) this.#cache.delete(this.#cache.keys().next().value!);
    const value = load().then(result => this.o.redactor.document(result));
    const entry = { value, until: this.o.now() + 60_000 }; this.#cache.set(key, entry);
    try { return await value; } catch (error) { if (this.#cache.get(key) === entry) this.#cache.delete(key); throw error; }
  }
  async read(scope: ProjectScope, raw: unknown, signal: AbortSignal): Promise<GithubResult> {
    signal.throwIfAborted(); const input = GithubInputSchema.parse(raw);
    const project = await this.o.project(scope.projectId), repository = this.o.repository ? await this.o.repository(project) : parseGitHubRemote(project.remoteUrl ?? '');
    if (!repository) throw new Error('This project has no GitHub repository.');
    const thread = scope.kind === 'thread' ? await this.o.thread(scope.threadId) : undefined;
    if (scope.kind === 'thread' && (!thread || thread.projectId !== scope.projectId || !thread.pr
      || !['pull', 'run', 'job_log'].includes(input.action) || (input.action === 'pull' && input.number !== thread.pr.number))) throw refused();
    const token = await this.o.github.token(scope.projectId), client = this.o.github.client(token ?? '');
    if (token) this.o.redactor.add(token);
    // Token rotation invalidates previous results; no token is kept in a cache key or output.
    const root = `${scope.projectId}:${repository.owner}/${repository.repo}:${createHash('sha256').update(token ?? '').digest('hex')}:`;
    const cached = <T>(key: string, load: () => Promise<T>) => this.#cached(root + key, load);
    if (scope.kind === 'thread') {
      const runId = input.action === 'run' ? input.runId : input.action === 'job_log'
        ? (await cached(`job:${input.jobId}`, () => client.workflowJob(repository, input.jobId))).run_id : undefined;
      if (runId !== undefined) {
        const run = await cached(`run:${runId}`, () => client.workflowRun(repository, runId));
        if (run.head_sha !== thread!.pr!.headSha) throw refused();
      }
    }
    const result = await cached(`result:${stableJson(input)}`, async () => {
      const loaded = this.o.redactor.document(await this.#load(client, repository, project, input, cached));
      // Bound the whole response as well as individual fields before it reaches the result cache or a prompt.
      if (JSON.stringify(loaded).length > 200_000) throw new Error('GitHub returned too much detail. Ask for a smaller result or a job log.');
      return GithubResultSchema.parse(loaded);
    });
    signal.throwIfAborted();
    return GithubResultSchema.parse(result);
  }
  async #load(client: GitHubClient, repository: GitHubRepository, project: Project, input: GithubInput,
    cached: <T>(key: string, load: () => Promise<T>) => Promise<T>): Promise<GithubResult> {
    switch (input.action) {
      case 'runs': return { schema: 'github-runs-v1', runs: (await client.recentWorkflowRuns(repository, input)).map(runView) };
      case 'run': {
        const [run, jobs] = await Promise.all([cached(`run:${input.runId}`, () => client.workflowRun(repository, input.runId)), client.workflowJobs(repository, input.runId)]);
        return { schema: 'github-run-v1', run: runView(run), jobsShortened: jobs.length > 100, jobs: jobs.slice(0, 100).map(job => ({ id: job.id,
          name: job.name.slice(0, 300), status: job.status.slice(0, 80), conclusion: job.conclusion?.slice(0, 80) ?? null, stepsShortened: (job.steps?.length ?? 0) > 100,
          steps: (job.steps ?? []).slice(0, 100).map(step => ({ name: step.name.slice(0, 300), status: step.status.slice(0, 80), conclusion: step.conclusion?.slice(0, 80) ?? null })) })) };
      }
      case 'job_log': return { schema: 'github-job-log-v1', jobId: input.jobId, output: (await cached(`log:${input.jobId}`, () => client.workflowJobLog(repository, input.jobId))).slice(-input.tailChars) };
      case 'pulls': {
        const pulls = await client.recentPulls(repository, input.state, input.limit);
        return { schema: 'github-pulls-v1', pulls: await Promise.all(pulls.map(async pull => pullView(pull,
          (await cached(`checks:${pull.head.sha}`, () => client.checkState(repository, pull.head.sha))).checks))) };
      }
      case 'pull': {
        const pull = await client.awarenessPull(repository, input.number);
        const [checks, files] = await Promise.all([cached(`checks:${pull.head.sha}`, () => client.checkState(repository, pull.head.sha)), client.pullFiles(repository, input.number, 201)]);
        return { schema: 'github-pull-v1', pull: pullView(pull, checks.checks), checks: checks.details.slice(0, 200).map(check => ({ name: check.name.slice(0, 200), status: check.status.slice(0, 80), conclusion: check.conclusion?.slice(0, 80) ?? null })),
          checksShortened: checks.details.length > 200, filesShortened: files.length > 200, files: files.slice(0, 200).map(file => ({ path: file.filename, additions: file.additions, deletions: file.deletions })) };
      }
      case 'commits': {
        const branch = input.branch ?? await this.o.baseBranch(project), commits = await client.recentCommits(repository, branch, input.since, input.limit);
        return { schema: 'github-commits-v1', branch, commits: await Promise.all(commits.map(async commit => ({ sha: commit.sha, author: commit.commit.author.name.slice(0, 300), at: commit.commit.author.date,
          subject: commit.commit.message.split(/\r?\n/u)[0]!.slice(0, 500), mergedPull: (await cached(`commit-pulls:${commit.sha}`, () => client.commitPulls(repository, commit.sha))).find(pull => pull.merged || pull.merged_at)?.number ?? null }))) };
      }
    }
  }
}
function runView(run: GitHubWorkflowRun) {
  const startedAt = run.run_started_at ?? run.created_at;
  return { id: run.id, workflow: (run.name ?? String(run.workflow_id ?? '')).slice(0, 200), event: run.event.slice(0, 80), branch: run.head_branch?.slice(0, 256) ?? null,
    headSha: run.head_sha, status: run.status.slice(0, 80), conclusion: run.conclusion?.slice(0, 80) ?? null, startedAt,
    durationSeconds: run.status === 'completed' && run.updated_at ? Math.max(0, Math.floor((Date.parse(run.updated_at) - Date.parse(startedAt)) / 1000)) : null,
    url: run.html_url, displayTitle: (run.display_title ?? '').slice(0, 1000) };
}
function pullView(pull: z.infer<typeof GitHubAwarenessPullResponseSchema>, checks: 'none' | 'pending' | 'passing' | 'failing') {
  return { number: pull.number, title: pull.title.slice(0, 300), author: pull.user.login.slice(0, 100), branch: pull.head.ref.slice(0, 256), draft: pull.draft,
    state: pull.merged || pull.merged_at ? 'merged' as const : pull.state, headSha: pull.head.sha, checks, mergeable: mapMergeable(pull.mergeable_state), updatedAt: pull.updated_at, url: pull.html_url };
}
