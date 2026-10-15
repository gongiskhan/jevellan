import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { parseGitHubRemote, type Homes, type SecretRedactor } from '@jevellan/core';
import { preserveBothVersions } from './conflicts.js';

/** Where the vault lives on GitHub and the token that reaches it; null keeps the vault local. */
export type VaultRemote = { url: string; token: string };
export const VaultStatusSchema = z.strictObject({
  schema: z.literal('vault-status-v1'), remote: z.string().nullable(), lastSyncAt: z.string().nullable(), lastError: z.string().nullable(), pending: z.boolean(),
});
export type VaultStatus = z.infer<typeof VaultStatusSchema>;
/** Minutes before each retry while GitHub cannot be reached; the last value repeats. */
export const VAULT_RETRY_MINUTES = [1, 5, 15, 30] as const;
const BRANCH = 'main';
const FOLDER = /^[A-Za-z0-9._-]{1,100}__[A-Za-z0-9._-]{1,100}$/u;

/** A project's vault folder, keyed by its GitHub origin (`projects/<owner>__<repo>`), never by its project id; null without one. */
export function vaultFolder(remoteUrl: string | undefined): string | null {
  const repository = parseGitHubRemote(remoteUrl ?? ''); if (!repository) return null;
  const name = `${repository.owner}__${repository.repo}`;
  return FOLDER.test(name) && !name.startsWith('.') ? name : null;
}

/**
 * The hub's one working copy of the private vault repository (`<home>/vault`): project memory notes, project definitions and the
 * coordinator notebook, one folder per project. Every local git step is synchronous, so no memory write lands between the steps
 * of a rebase; only fetch and push wait on the network. Commits push 60 seconds after the last one and at shutdown. GitHub being
 * unreachable never blocks a memory read or write: the error shows in Settings and pushes retry after 1, 5, 15 and then every 30
 * minutes. A push is never forced and nothing is reset; a conflicting note keeps both versions.
 */
