import { ProjectJobContextSchema, type ProjectJobContext } from '@jevellan/core';
import { projectEnvironment, gitEnvironment, runOwnedCommand, type CommandResult, type Homes, type SecretRedactor, type NativeProcess } from '@jevellan/core';
import { tail } from './git.js';

export const SETUP_TIMEOUT_MS = 15 * 60_000;
export const TEST_TIMEOUT_MS = 30 * 60_000;

/**
 * Runs a project command (setup or tests) in a thread's checkout like `verifyWorkspace`: `/bin/sh -c`, the git
 * environment with HOME set to an empty Jevellan folder (no user credentials or test tokens), redacted output, and the
 * whole process group stopped at the timeout.
 */
export async function runThreadCommand(cwd: string, command: string, o: { homes: Homes; workId: string; timeoutMs: number; redactor: SecretRedactor; signal?: AbortSignal | undefined; minimal?: boolean; environmentScope?: 'runtime' | 'command'; jobContext?: ProjectJobContext; projectEnv?: Record<string, string>; onProcess?(native: NativeProcess): void | Promise<void> }): Promise<CommandResult> {
  const env = { ...gitEnvironment(), ...projectEnvironment(o.projectEnv, o.environmentScope) }; if (o.minimal) delete env.SSH_AUTH_SOCK; env.HOME = o.homes.ensure('tmp', 'verification', o.workId);
  if (o.jobContext) {
    const context = ProjectJobContextSchema.parse(o.jobContext);
    Object.assign(env, { JEVELLAN_JOB_COMMIT: context.commit, JEVELLAN_JOB_RUN_ID: context.runId, JEVELLAN_JOB_PROJECT_ID: context.projectId, JEVELLAN_JOB_ID: context.jobId, JEVELLAN_JOB_WORKSPACE: cwd, JEVELLAN_JOB_CACHE: o.homes.ensure('project-work', context.projectId, 'job-cache') });
  }
  return runOwnedCommand('/bin/sh', ['-c', command], { cwd, env, timeoutMs: o.timeoutMs, redactor: o.redactor, ...(o.minimal ? { outputLimitBytes: 64 * 1024 } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.onProcess ? { onProcess: o.onProcess } : {}) });
}
/** The last 4,000 characters of redacted stdout followed by stderr (D49). */
export const outputTail = (result: Pick<CommandResult, 'stdout' | 'stderr'>, max = 4000): string =>
  tail(`${result.stdout}${result.stdout && result.stderr && !result.stdout.endsWith('\n') ? '\n' : ''}${result.stderr}`, max);
