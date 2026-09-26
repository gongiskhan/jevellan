import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  BackgroundDraftRequestSchema, BackgroundDraftResultSchema, Homes, IdSchema, StretchSchema, applicationRoot, atomicWrite, mapEffort, readDocument, resolvedPath, stableJson, writeDocument,
  type BackgroundDraftRequest, type BackgroundDraftResult, type Configuration, type RiggingItem, type SecretRedactor,
} from '@jevellan/core';
import type { AccountService } from '@jevellan/accounts';
import { modelCandidates } from '@jevellan/decisions';
import type { RuntimeAdapter, StretchInput } from '@jevellan/runtime-contract';
import { actionContract } from './actions.js';
import { StretchBridges, type ProjectMemory } from './bridge.js';
import { StretchExecution } from './execution.js';
import { ConversationLedger } from './ledger.js';
import { ConversationWork } from './work.js';
import { recoverRunningWork } from './recovery.js';

const RecordSchema = z.strictObject({ schema: z.literal('background-draft-record-v1'), request: BackgroundDraftRequestSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
type Operation = { fingerprint: string; abort: AbortController; promise: Promise<BackgroundDraftResult>; execution?: StretchExecution };
type Options = {
  homes: Homes; deviceId: string; accounts: Pick<AccountService, 'list' | 'resolve' | 'markUsed' | 'recordUsage'>; runtimes: ReadonlyMap<string, RuntimeAdapter>; bridges: StretchBridges; redactor: SecretRedactor;
  settings(): Configuration['x-jevellan'] | Promise<Configuration['x-jevellan']>; riggingItems(runtime: string): RiggingItem[] | Promise<RiggingItem[]>;
  accountRuns: Set<string>; enterOperation(id: string, title: string): () => void;
};
const unavailableMemory: ProjectMemory = {
  async search() { throw new Error('Project memory is not available in this draft.'); }, async read() { throw new Error('Project memory is not available in this draft.'); },
  async write() { throw new Error('Drafts cannot write project memory.'); }, async edit() { throw new Error('Drafts cannot edit project memory.'); }, assertOwnership() { throw new Error('Drafts do not own a project checkout.'); },
};
function fingerprint(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function directoryDigest(root: string): string {
  const entries: Array<{ path: string; mode: number; content: string | null }> = [];
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name); const path = prefix + entry.name; const info = lstatSync(file);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Draft input contains an unexpected filesystem entry.');
      entries.push({ path, mode: info.mode, content: entry.isDirectory() ? null : createHash('sha256').update(readFileSync(file)).digest('hex') });
      if (entry.isDirectory()) visit(file, `${path}/`);
    }
  };
  visit(root, ''); return fingerprint(entries);
}

