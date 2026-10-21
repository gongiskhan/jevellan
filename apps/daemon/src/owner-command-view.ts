import { UiAuth } from '@jevellan/mesh';
import { OwnerCommandViewRequestSchema } from '@jevellan/core';
import type { Application } from './application.js';
/** Read-only owner facade; command execution stays on the existing owner-session API. */
export async function ownerCommandViewForTools(app: Application, projectId: string, args: Record<string, unknown>) {
  const auth = app.auth; if (!(auth instanceof UiAuth)) throw Object.assign(new Error('Owner tools must run on the state point.'), { status: 409 });
  const request = OwnerCommandViewRequestSchema.parse({ schema: 'owner-command-view-request-v1', projectId, command: args.command, ...(args.thread ? { threadId: args.thread } : {}), ...(args.decision ? { decisionId: args.decision } : {}), ...(args.device ? { scopeDeviceId: args.device } : {}) });
  const token = auth.issue(); app.redactor.add(token);
  try { return await app.terminals.ownerCommandView(request, token); } finally { auth.logout(token); }
}
