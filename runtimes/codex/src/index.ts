import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { RiggingDelivery, supportedRigging, minimalEnvironment } from '@jevellan/core';
import { WorkerRun, ResolvedAccountSchema, beginTerminalLogin, spawnGroup, terminateGroup, type RuntimeAdapter, type RuntimeContext, type ResolvedAccount } from '@jevellan/runtime-contract';
import { listCodexModels, probeCodex } from './control.js';

export async function prepareApiKey(account: ResolvedAccount, context: RuntimeContext): Promise<void> {
  if (account.account.kind !== 'api-key' || account.account.runtime !== 'codex' || account.home !== context.homes.account('codex', account.account.id)) throw new Error('Codex API login requires an account home owned by Jevellan.');
  const key = account.env.OPENAI_API_KEY; if (!key || /[\r\n]/.test(key)) throw new Error('Enter the OpenAI API key in Accounts.');
  context.redactor?.add(key);
  const { child, native } = await spawnGroup(context.executable ?? 'codex', ['login', '--with-api-key'], { cwd: account.home, env: minimalEnvironment('codex', account.home) });
  child.stdout.resume(); child.stderr.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Codex API login timed out.')), 20_000);
      child.on('error', () => reject(new Error('Codex API login failed.')));
      child.stdin.on('error', () => reject(new Error('Codex API login channel closed.')));
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Codex API login failed.')));
    });
    child.stdin.end(`${key}\n`); await exit; chmodSync(join(account.home, 'auth.json'), 0o600);
  } finally { clearTimeout(timer); await terminateGroup(native); }
}

export function createRuntime(context: RuntimeContext): RuntimeAdapter {
  const delivery = new RiggingDelivery(context.homes, undefined, context.redactor);
  const checked = (value: ResolvedAccount) => {
    const account = ResolvedAccountSchema.parse(value);
    if (account.account.runtime !== 'codex' || account.home !== context.homes.account('codex', account.account.id)) throw new Error('Codex requires an account home owned by Jevellan.');
    return account;
  };
  return {
    id: 'codex', displayName: 'Codex', accountKinds: ['subscription', 'api-key'], riggingKinds: supportedRigging('codex'),
    capabilities: { edit: true, shell: true, mcp: true, images: true, interrupt: true, usage: true, continueSession: true, perLaunchConfig: true, readOnlyEnforced: true },
    listModels: (account) => listCodexModels(checked(account), context.executable),
    beginLogin: (account, home) => beginTerminalLogin('codex', account, home, context),
    probe: (account) => probeCodex(checked(account), context.executable),
    materialiseRigging: (home, items) => delivery.materialise('codex', home, items),
    startStretch: (input) => new WorkerRun('codex', fileURLToPath(new URL('./worker.js', import.meta.url)), input, context),
  };
}
