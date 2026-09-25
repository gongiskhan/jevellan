import { ExternalSessionsSchema, inside, type ExternalSession, type ExternalSessions, type Project } from '@jevellan/core';

const names: Record<ExternalSession['runtime'], string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' };
export class ExternalActivityError extends Error { readonly status = 409; }
export type ExternalActivityOptions = {
  deviceId: string; deviceName: string; read?(projects: readonly Project[], deviceId: string): Promise<ExternalSessions>;
  now?: () => number;
};
/** A resource guard, independent of decisions. It never terminates a process. */
export class ExternalActivityGuard {
  constructor(readonly options: ExternalActivityOptions) {}
  async #active(project: Project, path: string, minutes: number, since = -Infinity): Promise<ExternalSession | null> {
    if (!this.options.read) return null;
    const snapshot = ExternalSessionsSchema.parse(await this.options.read([project], this.options.deviceId));
    if (snapshot.unavailable.length) throw new Error('Activity sources are unavailable.');
    const now = (this.options.now ?? Date.now)();
    return snapshot.sessions.find(row => inside(path, row.cwd) && Date.parse(row.lastActivityAt) >= since && Date.parse(row.lastActivityAt) <= now && now - Date.parse(row.lastActivityAt) <= minutes * 60_000) ?? null;
  }
  async assertIdle(project: Project, path: string, minutes: number): Promise<void> {
    let active: ExternalSession | null;
    try { active = await this.#active(project, path, minutes); }
    catch { throw new ExternalActivityError(`External agent activity could not be checked in ${project.name} on ${this.options.deviceName}. Retry before changing this checkout.`); }
    if (active) throw new ExternalActivityError(`Another agent (${names[active.runtime]}) is active in ${project.name} on ${this.options.deviceName}.`);
  }
  watch(project: Project, path: string, minutes: number, observed: (reason: string) => void, intervalMs = 30_000) {
    const since = (this.options.now ?? Date.now)();
    let pending: Promise<void> | undefined; let closed = false; let closing: Promise<void> | undefined; let reason: string | undefined;
    const check = (): Promise<void> => {
      if (closed || reason) return Promise.resolve();
      return pending ??= (async () => {
        let next: string | undefined;
        try {
          const active = await this.#active(project, path, minutes, since);
          if (active) next = `${names[active.runtime]} started working in ${project.name} while this step ran. ${project.branchPolicy === 'main' ? "Jevellan hasn't committed anything. Check the changes, then press Continue." : "Check the changes, then press Continue to acknowledge them. This project follows its own git rules."}`;
        } catch { next = "External agent activity could not be checked while this step ran. Jevellan hasn't committed anything. Check the changes, then press Continue."; }
        if (next && !closed && !reason) { reason = next; observed(next); }
      })().finally(() => { pending = undefined; });
    };
    // A failed observer must not produce an unhandled timer rejection. The
    // reason remains latched so the owning boundary still refuses a checkpoint.
    const timer = this.options.read ? setInterval(() => { void check().catch(() => undefined); }, intervalMs) : undefined; timer?.unref();
    if (this.options.read) void check().catch(() => undefined);
    return { check, reason: () => reason, close: () => closing ??= (async () => { clearInterval(timer); await pending?.catch(() => undefined); await check().catch(() => undefined); closed = true; })() };
  }
}
