import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';

/** `login` (bridge specification). `status` reports each account's sign-in; start and complete come with accounts (phase 9). */
export const login: OwnerHandler = async (context) => {
  const { app, args } = context;
  if (context.action !== 'status') throw new OwnerRefusal(`login ${context.action} is not available in this version yet. Sign in from Settings, Runtimes.`, 'not_available', 501);
  const accounts = (await app.accounts.list()).filter(row => typeof args.account !== 'string' || row.account.label === args.account);
  if (!accounts.length) throw new OwnerRefusal(typeof args.account === 'string' ? `There is no account ${args.account}.` : 'There are no accounts yet.', 'not_found', 404);
  const line = (row: (typeof accounts)[number]) => {
    const status = [...row.statuses].sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    if (!status || status.auth === 'ready') return `${row.account.label}: logged in`;
    return `${row.account.label}: needs login (${status.lastError ?? status.auth.replace('-', ' ')})`;
  };
  return { text: accounts.map(line).join(' · ') };
};
