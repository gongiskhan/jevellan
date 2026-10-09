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
      .replace(/\bjva_[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}\b/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
  }
  /**
   * A cumulative output snapshot's safe prefix. An unfinished credential (or UTF-16 pair) stays in the
   * source, never in a public delta. Replaying the source resolves it without persisting raw pending text.
   */
  streamText(value: string): string {
    const protectedRanges: Array<{ start: number; end: number }> = [];
    for (const secret of this.#secrets) {
      for (let start = value.indexOf(secret); start >= 0; start = value.indexOf(secret, start + 1)) protectedRanges.push({ start, end: start + secret.length });
    }
    const patterns = [
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
      /\bjva_[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}\b/gu,
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/gu,
      /Bearer\s+\S+/giu,
    ];
    for (const pattern of patterns) for (const match of value.matchAll(pattern)) protectedRanges.push({ start: match.index, end: match.index + match[0].length });
    let cut = value.length;
    const hold = (start: number) => {
      // Do not cut through a complete credential's replacement, including self-overlapping secrets.
      if (!protectedRanges.some(range => range.start <= start && range.end === value.length)) cut = Math.min(cut, start);
    };
    for (const secret of this.#secrets) {
      for (let length = Math.min(value.length, secret.length - 1); length > 0; length--) {
        if (value.endsWith(secret.slice(0, length))) { hold(value.length - length); break; }
      }
    }
    const starts = ['sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'jva_', 'eyJ', 'Bearer'];
    for (const start of starts) for (let length = 1; length < start.length; length++) {
      const suffix = value.slice(-length); const position = value.length - length;
      if ((start === 'Bearer' ? suffix.toLowerCase() === start.slice(0, length).toLowerCase() : suffix === start.slice(0, length)) && (position === 0 || !/\w/u.test(value[position - 1]!))) hold(position);
    }
    for (const pattern of [
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]*|gh[pousr]_[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]*|jva_[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?|eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2})$/u,
      /\bBearer(?:\s+\S*)?$/iu,
    ]) { const match = pattern.exec(value); if (match) hold(match.index); }
    if (/[\uD800-\uDBFF]$/u.test(value)) cut = Math.min(cut, value.length - 1);
    // A suffix can overlap a completed credential. Moving left preserves the whole protected span.
    for (;;) {
      const overlap = protectedRanges.find(range => range.start < cut && range.end > cut);
      if (!overlap) break; cut = overlap.start;
    }
    const redacted = this.text(value.slice(0, cut));
    return fitRedacted(this, redacted, redacted.length);
  }
  /** Cumulative tool payloads can contain unfinished credentials inside quoted JSON values. */
  streamToolText(value: string): string {
    // An unfinished quoted value may encode a credential with \u escapes. Its decoded tail is not
    // available yet, so keep that literal in the source until a complete snapshot can be inspected.
    let quote = -1; let escaped = false;
    for (let index = 0; index < value.length; index++) {
      const character = value[index];
      if (escaped) { escaped = false; continue; }
      if (quote >= 0 && character === '\\') { escaped = true; continue; }
      if (character === '"') quote = quote < 0 ? index : -1;
    }
    const prefix = this.streamText(quote < 0 ? value : value.slice(0, quote));
    return prefix.replace(/"(?:\\.|[^"\\])*"/gu, (literal: string) => {
      let decoded: unknown; try { decoded = JSON.parse(literal); } catch { return literal; }
      if (typeof decoded !== 'string') return literal;
      const safe = this.streamText(decoded);
      return safe === decoded ? literal : JSON.stringify(safe);
    });
  }
  /** For output payloads whose individual string fields may be unfinished native deltas. */
  streamDocument<T>(value: T): T {
    const visit = (entry: unknown): unknown => typeof entry === 'string' ? this.streamText(entry) : Array.isArray(entry) ? entry.map(visit)
      : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).map(([key, child]) => [this.text(key), visit(child)])) : entry;
    return visit(value) as T;
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
