import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pty from 'node-pty';
import { LoginOutput } from '@jevellan/runtime-contract';
import { minimalEnvironment, type AccountView } from '@jevellan/core';
import type { Application } from './application.js';
import { OwnerRefusal } from './owner-tools.js';

type Interactive = { child: pty.IPty; output: LoginOutput; state: 'pending' | 'done' | 'failed'; label: string; projectId: string };

/**
 * Logins from the bridge (bridge specification, `login`). The ordinary Claude login is the account's long-lived token, through the
 * existing account login. An interactive login (`interactive`) runs `claude auth login` in the account's managed folder: the remote-control
 * sessions of the bridge and of takeovers need it, because a token cannot start remote control (run log, phase 0).
 */
export class OwnerLogins {
  readonly #token = new Map<string, { loginId: string; projectId: string; label: string }>();
  readonly #interactive = new Map<string, Interactive>();
  constructor(private readonly app: Application, readonly claude = process.env.JEVELLAN_CLAUDE_BIN || 'claude') {}
  async account(label: string): Promise<AccountView> {
    const accounts = await this.app.accounts.list(); const found = accounts.find(row => row.account.label.toLowerCase() === label.toLowerCase());
    if (!found) throw new OwnerRefusal(`There is no account ${label}. Accounts: ${accounts.map(row => row.account.label).join(', ') || 'none'}.`, 'not_found', 404);
    return found;
  }
  interactiveReady(account: AccountView): boolean { return existsSync(join(this.app.homes.account(account.account.runtime as 'claude', account.account.id), '.credentials.json')); }

  async start(projectId: string, label: string, interactive: boolean): Promise<string> {
    const account = await this.account(label); const runtime = account.account.runtime;
    if (interactive) {
      if (runtime !== 'claude') throw new OwnerRefusal('Only Claude accounts have an interactive login for remote control.', 'invalid_account');
      const home = this.app.homes.account('claude', account.account.id); const previous = this.#interactive.get(account.account.id);
      if (previous?.state === 'pending') previous.child.kill();
      const output = new LoginOutput(); const env = minimalEnvironment('claude', home);
      const child = pty.spawn(this.claude, ['auth', 'login'], { name: 'xterm-256color', cols: 200, rows: 50, cwd: home, env });
      const session: Interactive = { child, output, state: 'pending', label: account.account.label, projectId };
      child.onData(chunk => { void output.write(chunk); });
      child.onExit(({ exitCode }) => { session.state = exitCode === 0 && this.interactiveReady(account) ? 'done' : 'failed'; if (session.state === 'done') this.#done(projectId, account.account.label); });
      this.#interactive.set(account.account.id, session);
      const url = await this.#wait(() => output.url('claude'), 20_000);
      if (!url) { child.kill(); throw new OwnerRefusal(`The login for ${account.account.label} did not show a link. Try again, or run jevellan login ${account.account.label} --interactive in a terminal.`, 'login_failed', 502); }
      return `Open this link and approve access for account ${account.account.label}: ${url} Then tell me the code it shows.`;
    }
    const view = await this.app.accounts.beginLogin(account.account.id);
    this.#token.set(account.account.id, { loginId: view.id, projectId, label: account.account.label });
    const url = view.url ?? await this.#wait(async () => (await this.app.accounts.pollLogin(view.id)).url, 20_000);
    if (!url) throw new OwnerRefusal(`The login for ${account.account.label} did not show a link: ${view.error ?? 'no link yet'}.`, 'login_failed', 502);
    const latest = await this.app.accounts.pollLogin(view.id);
    if (runtime === 'codex' && latest.userCode) return `Open ${url} and enter the code ${latest.userCode} for account ${account.account.label}. A push confirms when it is done.`;
    return `Open this link and approve access for account ${account.account.label}: ${url} Then tell me the code it shows.`;
  }
  async complete(label: string, code: string): Promise<string> {
    const account = await this.account(label); const interactive = this.#interactive.get(account.account.id);
    if (interactive?.state === 'pending') {
      interactive.child.write(code.trim()); await new Promise(resolve => setTimeout(resolve, 250)); interactive.child.write('\r');
      await this.#wait(() => interactive.state !== 'pending' ? true : undefined, 60_000);
      return (interactive.state as Interactive['state']) === 'done' || this.interactiveReady(account) ? `Account ${account.account.label} is logged in.` : `Account ${account.account.label} still is not logged in: the code was not accepted.`;
    }
    const pending = this.#token.get(account.account.id); if (!pending) throw new OwnerRefusal(`There is no login waiting for ${account.account.label}. Start one with login start.`, 'not_pending', 409);
    await this.app.accounts.submitLogin(pending.loginId, code.trim());
    const state = await this.#wait(async () => { const view = await this.app.accounts.pollLogin(pending.loginId); return ['done', 'failed', 'cancelled'].includes(view.state) ? view : undefined; }, 60_000);
    if (state?.state === 'done') { this.#token.delete(account.account.id); this.#done(pending.projectId, account.account.label); return `Account ${account.account.label} is logged in.`; }
    return `Account ${account.account.label} still is not logged in: ${state?.error ?? 'the login has not finished'}.`;
  }
  /** Device logins finish on their own: a later sweep pushes `login_done`. */
  async sweep(): Promise<void> {
    for (const [accountId, pending] of [...this.#token]) {
      const view = await this.app.accounts.pollLogin(pending.loginId).catch(() => null);
      if (view?.state === 'done') { this.#token.delete(accountId); this.#done(pending.projectId, pending.label); }
      else if (view && ['failed', 'cancelled'].includes(view.state)) this.#token.delete(accountId);
    }
  }
  #done(projectId: string, label: string): void { this.app.ownerPushes.add({ projectId, kind: 'login_done', key: `login:${label}:${Date.now()}`, text: `Account ${label} is logged in.` }); }
  async #wait<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const value = await probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 300)); }
    return undefined;
  }
}
