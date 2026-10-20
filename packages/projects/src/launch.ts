import { join } from 'node:path';
import { rankAccounts } from '@jevellan/accounts';
import type { AccountService } from '@jevellan/accounts';
import { ACCOUNT_REASON_TEXT } from '@jevellan/decisions';
import { PROJECT_MEMORY_ID, applicationRoot, deviceAllowsWork, projectEnvironment, type PlacementAccountChoice, type AccountStatus, type Effort, type Homes, type RiggingItem, type ProjectWorkSettings, type SecretRedactor } from '@jevellan/core';
import type { BridgeScopeTools, StretchBridges } from '@jevellan/conversations';
import { TurnInputSchema, type RuntimeAdapter, type StretchRun, type TurnInput } from '@jevellan/runtime-contract';
import { ACCOUNT_BUSY, MEMORY_HOOKS_UNDELIVERED, accountInTerminal, libraryInstructions, cannotRunHere, noTurnAccount, waitingForAccountReason } from './copy.js';
import { ThreadGit } from './git.js';
import { compactPercent, contextEvent, sessionContext } from './session-context.js';
import type { ProjectLedger } from './ledger.js';
import { cacheRecords, sameCacheSession, cacheWindowMinutes, defaultCacheWindow, measureSession } from './session-cache.js';

import { coldCheckpoint, checkpointRun, sessionHash } from './checkpoints.js';

export type GitIdentity = { name: string; email: string };
export type LaunchRequest = {
  owner: TurnInput['owner']; turn: number; runtime: string; modelId: string; model: string;
  /** Menu label of the model, for the refusal text. */
  modelLabel: string;
  effort: Effort;
  /** The account the session lives on (D16); a different eligible account starts a fresh session. */
  pinnedAccountId?: string | undefined;
  /** An owner override is a requirement, unlike the preferred account of an automatic session. */
  requiredAccountId?: string | undefined;
  permissions: 'read-only' | 'write'; cwd: string; systemAppend: string;
  /**
   * Built after account resolution: `resumed` is false when there is no stored session or D16 dropped it, and the caller
   * then includes its fresh preamble (the thread task block, D94; the coordinator's fresh context).
   */
  prompt(resumed: boolean): string | Promise<string>;
  checkpointPrompt?(journal: string): Promise<{ digest: string; pending: string }>;
  resume?: string | undefined; safetyProfile: TurnInput['safetyProfile']; timeoutMs: number; tools: BridgeScopeTools;
  /** Thread turns: the project checkout whose git identity the agent commits with (D15). */
  gitIdentityFrom?: string | undefined;
  memoryMode?: 'hub' | 'repo' | 'device';
  isolation?: 'worktree' | 'main';
  contextTokensBefore?: number | null | undefined;
};
export type LaunchStarted = {
  /** Effective user input after account/session resolution; safe owner evidence uses the ledger redactor. */
  prompt?: string;
  kind: 'started'; run: StretchRun; accountId: string; accountLabel: string; accountChanged: boolean; resumed: boolean; secretRef: string | null;
  /** This device's last known usage of the account, the base for streamed rate limits. */
  usage?: AccountStatus['usage'] | undefined;
  accountChoice?: PlacementAccountChoice;
  compactionPercent: number; compactionNotice?: string;
  gitIdentity?: GitIdentity | undefined;
  /** Closes the bridge grant and the serial account guard; idempotent. */
  release(): Promise<void>;
};
export type AccountWait = { reason: string; earliestEligibleAt: string | null };
export type LaunchResult = LaunchStarted | { kind: 'unavailable'; reason: string; accountWait?: AccountWait | undefined };
export type TurnLauncherOptions = {
  accounts: Pick<AccountService, 'list' | 'resolve' | 'markUsed'>; runtimes: ReadonlyMap<string, RuntimeAdapter>; accountRuns: Set<string>;
  riggingItems(runtime: string, projectId?: string): Promise<RiggingItem[]>; bridges: Pick<StretchBridges, 'issueTools'>; homes: Homes; deviceId: string;
  deviceName: string; daemonUrl(): string; redactor: SecretRedactor;
  /**
   * The accounts of threads attached in a terminal on this device (phase 8), read at every launch from the threads' own state, so a
   * restart keeps them and detach frees them. No turn starts on them, whatever the runtime's serial guard says.
   */
  held?(): ReadonlySet<string>;
  useOwnSetup?(runtime: string): Promise<boolean>;
  cacheWindowMinutes?(runtime: string): Promise<number>;
  projectSettings?(projectId: string): Promise<ProjectWorkSettings>;
  library?: import('@jevellan/core').ProjectLibrary | undefined;
  projectEnvironment?(projectId: string): Promise<Record<string, string>>;
  sessionLedger?(projectId: string): ProjectLedger;
  cacheLedger?(owner: TurnInput['owner']): ProjectLedger;
  journalDirectory?(projectId: string): Promise<string>;
  archiveSession?(owner: TurnInput['owner'], session: import('@jevellan/core').SessionHistory): void;
  now?(): number;
  protectedPaths?(): Promise<string[]>;
  /** Fresh, repository-scoped Git authentication for a writable thread turn; never persisted in a home or MCP configuration. */
  threadGitEnvironment?(projectId: string, cwd: string): Promise<Record<string, string>>;
  chooseAccount?(request: LaunchRequest, ranking: readonly Ranked[]): Promise<PlacementAccountChoice>;
};
type Ranked = ReturnType<typeof rankAccounts>[number];

