import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { ProjectSetupItemSchema, SetupActionRequestSchema, SetupProposalViewSchema } from './project-setup-schemas.js';
import { SETUP_LABELS, setupApplied, setupGoalLabel } from './project-setup-copy.js';

export const SetupEditorPolicySchema = z.strictObject({ schema: z.literal('setup-editor-policy-v1'), title: z.string(), loading: z.string(), applyLabel: z.string(), dismissLabel: z.string(), dismissedLabel: z.string(), fillValuesLabel: z.string(), reloadLabel: z.string(), valueMax: z.number().int().positive() });
export function setupEditorPolicy() {
  return SetupEditorPolicySchema.parse({ schema: 'setup-editor-policy-v1', title: 'Suggested setup', loading: 'Loading…', applyLabel: 'Apply setup', dismissLabel: 'Not now', dismissedLabel: 'Setup dismissed.', fillValuesLabel: 'Fill in their values in Project settings → Environment.', reloadLabel: 'Reload', valueMax: ProjectSetupItemSchema.shape.value.maxLength! });
}
const index = z.number().int().min(0).max(11), rawValue = z.string().max(40000);
export const SetupEditorFieldsSchema = z.strictObject({ values: z.array(rawValue).max(12), selected: z.array(index).max(12).refine(rows => new Set(rows).size === rows.length, 'Choose each setup item once.') });
export const SetupEditorUiSchema = z.strictObject({ schema: z.literal('setup-editor-ui-v1'), busy: z.boolean(), stale: z.string().max(16000).nullable() });
export const SetupEditorEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ schema: z.literal('setup-editor-event-v1'), type: z.literal('value'), index, value: rawValue }),
  z.strictObject({ schema: z.literal('setup-editor-event-v1'), type: z.literal('selection'), index, checked: z.boolean() }),
]);
const paths = (projectId: string, proposalId: string) => {
  const path = `/api/projects/${projectId}/setup-proposals/${proposalId}`;
  return { editor: `${path}/editor`, prepare: `${path}/prepare`, command: `${path}/commands` };
};
export const SetupProposalEditorSchema = z.strictObject({ schema: z.literal('setup-proposal-editor-v1'), projectId: IdSchema, proposalId: IdSchema,
  view: SetupProposalViewSchema, fields: SetupEditorFieldsSchema, ui: SetupEditorUiSchema, policy: SetupEditorPolicySchema,
  state: z.enum(['open', 'applied', 'dismissed']), items: z.array(z.strictObject({ index, label: z.string(), note: z.string().nullable(), value: rawValue, selected: z.boolean() })).max(12),
  appliedLine: z.string().nullable(), followUp: z.string().nullable(), actions: z.strictObject({ visible: z.boolean(), applyEnabled: z.boolean(), dismissEnabled: z.boolean(), reloadVisible: z.boolean() }),
  paths: z.strictObject({ editor: z.string(), prepare: z.string(), command: z.string() }),
}).refine(row => row.projectId === row.view.proposal.projectId && row.proposalId === row.view.proposal.id && row.fields.values.length === row.view.proposal.items.length && row.fields.selected.every(i => i < row.fields.values.length), 'The editor does not match its captured proposal.');
export const SetupEditorPreviewSchema = z.strictObject({ schema: z.literal('setup-editor-preview-v1'), view: SetupProposalViewSchema, fields: SetupEditorFieldsSchema, ui: SetupEditorUiSchema });
export const SetupEditorCommandSchema = z.strictObject({ schema: z.literal('setup-editor-command-v1'), projectId: IdSchema, proposalId: IdSchema, body: SetupActionRequestSchema });
type Command = z.infer<typeof SetupEditorCommandSchema>;
function signature(command: Command) {
  const { clientRequestId, ...body } = command.body; void clientRequestId;
  return JSON.stringify({ projectId: command.projectId, proposalId: command.proposalId, body });
}
export const SetupEditorAttemptSchema = z.strictObject({ schema: z.literal('setup-editor-attempt-v1'), signature: z.string(), path: z.string(), command: SetupEditorCommandSchema })
  .refine(row => row.signature === signature(row.command) && row.path === paths(row.command.projectId, row.command.proposalId).command, 'The attempt does not match its captured command.');
export const SetupEditorPrepareSchema = z.strictObject({ schema: z.literal('setup-editor-prepare-v1'), editor: SetupProposalEditorSchema, previous: SetupEditorAttemptSchema.nullable(), action: z.enum(['apply', 'dismiss']), candidateId: IdSchema });
export const SetupEditorReceiptSchema = z.strictObject({ schema: z.literal('setup-editor-receipt-v1'), projectId: IdSchema, proposalId: IdSchema, action: z.enum(['apply', 'dismiss']), clientRequestId: IdSchema, view: SetupProposalViewSchema })
  .refine(row => row.projectId === row.view.proposal.projectId && row.proposalId === row.view.proposal.id && (row.action === 'apply' ? !!row.view.proposal.appliedAt && !row.view.proposal.dismissedAt : !!row.view.proposal.dismissedAt && !row.view.proposal.appliedAt), 'The receipt does not match the completed setup action.');

