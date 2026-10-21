import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_ENDPOINT_AUTH_KEYS, CLAUDE_FLAG_SETTINGS, EffortSchema, hasInteractiveClaudeLogin, minimalEnvironment, type AccountStatus, type OfferedModel } from '@jevellan/core';
import { AsyncQueue, type ResolvedAccount } from '@jevellan/runtime-contract';
import { z } from 'zod';

const ModelsSchema = z.array(z.object({ value: z.string(), resolvedModel: z.string().optional(), displayName: z.string(), supportedEffortLevels: z.array(EffortSchema).optional() }));
const authEnvironment = (account: ResolvedAccount) => Object.fromEntries((account.account.kind === 'endpoint' ? CLAUDE_ENDPOINT_AUTH_KEYS : ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']).flatMap((key) => account.env[key] ? [[key, account.env[key]!]] : []));

export async function listClaudeModels(account: ResolvedAccount, executable?: string): Promise<OfferedModel[]> {
  if (account.account.kind === 'endpoint') return account.account.endpoint!.models.map(({ id, label, efforts }) => ({ id, label, efforts }));
  const input = new AsyncQueue<SDKUserMessage>(); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  // An empty open input stream performs the SDK handshake without submitting a model turn.
  const runtime = query({ prompt: input, options: { cwd: account.home, env: minimalEnvironment('claude', account.home, authEnvironment(account)), abortController: controller, settingSources: ['user'], settings: { ...CLAUDE_FLAG_SETTINGS }, permissionMode: 'dontAsk', stderr: () => {}, ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) } });
  try {
    const models = ModelsSchema.parse(await runtime.supportedModels());
    return models.flatMap((model) => model.supportedEffortLevels?.length ? [{ id: model.resolvedModel ?? model.value, label: model.displayName, efforts: model.supportedEffortLevels }] : []);
  } finally { clearTimeout(timer); input.close(); runtime.close(); }
}

export function claudeUsage(headers: Headers, now = new Date()): AccountStatus['usage'] {
  const window = (prefix: string) => {
    const raw = headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
    const value = raw === null || !raw.trim() ? NaN : Number(raw);
    const reset = headers.get(`anthropic-ratelimit-unified-${prefix}-reset`);
    const seconds = reset === null || !reset.trim() ? NaN : Number(reset);
    return { pct: Number.isFinite(value) && value >= 0 ? Math.min(100, Math.round(value * 1000) / 10) : undefined, reset: Number.isFinite(seconds) && seconds >= 0 && seconds < 8.64e12 ? new Date(seconds * 1000).toISOString() : undefined };
  };
  const five = window('5h'); const week = window('7d');
  if (five.pct === undefined && week.pct === undefined) return;
  return { source: 'probe', observedAt: now.toISOString(), ...(five.pct === undefined ? {} : { fiveHourPct: five.pct }), ...(week.pct === undefined ? {} : { weeklyPct: week.pct }), ...(five.reset ? { fiveHourResetsAt: five.reset } : {}), ...(week.reset ? { weeklyResetsAt: week.reset } : {}) };
}

const StreamWindow = z.object({ utilization: z.number().min(0).nullable().optional(), resetsAt: z.number().nonnegative().nullable().optional() }).nullable().optional();
const RateLimitEvent = z.object({ type: z.literal('rate_limit_event'), rate_limit_info: z.object({ rateLimitType: z.string().optional(), utilization: z.number().min(0).optional(), resetsAt: z.number().nonnegative().optional(),
  unifiedWindows: z.object({ five_hour: StreamWindow, seven_day: StreamWindow }).optional() }) });
/**
 * The account's usage from a Claude Code `rate_limit_event` (fractions and reset seconds, like the probe's headers): the unified five-hour and
 * seven-day windows, else the event's own window when it is one of them. A per-model window is never the account's week. Null otherwise.
 */
export function claudeStreamUsage(raw: unknown): { type: 'rate-limit'; fiveHourPct?: number; weeklyPct?: number; fiveHourResetsAt?: string; weeklyResetsAt?: string } | null {
  const parsed = RateLimitEvent.safeParse(raw); if (!parsed.success) return null;
  const info = parsed.data.rate_limit_info;
  const own = (type: string) => info.rateLimitType === type ? { utilization: info.utilization, resetsAt: info.resetsAt } : undefined;
  const pct = (value: number | null | undefined) => typeof value === 'number' ? Math.min(100, Math.round(value * 1000) / 10) : undefined;
  const at = (value: number | null | undefined) => typeof value === 'number' && value < 8.64e12 ? new Date(value * 1000).toISOString() : undefined;
  const five = info.unifiedWindows?.five_hour ?? own('five_hour'), week = info.unifiedWindows?.seven_day ?? own('seven_day');
  const fiveHourPct = pct(five?.utilization), weeklyPct = pct(week?.utilization);
  if (fiveHourPct === undefined && weeklyPct === undefined) return null;
  const fiveHourResetsAt = fiveHourPct === undefined ? undefined : at(five?.resetsAt), weeklyResetsAt = weeklyPct === undefined ? undefined : at(week?.resetsAt);
  return { type: 'rate-limit', ...(fiveHourPct === undefined ? {} : { fiveHourPct }), ...(weeklyPct === undefined ? {} : { weeklyPct }),
    ...(fiveHourResetsAt ? { fiveHourResetsAt } : {}), ...(weeklyResetsAt ? { weeklyResetsAt } : {}) };
}

export async function probeClaude(account: ResolvedAccount, fetcher: typeof fetch = fetch): Promise<{ auth: AccountStatus['auth']; usage?: AccountStatus['usage']; error?: string }> {
  if (account.account.kind === 'endpoint') {
    const token = account.env.ANTHROPIC_AUTH_TOKEN; if (!token) return { auth: 'needs-login', error: 'Key refused' };
    try {
      const response = await fetcher(`${account.account.endpoint!.baseUrl.replace(/\/$/u, '')}/v1/messages`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${token}` }, body: JSON.stringify({ model: account.account.endpoint!.models[0]!.id, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) });
      await response.body?.cancel();
      if (response.ok) return { auth: 'ready' };
      return response.status === 401 || response.status === 403 ? { auth: 'needs-login', error: 'Key refused' } : { auth: 'unknown', error: `Unreachable: HTTP ${response.status}` };
    } catch (error) { return { auth: 'unknown', error: `Unreachable: ${error instanceof Error ? error.message : 'connection failed'}` }; }
  }
  const token = account.account.kind === 'subscription'  ? account.env.CLAUDE_CODE_OAUTH_TOKEN : account.env.ANTHROPIC_API_KEY;
  // A folder logged in to claude.ai (an in-place account, or an interactive login) runs without a token; its usage is read from turns.
  if (!token) return account.account.kind === 'subscription' && hasInteractiveClaudeLogin(account.home) ? { auth: 'ready' } : { auth: 'needs-login' };
  try {
    const subscription = account.account.kind === 'subscription';
    const response = await fetcher(subscription ? 'https://api.anthropic.com/v1/messages' : 'https://api.anthropic.com/v1/models?limit=1', {
      method: subscription ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'anthropic-version': '2023-06-01', ...(subscription ? { 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20', authorization: `Bearer ${token}` } : { 'x-api-key': token }) },
      ...(subscription ? { body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: 'hi' }] }) } : {}),
    });
    const usage = claudeUsage(response.headers); await response.body?.cancel();
    if (response.status === 401 || response.status === 403) return { auth: 'needs-login', error: 'The provider refused this credential. Log in again.' };
    if (response.ok || response.status === 429) return { auth: 'ready', ...(usage ? { usage } : {}) };
    return { auth: 'unknown', error: `The provider probe returned HTTP ${response.status}. Usage is unknown.` };
  } catch { return { auth: 'unknown', error: 'The provider probe could not connect. Usage is unknown.' }; }
}
