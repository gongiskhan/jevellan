import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EffortSchema, minimalEnvironment, type AccountStatus, type OfferedModel } from '@jevellan/core';
import { AsyncQueue, type ResolvedAccount } from '@jevellan/runtime-contract';
import { z } from 'zod';

const ModelsSchema = z.array(z.object({ value: z.string(), resolvedModel: z.string().optional(), displayName: z.string(), supportedEffortLevels: z.array(EffortSchema).optional() }));
const authEnvironment = (account: ResolvedAccount) => Object.fromEntries(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].flatMap((key) => account.env[key] ? [[key, account.env[key]!]] : []));

export async function listClaudeModels(account: ResolvedAccount, executable?: string): Promise<OfferedModel[]> {
  const input = new AsyncQueue<SDKUserMessage>(); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  // An empty open input stream performs the SDK handshake without submitting a model turn.
  const runtime = query({ prompt: input, options: { cwd: account.home, env: minimalEnvironment('claude', account.home, authEnvironment(account)), abortController: controller, settingSources: ['user'], permissionMode: 'dontAsk', stderr: () => {}, ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) } });
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

export async function probeClaude(account: ResolvedAccount, fetcher: typeof fetch = fetch): Promise<{ auth: AccountStatus['auth']; usage?: AccountStatus['usage']; error?: string }> {
  const token = account.account.kind === 'subscription' ? account.env.CLAUDE_CODE_OAUTH_TOKEN : account.env.ANTHROPIC_API_KEY;
  if (!token) return { auth: 'needs-login' };
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
