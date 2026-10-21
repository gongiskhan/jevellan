import { EkoaEditorSchema, EkoaEditorPreviewSchema, EkoaEditorSaveSchema, EkoaEditorConnectSchema } from './ekoa-editor-schemas.js';
import { EkoaStateSchema, EkoaSettingsSchema, EkoaSettingsInputSchema } from './ekoa-schemas.js';
import { EkoaOAuthStartSchema, EkoaOAuthCallbackSchema } from './ekoa-oauth-schemas.js';
const DEFAULT_URL = 'https://mcp.ekoa.io/mcp';
export const ekoaUrlRequired = (fields: { enabled: boolean }) => fields.enabled;
function settingsBody(revision: number, fields: { url: string; enabled: boolean }, removeToken: boolean) {
  const settings = EkoaSettingsSchema.parse({ schema: 'ekoa-settings-v1', revision, ...fields, enabled: removeToken ? false : fields.enabled });
  return { schema: 'ekoa-settings-input-v1' as const, revision, url: settings.url, enabled: settings.enabled, ...(removeToken ? { removeToken: true } : {}) };
}
export function ekoaEditor(rawState: unknown, rawPreview?: unknown) {
  const state = EkoaStateSchema.parse(rawState), preview = rawPreview === undefined ? undefined : EkoaEditorPreviewSchema.parse(rawPreview), fields = preview?.fields ?? { url: state.settings.url, enabled: state.settings.enabled };
  const validation: string[] = []; let plan = null;
  if (preview && preview.revision !== state.settings.revision) validation.push('Ekoa settings changed elsewhere. Reload before saving.');
  if (preview?.operation === 'remove-token' && preview.credentialPresent) validation.push('Replace or remove the token, not both.');
  try {
    const body = settingsBody(preview?.revision ?? state.settings.revision, fields, preview?.operation === 'remove-token');
    if (!validation.length) plan = { body, includeCredential: preview?.credentialPresent ?? false };
  } catch (error) {
    const parsed = EkoaSettingsSchema.safeParse({ schema: 'ekoa-settings-v1', revision: state.settings.revision, ...fields });
    validation.push(...(parsed.success ? [error instanceof Error ? error.message : 'Check the mirror settings.'] : parsed.error.issues.map(issue => issue.message)));
  }
  return EkoaEditorSchema.parse({ schema: 'ekoa-editor-v1', state, fields, title: 'Ekoa', heading: 'Tasks that need you', intro: 'Decisions, merge questions and proposed tasks appear in your Ekoa account with the Jevellan label. Answer and approve them in Jevellan.',
    tokenHelp: 'Ekoa must offer task access with read and write permission.', connectLabel: 'Connect to Ekoa', mirrorLabel: 'Mirror tasks to Ekoa', savedNotice: 'Ekoa settings saved.',
    connect: { defaultUrl: DEFAULT_URL, authorizationUrl: state.oauth?.authorizationUrl, failure: state.connection?.reason ?? 'Ekoa could not start sign-in.' },
    write: { path: '/hub/ekoa/editor', method: 'PUT', body: { schema: 'ekoa-editor-save-v1', revision: state.settings.revision } }, urlRequired: ekoaUrlRequired(fields), canSave: validation.length === 0, validation, plan,
    presentation: { oauthLine: state.oauth?.connected ? 'OAuth sign-in saved. Access refreshes automatically.' : 'Sign in to grant task read and write access.',
      tokenLine: state.tokenSaved ? 'Token saved in the hub vault.' : 'No token saved.', tokenPlaceholder: state.tokenSaved ? 'Saved · enter a replacement' : 'Enter your Ekoa token',
      connection: state.connection ? { title: state.connection.status === 'connected' ? 'Connected' : 'Connection blocked', reason: state.connection.reason, tools: state.connection.tools } : null,
      mirrorsLine: `${state.mirrors.filter(row => row.state === 'open').length} open · ${state.mirrors.filter(row => row.state === 'completed').length} completed`,
      mirrors: state.mirrors.map(row => ({ id: row.id, title: row.title ?? row.kind, state: row.state })), errors: state.mirrors.filter(row => row.error).map(row => ({ id: row.id, message: row.error!, retryLine: row.retryAt ? 'Jevellan will retry.' : '' })),
    },
  });
}
export function prepareEkoaEditorSave(raw: unknown) {
  const input = EkoaEditorSaveSchema.parse(raw);
  return EkoaSettingsInputSchema.parse({ ...settingsBody(input.revision, input.fields, input.operation === 'remove-token'), clientRequestId: input.clientRequestId, ...(input.credential === undefined ? {} : { token: input.credential }) });
}
export function prepareEkoaEditorConnect(raw: unknown) {
  const input = EkoaEditorConnectSchema.parse(raw);
  return EkoaOAuthStartSchema.parse({ schema: 'ekoa-oauth-start-v1', clientRequestId: input.clientRequestId, url: input.url || DEFAULT_URL });
}
export function ekoaCallbackInput(search: string) {
  const query = new URLSearchParams(search);
  return EkoaOAuthCallbackSchema.parse({ schema: 'ekoa-oauth-callback-v1', state: query.get('state') ?? '', ...(query.get('code') ? { code: query.get('code') } : {}), ...(query.get('error') ? { error: query.get('error') } : {}) });
}
