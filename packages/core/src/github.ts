import { GitHubWorkflowRunSchema, GitHubWorkflowRunsSchema, GitHubWorkflowJobsSchema, GitHubWorkflowDispatchSchema } from './github-actions.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
const budgets = new Map<string, { remaining: number; limit: number; resetAt: number }>();
import { SecretRedactor } from './environment.js';
import type { PullRequestState } from './project-schemas.js';

// GitHub REST access for thread pull requests (brief 8.5). Node only: exported from index.ts, never from client.ts.
export const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_API = 'https://api.github.com';
const ERROR_BODY_LIMIT = 4 * 1024;
const BODY_LIMIT = 4 * 1024 * 1024;
const PAGE_LIMIT = 10;
const name = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const sha = /^[a-f0-9]{40,64}$/;

export type GitHubRepository = { owner: string; repo: string };
const PullFiles = z.array(z.object({ filename: z.string().max(4096), status: z.string(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), patch: z.string().optional() })).max(100);
/** Owner and repository of a raw GitHub remote URL (D18): https, scp-like ssh and ssh:// forms, optional `.git` and trailing `/`, case kept. */
export function parseGitHubRemote(url: string): GitHubRepository | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match || !name.test(match[1]!) || !name.test(match[2]!)) return null;
  return { owner: match[1]!, repo: match[2]! };
}
/** Owner and repository of a pull request page URL (`https://github.com/o/r/pull/42`), as stored in `PullRequestState.url`; null for any other URL. */
export function parseGitHubPullUrl(url: string): GitHubRepository | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/i.exec(url.trim());
  if (!match || !name.test(match[1]!) || !name.test(match[2]!)) return null;
  return { owner: match[1]!, repo: match[2]! };
}

// Responses of API version 2022-11-28 (D38). Loose: unknown fields are dropped, only the fields Jevellan reads are checked.
// List items omit `merged`, `mergeable` and `mergeable_state`; only single pull requests carry them.
export const GitHubPullResponseSchema = z.object({
  number: z.number().int().positive(), html_url: z.url(), state: z.enum(['open', 'closed']),
  merged: z.boolean().optional(), merged_at: z.string().nullable().optional(), mergeable_state: z.string().nullable().optional(),
  head: z.object({ sha: z.string().regex(sha), ref: z.string().min(1) }), base: z.object({ ref: z.string().min(1) }),
});
export const GitHubPullListResponseSchema = z.array(GitHubPullResponseSchema);
export const GitHubCheckRunsResponseSchema = z.object({ total_count: z.number().int().nonnegative(),
  check_runs: z.array(z.object({ name: z.string().optional(), status: z.string(), conclusion: z.string().nullable().optional() })) });
// The combined `state` is deliberately not read: it is `pending` with zero statuses when a repository uses only check runs.
export const GitHubStatusResponseSchema = z.object({ total_count: z.number().int().nonnegative(), statuses: z.array(z.object({ context: z.string().optional(), state: z.string() })) });
export const GitHubMergeResponseSchema = z.object({ merged: z.boolean(), sha: z.string().optional(), message: z.string() });
const GitHubErrorBodySchema = z.object({ message: z.string() });

export type GitHubPull = { number: number; url: string; state: 'open' | 'closed'; merged: boolean; mergeableState: string | null; headSha: string; headRef: string; baseRef: string };
export type GitHubChecks = PullRequestState['checks'];
export type GitHubMergeResult = { merged: boolean; sha?: string; message: string };
export type GitHubErrorKind = 'no-token' | 'auth' | 'not-found' | 'conflict' | 'unprocessable' | 'not-mergeable' | 'redirect' | 'timeout' | 'network' | 'invalid-response' | 'http';
/** A failed GitHub call. The message is GitHub's own `message` (redacted, at most 300 characters) or a fixed sentence; never the token. */
export class GitHubError extends Error {
  constructor(readonly kind: GitHubErrorKind, message: string, readonly status?: number) { super(message); this.name = 'GitHubError'; }
}