/**
 * Starts one coordinator or thread turn, shared by both (brief 6.1, 8.1, 8.2). Mirrors the stretch launch: capability gate,
 * account ranking with the session's account kept while it is eligible (D16), the serial guard for runtimes without
 * per-launch configuration, rigging with the project-memory delivery check, `markUsed`, a scoped bridge grant, and the
 * launch environment with the machine's git identity for thread turns (D15). Nothing durable is written here.
 */
export class TurnLauncher {
  readonly #o: TurnLauncherOptions;
  readonly #git: ThreadGit;
  readonly #modelWindows = new Map<string, { at: number; values: Promise<Map<string, number>> }>();
  readonly #identities = new Map<string, Promise<GitIdentity | undefined>>();
  constructor(o: TurnLauncherOptions) { this.#o = o; this.#git = new ThreadGit({ homes: o.homes, redactor: o.redactor }); }
  /** Read once per checkout per daemon; a failed read is retried next time. */
  #identity(path: string): Promise<GitIdentity | undefined> {
    let identity = this.#identities.get(path);
    if (!identity) {
      identity = this.#git.identity(path); this.#identities.set(path, identity);
      identity.catch(() => { this.#identities.delete(path); });
    }
    return identity;
  }
  #ranking(accounts: Awaited<ReturnType<AccountService['list']>>, request: Pick<LaunchRequest, 'runtime' | 'model'>): Ranked[] {
    return rankAccounts({ accounts: accounts.map((view) => view.account), statuses: accounts.flatMap((view) => view.statuses), runtime: request.runtime,
      model: request.model, deviceId: this.#o.deviceId, now: this.#o.now?.() ?? Date.now() }).filter((entry) => entry.account.runtime === request.runtime);
  }
  async unavailableAccount(request: Pick<LaunchRequest, 'runtime' | 'model' | 'modelLabel' | 'requiredAccountId'>): Promise<AccountWait | undefined> {
    const ranking = this.#ranking(await this.#o.accounts.list(), request).filter(row => !request.requiredAccountId || row.account.id === request.requiredAccountId);
    if (ranking.some(row => row.eligible)) return undefined;
    const now = this.#o.now?.() ?? Date.now();
    const resets = ranking.filter(row => ['cooling', 'usage-ceiling'].includes(row.reason)).map(row => {
      const status = row.status, usage = status?.usage;
      const dates = [status?.coolingUntil, status?.modelCooling?.[request.model],
        ...(usage?.fiveHourPct !== undefined && usage.fiveHourPct >= row.account.ceilingPct ? [usage.fiveHourResetsAt ?? null] : []),
        ...(usage?.weeklyPct !== undefined && usage.weeklyPct >= row.account.ceilingPct ? [usage.weeklyResetsAt ?? null] : [])];
      if (dates.includes(null)) return null;
      const future = dates.flatMap(value => value && Date.parse(value) > now ? [Date.parse(value)] : []);
      return future.length ? Math.max(...future) : null;
    });
    const known = resets.filter((value): value is number => value !== null);
    const earliestEligibleAt = known.length ? new Date(Math.min(...known)).toISOString() : null;
    const best = ranking[0]?.reason, adapter = this.#o.runtimes.get(request.runtime);
    return { reason: `${adapter?.displayName ?? request.runtime} ${ACCOUNT_REASON_TEXT[best && best !== 'eligible' ? best : 'no-account'].replace('{model}', request.modelLabel)}`, earliestEligibleAt };
  }
  /**
   * Why a turn of `runtime` and `model` waits now (phase 8): no eligible account is free because threads attached in a terminal here hold
   * them. Undefined when one is free, and when none is eligible at all (the launch then answers with its own refusal).
   */
  async accountWait(request: Pick<LaunchRequest, 'runtime' | 'model' | 'requiredAccountId'>): Promise<string | undefined> {
    const held = this.#o.held?.(); if (!held?.size) return undefined;
    const ranking = this.#ranking(await this.#o.accounts.list(), request).filter((entry) => request.requiredAccountId === undefined || entry.account.id === request.requiredAccountId);
    if (ranking.some((entry) => entry.eligible && !held.has(entry.account.id))) return undefined;
    const taken = ranking.find((entry) => entry.eligible);
    return taken && waitingForAccountReason(taken.account.label);
  }
  async launch(request: LaunchRequest): Promise<LaunchResult> {
    if (!deviceAllowsWork(this.#o.homes)) return { kind: 'unavailable', reason: 'This device serves apps only; project work runs on a working device.' };
    const daemonUrl = this.#o.daemonUrl();
    if (!daemonUrl) throw new Error('Project turns start after the daemon is listening.');
    const adapter = this.#o.runtimes.get(request.runtime); const capabilities = adapter?.capabilities;
    if (!adapter || !capabilities?.turns || !capabilities.mcp || (request.permissions === 'read-only' ? !capabilities.readOnlyEnforced : !capabilities.edit || !capabilities.shell)) {
      return { kind: 'unavailable', reason: cannotRunHere(adapter?.displayName ?? request.runtime) };
    }
    let accounts = await this.#o.accounts.list();
    let ranking = this.#ranking(accounts, request).filter((entry) => request.requiredAccountId === undefined || entry.account.id === request.requiredAccountId);
    // An account a terminal holds is passed over like an ineligible one: the pinned account while it is free, else the next in rank (D16).
    const held = new Set(this.#o.held?.() ?? []);
    const free = (entry: Ranked) => entry.eligible && !held.has(entry.account.id);
    const pinned = ranking.find((entry) => free(entry) && entry.account.id === request.pinnedAccountId);
    const chosenAccount = !pinned && request.requiredAccountId === undefined && ranking.some(free) && this.#o.chooseAccount
      ? await this.#o.chooseAccount(request, ranking.filter(entry => !held.has(entry.account.id))) : undefined;
    if (chosenAccount) {
      accounts = await this.#o.accounts.list(); ranking = this.#ranking(accounts, request);
      for (const id of this.#o.held?.() ?? []) held.add(id);
    }
    const selected = pinned ?? (chosenAccount ? ranking.find(entry => free(entry) && entry.account.id === chosenAccount.accountId) : ranking.find(free));
    if (!selected) {
      if (chosenAccount) {
        const reason = 'The saved account changed availability while Jev was choosing. Retry the turn to choose an available account.';
        return { kind: 'unavailable', reason, accountWait: await this.unavailableAccount(request) ?? { reason, earliestEligibleAt: null } };
      }
      const taken = ranking.find((entry) => entry.eligible);
      if (taken) return { kind: 'unavailable', reason: accountInTerminal(taken.account.label) };
      const best = ranking[0]?.reason;
      return { kind: 'unavailable', reason: noTurnAccount(request.modelLabel, this.#o.deviceName, `${adapter.displayName} ${ACCOUNT_REASON_TEXT[best && best !== 'eligible' ? best : 'no-account'].replace('{model}', request.modelLabel)}`), accountWait: await this.unavailableAccount(request) };
    }
    const account = selected.account;
    const accountChanged = request.pinnedAccountId !== undefined && account.id !== request.pinnedAccountId;
    let resumed = !!request.resume && !accountChanged;
    const serial = !capabilities.perLaunchConfig;
    if (serial && this.#o.accountRuns.has(account.id)) return { kind: 'unavailable', reason: ACCOUNT_BUSY };
    if (serial) this.#o.accountRuns.add(account.id);
    let grant: { token: string; close(): Promise<void> } | undefined; let released = false;
    const release = async () => {
      if (released) return; released = true;
      try { await grant?.close(); } finally { if (serial) this.#o.accountRuns.delete(account.id); }
    };
    try {
      const projectSettings = await this.#o.projectSettings?.(request.owner.projectId);
      const percent = request.owner.kind === 'coordinator' ? 95 : compactPercent(projectSettings?.compactAtPercent ?? 70, this.#o.homes);
      const cacheWindow = cacheWindowMinutes(await this.#o.cacheWindowMinutes?.(request.runtime) ?? defaultCacheWindow(request.runtime), this.#o.homes);
      const resolved = await this.#o.accounts.resolve(account.id);
      let contextWindow: number | undefined;
      if (request.runtime === 'codex') {
        let cached = this.#modelWindows.get(account.id);
        if (!cached || cached.at + 15 * 60_000 < Date.now()) {
          cached = { at: Date.now(), values: adapter.listModels(resolved).then(models => new Map(models.flatMap(model => model.contextWindow ? [[model.id, model.contextWindow] as const] : []))).catch(() => new Map<string, number>()) };
          this.#modelWindows.set(account.id, cached);
        }
        contextWindow = (await cached.values).get(request.model);
      }
      const compactionNotice = request.runtime === 'codex' && !contextWindow ? 'Codex did not expose this model’s context window; native default auto-compaction is active until model discovery supplies it.' : undefined;
      const rigging = await this.#o.riggingItems(request.runtime, request.owner.projectId);
      const delivered = await adapter.materialiseRigging(resolved.home, rigging);
      if (adapter.riggingKinds.includes('hook') && rigging.some((item) => item.id === PROJECT_MEMORY_ID && item.enabled && item.state !== 'parked')
        && !delivered.some((item) => item.itemId === PROJECT_MEMORY_ID && item.applied)) { await release(); return { kind: 'unavailable', reason: MEMORY_HOOKS_UNDELIVERED }; }
      const gitIdentity = request.owner.kind === 'thread' && request.gitIdentityFrom ? await this.#identity(request.gitIdentityFrom) : undefined;
      await this.#o.accounts.markUsed(account.id);
      grant = this.#o.bridges.issueTools(request.tools);
      // Every value is non-empty: WorkerRun drops empty launch values, and the MCP server env must equal what it keeps.
      // The recursion guard (bridge): a session Jevellan starts never sees the owner tools; the forwarder registers none with a role set.
      const env: Record<string, string> = { JEVELLAN_STRETCH_TOKEN: grant.token, JEVELLAN_DAEMON_URL: daemonUrl, JEVELLAN_ROLE: request.owner.kind === 'coordinator' ? 'coordinator' : 'thread',
        ...(request.memoryMode ? { JEVELLAN_PROJECT_MEMORY_MODE: request.memoryMode } : {}),
        ...(gitIdentity ? { GIT_AUTHOR_NAME: gitIdentity.name, GIT_AUTHOR_EMAIL: gitIdentity.email, GIT_COMMITTER_NAME: gitIdentity.name, GIT_COMMITTER_EMAIL: gitIdentity.email } : {}) };
      const gitEnv = request.owner.kind === 'thread' && request.permissions === 'write'
        ? await this.#o.threadGitEnvironment?.(request.owner.projectId, request.cwd) ?? {} : {};
      const journal = await this.#o.journalDirectory?.(request.owner.projectId);
      const cacheLedger = this.#o.cacheLedger?.(request.owner) ?? this.#o.sessionLedger?.(request.owner.projectId);
      const now = this.#o.now ?? Date.now;
      const previous = resumed && cacheLedger ? cacheRecords(cacheLedger).findLast(row => sameCacheSession(row, request.owner, request.resume!, request.runtime, account.id)) : undefined;
      const checkpoint = request.owner.kind !== 'coordinator' && resumed && journal && request.checkpointPrompt ? coldCheckpoint(projectSettings?.sessionCheckpoints, previous, request.resume, cacheWindow, now(), request.contextTokensBefore) : undefined;
      const checkpointPrompt = checkpoint ? await request.checkpointPrompt!(journal!) : undefined;
      if (checkpoint) resumed = false;
      const prompt = checkpointPrompt ? `${checkpointPrompt.digest}\n\n${checkpointPrompt.pending}` : await request.prompt(resumed);
      const library = ['thread', 'coordinator'].includes(request.owner.kind) ? this.#o.library : undefined;
      if (library) await library.prepare(request.owner.projectId, prompt);
      const libraryDirectory = library?.directory(request.owner.projectId);
      const input = TurnInputSchema.parse({
        schema: 'turn-input-v1', owner: request.owner, turn: request.turn, cwd: request.cwd, permissions: request.permissions, model: request.model, effort: request.effort,
        account: resolved, systemAppend: (libraryDirectory ? `${libraryInstructions(libraryDirectory, request.owner.kind === 'thread')}\n\n` : '') + (journal ? `- The project journal at ${journal} has one file per thread, per day and per night, listed in INDEX.md. Read it when you need to know what other work did.\n\n` : '') + request.systemAppend, prompt, ...(resumed ? { resume: { sessionId: request.resume } } : {}),
        ...((journal || libraryDirectory) ? { readOnlyDirectories: [...(journal ? [journal] : []), ...(libraryDirectory ? [libraryDirectory] : [])] } : {}),
        launch: { ...(['thread', 'verification'].includes(request.owner.kind) ? { projectEnv: projectEnvironment(await this.#o.projectEnvironment?.(request.owner.projectId) ?? {}) } : {}), useOwnSetup: await this.#o.useOwnSetup?.(request.runtime) ?? true, env: { ...env, ...gitEnv }, mcpServers: { jevellan: { command: process.execPath, args: [join(applicationRoot(), 'bin', 'jevellan.mjs'), 'mcp-bridge'], env } } },
        safetyProfile: request.safetyProfile, timeoutMs: request.timeoutMs, compaction: { thresholdPercent: percent, ...(contextWindow ? { contextWindow } : {}) },
        ...(['thread', 'coordinator'].includes(request.owner.kind) ? { privatePaths: [this.#o.homes.at('project-work', request.owner.projectId, 'job-cache'), this.#o.homes.at('project-work', request.owner.projectId, 'job-workspaces')] } : {}),
        ...(request.owner.kind === 'thread' && request.isolation === 'worktree' ? { protectedPaths: await this.#o.protectedPaths?.() ?? [] } : {}),
      });
      const rawRun = adapter.startTurn(input);
      const measuredRun = cacheLedger ? measureSession(rawRun, { ledger: cacheLedger, owner: request.owner, runtime: request.runtime, model: request.model,
        accountId: account.id, turn: request.turn, windowMinutes: cacheWindow, ...(resumed ? { resume: request.resume } : {}),
        contextTokensBefore: resumed ? request.contextTokensBefore : undefined, timezone: projectSettings?.nightlyWindow.timezone, now: this.#o.now ?? Date.now }) : rawRun;
      const nativeRun = checkpoint && checkpointPrompt && cacheLedger && (request.owner.kind === 'coordinator' || request.owner.kind === 'thread') ? checkpointRun(measuredRun, cacheLedger, checkpoint, {
        kind: request.owner.kind, id: request.owner.id, turn: request.turn, digestChars: checkpointPrompt.digest.length, now,
        archive: previousSessionId => this.#o.archiveSession?.(request.owner, { schema: 'project-session-history-v1', key: sessionHash(previousSessionId), nativeSessionId: previousSessionId, runtime: request.runtime, model: request.model, accountId: account.id, at: new Date(now()).toISOString() }) }) : measuredRun;
      const ledger = ['review', 'verification', 'memory'].includes(request.owner.kind) ? this.#o.sessionLedger?.(request.owner.projectId) : undefined;
      let context = sessionContext(undefined, percent, compactionNotice);
      const run: StretchRun = ledger ? {
        get native() { return nativeRun.native; }, done: nativeRun.done,
        events: (async function* () {
          for await (const event of nativeRun.events) {
            context = contextEvent(context, event, request.owner, request.runtime, request.model, ledger, request.turn, new Date(now()).toISOString());
            yield event;
          }
        })(),
        interrupt: reason => nativeRun.interrupt(reason), continue: (message, timeout) => nativeRun.continue(message, timeout), terminate: () => nativeRun.terminate(),
      } : nativeRun;
      const usage = accounts.find((view) => view.account.id === account.id)?.statuses.find((status) => status.deviceId === this.#o.deviceId)?.usage;
      return { kind: 'started', run, prompt: input.prompt, accountId: account.id, accountLabel: account.label, accountChanged, resumed, secretRef: account.secretRef ?? null,
        ...(chosenAccount ? { accountChoice: chosenAccount } : {}),
        compactionPercent: percent, ...(compactionNotice ? { compactionNotice } : {}), ...(usage ? { usage } : {}), ...(gitIdentity ? { gitIdentity } : {}), release };
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  }
}
