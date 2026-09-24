import pty from 'node-pty';
import headless from '@xterm/headless';
import { minimalEnvironment, type Account } from '@jevellan/core';
import { terminateGroup } from './process-group.js';
import type { LoginSession, RuntimeContext } from './contract.js';

/** Interpret terminal cells: cursor movements and soft wraps are part of a token. */
export class LoginOutput {
  readonly #terminal: headless.Terminal;
  #raw = '';
  constructor(cols = 200) { this.#terminal = new headless.Terminal({ cols, rows: 50, scrollback: 1000, allowProposedApi: true }); }
  async write(chunk: string): Promise<void> {
    this.#raw = (this.#raw + chunk).slice(-256_000);
    await new Promise<void>((resolve) => this.#terminal.write(chunk, resolve));
  }
  text(): string {
    const buffer = this.#terminal.buffer.active; let value = '';
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)!;
      if (i && !line.isWrapped) value += '\n';
      value += line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
    }
    return value.trimEnd();
  }
  token(exitedSuccessfully = false): string | undefined {
    const value = this.text();
    if (!exitedSuccessfully && !/Store this token securely|Use this token by setting/.test(value)) return;
    const prefix = ['sk', 'ant', 'oat01'].join('-');
    return value.match(new RegExp(`\\b${prefix}-[A-Za-z0-9_-]{20,}(?=\\s|$)`))?.[0];
  }
  url(runtime: 'claude' | 'codex'): string | undefined {
    // eslint-disable-next-line no-control-regex -- OSC 8 hyperlinks end at a terminal control byte.
    const candidates = [...this.#raw.matchAll(/\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b]+)/g)].map((entry) => entry[1]!);
    const text = this.text().replace(/(https:\/\/\S+)\n(?=\S)/g, '$1');
    candidates.push(...[...text.matchAll(/https:\/\/[^\s<>]+/g)].map((entry) => entry[0].replace(/[.,)\]]+$/, '')));
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate);
        const hosts = runtime === 'claude' ? ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'] : ['auth.openai.com', 'chatgpt.com'];
        if (url.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.hostname) && /authorize|oauth|device/.test(url.pathname)) return url.href;
      } catch { /* Incomplete URL while the terminal is streaming. */ }
    }
  }
  userCode(): string | undefined { return this.text().match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1]; }
  dispose(): void { this.#raw = ''; this.#terminal.dispose(); }
}

export function loginCallback(authorizeUrl: string, submitted: string): URL {
  const expected = new URL(authorizeUrl);
  const redirect = expected.searchParams.get('redirect_uri');
  if (!redirect) throw new Error('The login has no callback address.');
  const target = new URL(redirect); const value = new URL(submitted);
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/auth/callback' || !target.port || target.username || target.password) throw new Error('The login callback address is not supported.');
  if (value.origin !== target.origin || value.pathname !== target.pathname || value.username || value.password || value.hash || !value.searchParams.get('code')) throw new Error('Paste the complete callback address from this login.');
  const state = expected.searchParams.get('state');
  if (!state || value.searchParams.get('state') !== state) throw new Error('The callback belongs to a different login.');
  // Only the CLI's loopback callback may receive the pasted authorization code.
  value.hostname = '127.0.0.1';
  return value;
}

export async function beginTerminalLogin(runtime: 'claude' | 'codex', account: Account, home: string, context: RuntimeContext): Promise<LoginSession> {
  if (account.runtime !== runtime || home !== context.homes.account(runtime, account.id)) throw new Error('Login requires the account home owned by Jevellan.');
  if (account.kind !== 'subscription') throw new Error('API keys are entered in the Add account form.');
  if (runtime === 'claude' && !context.saveSecret) throw new Error('Claude login requires the encrypted hub vault.');
  let output = new LoginOutput(); let queue = Promise.resolve(); let child: pty.IPty;
  let state: 'pending' | 'done' | 'failed' = 'pending'; let cancelled = false; let deviceCode = runtime === 'codex'; let capturing = false;
  const session: LoginSession = {
    instructions: runtime === 'claude' ? 'Open the link, approve access, then paste the code here.' : 'Open the link and enter the code. This login belongs to this device.',
    async submitCode(code) {
      if (state !== 'pending' || cancelled) throw new Error('This login is no longer waiting.');
      if (code.length > 16_384 || [...code].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Paste a single code or callback address.');
      if (runtime === 'codex') {
        if (deviceCode || !session.url) throw new Error('Complete this login at the verification link.');
        const callback = loginCallback(session.url, code);
        const response = await fetch(callback, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
        await response.body?.cancel();
        if (response.status >= 400) throw new Error('The local login callback refused that address.');
      } else child.write(`${code}\r`);
    },
    async poll() { await queue; return state; },
    async cancel() {
      cancelled = true; if (state === 'pending') state = 'failed'; clearTimeout(timer);
      await terminateGroup({ pid: child.pid, pgid: child.pid }); await queue; output.dispose();
    },
  };
  const capture = async (success = false) => {
    if (cancelled || state !== 'pending') return;
    const url = output.url(runtime); if (url) session.url = url;
    if (deviceCode) { const code = output.userCode(); if (code) session.userCode = code; }
    if (runtime !== 'claude' || capturing) return;
    const token = output.token(success); if (!token) return;
    capturing = true;
    try {
      context.redactor?.add(token);
      await context.saveSecret!(account.id, token);
      state = 'done';
    } catch { state = 'failed'; }
    finally { clearTimeout(timer); void terminateGroup({ pid: child.pid, pgid: child.pid }).catch(() => undefined); }
  };
  const start = () => {
    child = pty.spawn(context.executable ?? runtime, runtime === 'claude' ? ['setup-token'] : deviceCode ? ['login', '--device-auth'] : ['login'], { name: 'xterm-256color', cols: 200, rows: 50, cwd: home, env: minimalEnvironment(runtime, home) });
    child.onData((chunk) => { queue = queue.then(async () => { if (!cancelled) { await output.write(chunk); await capture(); } }).catch(() => { state = 'failed'; }); });
    child.onExit(({ exitCode }) => {
      queue = queue.then(async () => {
        if (cancelled) return;
        await capture(exitCode === 0);
        if (runtime === 'codex' && deviceCode && exitCode !== 0 && /unexpected argument.*device-auth|unrecognized.*device-auth|unknown option.*device-auth/is.test(output.text())) {
          output.dispose(); output = new LoginOutput(); deviceCode = false;
          session.instructions = 'After approving, your browser opens a page that may not load. Paste its full address here.';
          delete session.url; delete session.userCode; start(); return;
        }
        if (state === 'pending') state = runtime === 'codex' && exitCode === 0 ? 'done' : 'failed';
        clearTimeout(timer); output.dispose();
      }).catch(() => { state = 'failed'; });
    });
  };
  const timer = setTimeout(() => { void session.cancel(); }, 15 * 60_000);
  try { start(); } catch { clearTimeout(timer); output.dispose(); throw new Error('The runtime login process could not start.'); }
  return session;
}
