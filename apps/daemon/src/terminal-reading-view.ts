import { UiAuth } from '@jevellan/mesh';
import { TerminalReadRequestSchema, terminalReadView } from '@jevellan/core';
import type { Application } from './application.js';

/** Snapshot authentication and local/legacy-peer resource checks remain in the canonical terminal service. */
export async function readTerminalView(app: Application, raw: unknown, providedToken?: string) {
  const request = TerminalReadRequestSchema.parse(raw), auth = app.auth;
  if (!providedToken && !(auth instanceof UiAuth)) throw Object.assign(new Error('Terminal owner reads must run through the state point.'), { status: 409 });
  const token = providedToken ?? (auth as UiAuth).issue(); app.redactor.add(token);
  try { return terminalReadView(request, await app.terminals.snapshot(request.sessionId, token)); }
  finally { if (!providedToken) (auth as UiAuth).logout(token); }
}
