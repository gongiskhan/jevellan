import { createInterface } from 'node:readline';
import { minimalEnvironment, EffortSchema, type OfferedModel } from '@jevellan/core';
import { spawnGroup, terminateGroup, type NativeProcess, type ResolvedAccount } from '@jevellan/runtime-contract';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';

const ReplySchema = z.object({ id: z.number().int().optional(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });
const ModelsSchema = z.object({ data: z.array(z.object({ id: z.string(), model: z.string(), displayName: z.string(), hidden: z.boolean(), isDefault: z.boolean(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })), nextCursor: z.string().nullable() });
const AccountReplySchema = z.object({ account: z.discriminatedUnion('type', [z.object({ type: z.literal('apiKey') }), z.object({ type: z.literal('chatgpt'), email: z.string().nullable(), planType: z.string() }), z.object({ type: z.literal('amazonBedrock'), usesCodexManagedCredentials: z.boolean() })]).nullable(), requiresOpenaiAuth: z.boolean() });

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
        if (reply.error) pending.reject(new Error('Codex control request was refused.')); else pending.resolve(reply.result);
      } catch { this.#fail(new Error('Codex control returned an invalid response.')); }
    });
    child.stderr.on('data', () => {});
    child.on('close', () => { lines.close(); this.#fail(new Error('Codex control process closed.')); });
    child.on('error', () => this.#fail(new Error('Codex control process failed.')));
    child.stdin.on('error', () => this.#fail(new Error('Codex control channel closed.')));
  }
  #fail(error: Error): void { for (const request of this.#pending.values()) request.reject(error); this.#pending.clear(); }
  static async open(account: ResolvedAccount, executable = 'codex'): Promise<CodexControl> {
    const { child, native } = await spawnGroup(executable, ['app-server'], { cwd: account.home, env: minimalEnvironment('codex', account.home) });
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

export async function probeCodex(account: ResolvedAccount, executable = 'codex') {
  const control = await CodexControl.open(account, executable);
  try {
    const response = AccountReplySchema.parse(await control.request('account/read', { refreshToken: false }));
    if (!response.account) return { auth: 'needs-login' as const };
    if (response.account.type === 'amazonBedrock') return { auth: 'unknown' as const, error: 'This credential provider is not supported by this runtime.' };
    return { auth: 'ready' as const, ...(response.account.type === 'chatgpt' ? { identity: { ...(response.account.email ? { email: response.account.email } : {}), plan: response.account.planType } } : {}) };
  } finally { await control.close(); }
}