/** Brief 8.5: failing beats pending, which beats none; derived only from the check run and status entries. */
export function mapChecks(runs: readonly { status: string; conclusion?: string | null | undefined }[], statuses: readonly { state: string }[]): GitHubChecks {
  if (runs.some((run) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion ?? '')) || statuses.some((status) => ['failure', 'error'].includes(status.state))) return 'failing';
  if (runs.some((run) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status)) || statuses.some((status) => status.state === 'pending')) return 'pending';
  return runs.length || statuses.length ? 'passing' : 'none';
}
export const mapMergeable = (state: string | null | undefined): PullRequestState['mergeable'] => ['clean', 'unstable', 'has_hooks'].includes(state ?? '') ? 'clean' : state === 'dirty' ? 'conflict' : 'unknown';

export type GitHubClientOptions = { token(): Promise<string | undefined>; fetch?: typeof fetch; baseUrl?: string; redactor?: SecretRedactor; timeoutMs?: number };
export class GitHubClient {
  readonly #token: GitHubClientOptions['token'];
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #redactor: SecretRedactor;
  readonly #timeoutMs: number;
  constructor(options: GitHubClientOptions) {
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid GitHub timeout.');
    this.#token = options.token; this.#fetch = options.fetch ?? fetch; this.#base = (options.baseUrl ?? GITHUB_API).replace(/\/+$/, '');
    this.#redactor = options.redactor ?? new SecretRedactor(); this.#timeoutMs = timeoutMs;
  }

