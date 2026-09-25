import { randomUUID } from 'node:crypto';
import { Homes, SecretRedactor, VerificationSchema, gitEnvironment, runOwnedCommand, type GitWorkspace, type Verification } from '@jevellan/core';
import type { ConversationLedger } from './ledger.js';

export function verificationCounts(receipt: Verification, currentHead: string, treeClean: boolean): boolean {
  return receipt.passed && receipt.treeClean && receipt.headStable && treeClean && receipt.commit === currentHead;
}
export function externalVerificationCounts(receipt: Verification, currentHead: string, digest: string): boolean {
  return receipt.passed && receipt.headStable && receipt.commit === currentHead && receipt.worktreeBefore === digest && receipt.worktreeAfter === digest;
}
export async function verifyWorkspace(workspace: GitWorkspace, ledger: ConversationLedger, homes: Homes, trigger: Verification['trigger'], options: { timeoutMs?: number; redactor?: SecretRedactor; signal?: AbortSignal } = {}): Promise<Verification> {
  await workspace.ownership.assert(workspace.project, workspace.owner);
  const command = workspace.project.testCommand;
  if (!command) throw new Error('This project has no test command.');
  const before = await workspace.head(); const cleanBefore = await workspace.clean();
  const worktreeBefore = workspace.project.branchPolicy === 'external' ? await workspace.workingTreeDigest() : undefined;
  if (workspace.project.branchPolicy === 'main' && !cleanBefore) throw new Error('Verification requires a clean checkpoint.');
  const env = gitEnvironment();
  env.HOME = homes.ensure('tmp', 'verification', workspace.owner.workId);
  const result = await runOwnedCommand('/bin/sh', ['-c', command], { cwd: workspace.path, env, timeoutMs: options.timeoutMs ?? 10 * 60_000, ...(options.redactor ? { redactor: options.redactor } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  const after = await workspace.head(); const cleanAfter = await workspace.clean();
  const worktreeAfter = worktreeBefore === undefined ? undefined : await workspace.workingTreeDigest();
  const output = ledger.putBlob({ stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut });
  const receipt = VerificationSchema.parse({ schema: 'verification-v1', id: `verification_${randomUUID()}`, workId: workspace.owner.workId, at: new Date().toISOString(), trigger, command, exitCode: result.code, passed: result.code === 0, outputRef: output.ref, commit: before, treeClean: cleanBefore && cleanAfter, headStable: before === after, ...(worktreeBefore === undefined ? {} : { worktreeBefore, worktreeAfter }) });
  ledger.append({ type: 'verification', data: receipt });
  await workspace.ownership.assert(workspace.project, workspace.owner);
  return receipt;
}
