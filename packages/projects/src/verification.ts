import { gitEnvironment, runOwnedCommand, type CommandResult, type Homes, type SecretRedactor } from '@jevellan/core';
import { tail } from './git.js';

export const SETUP_TIMEOUT_MS = 15 * 60_000;
export const TEST_TIMEOUT_MS = 30 * 60_000;

/**
 * Runs a project command (setup or tests) in a thread's checkout like `verifyWorkspace`: `/bin/sh -c`, the git
 * environment with HOME set to an empty Jevellan folder (no user credentials or test tokens), redacted output, and the
 * whole process group stopped at the timeout.
 */
export async function runThreadCommand(cwd: string, command: string, o: { homes: Homes; workId: string; timeoutMs: number; redactor: SecretRedactor; signal?: AbortSignal | undefined }): Promise<CommandResult> {
  const env = gitEnvironment(); env.HOME = o.homes.ensure('tmp', 'verification', o.workId);
  return runOwnedCommand('/bin/sh', ['-c', command], { cwd, env, timeoutMs: o.timeoutMs, redactor: o.redactor, ...(o.signal ? { signal: o.signal } : {}) });
}
/** The last 4,000 characters of redacted stdout followed by stderr (D49). */
export const outputTail = (result: Pick<CommandResult, 'stdout' | 'stderr'>, max = 4000): string =>
  tail(`${result.stdout}${result.stdout && result.stderr && !result.stdout.endsWith('\n') ? '\n' : ''}${result.stderr}`, max);