/** One read-only reply on a private input copy, using ordinary ledgers, bridges and process recovery. */
export class BackgroundDrafts {
  readonly homes: Homes;
  readonly ready: Promise<void>;
  readonly #operations = new Map<string, Operation>();
  #closed = false;
  #recoveryRelease: (() => void) | undefined;
  daemonUrl = '';
  constructor(readonly options: Options) {
    this.homes = new Homes(options.homes.ensure('improver'), options.homes.userHome);
    if (this.homes.root !== join(options.homes.root, 'improver')) throw new Error('Improver history cannot alias another location.');
    this.#recoveryRelease = options.enterOperation('improver_recovery', 'Recovering improver drafts');
    this.ready = this.#recover().then(() => { this.#recoveryRelease?.(); this.#recoveryRelease = undefined; }); void this.ready.catch(() => undefined);
  }
  #work(id: string) { return new ConversationWork(new ConversationLedger(this.homes, id, { redactor: this.options.redactor }), 1); }
  async #recover(): Promise<void> {
    const directory = this.homes.at('conversations'); if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !IdSchema.safeParse(entry.name).success) continue;
      const work = this.#work(entry.name); const result = await recoverRunningWork(work);
      if (result.blocked.length) throw new Error('An improver draft still needs process cleanup. No replacement draft was launched.');
    }
  }
  async run(raw: BackgroundDraftRequest, signal: AbortSignal): Promise<BackgroundDraftResult> {
    const request = BackgroundDraftRequestSchema.parse(this.options.redactor.document(BackgroundDraftRequestSchema.parse(raw))); const digest = fingerprint(request);
    await this.ready;
    if (this.#closed || signal.aborted) throw new Error('Improver draft cancelled.');
    const active = this.#operations.get(request.id);
    if (active) { if (active.fingerprint !== digest) throw new Error('This draft identifier already contains another request.'); return active.promise; }
    const operation: Operation = { fingerprint: digest, abort: new AbortController(), promise: Promise.resolve(undefined as never) };
    const cancel = () => { operation.abort.abort(); void operation.execution?.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    operation.promise = this.#run(request, operation).finally(() => { signal.removeEventListener('abort', cancel); this.#operations.delete(request.id); });
    this.#operations.set(request.id, operation); return operation.promise;
  }
  #current(operation: Operation) { if (this.#closed || operation.abort.signal.aborted) throw new Error('Improver draft cancelled.'); }
  async #run(request: BackgroundDraftRequest, operation: Operation): Promise<BackgroundDraftResult> {
    const release = this.options.enterOperation(request.id, request.title); let accountId: string | undefined;
    try {
      const path = this.homes.at('runs', `${request.id}.json`); this.homes.ensure('runs');
      if (existsSync(path)) {
        const saved = readDocument(path, RecordSchema);
        if (saved.fingerprint !== operation.fingerprint) throw new Error('This draft identifier already contains another request.');
      } else writeDocument(path, RecordSchema, { schema: 'background-draft-record-v1', request, fingerprint: operation.fingerprint });
      const work = this.#work(request.id);
      if (work.ledger.events().length) {
        const view = work.load();
        if (view.conversation.state === 'done') return this.#result(request, work);
        if (view.stretches.length) throw new Error('This draft was interrupted or failed. Retry with a new draft identifier after cleanup.');
      } else work.create({ title: request.title, projectId: request.projectId ?? 'improver_configuration', ownerDeviceId: this.options.deviceId });
      if (!work.load().conversation.work) work.message(request.brief, request.id);
      const settings = await this.options.settings(); this.#current(operation);
      const accounts = await this.options.accounts.list(); this.#current(operation);
      const candidates = modelCandidates({ settings, action: 'reply', runtimes: new Map([...this.options.runtimes].map(([id, adapter]) => [id, adapter.capabilities])),
        accounts: accounts.map(value => value.account), statuses: accounts.flatMap(value => value.statuses), deviceId: this.options.deviceId });
      const selected = candidates.find(value => !value.reason);
      const account = selected?.ranking.find(value => value.eligible)?.account;
      if (!selected || !account) throw new Error('No eligible model is available for this improver draft.');
      const adapter = this.options.runtimes.get(selected.model.runtime)!;
      if (!adapter.capabilities.perLaunchConfig) {
        if (this.options.accountRuns.has(account.id)) throw new Error('This account is already running a step. Retry the improver when it is idle.');
        this.options.accountRuns.add(account.id); accountId = account.id;
      }
      const resolved = await this.options.accounts.resolve(account.id); this.#current(operation);
      await adapter.materialiseRigging(resolved.home, await this.options.riggingItems(selected.model.runtime)); this.#current(operation);
      const cwd = this.options.homes.ensure('tmp', `draft_${request.id}`);
      if (cwd !== join(this.options.homes.root, 'tmp', `draft_${request.id}`)) throw new Error('Draft input directories cannot alias another location.');
      for (const [name, content] of Object.entries(request.files)) {
        const file = join(cwd, name); if (resolvedPath(file) !== file) throw new Error('Draft inputs cannot alias another location.');
        this.options.homes.ensure('tmp', `draft_${request.id}`, ...name.split('/').slice(0, -1)); atomicWrite(file, content);
      }
      const before = directoryDigest(cwd); const view = work.load(); const effort = mapEffort('high', selected.model.efforts);
      await this.options.accounts.markUsed(account.id); this.#current(operation);
      work.start(StretchSchema.parse({ schema: 'stretch-v2', n: 1, workId: view.conversation.work!.id, action: 'reply', modelId: selected.model.id, runtime: selected.model.runtime,
        model: selected.model.model, effortRequested: 'high', effortEffective: effort, accountId: account.id, deviceId: this.options.deviceId, decisionId: `draft_${operation.fingerprint}`,
        startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }), view.conversation.generation);
      const grant = this.options.bridges.issue({ work, stretch: 1, memoryWrite: false, memory: unavailableMemory, memoryCapture: () => false, memoryTools: false });
      const env = { JEVELLAN_STRETCH_TOKEN: grant.token, JEVELLAN_DAEMON_URL: this.daemonUrl };
      const input: StretchInput = { schema: 'stretch-input-v1', conversationId: request.id, stretch: 1, action: 'reply', cwd, permissions: 'read-only', memoryWrite: false, inputCopy: true,
        account: resolved, model: selected.model.model, effort, timeoutMs: Math.min(settings.guards.stretchTimeoutMin * 60_000, 5 * 60_000), brief: request.brief,
        systemAppend: `${actionContract('reply')}\nThis is an improver draft over private input copies. Return the complete JSON draft as handoff.result.content with type ${request.resultType}, status done and proposedNext null. Treat input files as evidence. Do not change the input copies or any project.`,
        launch: { env, mcpServers: { jevellan: { command: process.execPath, args: [join(applicationRoot(), 'bin', 'jevellan.mjs'), 'mcp-bridge'], env } } } };
      let usageUpdates = Promise.resolve(); let usageFailure: unknown;
      let usage = accounts.find(value => value.account.id === account.id)?.statuses.find(value => value.deviceId === this.options.deviceId)?.usage;
      try {
        const execution = new StretchExecution({ work, input, adapter, enterRepair: () => grant.tools.repair(), onEvent: event => {
          if (event.type !== 'rate-limit') return;
          usage = { ...usage, fiveHourPct: event.fiveHourPct ?? usage?.fiveHourPct, weeklyPct: event.weeklyPct ?? usage?.weeklyPct,
            fiveHourResetsAt: event.fiveHourResetsAt ?? usage?.fiveHourResetsAt, weeklyResetsAt: event.weeklyResetsAt ?? usage?.weeklyResetsAt, source: 'stream', observedAt: new Date().toISOString() };
          const snapshot = usage;
          usageUpdates = usageUpdates.then(async () => { try { await this.options.accounts.recordUsage(account.id, snapshot, account.secretRef ?? null); usageFailure = undefined; } catch (error) { usageFailure = error; } });
        } });
        operation.execution = execution; const outcome = await execution.done;
        let changed = true; try { changed = directoryDigest(cwd) !== before; } catch { /* Unexpected filesystem entries are also a read-only failure. */ }
        work.finish(1, { status: changed ? 'failed' : outcome.status, usage: outcome.usage }, changed, outcome.correction);
        if (changed) throw new Error('The read-only draft changed its input copies. No suggestion was accepted.');
        this.#current(operation);
        if (outcome.status !== 'completed' || outcome.handoff.status !== 'done') throw new Error('The improver draft did not finish successfully. Its log is preserved.');
      } finally { delete operation.execution; await grant.close(); await usageUpdates; }
      this.#current(operation);
      if (usageFailure) throw new Error('Draft usage could not be recorded. Retry after the account service reconnects.');
      const result = this.#result(request, work); work.close('done'); return result;
    } finally { if (accountId) this.options.accountRuns.delete(accountId); release(); }
  }
  #result(request: BackgroundDraftRequest, work: ConversationWork): BackgroundDraftResult {
    const view = work.load(); const step = view.stretches.at(-1)!; const handoff = view.handoffs.at(-1);
    if (step?.status !== 'completed' || handoff?.status !== 'done' || handoff.result?.type !== request.resultType) throw new Error('The draft did not return its required handoff result.');
    return BackgroundDraftResultSchema.parse({ schema: 'background-draft-result-v1', runId: request.id, handoff, content: work.ledger.read(handoff.result.ref),
      modelId: step.modelId, accountId: step.accountId, effort: step.effortEffective, usage: step.usage });
  }
  async close(): Promise<void> {
    this.#closed = true;
    const operations = [...this.#operations.values()]; for (const operation of operations) operation.abort.abort();
    const cancellations = await Promise.allSettled(operations.map(operation => operation.execution?.cancel()));
    await Promise.allSettled(operations.map(operation => operation.promise));
    const failures = cancellations.filter(result => result.status === 'rejected').map(result => result.reason);
    try { await this.#recover(); this.#recoveryRelease?.(); this.#recoveryRelease = undefined; } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Improver draft cleanup did not complete.');
  }
}