export function setupProposalEditor(raw: unknown, rawFields?: unknown, rawUi?: unknown) {
  const view = SetupProposalViewSchema.parse(raw), proposal = view.proposal, policy = setupEditorPolicy();
  const fields = SetupEditorFieldsSchema.parse(rawFields ?? { values: proposal.items.map(item => item.value), selected: proposal.items.map((_, i) => i) });
  if (fields.values.length !== proposal.items.length || fields.selected.some(i => i >= proposal.items.length)) throw new Error('The fields do not match this setup proposal.');
  const ui = SetupEditorUiSchema.parse(rawUi ?? { schema: 'setup-editor-ui-v1', busy: false, stale: null });
  const state = proposal.appliedAt ? 'applied' : proposal.dismissedAt ? 'dismissed' : 'open', available = state === 'open' && !ui.busy && !ui.stale;
  return SetupProposalEditorSchema.parse({ schema: 'setup-proposal-editor-v1', projectId: proposal.projectId, proposalId: proposal.id, view, fields, ui, policy, state,
    items: proposal.items.map((item, i) => ({ index: i, label: item.key === 'goal' ? setupGoalLabel(fields.values[i]!) : SETUP_LABELS[item.key], note: item.note ?? null, value: fields.values[i]!, selected: fields.selected.includes(i) })),
    appliedLine: state === 'applied' ? setupApplied(proposal.applied?.length ?? 0) : null,
    followUp: state === 'applied' && proposal.items.some((item, i) => proposal.applied?.includes(i) && (item.key === 'variables' || item.key === 'secrets')) ? policy.fillValuesLabel : null,
    actions: { visible: state === 'open', applyEnabled: !!available && fields.selected.length > 0 && fields.selected.every(i => !!fields.values[i]?.trim() && ProjectSetupItemSchema.shape.value.safeParse(fields.values[i]).success), dismissEnabled: !!available, reloadVisible: state === 'open' && !!ui.stale },
    paths: paths(proposal.projectId, proposal.id),
  });
}
export function setupProposalEdit(raw: unknown, rawEvent: unknown) {
  const parsed = SetupProposalEditorSchema.parse(raw), model = setupProposalEditor(parsed.view, parsed.fields, parsed.ui), event = SetupEditorEventSchema.parse(rawEvent);
  if (model.state !== 'open' || model.ui.busy) throw new Error('This setup proposal cannot be edited now.');
  if (event.index >= model.items.length) throw new Error('This setup item does not exist.');
  const fields = structuredClone(model.fields);
  if (event.type === 'value') fields.values[event.index] = event.value;
  else if (event.checked) { if (!fields.selected.includes(event.index)) fields.selected.push(event.index); }
  else fields.selected = fields.selected.filter(i => i !== event.index);
  return setupProposalEditor(model.view, fields, model.ui);
}
export function setupProposalUi(raw: unknown, ui: unknown) {
  const model = SetupProposalEditorSchema.parse(raw); return setupProposalEditor(model.view, model.fields, ui);
}
export function setupProposalAttempt(rawPrevious: unknown, rawModel: unknown, action: 'apply' | 'dismiss', candidateId: string) {
  const parsed = SetupProposalEditorSchema.parse(rawModel), model = setupProposalEditor(parsed.view, parsed.fields, parsed.ui);
  if (action === 'apply' ? !model.actions.applyEnabled : action !== 'dismiss' || !model.actions.dismissEnabled) throw new Error('This setup action is not available.');
  const command = SetupEditorCommandSchema.parse({ schema: 'setup-editor-command-v1', projectId: model.projectId, proposalId: model.proposalId,
    body: { schema: 'setup-action-request-v1', clientRequestId: candidateId, expectedRevision: model.view.proposal.revision, action,
      ...(action === 'apply' ? { settingsRevision: model.view.settingsRevision, projectRevision: model.view.projectRevision, selected: model.fields.selected.map(i => ({ index: i, value: model.fields.values[i] })) } : {}) } });
  const previous = rawPrevious === null ? null : SetupEditorAttemptSchema.parse(rawPrevious), nextSignature = signature(command);
  if (previous?.signature === nextSignature) return previous;
  return SetupEditorAttemptSchema.parse({ schema: 'setup-editor-attempt-v1', signature: nextSignature, path: model.paths.command, command });
}
export function setupProposalReceipt(rawCommand: unknown, rawView: unknown) {
  const command = SetupEditorCommandSchema.parse(rawCommand);
  return SetupEditorReceiptSchema.parse({ schema: 'setup-editor-receipt-v1', projectId: command.projectId, proposalId: command.proposalId, action: command.body.action, clientRequestId: command.body.clientRequestId, view: rawView });
}
export function setupProposalAccepted(rawAttempt: unknown, rawReceipt: unknown, currentResource: { projectId: string; proposalId: string }) {
  const attempt = SetupEditorAttemptSchema.parse(rawAttempt), receipt = SetupEditorReceiptSchema.parse(rawReceipt), command = attempt.command;
  if (currentResource.projectId !== command.projectId || currentResource.proposalId !== command.proposalId || receipt.projectId !== command.projectId || receipt.proposalId !== command.proposalId || receipt.action !== command.body.action || receipt.clientRequestId !== command.body.clientRequestId) throw new Error('The setup receipt belongs to another action.');
  return setupProposalEditor(receipt.view);
}
