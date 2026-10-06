const BASE = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'] as const;
const AUTH: Record<string, readonly string[]> = { claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], codex: [] };
const LAUNCH = ['JEVELLAN_STRETCH_TOKEN', 'JEVELLAN_DAEMON_URL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

export function minimalEnvironment(runtime: 'claude' | 'codex', home: string, auth: Record<string, string> = {}, launch: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of BASE) if (base[key] !== undefined) result[key] = base[key]!;
  result.HOME = home;
  for (const [key, value] of Object.entries(auth)) {
    if (!AUTH[runtime]!.includes(key)) throw new Error(`Unsupported authentication variable for ${runtime}.`);
    result[key] = value;
  }
  for (const [key, value] of Object.entries(launch)) {
    if (!LAUNCH.includes(key)) throw new Error('Unsupported launch environment variable.');
    result[key] = value;
  }
  result[runtime === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = home;
  return result;
}

export class SecretRedactor {
  #secrets = new Set<string>();
  add(secret: string): void { if (secret) this.#secrets.add(secret); }
  text(value: string): string {
    let result = value;
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[redacted]');
    return result
      .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
  }
  document<T>(value: T): T {
    const visit = (entry: unknown): unknown => {
      if (typeof entry === 'string') return this.text(entry);
      if (Array.isArray(entry)) return entry.map(visit);
      if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, child]) => [this.text(key), visit(child)]));
      return entry;
    };
    return visit(value) as T;
  }
}

/**
 * The longest prefix of `text` (with `keep: 'end'`, the longest suffix) of at most `max` characters that `redactor` leaves unchanged.
 * `text` should already be redacted: the cut moves back past anything a later pass would rewrite, such as a token cut to `Bearer [reda`,
 * so a stored or relayed text never grows on the next redaction (P8 review S-1). The empty string ends every search.
 */
export function fitRedacted(redactor: SecretRedactor, text: string, max: number, keep: 'start' | 'end' = 'start'): string {
  const limit = Math.max(0, Math.floor(max));
  let cut = keep === 'start' ? text.slice(0, limit) : text.slice(Math.max(0, text.length - limit));
  while (cut && redactor.text(cut) !== cut) cut = keep === 'start' ? cut.slice(0, -1) : cut.slice(1);
  return cut;
}
/** `fitRedacted` after redacting `text` first: what a producer stores when it cuts a text it has not redacted yet. */
export function redactWithin(redactor: SecretRedactor, text: string, max: number, keep: 'start' | 'end' = 'start'): string {
  return fitRedacted(redactor, redactor.text(text), max, keep);
}
const PATTERNS = new SecretRedactor();
/** A cut of already redacted text that the redaction patterns leave unchanged (every device's redactor knows the patterns). */
export function clipRedacted(text: string, max: number, keep: 'start' | 'end' = 'start'): string { return fitRedacted(PATTERNS, text, max, keep); }
/**
 * `redactor.document` that never makes a string longer (P8 review S-1): a string the redaction would lengthen (a short secret, a token
 * after `Bearer`) keeps its old length, cut back at its end to a point redaction leaves unchanged, so a document that passed its schema
 * before still passes after. Every string of the result is a redaction fixed point. Keys are redacted as `document` redacts them.
 */
export function boundedRedaction<T>(redactor: SecretRedactor, value: T): T {
  const text = (entry: string): string => {
    const redacted = redactor.text(entry);
    return redacted.length > entry.length || redactor.text(redacted) !== redacted ? fitRedacted(redactor, redacted, Math.min(entry.length, redacted.length)) : redacted;
  };
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') return text(entry);
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, child]) => [redactor.text(key), visit(child)]));
    return entry;
  };
  return visit(value) as T;
}

/**
 * Flag settings for every Claude process Jevellan starts on an account home (P8 review R-T1): the CLI deletes transcripts older than
 * `cleanupPeriodDays` (30 by default) from the home it runs in, and a thread's or coordinator's native session is its only transcript and
 * the session its next turn resumes. 100 years keeps them while the work lasts. Flag settings change no file in the home.
 */
export const CLAUDE_FLAG_SETTINGS = Object.freeze({ cleanupPeriodDays: 36_500 });