export class ProjectVault {
  readonly root: string;
  #lastSyncAt: string | null = null; #lastError: string | null = null; #remoteUrl: string | null = null;
  #pending = false; #failures = 0; #closed = false;
  #pushTimer: ReturnType<typeof setTimeout> | undefined; #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  constructor(readonly o: { homes: Homes; deviceId: string; redactor: SecretRedactor; now(): number; remote(): Promise<VaultRemote | null>;
    /** Default 60 seconds; tests use 0 with `timers: false` and call `sync()`. */ pushDelayMs?: number; timers?: boolean }) {
    this.root = o.homes.at('vault');
  }
  status(): VaultStatus {
    return VaultStatusSchema.parse({ schema: 'vault-status-v1', remote: this.#remoteUrl, lastSyncAt: this.#lastSyncAt, lastError: this.#lastError, pending: this.#pending });
  }
  git(...args: string[]): string {
    return execFileSync('git', this.#args(args), { cwd: this.root, encoding: 'utf8', timeout: 60_000, env: this.#env(), maxBuffer: 20_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  #args(args: string[]): string[] {
    return ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=Jevellan', '-c', 'user.email=jevellan@localhost', '-c', 'commit.gpgsign=false', ...args];
  }
  #env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.o.homes.root, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_CONFIG_NOSYSTEM: '1', ...extra };
  }
  ensure(): string {
    if (!existsSync(join(this.root, '.git'))) {
      mkdirSync(join(this.root, 'projects'), { recursive: true, mode: 0o700 });
      this.git('init', '--quiet', '--initial-branch', BRANCH);
      writeFileSync(join(this.root, 'README.md'), '# Jevellan vault\n\nProject memory, project definitions and coordinator notebooks, one folder per project under `projects/<owner>__<repo>/`.\n');
      // The same first commit on every hub (fixed dates and identity), so two hubs' histories share their root and rebase cleanly.
      this.git('add', '--', 'README.md');
      execFileSync('git', this.#args(['commit', '--quiet', '-m', 'owner: Jevellan vault', '--', 'README.md']), { cwd: this.root, stdio: 'ignore', timeout: 60_000,
        env: this.#env({ GIT_AUTHOR_DATE: '2026-10-15T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T00:00:00Z' }) });
    }
    return this.root;
  }
  folder(name: string): string {
    if (!FOLDER.test(name)) throw new Error('A vault folder is named <owner>__<repo>.');
    return join(this.ensure(), 'projects', name);
  }
  /** Project folders in the working copy, as of the last pull. */
  folders(): string[] {
    const projects = join(this.ensure(), 'projects');
    return existsSync(projects) ? readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory() && FOLDER.test(entry.name)).map(entry => entry.name).sort() : [];
  }
  read(folder: string, file: 'project.json' | 'notebook.md'): string | null { const path = join(this.folder(folder), file); return existsSync(path) ? readFileSync(path, 'utf8') : null; }
  /** Writes a project's definition files and commits only them when they changed. */
  writeFiles(folder: string, files: Partial<Record<'project.json' | 'notebook.md', string>>, message: string): boolean {
    const base = this.folder(folder); mkdirSync(base, { recursive: true, mode: 0o700 });
    const changed = Object.entries(files).filter(([file, text]) => text !== undefined && (!existsSync(join(base, file)) || readFileSync(join(base, file), 'utf8') !== text));
    if (!changed.length) return false;
    const paths = changed.map(([file, text]) => { writeFileSync(join(base, file), text!); return join('projects', folder, file); });
    this.git('add', '--', ...paths); this.git('commit', '--quiet', '-m', message, '--', ...paths); this.changed(); return true;
  }
  /** The working copy changed: push once things settle. */
  changed(): void {
    this.#pending = true;
    if (this.#closed || this.o.timers === false) return;
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => { this.#pushTimer = undefined; void this.sync().catch(() => undefined); }, this.o.pushDelayMs ?? 60_000);
    this.#pushTimer.unref();
  }
  /** Pull with rebase, then push what is new. One at a time; a second call while one runs waits for it and then runs again. */
  sync(): Promise<void> {
    const previous = this.#running ?? Promise.resolve();
    const run = previous.then(() => this.#sync(), () => this.#sync());
    this.#running = run.finally(() => { if (this.#running === run) this.#running = undefined; });
    return run;
  }
  /** Before a memory session or dream: bring in what another hub pushed. Never throws; the error shows in Settings. */
  async pull(): Promise<void> {
    try { const remote = await this.#remote(); if (remote) { await this.#fetch(remote); this.#rebase(); this.#lastSyncAt = new Date(this.o.now()).toISOString(); } }
    catch (error) { this.#failed(error); }
  }
  async #sync(): Promise<void> {
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = undefined; }
    try {
      const remote = await this.#remote(); if (!remote) return;
      await this.#fetch(remote); this.#rebase();
      if (this.#ahead()) {
        try { await this.#push(remote); }
        catch {
          // Someone else pushed meanwhile: bring that in and push once more.
          await this.#fetch(remote); this.#rebase(); await this.#push(remote);
        }
      }
      this.#pending = false; this.#failures = 0; this.#lastError = null; this.#lastSyncAt = new Date(this.o.now()).toISOString();
    } catch (error) {
      this.#failed(error);
      if (!this.#closed && this.o.timers !== false) {
        const minutes = VAULT_RETRY_MINUTES[Math.min(this.#failures - 1, VAULT_RETRY_MINUTES.length - 1)]!;
        this.#retryTimer = setTimeout(() => { this.#retryTimer = undefined; void this.sync().catch(() => undefined); }, minutes * 60_000); this.#retryTimer.unref();
      }
    }
  }
  #failed(error: unknown): void {
    this.#failures++;
    const message = error instanceof Error ? (error as Error & { stderr?: string }).stderr || error.message : String(error);
    this.#lastError = this.o.redactor.text(message).split('\n').map(line => line.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 400) || 'The vault could not sync.';
  }
  async #remote(): Promise<VaultRemote | null> {
    const remote = await this.o.remote(); this.ensure();
    if (!remote) { this.#remoteUrl = null; return null; }
    if (!parseGitHubRemote(remote.url)) throw new Error('The vault remote must be a GitHub repository.');
    this.o.redactor.add(remote.token);
    const current = this.git('remote').split('\n').includes('origin') ? this.git('remote', 'get-url', 'origin').trim() : null;
    if (current === null) this.git('remote', 'add', 'origin', remote.url); else if (current !== remote.url) this.git('remote', 'set-url', 'origin', remote.url);
    this.#remoteUrl = remote.url; return remote;
  }
  /** The token travels per command in an extra header, never in the remote URL or the repository's configuration. */
  #credentials(remote: VaultRemote): Record<string, string> {
    const authorization = Buffer.from(`x-access-token:${remote.token}`).toString('base64'), header = `Authorization: Basic ${authorization}`;
    this.o.redactor.add(authorization); this.o.redactor.add(header);
    return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${remote.url.replace(/\/$/u, '')}.extraheader`, GIT_CONFIG_VALUE_0: header };
  }
  async #network(remote: VaultRemote, args: string[]): Promise<void> {
    await promisify(execFile)('git', this.#args(args), { cwd: this.root, timeout: 120_000, env: this.#env(this.#credentials(remote)), maxBuffer: 20_000_000 });
  }
  async #fetch(remote: VaultRemote): Promise<void> {
    try { await this.#network(remote, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]); }
    catch (error) {
      // A new, empty vault repository has no branch yet: the first push creates it.
      const text = String((error as { stderr?: string }).stderr ?? '');
      if (/couldn't find remote ref/iu.test(text)) return;
      throw error;
    }
  }
  async #push(remote: VaultRemote): Promise<void> { await this.#network(remote, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`]); }
  #upstream(): string | null { try { return this.git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${BRANCH}`).trim() || null; } catch { return null; } }
  #ahead(): boolean { const upstream = this.#upstream(); return !upstream || this.git('rev-list', '--count', `${upstream}..HEAD`).trim() !== '0'; }
  /**
   * Replays local commits onto what GitHub has. Synchronous from start to end, so nothing else touches the working copy meanwhile.
   * A conflicting note keeps the upstream version and appends this hub's under `## Merged from`, marked unresolved; any other file
   * keeps this hub's version. Anything else aborts the rebase, which leaves the local history as it was.
   */
  #rebase(): void {
    const upstream = this.#upstream(); if (!upstream) return;
    try { this.git('merge-base', '--is-ancestor', upstream, 'HEAD'); return; } catch { /* Upstream has commits this copy lacks. */ }
    try { this.git('rebase', '--autostash', '--quiet', upstream); return; } catch { /* Conflicts are resolved below. */ }
    try {
      for (let step = 0; step < 1000; step++) {
        if (!existsSync(join(this.root, '.git', 'rebase-merge')) && !existsSync(join(this.root, '.git', 'rebase-apply'))) return;
        const conflicted = this.git('diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
        for (const path of conflicted) {
          const side = (stage: 2 | 3) => { try { return this.git('show', `:${stage}:${path}`); } catch { return null; } };
          if (/\.(?:md|markdown)$/iu.test(path)) {
            writeFileSync(join(this.root, path), preserveBothVersions(side(2), side(3), this.o.deviceId, new Date(this.o.now()).toISOString()));
            this.git('add', '--', path);
          } else if (side(3) === null) this.git('rm', '--quiet', '--', path);
          else { this.git('checkout', '--theirs', '--', path); this.git('add', '--', path); }
        }
        if (!this.git('diff', '--cached', '--name-only').trim()) { try { this.git('rebase', '--skip'); } catch { /* The next step reports its own conflicts. */ } continue; }
        try { this.git('rebase', '--continue'); } catch { /* Another commit conflicts; the loop resolves it. */ }
      }
      throw new Error('The vault rebase did not finish.');
    } catch (error) {
      try { this.git('rebase', '--abort'); } catch { /* Nothing to abort. */ }
      throw error;
    }
  }
  /** Stops the timers and pushes what is still pending, within `timeoutMs`. */
  async close(timeoutMs = 20_000): Promise<void> {
    this.#closed = true;
    if (this.#pushTimer) clearTimeout(this.#pushTimer); if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (!this.#pending) { await this.#running?.catch(() => undefined); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.sync().catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref(); })]);
    if (timer) clearTimeout(timer);
  }
}
