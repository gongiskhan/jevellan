import { join } from 'node:path';
import { rankAccounts } from '@jevellan/accounts';
import type { AccountService } from '@jevellan/accounts';
import { ACCOUNT_REASON_TEXT } from '@jevellan/decisions';
import { PROJECT_MEMORY_ID, applicationRoot, type AccountStatus, type Effort, type Homes, type RiggingItem, type SecretRedactor } from '@jevellan/core';
import type { StretchBridges } from '@jevellan/conversations';
import { TurnInputSchema, type RuntimeAdapter, type StretchRun, type TurnInput } from '@jevellan/runtime-contract';
import type { ProjectTools } from './bridge-tools.js';
import { ACCOUNT_BUSY, MEMORY_HOOKS_UNDELIVERED, accountInTerminal, cannotRunHere, noTurnAccount, waitingForAccountReason } from './copy.js';
import { ThreadGit } from './git.js';

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
  prompt(resumed: boolean): string;
  resume?: string | undefined; safetyProfile: 'coordinator' | 'thread'; timeoutMs: number; tools: ProjectTools;
  /** Thread turns: the project checkout whose git identity the agent commits with (D15). */
  gitIdentityFrom?: string | undefined;
};
export type LaunchStarted = {
  kind: 'started'; run: StretchRun; accountId: string; accountLabel: string; accountChanged: boolean; resumed: boolean; secretRef: string | null;
  /** This device's last known usage of the account, the base for streamed rate limits. */
  usage?: AccountStatus['usage'] | undefined;
  gitIdentity?: GitIdentity | undefined;
  /** Closes the bridge grant and the serial account guard; idempotent. */
  release(): Promise<void>;
};
export type LaunchResult = LaunchStarted | { kind: 'unavailable'; reason: string };
export type TurnLauncherOptions = {
  accounts: Pick<AccountService, 'list' | 'resolve' | 'markUsed'>; runtimes: ReadonlyMap<string, RuntimeAdapter>; accountRuns: Set<string>;
  riggingItems(runtime: string): Promise<RiggingItem[]>; bridges: Pick<StretchBridges, 'issueTools'>; homes: Homes; deviceId: string;
  deviceName: string; daemonUrl(): string; redactor: SecretRedactor;
  /**
   * The accounts of threads attached in a terminal on this device (phase 8), read at every launch from the threads' own state, so a
   * restart keeps them and detach frees them. No turn starts on them, whatever the runtime's serial guard says.
   */
  held?(): ReadonlySet<string>;
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
      model: request.model, deviceId: this.#o.deviceId }).filter((entry) => entry.account.runtime === request.runtime);
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
    const daemonUrl = this.#o.daemonUrl();
    if (!daemonUrl) throw new Error('Project turns start after the daemon is listening.');
    const adapter = this.#o.runtimes.get(request.runtime); const capabilities = adapter?.capabilities;
    if (!adapter || !capabilities?.turns || !capabilities.mcp || (request.permissions === 'read-only' ? !capabilities.readOnlyEnforced : !capabilities.edit || !capabilities.shell)) {
      return { kind: 'unavailable', reason: cannotRunHere(adapter?.displayName ?? request.runtime) };
    }
    const accounts = await this.#o.accounts.list();
    const ranking = this.#ranking(accounts, request).filter((entry) => request.requiredAccountId === undefined || entry.account.id === request.requiredAccountId);
    // An account a terminal holds is passed over like an ineligible one: the pinned account while it is free, else the next in rank (D16).
    const held = this.#o.held?.() ?? new Set<string>();
    const free = (entry: Ranked) => entry.eligible && !held.has(entry.account.id);
    const selected = ranking.find((entry) => free(entry) && entry.account.id === request.pinnedAccountId) ?? ranking.find(free);
    if (!selected) {
      const taken = ranking.find((entry) => entry.eligible);
      if (taken) return { kind: 'unavailable', reason: accountInTerminal(taken.account.label) };
      const best = ranking[0]?.reason;
      return { kind: 'unavailable', reason: noTurnAccount(request.modelLabel, this.#o.deviceName, `${adapter.displayName} ${ACCOUNT_REASON_TEXT[best && best !== 'eligible' ? best : 'no-account']}`) };
    }
    const account = selected.account;
    const accountChanged = request.pinnedAccountId !== undefined && account.id !== request.pinnedAccountId;
    const resumed = !!request.resume && !accountChanged;
    const serial = !capabilities.perLaunchConfig;
    if (serial && this.#o.accountRuns.has(account.id)) return { kind: 'unavailable', reason: ACCOUNT_BUSY };
    if (serial) this.#o.accountRuns.add(account.id);
    let grant: { token: string; close(): Promise<void> } | undefined; let released = false;
    const release = async () => {
      if (released) return; released = true;
      try { await grant?.close(); } finally { if (serial) this.#o.accountRuns.delete(account.id); }
    };
    try {
      const resolved = await this.#o.accounts.resolve(account.id);
      const rigging = await this.#o.riggingItems(request.runtime);
      const delivered = await adapter.materialiseRigging(resolved.home, rigging);
      if (adapter.riggingKinds.includes('hook') && rigging.some((item) => item.id === PROJECT_MEMORY_ID && item.enabled && item.state !== 'parked')
        && !delivered.some((item) => item.itemId === PROJECT_MEMORY_ID && item.applied)) { await release(); return { kind: 'unavailable', reason: MEMORY_HOOKS_UNDELIVERED }; }
      const gitIdentity = request.owner.kind === 'thread' && request.gitIdentityFrom ? await this.#identity(request.gitIdentityFrom) : undefined;
      await this.#o.accounts.markUsed(account.id);
      grant = this.#o.bridges.issueTools(request.tools);
      // Every value is non-empty: WorkerRun drops empty launch values, and the MCP server env must equal what it keeps.
      const env: Record<string, string> = { JEVELLAN_STRETCH_TOKEN: grant.token, JEVELLAN_DAEMON_URL: daemonUrl,
        ...(gitIdentity ? { GIT_AUTHOR_NAME: gitIdentity.name, GIT_AUTHOR_EMAIL: gitIdentity.email, GIT_COMMITTER_NAME: gitIdentity.name, GIT_COMMITTER_EMAIL: gitIdentity.email } : {}) };
      const input = TurnInputSchema.parse({
        schema: 'turn-input-v1', owner: request.owner, turn: request.turn, cwd: request.cwd, permissions: request.permissions, model: request.model, effort: request.effort,
        account: resolved, systemAppend: request.systemAppend, prompt: request.prompt(resumed), ...(resumed ? { resume: { sessionId: request.resume } } : {}),
        launch: { env, mcpServers: { jevellan: { command: process.execPath, args: [join(applicationRoot(), 'bin', 'jevellan.mjs'), 'mcp-bridge'], env } } },
        safetyProfile: request.safetyProfile, timeoutMs: request.timeoutMs,
      });
      const run = adapter.startTurn(input);
      const usage = accounts.find((view) => view.account.id === account.id)?.statuses.find((status) => status.deviceId === this.#o.deviceId)?.usage;
      return { kind: 'started', run, accountId: account.id, accountLabel: account.label, accountChanged, resumed, secretRef: account.secretRef ?? null,
        ...(usage ? { usage } : {}), ...(gitIdentity ? { gitIdentity } : {}), release };
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  }
}
