import { ProjectJobLogSchema, readDocument, writeDocument } from '@jevellan/core';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ProjectJobContextSchema, type ProjectJobContext } from '@jevellan/core';
import { projectEnvironment, gitEnvironment, runOwnedCommand, type CommandResult, type Homes, type SecretRedactor, type NativeProcess } from '@jevellan/core';
import { tail } from './git.js';

export const SETUP_TIMEOUT_MS = 15 * 60_000;
export const TEST_TIMEOUT_MS = 30 * 60_000;

export type ProjectCheckCommandOptions = { timeoutMs: number; signal?: AbortSignal; jobContext?: ProjectJobContext; gitEnv?: Record<string, string>; onProcess?(native: NativeProcess): void | Promise<void> };

/**
 * Runs a project command (setup or tests) in a thread's checkout like `verifyWorkspace`: `/bin/sh -c`, the git
 * environment with HOME set to an empty Jevellan folder (no user credentials or test tokens), redacted output, and the
 * whole process group stopped at the timeout.
 */
export async function runThreadCommand(cwd: string, command: string, o: { homes: Homes; workId: string; timeoutMs: number; redactor: SecretRedactor; signal?: AbortSignal | undefined; minimal?: boolean; environmentScope?: 'runtime' | 'command'; jobContext?: ProjectJobContext; projectEnv?: Record<string, string>; gitEnv?: Record<string, string>; commandHome?: string; onProcess?(native: NativeProcess): void | Promise<void> }): Promise<CommandResult> {
  const env = { ...gitEnvironment(), ...projectEnvironment(o.projectEnv, o.environmentScope), ...o.gitEnv }; if (o.minimal) delete env.SSH_AUTH_SOCK;
  if (o.commandHome) {
    const path = resolve(o.commandHome), rel = relative(o.homes.root, path);
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('The check home must stay inside Jevellan.');
    env.HOME = path; env.TMPDIR = join(path, 'tmp'); mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
  } else env.HOME = o.homes.ensure('tmp', 'verification', o.workId);
  if (o.jobContext) {
    const context = ProjectJobContextSchema.parse(o.jobContext);
    const workspace = context.workspace ?? cwd;
    env.HOME = join(workspace, 'home'); env.TMPDIR = join(env.HOME, 'tmp'); mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
    Object.assign(env, { JEVELLAN_JOB_COMMIT: context.commit, JEVELLAN_JOB_RUN_ID: context.runId, JEVELLAN_JOB_PROJECT_ID: context.projectId, JEVELLAN_JOB_ID: context.jobId, ...(context.deployment ? { JEVELLAN_JOB_MODE: context.deployment.mode, JEVELLAN_DEPLOY_ID: context.deployment.deployId, JEVELLAN_DEPLOY_PREVIOUS_COMMIT: context.deployment.previousCommit ?? '' } : {}), JEVELLAN_JOB_WORKSPACE: workspace, JEVELLAN_JOB_COMMAND_CHECKOUT: context.commandCheckout ?? cwd, JEVELLAN_JOB_CACHE: o.homes.ensure('project-work', context.projectId, context.purpose === 'check' ? 'check-cache' : 'job-cache') });
  }
  const result = await runOwnedCommand('/bin/sh', ['-c', command], { cwd, env, timeoutMs: o.timeoutMs, redactor: o.redactor, ...(o.minimal ? { outputLimitBytes: 64 * 1024 } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.onProcess ? { onProcess: o.onProcess } : {}) });
  if (o.jobContext) {
    const context = o.jobContext, file = o.homes.at('project-work', context.projectId, 'job-logs', `${context.runId}.json`);
    try {
      const prior = existsSync(file) ? readDocument(file, ProjectJobLogSchema).sections : [];
      writeDocument(file, ProjectJobLogSchema, { schema: 'project-job-log-v1', runId: context.runId, projectId: context.projectId, sections: [...prior, { at: new Date().toISOString(), text: o.redactor.text(`${result.stdout}\n${result.stderr}`).slice(-131072) }].slice(-10) });
    } catch { /* The durable job receipt still retains its redacted tail if the optional local archive is unavailable. */ }
  }
  return result;
}
/** The last 4,000 characters of redacted stdout followed by stderr (D49). */
export const outputTail = (result: Pick<CommandResult, 'stdout' | 'stderr'>, max = 4000): string =>
  tail(`${result.stdout}${result.stdout && result.stderr && !result.stdout.endsWith('\n') ? '\n' : ''}${result.stderr}`, max);
