import { z } from 'zod';
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
/** Owner and repository of a raw GitHub remote URL (D18): https, scp-like ssh and ssh:// forms, optional `.git` and trailing `/`, case kept. */
export function parseGitHubRemote(url: string): GitHubRepository | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
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
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable().optional() })) });
// The combined `state` is deliberately not read: it is `pending` with zero statuses when a repository uses only check runs.
export const GitHubStatusResponseSchema = z.object({ total_count: z.number().int().nonnegative(), statuses: z.array(z.object({ state: z.string() })) });
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
  /** Check runs and commit statuses of a head commit (brief 8.5). Pages of 100, at most 10 pages each. */
  async checks(repository: GitHubRepository, commit: string): Promise<GitHubChecks> {
    if (!sha.test(commit)) throw new Error('Invalid commit id.');
    const path = `${repo(repository)}/commits/${commit}`;
    const [runs, statuses] = await Promise.all([
      this.#pages((page) => this.#request('GET', `${path}/check-runs?per_page=100&page=${page}`, GitHubCheckRunsResponseSchema), (result) => result.check_runs),
      this.#pages((page) => this.#request('GET', `${path}/status?per_page=100&page=${page}`, GitHubStatusResponseSchema), (result) => result.statuses),
    ]);
    return mapChecks(runs, statuses);
  }
  /** Squash merge, only while the head is still `commit` (GitHub answers 409 otherwise). */
  async merge(repository: GitHubRepository, number: number, commit: string): Promise<GitHubMergeResult> {
    if (!sha.test(commit)) throw new Error('Invalid commit id.');
    const result = await this.#request('PUT', `${repo(repository)}/pulls/${pullNumber(number)}/merge`, GitHubMergeResponseSchema, { merge_method: 'squash', sha: commit });
    return { merged: result.merged, ...(result.sha === undefined ? {} : { sha: result.sha }), message: this.#text(result.message) };
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
  async #request<T>(method: 'GET' | 'POST' | 'PUT', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
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
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': GITHUB_API_VERSION, 'User-Agent': 'jevellan',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw controller.signal.aborted ? timedOut() : new GitHubError('network', 'GitHub could not be reached.'); }
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
      let value: unknown;
      try { value = JSON.parse(await read(response, BODY_LIMIT, controller.signal, true)); } catch (error) { if (error instanceof GitHubError) throw error; throw invalid(); }
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
