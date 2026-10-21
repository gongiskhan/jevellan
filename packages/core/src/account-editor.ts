import { z } from 'zod';
import { AccountEndpointSchema, AccountSchemaV2, ACCOUNT_ENDPOINT_LIMITS, EffortSchema, type Account } from './schemas.js';
import { AddAccountSchema, CredentialInputSchema, type AccountView } from './client-schemas.js';
import { ACCOUNT_KIND_LABELS, ACCOUNT_PAID_LABELS, ACCOUNT_EFFORT_LABELS, ACCOUNT_ENDPOINT_COPY, accountIsMetered, accountInputIssues } from './account-policy.js';
import { AccountEditorViewSchema, AccountEditorContextSchema, AccountEditorFieldsSchema, type AccountEditorContext, type AccountEditorFields, type AccountEditorPreview } from './account-editor-schemas.js';
const newModel = () => ({ id: '', label: '', efforts: ['medium' as const], description: '' });
const refuse = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
export function accountEditorInitial(runtime: string, kinds: Account['kind'][], current?: AccountView, mode: 'edit' | 'replace-key' = 'edit') {
  const account = current?.account;
  if (account && account.runtime !== runtime) refuse('This account belongs to a different runtime.');
  const kind = account?.kind ?? (kinds.includes('subscription') ? 'subscription' : kinds[0] ?? 'subscription');
  const context = AccountEditorContextSchema.parse({ schema: 'account-editor-context-v1', runtime, mode: current ? mode : 'create', accountId: account?.id ?? null, revision: current?.revision ?? 0, kind: account?.kind ?? null, enabled: account?.enabled ?? true });
  const fields = AccountEditorFieldsSchema.parse({ label: account?.label ?? '', kind, ceilingPct: String(account?.ceilingPct ?? AddAccountSchema.shape.ceilingPct.parse(undefined)), paidUse: account?.paidUse ?? '',
    endpoint: account?.endpoint ? { ...structuredClone(account.endpoint), backgroundModel: account.endpoint.backgroundModel ?? '' } : { baseUrl: '', billing: 'subscription', backgroundModel: '', models: [newModel()] } });
  return { context, fields };
}
export function accountEditorView(input: AccountEditorPreview, kinds: Account['kind'][], current?: AccountView, allowReceiptRetry = false) {
  const { context, credentialPresent } = input, fields = structuredClone(input.fields);
  if (context.mode !== 'create' && (!current || current.account.id !== context.accountId || current.account.runtime !== context.runtime || current.account.kind !== context.kind)) refuse('Reload this account before saving.', 409);
  if (input.command) {
    if (input.command.kind === 'select-kind') {
      if (context.mode !== 'create' || !kinds.includes(input.command.value)) refuse('This runtime does not support that account kind.');
      fields.kind = input.command.value; fields.paidUse = '';
    } else if (input.command.kind === 'add-model') {
      if (fields.endpoint.models.length >= ACCOUNT_ENDPOINT_LIMITS.models) refuse(`An endpoint holds at most ${ACCOUNT_ENDPOINT_LIMITS.models} models.`);
      fields.endpoint.models.push(newModel());
    } else {
      if (fields.endpoint.models.length <= 1 || input.command.index >= fields.endpoint.models.length) refuse('Keep at least one endpoint model.');
      fields.endpoint.models.splice(input.command.index, 1);
    }
  }
  const validation: { field: string; message: string }[] = [], issue = (field: string, message: string) => validation.push({ field, message });
  const check = <T>(field: string, schema: z.ZodType<T>, raw: unknown): T | undefined => {
    const result = schema.safeParse(raw); if (result.success) return result.data;
    for (const item of result.error.issues) issue([field, ...item.path.map(String)].join('.'), item.message); return undefined;
  };
  const replace = context.mode === 'replace-key', editing = context.mode !== 'create';
  const stale = editing && current!.revision !== context.revision;
  if (stale && !allowReceiptRetry) issue('revision', 'This account changed elsewhere. Your draft is preserved. Reload before saving.');
  if (editing && fields.kind !== context.kind) issue('kind', 'An existing account keeps its runtime and kind.');
  if (editing && !stale && current!.account.enabled !== context.enabled) issue('context', 'Reload this account before saving.');
  if (!editing && !kinds.includes(fields.kind)) issue('kind', 'This runtime does not support that account kind.');
  let label: string | undefined, ceilingPct: number | undefined, endpoint: z.infer<typeof AccountEndpointSchema> | undefined;
  const metered = accountIsMetered(fields.kind, fields.endpoint.billing);
  const paidUse = metered && fields.paidUse ? check('paidUse', AddAccountSchema.shape.paidUse.unwrap(), fields.paidUse) : undefined;
  if (!replace) {
    label = check('label', AddAccountSchema.shape.label, fields.label);
    ceilingPct = check('ceilingPct', AddAccountSchema.shape.ceilingPct, fields.ceilingPct.trim() ? Number(fields.ceilingPct) : NaN);
    if (fields.kind === 'endpoint') {
      const { backgroundModel, ...rest } = fields.endpoint;
      endpoint = check('endpoint', AccountEndpointSchema, { ...rest, ...(backgroundModel.trim() ? { backgroundModel: backgroundModel.trim() } : {}) });
    }
    if (editing && label !== undefined && ceilingPct !== undefined) {
      const candidate = { ...current!.account, label, ceilingPct, ...(endpoint ? { endpoint } : {}) }; delete candidate.paidUse;
      if (paidUse) candidate.paidUse = paidUse; check('account', AccountSchemaV2, candidate);
    } else if (!editing) for (const message of accountInputIssues({ runtime: context.runtime, kind: fields.kind, ...(paidUse ? { paidUse } : {}), ...(endpoint ? { endpoint } : {}) }, credentialPresent)) issue('credential', message);
  } else {
    if (current!.account.kind !== 'api-key') issue('kind', 'Choose an API key account.');
    if (!credentialPresent) issue('credential', 'Enter the new API key.');
  }
  const canSave = validation.length === 0;
  const body = replace ? { schema: 'replace-credential-v1', revision: context.revision }
    : editing ? { schema: 'update-account-v1', revision: context.revision, label, enabled: context.enabled, ceilingPct, ...(paidUse ? { paidUse } : {}), ...(endpoint ? { endpoint } : {}) }
      : { schema: 'add-account-v1', runtime: context.runtime, label, kind: fields.kind, ceilingPct, ...(paidUse ? { paidUse } : {}), ...(endpoint ? { endpoint } : {}) };
  const primary = { schema: 'account-editor-write-v1', path: editing ? `/hub/accounts/${context.accountId}${replace ? '/credential' : ''}` : '/hub/accounts', method: replace ? 'PUT' : editing ? 'PATCH' : 'POST', includeCredential: replace || !editing && credentialPresent, body };
  const credentialReplacement = editing && !replace && fields.kind === 'endpoint' && credentialPresent ? { schema: 'account-editor-write-v1', path: `/hub/accounts/${context.accountId}/credential`, method: 'PUT', includeCredential: true, body: { schema: 'replace-credential-v1', revision: context.revision + 1 } } : null;
  const range = AddAccountSchema.shape.ceilingPct.unwrap();
  return AccountEditorViewSchema.parse({ schema: 'account-editor-view-v1', context, fields, title: replace ? 'Replace API key' : editing ? 'Edit account' : 'Add account', submitLabel: replace ? 'Replace key' : editing ? 'Save account' : 'Add account', busyLabel: replace ? 'Checking…' : 'Saving…', cancelLabel: 'Cancel', showDetails: !replace,
    currentRevision: current?.revision ?? 0, staleNotice: stale ? 'This account changed elsewhere. Your draft is preserved. Reload before saving.' : null, reloadLabel: 'Reload account',
    inputs: { label: { label: 'Label', placeholder: 'Personal', maxLength: AddAccountSchema.shape.label.maxLength }, kind: { label: 'Kind', visible: !editing, options: kinds.map(value => ({ value, label: ACCOUNT_KIND_LABELS[value] })) }, ceiling: { label: 'Usage ceiling (%)', min: range.minValue, max: range.maxValue, step: 'any' } },
    paid: { visible: !replace && metered, label: fields.kind === 'endpoint' ? ACCOUNT_ENDPOINT_COPY.paid : 'When may Jevellan use this key?', emptyLabel: 'Choose when', options: Object.entries(ACCOUNT_PAID_LABELS).map(([value, label]) => ({ value, label })) },
    credential: { visible: replace || fields.kind === 'endpoint' || !editing && (fields.kind === 'api-key' || fields.kind === 'subscription' && context.runtime === 'claude'), required: replace || !editing && (fields.kind === 'api-key' || fields.kind === 'endpoint'),
      label: replace ? 'New API key' : fields.kind === 'endpoint' ? ACCOUNT_ENDPOINT_COPY.token : fields.kind === 'api-key' ? 'API key' : 'Subscription token', maxLength: CredentialInputSchema.maxLength,
      detailsLabel: !editing && fields.kind === 'subscription' && context.runtime === 'claude' ? 'Use an existing token' : null, help: replace ? 'The saved key is replaced when you submit this form.' : null,
      notice: !replace && fields.kind === 'subscription' && context.runtime === 'claude' ? "Anthropic's terms restrict third-party tools from offering Claude subscription logins without their approval. Using your own token here is your decision." : null },
    endpoint: { visible: !replace && fields.kind === 'endpoint', copy: ACCOUNT_ENDPOINT_COPY, limits: ACCOUNT_ENDPOINT_LIMITS, efforts: EffortSchema.options.map(value => ({ value, label: ACCOUNT_EFFORT_LABELS[value] })), billing: [{ value: 'subscription', label: ACCOUNT_ENDPOINT_COPY.subscription }, { value: 'metered', label: ACCOUNT_ENDPOINT_COPY.metered }, { value: 'free', label: ACCOUNT_ENDPOINT_COPY.free }], canAdd: fields.endpoint.models.length < ACCOUNT_ENDPOINT_LIMITS.models, canRemove: fields.endpoint.models.length > 1, backgroundPlaceholder: fields.endpoint.models[0]!.id },
    validation, canSave, plan: canSave ? { schema: 'account-editor-plan-v1', primary, credentialReplacement, startLogin: !editing && fields.kind === 'subscription' && !credentialPresent } : null,
    request: { previewPath: '/api/accounts/editor/preview', savePath: '/api/accounts/editor/save' } });
}
export function accountEditorPreviewInput(context: AccountEditorContext, fields: AccountEditorFields, credentialPresent: boolean): AccountEditorPreview {
  return { schema: 'account-editor-preview-v1', context, fields, credentialPresent };
}