  async rateLimit() { const token = (await this.#token())?.trim(); return token ? budgets.get(createHash('sha256').update(`${this.#base}\0${token}`).digest('hex')) ?? null : null; }
  async findOpenPull(repository: GitHubRepository, branch: string): Promise<GitHubPull | null> {
    const query = new URLSearchParams({ head: `${repository.owner}:${branch}`, state: 'open' });
    const pulls = await this.#request('GET', `${repo(repository)}/pulls?${query}`, GitHubPullListResponseSchema);
    return pulls[0] ? pull(pulls[0]) : null;
  }
  async createPull(repository: GitHubRepository, input: { title: string; head: string; base: string; body: string }): Promise<GitHubPull> {
    const { title, head, base, body } = input;
    return pull(await this.#request('POST', `${repo(repository)}/pulls`, GitHubPullResponseSchema, { title, head, base, body }));
  }
  async getPull(repository: GitHubRepository, number: number): Promise<GitHubPull> {
    return pull(await this.#request('GET', `${repo(repository)}/pulls/${pullNumber(number)}`, GitHubPullResponseSchema));
  }
  async closePull(repository: GitHubRepository, number: number): Promise<GitHubPull> {
    return pull(await this.#request('PATCH', `${repo(repository)}/pulls/${pullNumber(number)}`, GitHubPullResponseSchema, { state: 'closed' }));
  }
  async pullFiles(repository: GitHubRepository, number: number): Promise<z.infer<typeof PullFiles>> {
    const files: z.infer<typeof PullFiles> = [];
    for (let page = 1; page <= 30; page++) {
      const next = await this.#request('GET', `${repo(repository)}/pulls/${pullNumber(number)}/files?per_page=100&page=${page}`, PullFiles);
      files.push(...next); if (next.length < 100) break;
    }
    return files;
  }
  /** Check runs and commit statuses of a head commit (brief 8.5). Pages of 100, at most 10 pages each. */
  async checks(repository: GitHubRepository, commit: string): Promise<GitHubChecks> { return (await this.checkState(repository, commit)).checks; }
  async checkState(repository: GitHubRepository, commit: string) {
    if (!sha.test(commit)) throw new Error('Invalid commit id.');
    const path = `${repo(repository)}/commits/${commit}`;
    const [runs, statuses] = await Promise.all([
      this.#pages((page) => this.#request('GET', `${path}/check-runs?per_page=100&page=${page}`, GitHubCheckRunsResponseSchema), (result) => result.check_runs),
      this.#pages((page) => this.#request('GET', `${path}/status?per_page=100&page=${page}`, GitHubStatusResponseSchema), (result) => result.statuses),
    ]);
    return { checks: mapChecks(runs, statuses), passedChecks: [...runs.filter(run => run.status === 'completed' && run.conclusion === 'success').flatMap(run => run.name ? [run.name] : []), ...statuses.filter(status => status.state === 'success').flatMap(status => status.context ? [status.context] : [])] };
  }
  /** Squash merge, only while the head is still `commit` (GitHub answers 409 otherwise). */
  async merge(repository: GitHubRepository, number: number, commit: string): Promise<GitHubMergeResult> {
    if (!sha.test(commit)) throw new Error('Invalid commit id.');
    const result = await this.#request('PUT', `${repo(repository)}/pulls/${pullNumber(number)}/merge`, GitHubMergeResponseSchema, { merge_method: 'squash', sha: commit });
    return { merged: result.merged, ...(result.sha === undefined ? {} : { sha: result.sha }), message: this.#text(result.message) };
  }

  async workflowRuns(repository: GitHubRepository, workflow: string, branch: string, since: string) {
    const runs: z.infer<typeof GitHubWorkflowRunSchema>[] = [];
    for (let page = 1; page <= 10; page++) {
      void since; // The caller filters started time; a queued run may have been created before the day.
      const query = new URLSearchParams({ branch, per_page: '100', page: String(page) });
      const next = await this.#request('GET', `${repo(repository)}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`, GitHubWorkflowRunsSchema);
      runs.push(...next.workflow_runs); if (next.workflow_runs.length < 100) break;
    }
    return runs;
  }
  async workflowRun(repository: GitHubRepository, runId: number) { return this.#request('GET', `${repo(repository)}/actions/runs/${pullNumber(runId)}`, GitHubWorkflowRunSchema); }
  async workflowJobs(repository: GitHubRepository, runId: number) {
    return this.#pages(page => this.#request('GET', `${repo(repository)}/actions/runs/${pullNumber(runId)}/jobs?per_page=100&page=${page}`, GitHubWorkflowJobsSchema), value => value.jobs);
  }
  async pinWorkflowRef(repository: GitHubRepository, branch: string, commit: string): Promise<void> {
    if (!sha.test(commit) || !/^jv\/jobs\/[A-Za-z0-9_-]+$/u.test(branch)) throw new Error('Invalid workflow dispatch ref.');
    await this.#request('POST', `${repo(repository)}/git/refs`, z.object({ ref: z.string(), object: z.object({ sha: z.string() }) }), { ref: `refs/heads/${branch}`, sha: commit });
  }
  async dispatchWorkflow(repository: GitHubRepository, workflow: string, ref: string, inputs?: Record<string, string>) {
    // This API version can return the actual run; never infer identity from a generic latest run.
    return this.#request('POST', `${repo(repository)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, GitHubWorkflowDispatchSchema,
      { ref, return_run_details: true, ...(inputs ? { inputs } : {}) }, { version: '2026-03-10' });
  }
  async workflowJobLog(repository: GitHubRepository, jobId: number): Promise<string> {
    return this.#request('GET', `${repo(repository)}/actions/jobs/${pullNumber(jobId)}/logs`, z.string(), undefined, { text: true, download: true });
  }
  async actionsVariable(repository: GitHubRepository, variable: string): Promise<string> {
    if (!/^[A-Za-z0-9_]{1,64}$/u.test(variable)) throw new Error('Invalid Actions variable name.');
    return (await this.#request('GET', `${repo(repository)}/actions/variables/${encodeURIComponent(variable)}`, z.object({ name: z.string(), value: z.string().max(48000) }))).value;
  }
  async workflowRefs(repository: GitHubRepository) {
    return this.#request('GET', `${repo(repository)}/git/matching-refs/heads/jv/jobs/`, z.array(z.object({ ref: z.string(), object: z.object({ sha: z.string().regex(sha) }) })).max(1000));
  }
  async deleteWorkflowRef(repository: GitHubRepository, branch: string): Promise<void> {
    if (!/^jv\/jobs\/[A-Za-z0-9_-]+$/u.test(branch)) throw new Error('Invalid workflow dispatch ref.');
    try { await this.#request('DELETE', `${repo(repository)}/git/refs/heads/${branch}`, z.null(), undefined, { noContent: true }); }
    catch (error) {
      // Recover a crash between successful deletion and its local receipt. Never hide permissions or validation failures on an existing ref.
      if (!(error instanceof GitHubError) || ![404, 422].includes(error.status ?? 0) || (await this.workflowRefs(repository)).some(ref => ref.ref === `refs/heads/${branch}`)) throw error;
    }
  }

  async #pages<T extends { total_count: number }, E>(load: (page: number) => Promise<T>, entries: (result: T) => E[]): Promise<E[]> {
    const all: E[] = [];
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const result = await load(page); const items = entries(result); all.push(...items);
      if (!items.length || all.length >= result.total_count) break;
    }
    return all;
  }
  #text(value: string): string { return this.#redactor.text(value).replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, 300); }
  async #request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, schema: z.ZodType<T>, body?: unknown, options: { version?: string; text?: boolean; download?: boolean; noContent?: boolean } = {}): Promise<T> {
    const token = (await this.#token())?.trim();
    if (!token) throw new GitHubError('no-token', 'No GitHub token is saved.');
    this.#redactor.add(token);
    // A header value with control or non-ASCII characters would make fetch throw an error that quotes it.
    if (!/^[\x21-\x7e]+$/.test(token)) throw new GitHubError('auth', 'The saved GitHub token is not valid.');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#base}${path}`, {
          method, redirect: 'manual', signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': options.version ?? GITHUB_API_VERSION, 'User-Agent': 'jevellan',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw controller.signal.aborted ? timedOut() : new GitHubError('network', 'GitHub could not be reached.'); }
      const remaining = Number(response.headers.get('x-ratelimit-remaining')), limit = Number(response.headers.get('x-ratelimit-limit')), resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      if (response.headers.has('x-ratelimit-remaining') && limit > 0 && Number.isFinite(remaining) && Number.isFinite(resetAt)) budgets.set(createHash('sha256').update(`${this.#base}\0${token}`).digest('hex'), { remaining, limit, resetAt });
      if (options.download && response.status === 302) {
        const location = response.headers.get('location'); await response.body?.cancel();
        let target: URL; try { target = new URL(location ?? ''); } catch { throw invalid(); }
        if (target.protocol !== 'https:' || target.username || target.password || !(target.hostname.endsWith('.githubusercontent.com') || target.hostname.endsWith('.blob.core.windows.net'))) throw invalid();
        // Signed log URLs carry their own authorization; never forward the GitHub token.
        response = await this.#fetch(target, { redirect: 'manual', signal: controller.signal });
      }
      const status = response.status;
      if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
        await response.body?.cancel().catch(() => undefined);
        throw new GitHubError('redirect', 'GitHub answered with a redirect, which Jevellan does not follow.', status || undefined);
      }
      if (!response.ok) {
        const text = await read(response, ERROR_BODY_LIMIT, controller.signal, false).catch(() => '');
        let message = ''; try { message = this.#text(GitHubErrorBodySchema.parse(JSON.parse(text)).message); } catch { /* a body without a message */ }
        throw new GitHubError(errorKind(status), message || `GitHub answered with HTTP ${status}.`, status);
      }
      if (options.noContent && status === 204) { await response.body?.cancel(); return schema.parse(null); }
      let value: unknown;
      try { const content = await read(response, BODY_LIMIT, controller.signal, true); value = options.text ? this.#redactor.text(content).slice(-8000) : JSON.parse(content); } catch (error) { if (error instanceof GitHubError) throw error; throw invalid(); }
      const parsed = schema.safeParse(value); if (!parsed.success) throw invalid();
      return parsed.data;
    } finally { clearTimeout(timer); }
  }
}

const repo = (repository: GitHubRepository) => {
  if (!name.test(repository.owner) || !name.test(repository.repo)) throw new Error('Invalid GitHub repository.');
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
};
const pullNumber = (number: number) => { if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number.'); return number; };
const pull = (value: z.infer<typeof GitHubPullResponseSchema>): GitHubPull => ({ number: value.number, url: value.html_url, state: value.state,
  merged: value.merged ?? Boolean(value.merged_at), mergeableState: value.mergeable_state ?? null, headSha: value.head.sha, headRef: value.head.ref, baseRef: value.base.ref });
const timedOut = () => new GitHubError('timeout', 'GitHub did not answer in time.');
const invalid = () => new GitHubError('invalid-response', 'GitHub returned an unexpected response.');
const errorKind = (status: number): GitHubErrorKind => status === 401 || status === 403 ? 'auth' : status === 404 ? 'not-found' : status === 405 ? 'not-mergeable'
  : status === 409 ? 'conflict' : status === 422 ? 'unprocessable' : 'http';
/** Reads at most `limit` bytes. Error bodies are cut there; a success body over the limit is refused. */
async function read(response: Response, limit: number, signal: AbortSignal, strict: boolean): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      chunks.push(chunk.value); size += chunk.value.length;
      if (size > limit || (!strict && size === limit)) { await reader.cancel().catch(() => undefined); if (strict) throw invalid(); break; }
    }
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw signal.aborted ? timedOut() : new GitHubError('network', 'GitHub could not be reached.');
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}
