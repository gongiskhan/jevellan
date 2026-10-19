import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';

/** `login` (bridge specification). `status` reports each account's sign-in; start and complete come with accounts (phase 9). */
export const login: OwnerHandler = async (context) => {
  const { app, args } = context;
  if (context.action === 'start') return { text: await app.ownerLogins.start(context.project.id, String(args.account), args.interactive === true) };
  if (context.action === 'complete') return { text: await app.ownerLogins.complete(String(args.account), String(args.code)) };
  const accounts = (await app.accounts.list()).filter(row => typeof args.account !== 'string' || row.account.label === args.account);
  if (!accounts.length) throw new OwnerRefusal(typeof args.account === 'string' ? `There is no account ${args.account}.` : 'There are no accounts yet.', 'not_found', 404);
  const line = (row: (typeof accounts)[number]) => {
    const status = [...row.statuses].sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    const remote = row.account.runtime === 'claude' ? (app.ownerLogins.interactiveReady(row) ? ', remote control ready' : ', no interactive login for remote control') : '';
    if (!status || status.auth === 'ready') return `${row.account.label}: logged in${remote}`;
    return `${row.account.label}: needs login (${status.lastError ?? status.auth.replace("-", " ")})${remote}`;
  };
  return { text: accounts.map(line).join(' · ') };
};
