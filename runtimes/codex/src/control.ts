import { createInterface } from 'node:readline';
import { minimalEnvironment, EffortSchema, AccountUsageSchema, type AccountStatus, type OfferedModel } from '@jevellan/core';
import { classifyRuntimeError, spawnGroup, terminateGroup, type NativeProcess, type ResolvedAccount } from '@jevellan/runtime-contract';
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';

const ReplySchema = z.object({ id: z.number().int().optional(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });
const ModelsSchema = z.object({ data: z.array(z.object({ id: z.string(), model: z.string(), displayName: z.string(), hidden: z.boolean(), isDefault: z.boolean(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })), nextCursor: z.string().nullable() });
const AccountReplySchema = z.object({ account: z.discriminatedUnion('type', [z.object({ type: z.literal('apiKey') }), z.object({ type: z.literal('chatgpt'), email: z.string().nullable(), planType: z.string() }), z.object({ type: z.literal('amazonBedrock'), usesCodexManagedCredentials: z.boolean() })]).nullable(), requiresOpenaiAuth: z.boolean() });
const RateWindowSchema = z.object({ usedPercent: z.number().nonnegative(), windowDurationMins: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nonnegative().max(253_402_300_799).nullable() });
const RateSnapshotSchema = z.object({ limitId: z.string().nullable().optional(), primary: RateWindowSchema.nullable().optional(), secondary: RateWindowSchema.nullable().optional() });
const RateLimitsReplySchema = z.object({ rateLimits: RateSnapshotSchema, rateLimitsByLimitId: z.record(z.string(), RateSnapshotSchema).nullable().optional() });

function codexUsage(raw: unknown): AccountStatus['usage'] {
  const response = RateLimitsReplySchema.parse(raw);
  const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  if (snapshot.limitId && snapshot.limitId !== 'codex') return;
  const windows = [snapshot.primary, snapshot.secondary];
  const five = windows.find(window => window?.windowDurationMins === 300);
  const week = windows.find(window => window?.windowDurationMins === 10080);
  if (!five && !week) return;
  // Primary can be weekly on some subscriptions. Window duration, not position, determines the displayed quota.
  return AccountUsageSchema.parse({ source: 'probe', observedAt: new Date().toISOString(),
    ...(five ? { fiveHourPct: Math.min(100, five.usedPercent), ...(five.resetsAt === null ? {} : { fiveHourResetsAt: new Date(five.resetsAt * 1000).toISOString() }) } : {}),
    ...(week ? { weeklyPct: Math.min(100, week.usedPercent), ...(week.resetsAt === null ? {} : { weeklyResetsAt: new Date(week.resetsAt * 1000).toISOString() }) } : {}) });
}

export class CodexControl {
  #id = 0;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly native: NativeProcess) {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const reply = ReplySchema.parse(JSON.parse(line));
        if (reply.id === undefined) return;
        const pending = this.#pending.get(reply.id);
        if (!pending) return;
        this.#pending.delete(reply.id);
        if (reply.error) { const error = classifyRuntimeError(reply.error.message); pending.reject(Object.assign(new Error('Codex control request was refused.'), { kind: error.kind })); } else pending.resolve(reply.result);
      } catch { this.#fail(new Error('Codex control returned an invalid response.')); }
    });
    child.stderr.on('data', () => {});
    child.on('close', () => { lines.close(); this.#fail(new Error('Codex control process closed.')); });
    child.on('error', () => this.#fail(new Error('Codex control process failed.')));
    child.stdin.on('error', () => this.#fail(new Error('Codex control channel closed.')));
  }
  #fail(error: Error): void { for (const request of this.#pending.values()) request.reject(error); this.#pending.clear(); }
  static async open(account: ResolvedAccount, executable = 'codex', configOverrides: readonly string[] = []): Promise<CodexControl> {
    const { child, native } = await spawnGroup(executable, ['app-server', ...configOverrides.flatMap((value) => ['--config', value])], { cwd: account.home, env: minimalEnvironment('codex', account.home) });
    const control = new CodexControl(child, native);
    try {
      await control.request('initialize', { clientInfo: { name: 'jevellan', version: '0.1.0' } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      return control;
    } catch (error) { await control.close(); throw error; }
  }
  async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.#id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Codex control request timed out.')); }, 15_000);
        this.#pending.set(id, { resolve, reject });
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    } finally { clearTimeout(timer); }
  }
  async close(): Promise<void> { await terminateGroup(this.native); this.#fail(new Error('Codex control closed.')); }
}

export async function listCodexModels(account: ResolvedAccount, executable = 'codex'): Promise<OfferedModel[]> {
  const control = await CodexControl.open(account, executable);
  try {
    let cursor: string | null = null;
    const models: Array<OfferedModel & { isDefault: boolean }> = [];
    for (let page = 0; page < 20; page++) {
      const response = ModelsSchema.parse(await control.request('model/list', { cursor, limit: 100, includeHidden: false }));
      for (const model of response.data) {
        const efforts = model.supportedReasoningEfforts.flatMap((entry) => { const value = EffortSchema.safeParse(entry.reasoningEffort); return value.success ? [value.data] : []; });
        if (!model.hidden && efforts.length) models.push({ id: model.model, label: model.displayName, efforts, isDefault: model.isDefault });
      }
      cursor = response.nextCursor;
      if (!cursor) return models.sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map(({ id, label, efforts }) => ({ id, label, efforts }));
    }
    throw new Error('Codex model pagination exceeded its limit.');
  } finally { await control.close(); }
}

export async function probeCodex(account: ResolvedAccount, executable = 'codex', fetcher: typeof fetch = fetch): Promise<{ auth: AccountStatus['auth']; usage?: AccountStatus['usage']; identity?: ResolvedAccount['account']['identity']; error?: string }> {
  if (account.account.kind === 'api-key') {
    const key = account.env.OPENAI_API_KEY;
    if (!key) return { auth: 'needs-login' as const };
    try {
      const response = await fetcher('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) return { auth: 'needs-login' as const, error: 'The provider refused this credential. Replace the API key.' };
      if (response.ok || response.status === 429) return { auth: 'ready' as const };
      return { auth: 'unknown' as const, error: `The provider probe returned HTTP ${response.status}. Usage is unknown.` };
    } catch { return { auth: 'unknown' as const, error: 'The provider probe could not connect. Usage is unknown.' }; }
  }
  const control = await CodexControl.open(account, executable);
  try {
    const response = AccountReplySchema.parse(await control.request('account/read', { refreshToken: true }));
    if (!response.account) return { auth: 'needs-login' as const };
    if (response.account.type === 'amazonBedrock') return { auth: 'unknown' as const, error: 'This credential provider is not supported by this runtime.' };
    if (response.account.type !== 'chatgpt') return { auth: 'ready' };
    const identity = { ...(response.account.email ? { email: response.account.email } : {}), plan: response.account.planType };
    try {
      const usage = codexUsage(await control.request('account/rateLimits/read', {}));
      return { auth: 'ready', identity, ...(usage ? { usage } : {}) };
    } catch {
      // Authentication already succeeded. An unavailable quota endpoint must not turn it into a login failure.
      return { auth: 'ready', identity, error: 'Codex is signed in, but its usage could not be read. Try checking this account again.' };
    }
  } catch (error) {
    return (error as { kind?: string }).kind === 'auth' ? { auth: 'needs-login' as const, error: 'Codex could not refresh this login. Log in again.' } : { auth: 'unknown' as const, error: 'The Codex account check could not complete. Usage is unknown.' };
  } finally { await control.close(); }
}

/**
 * On Linux, Codex runs every shell command inside bubblewrap. Hosts that restrict unprivileged user namespaces (for
 * example Ubuntu 24.04's AppArmor restriction) make that sandbox fail to start, so read-only and shell steps cannot be
 * enforced. One short native check at startup reports it instead of launching agents that cannot inspect anything.
 */
export function codexSandboxCheck(executable = 'codex', home: string, platform: NodeJS.Platform = process.platform): { available: true } | { available: false; reason: string } {
  if (platform !== 'linux') return { available: true };
  const result = spawnSync(executable, ['sandbox', '--', 'true'], { cwd: home, env: minimalEnvironment('codex', home), input: '', encoding: 'utf8', timeout: 20_000 });
  // A missing or hanging executable is reported by the account check and the launch itself, not as a sandbox fault.
  if (result.error || result.status === 0) return { available: true };
  const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.split('\n').map((line) => line.trim()).find((line) => /bwrap|bubblewrap|landlock|namespace|sandbox/i.test(line));
  if (!detail) return { available: true };
  return { available: false, reason: `Codex's sandbox can't start on this device (${detail.slice(0, 300)}), so its read-only and shell steps can't be enforced and Codex is not used. Allow Codex's bubblewrap to create user namespaces (for example with an AppArmor profile), then restart Jevellan.` };
}
