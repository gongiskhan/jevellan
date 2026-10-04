export type GitHubFixtureChecks = 'pending' | 'passing' | 'passing-status' | 'failing' | 'none'
  | { runs?: { status: string; conclusion: string | null }[]; statuses?: { state: string }[] };
export type GitHubFixtureMergeable = 'clean' | 'dirty' | 'unknown' | 'unstable';
export type GitHubFixtureRequest = {
  method: string; path: string; query: Record<string, string>; body: unknown;
  headers: { accept: string | null; apiVersion: string | null; userAgent: string | null; contentType: string | null; authorized: boolean };
};
export type GitHubFixturePull = {
  repo: string; number: number; title: string; body: string; head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergedAt: string | null;
  mergeable: GitHubFixtureMergeable; checks: GitHubFixtureChecks; headSha: string; mergeSha: string | null;
};
export type GitHubFixture = {
  url: string;
  /** Every API request, without the token. Control routes are not recorded. */
  requests: GitHubFixtureRequest[];
  pulls: GitHubFixturePull[];
  /** `repo` defaults to the first configured repository. */
  setChecks(number: number, checks: GitHubFixtureChecks, repo?: string): void;
  setMergeable(number: number, mergeable: GitHubFixtureMergeable, repo?: string): void;
  markMerged(number: number, repo?: string): void;
  closePull(number: number, repo?: string): void;
  /** The next matching request answers `status` with `{ message }`, or with the given body. */
  failNext(method: string, path: RegExp, status: number, message: string | Record<string, unknown>): void;
  close(): Promise<void>;
};
/** `repositories` maps `owner/repo` to its bare origin; pull request heads are read from it. */
export function startGitHubFixture(options: { token: string; repositories?: Record<string, string>; port?: number }): Promise<GitHubFixture>;
