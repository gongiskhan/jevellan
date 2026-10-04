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
