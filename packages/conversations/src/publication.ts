import { GitRewriteAbortedSchema, GitRewriteCapture, GitRewritePlanSchema, GitRewriteReceiptSchema, IntegrationStatusSchema, MemoryConflictMergeSchema, MemoryPublicationScopeSchema, PublicationEventSchema, VerificationSchema, newId, withPublicationLease, type GitConflict, type GitWorkspace, type Homes, type IntegrationRunner, type PublicationEvent, type PublicationLeaseService, type Verification } from '@jevellan/core';
import { memoryConflictResolutions, onlyMemoryChanges } from '@jevellan/memory';
import type { ConversationLedger } from './ledger.js';
import { verificationCounts, verifyWorkspace } from './verification.js';

type Integrate = (input: { upstream: string; savedRef: string; run: IntegrationRunner }) => Promise<boolean>;
/** A retry cannot bypass the rewrite evidence required by the original attempt. */
export async function recoverIntegrationHistory(workspace: GitWorkspace, ledger: ConversationLedger, homes: Homes): Promise<void> {
  await workspace.ownership.assert(workspace.project, workspace.owner);
  const documents = ledger.events().filter((event) => event.type === 'git').map((event) => ledger.data(event));
  const settled = new Set(documents.flatMap((document) => {
    const receipt = GitRewriteReceiptSchema.safeParse(document); const aborted = GitRewriteAbortedSchema.safeParse(document);
    return receipt.success ? [receipt.data.plan.id] : aborted.success ? [aborted.data.plan.id] : [];
  }));
  for (const document of documents) {
    const parsed = GitRewritePlanSchema.safeParse(document);
    if (!parsed.success || parsed.data.workId !== workspace.owner.workId || settled.has(parsed.data.id)) continue;
    const plan = parsed.data;
    if (await workspace.head() === plan.before && await workspace.clean() && !await workspace.rebaseInProgress()) {
      ledger.append({ type: 'git', data: GitRewriteAbortedSchema.parse({ schema: 'git-rewrite-aborted-v1', plan }) });
    } else {
      const capture = GitRewriteCapture.recover(homes, plan.id);
      if (JSON.stringify(capture.plan) !== JSON.stringify(plan)) throw new Error('Integration capture does not match its recorded plan.');
      ledger.append({ type: 'git', data: await workspace.finishRebaseTracking(capture) });
    }
    settled.add(plan.id);
  }
}
export async function publishWorkspace(workspace: GitWorkspace, ledger: ConversationLedger, homes: Homes, leases: PublicationLeaseService, options: { nextStretch: () => number; integrate: Integrate; baseCommit?: string; assertCurrent?: () => void | Promise<void>; assertHistory?: () => void | Promise<void>; abortRebase?: () => Promise<void>; signal?: AbortSignal }): Promise<PublicationEvent> {
  const record = (data: Omit<PublicationEvent, 'schema' | 'workId'>): PublicationEvent => {
    const document = PublicationEventSchema.parse({ ...data, schema: 'publication-event-v1', workId: workspace.owner.workId });
    ledger.append({ type: 'publication', data: document }); return document;
  };
  if (workspace.project.branchPolicy === 'external') return record({ status: 'external', commit: await workspace.head(), attempts: 0, notice: "This project follows its own git rules. Jevellan won't commit or push here." });
  const receiptFor = (head: string, clean: boolean) => ledger.events().filter((event) => event.type === 'verification').map((event) => VerificationSchema.parse(ledger.data(event))).reverse().find((entry) => entry.workId === workspace.owner.workId && verificationCounts(entry, head, clean));
  await workspace.ownership.assert(workspace.project, workspace.owner);
  await options.assertCurrent?.();
  await recoverIntegrationHistory(workspace, ledger, homes); await options.assertHistory?.();
  const savedMemoryScope = (head: string) => ledger.events().some((event) => {
    if (event.type !== 'git') return false;
    const scope = MemoryPublicationScopeSchema.safeParse(ledger.data(event));
    return scope.success && scope.data.workId === workspace.owner.workId && scope.data.baseCommit === options.baseCommit && scope.data.commit === head;
  });
  const memoryOnly = !!options.baseCommit && (savedMemoryScope(await workspace.head()) || await onlyMemoryChanges(workspace, options.baseCommit));
  if (workspace.project.testCommand && !memoryOnly) {
    const initial = receiptFor(await workspace.head(), await workspace.clean()) ?? await verifyWorkspace(workspace, ledger, homes, 'done-gate', options);
    if (!verificationCounts(initial, await workspace.head(), await workspace.clean())) return record({ status: 'blocked', commit: await workspace.head(), attempts: 0, verificationId: initial.id, notice: 'Verification failed or the tested checkout changed. This work remains open.' });
  }
  const remote = await workspace.publicationKey();
  const abortRebase = options.abortRebase ?? (() => workspace.abortRebase());
  return withPublicationLease(leases, remote, workspace.owner.workId, async (assertLease) => {
    const allowed = async () => { await options.assertCurrent?.(); await assertLease(); await options.assertCurrent?.(); };
    let savedRef: string | undefined;
    for (let attempts = 1; attempts <= 3; attempts++) {
      await workspace.ownership.assert(workspace.project, workspace.owner);
      await allowed(); await options.assertHistory?.(); await workspace.fetch();
      const upstream = await workspace.upstream();
      if (!await workspace.contains(upstream)) {
        const conflicts: GitConflict[] = []; const at = new Date().toISOString();
        const tracking = await workspace.prepareRebaseTracking(homes, newId('integration'));
        ledger.append({ type: 'git', data: tracking.plan });
        let outcome: 'clean' | 'conflict';
        try {
          outcome = await workspace.rebase({ tracking, assertCurrent: allowed, resolveConflicts: async (files) => {
            await allowed(); const resolutions = memoryConflictResolutions(workspace.project, files, workspace.deviceId, at);
            if (resolutions) conflicts.push(...files); return resolutions;
          } });
        } catch (error) { await abortRebase(); throw error; }
        if (outcome === 'clean') ledger.append({ type: 'git', data: await workspace.finishRebaseTracking(tracking) });
        if (outcome === 'clean' && conflicts.length) {
          await workspace.assertIntegrated();
          ledger.append({ type: 'git', data: MemoryConflictMergeSchema.parse({ schema: 'memory-conflict-merge-v1', workId: workspace.owner.workId, deviceId: workspace.deviceId, at, upstream, commit: await workspace.head(),
            files: conflicts.map((file) => ({ path: file.path, upstream: file.upstream?.oid ?? null, local: file.local?.oid ?? null })) }) });
        }
        if (outcome === 'conflict') {
          await abortRebase(); await allowed();
          savedRef = await workspace.saveRef('pre-integration', options.nextStretch());
          let rewritten = false;
          const run: IntegrationRunner = async (command) => {
            await allowed();
            if (!rewritten) {
              const status = command === 'start' ? await workspace.rebase({ tracking, assertCurrent: allowed }) : await workspace.continueTrackedRebase(tracking, command, allowed);
              if (status === 'clean') { ledger.append({ type: 'git', data: await workspace.finishRebaseTracking(tracking) }); rewritten = true; }
              return IntegrationStatusSchema.parse({ schema: 'integration-status-v1', status, conflicts: status === 'conflict' ? await workspace.integrationConflicts() : [] });
            }
            return IntegrationStatusSchema.parse({ schema: 'integration-status-v1', status: 'clean', conflicts: [] });
          };
          const completed = await options.integrate({ upstream, savedRef, run });
          if (!completed) return record({ status: 'blocked', commit: await workspace.head(), attempts, savedRef, notice: `Couldn't bring in newer work from main automatically. Your work is saved at ${savedRef}.` });
          if (!rewritten) throw new Error('The integration step did not finish through its tracked Git tool. Publication has not run.');
          await workspace.assertIntegrated();
        }
      }
      await options.assertHistory?.();
      const head = await workspace.head(); const clean = await workspace.clean();
      const exempt = memoryOnly && (head === upstream || await onlyMemoryChanges(workspace, upstream));
      let receipt: Verification | undefined;
      if (workspace.project.testCommand && !exempt) {
        receipt = receiptFor(head, clean);
        receipt ??= await verifyWorkspace(workspace, ledger, homes, 'publication', options);
        if (!verificationCounts(receipt, await workspace.head(), await workspace.clean())) return record({ status: 'blocked', commit: await workspace.head(), attempts, verificationId: receipt.id, ...(savedRef ? { savedRef } : {}), notice: 'Verification failed or the tested checkout changed. This work remains open.' });
      } else if (!clean) throw new Error('Publication requires a clean checkpoint.');
      // A retry after rebase must not mistake upstream code for this work's changes.
      // The receipt qualifies one exact commit only; later edits require a fresh check.
      if (exempt && !savedMemoryScope(head)) ledger.append({ type: 'git', data: MemoryPublicationScopeSchema.parse({ schema: 'memory-publication-scope-v1', workId: workspace.owner.workId, baseCommit: options.baseCommit, commit: head, upstream }) });
      await allowed();
      if (await workspace.push(head, async () => { await allowed(); await options.assertHistory?.(); }) === 'pushed') return record({ status: 'published', commit: head, attempts, ...(receipt ? { verificationId: receipt.id } : exempt ? { verificationExemption: 'memory-only', notice: 'Published memory-only changes without running project tests.' } : { notice: 'Finished without tests: this project has no test command.' }), ...(savedRef ? { savedRef } : {}) });
    }
    return record({ status: 'blocked', commit: await workspace.head(), attempts: 3, ...(savedRef ? { savedRef } : {}), notice: 'Main changed during publication three times. Your checkpoints remain local; retry when ready.' });
  });
}
