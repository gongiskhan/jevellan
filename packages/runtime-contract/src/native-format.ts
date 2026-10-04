/** The native session layout a runtime writes: Codex rollouts for `codex`, Claude project journals for every other runtime. */
export function nativeFormat(runtime: string): 'claude' | 'codex' { return runtime === 'codex' ? 'codex' : 'claude'; }
