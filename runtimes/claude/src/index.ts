import { fileURLToPath } from 'node:url';
import { RiggingDelivery, supportedRigging } from '@jevellan/core';
import { WorkerRun, ResolvedAccountSchema, beginTerminalLogin, type RuntimeAdapter, type RuntimeContext, type ResolvedAccount } from '@jevellan/runtime-contract';
import { listClaudeModels, probeClaude } from './control.js';

export function createRuntime(context: RuntimeContext): RuntimeAdapter {
  const delivery = new RiggingDelivery(context.homes, undefined, context.redactor);
  const checked = (value: ResolvedAccount) => {
    const account = ResolvedAccountSchema.parse(value);
    if (account.account.runtime !== 'claude' || account.home !== context.homes.account('claude', account.account.id)) throw new Error('Claude requires an account home owned by Jevellan.');
    return account;
  };
  return {
    id: 'claude', displayName: 'Claude Code', accountKinds: ['subscription', 'api-key'], riggingKinds: supportedRigging('claude'),
    capabilities: { edit: true, shell: true, mcp: true, images: true, interrupt: true, usage: true, continueSession: true, perLaunchConfig: true, readOnlyEnforced: true },
    listModels: (account) => listClaudeModels(checked(account), context.executable),
    beginLogin: (account, home) => beginTerminalLogin('claude', account, home, context),
    probe: (account) => probeClaude(checked(account)),
    materialiseRigging: (home, items) => delivery.materialise('claude', home, items),
    startStretch: (input) => new WorkerRun('claude', fileURLToPath(new URL('./worker.js', import.meta.url)), input, context),
  };
}
