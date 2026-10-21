import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OfferedModelsSchema, type JevConnectionSchema, type SecretStateSchema } from './client-schemas.js';
import { stableJson } from './files.js';
import { newId } from './models.js';
import { suggestedEffortCriteria, SUGGESTED_EFFORT_GUIDE } from './effort-guide.js';
import { ConfigurationSchema, GuardsSchema, MODEL_MENU_LIMIT, SAVED_MODEL_MENU_LIMIT, type ConfigRevision, type Configuration, type ModelOption } from './schemas.js';
import { DecisionsSettingsEditorSchema, DecisionsSettingsFieldsSchema, JevConnectionViewSchema, type DecisionsSettingsFields, type DecisionsSettingsPreview } from './decisions-settings-schemas.js';

type Offers = z.infer<typeof OfferedModelsSchema>[];
type Connection = z.infer<typeof JevConnectionSchema> | null;
const GUARDS = [
  ['maxStretchesPerWork', 'Stretches per work', 1, '1'], ['stretchTimeoutMin', 'Stretch timeout (minutes)', 0, 'any'], ['reviewCap', 'Review cap', 0, '1'],
  ['noProgressLimit', 'No-progress limit', 1, '1'], ['testFailureLimit', 'Test failure limit', 1, '1'], ['externalActivityWindowMin', 'External activity window (minutes)', 0, 'any'],
  ['workCostCapUsd', 'Work cost cap (USD)', 0, 'any'],
] as const;
const failure = (message: string) => Object.assign(new Error(message), { status: 400 });
const draftId = (nonce: string, key: string) => `model_${createHash('sha256').update(`${nonce}\0${key}`).digest('hex').slice(0, 40)}`;
function offersByKey(offers: Offers) {
  const result = new Map<string, { runtime: string; id: string; label: string; efforts: ModelOption['efforts'] }>();
  for (const offered of offers) for (const model of offered.models) {
    const key = `${offered.runtime}/${model.id}`;
    if (!result.has(key) && model.efforts.length) result.set(key, { ...model, runtime: offered.runtime });
  }
  return result;
}
export function decisionsSettingsFields(configuration: Configuration): DecisionsSettingsFields {
  const settings = configuration['x-jevellan'];
  return DecisionsSettingsFieldsSchema.parse({ model: settings.decisions.model, menu: settings.menu.map(({ id, label, description, enabled }) => ({ id, label, description, enabled })),
    effortGuide: settings.effortGuide, routingProfile: settings.routingProfile,
    guards: Object.fromEntries(Object.entries(settings.guards).map(([key, value]) => [key, value === null ? '' : typeof value === 'boolean' ? value : String(value)])) });
}
/** Only this section is rebuilt; hidden configuration and model resource metadata come from the canonical base/offer. */
export function normalizeDecisionsSettings(base: ConfigRevision, fields: DecisionsSettingsFields, offers: Offers, check: Connection, draftRequestId: string) {
  const settings = base.configuration['x-jevellan'], available = offersByKey(offers), validation: Array<{ path: string; message: string }> = [];
  const issue = (path: string, allowed: string) => validation.push({ path, message: `${path} must be ${allowed}.` });
  const nonempty = (path: string, value: string) => { if (!value.trim()) issue(path, 'non-empty'); };
  nonempty('model', fields.model); nonempty('routingProfile', fields.routingProfile);
  for (const [effort, value] of Object.entries(fields.effortGuide)) nonempty(`effortGuide.${effort}`, value);
  if (fields.model !== settings.decisions.model && (!check || check.status !== 'connected' || !check.availableModels.includes(fields.model))) issue('model', check?.status === 'connected' ? `one of the last returned Jev models: ${check.availableModels.join(', ') || 'none listed'}` : 'a model returned by Test connection with the current saved Jev key');
  const old = new Map(settings.menu.map(row => [row.id, row])), seen = new Set<string>(), pairs = new Set<string>(), menu: ModelOption[] = [];
  for (const row of fields.menu) {
    const path = `menu.${row.id}`; if (seen.has(row.id)) { issue(`${path}.id`, 'unique'); continue; } seen.add(row.id);
    let model = old.get(row.id);
    if (!model) {
      const offer = row.offerKey ? available.get(row.offerKey) : undefined;
      if (!offer) { issue(`${path}.id`, 'an existing model or a current offered model'); continue; }
      model = { id: row.id, runtime: offer.runtime, model: offer.id, efforts: offer.efforts, label: row.label, description: row.description, enabled: row.enabled };
      if (row.id !== draftId(draftRequestId, row.offerKey!)) issue(`${path}.id`, 'the engine-generated id for this offered model');
    } else if (row.offerKey !== undefined) issue(`${path}.offerKey`, 'omitted for an existing model');
    const pair = `${model.runtime}/${model.model}`;
    if (!old.has(row.id) && (settings.menu.some(existing => `${existing.runtime}/${existing.model}` === pair) || pairs.has(pair))) issue(`${path}.model`, 'absent from the current menu');
    pairs.add(pair);
    nonempty(`${path}.label`, row.label); nonempty(`${path}.description`, row.description);
    if (row.enabled && model.unavailableReason) issue(`${path}.enabled`, 'false while this model is unavailable');
    menu.push({ ...model, label: row.label, description: row.description, enabled: row.enabled });
  }
  if (settings.menu.some(row => !seen.has(row.id))) issue('menu', 'the complete existing model list');
  if (menu.filter(row => row.enabled).length > MODEL_MENU_LIMIT) validation.push({ path: 'menu', message: 'The model menu holds 19 models. Disable or remove one first.' });
  const guards: Record<string, number | null | boolean> = { pauseAfterPlan: fields.guards.pauseAfterPlan };
  for (const [key] of GUARDS) {
    const raw = fields.guards[key].trim(), value = key === 'workCostCapUsd' && !raw ? null : raw ? Number(raw) : NaN;
    const schema = GuardsSchema.shape[key], parsed = schema.safeParse(value);
    if (!parsed.success) issue(`guards.${key}`, key === 'reviewCap' ? 'a non-negative whole number' : ['maxStretchesPerWork', 'noProgressLimit', 'testFailureLimit'].includes(key) ? 'a positive whole number' : key === 'workCostCapUsd' ? 'blank or a positive number' : 'a positive number');
    else guards[key] = parsed.data;
  }
  if (validation.length) return { validation, configuration: null };
  const configuration = ConfigurationSchema.parse({ ...base.configuration, 'x-jevellan': { ...settings, decisions: { ...settings.decisions, model: fields.model }, menu,
    effortGuide: fields.effortGuide, routingProfile: fields.routingProfile, guards } });
  return { validation, configuration };
}
export function decisionsSettingsEditor(base: ConfigRevision, currentRevision: number, offers: Offers, check: Connection, raw?: DecisionsSettingsPreview) {
  const nonce = raw?.clientRequestId ?? newId('decisions_draft'), fields = structuredClone(raw?.fields ?? decisionsSettingsFields(base.configuration));
  const offered = offersByKey(offers);
  const used = () => new Set(fields.menu.map(row => { const original = base.configuration['x-jevellan'].menu.find(model => model.id === row.id); return original ? `${original.runtime}/${original.model}` : row.offerKey; }));
  if (raw?.command?.kind === 'reset-effort-guide') fields.effortGuide = { ...suggestedEffortCriteria };
  if (raw?.command?.kind === 'add-model') {
    if (fields.menu.filter(row => row.enabled).length >= MODEL_MENU_LIMIT) throw failure('The model menu holds 19 models. Disable or remove one first.');
    if (fields.menu.length >= SAVED_MODEL_MENU_LIMIT) throw failure('The saved model list is full. Remove a disabled model first.');
    const key = raw.command.offerKey, offer = offered.get(key);
    if (!offer || used().has(key)) throw failure('Choose a current offered model that is not already in the menu.');
    fields.menu.push({ id: draftId(nonce, key), offerKey: key, label: offer.label, description: 'Describe when this model fits the work.', enabled: true });
  }
  const normalized = normalizeDecisionsSettings(base, fields, offers, check, nonce), staleNotice = currentRevision === base.revision ? null : 'Settings changed elsewhere. Your draft is preserved. Reload the latest decisions settings before saving.';
  const candidates = [...offered].filter(([key]) => !used().has(key)).map(([key, offer]) => ({ key, label: offer.label, runtime: offer.runtime }));
  const addRefusal = fields.menu.filter(row => row.enabled).length >= MODEL_MENU_LIMIT ? 'The model menu holds 19 models. Disable or remove one first.' : fields.menu.length >= SAVED_MODEL_MENU_LIMIT ? 'The saved model list is full. Remove a disabled model first.' : null;
  const menu = normalized.configuration?.['x-jevellan'].menu;
  const rows = fields.menu.map(row => { const model = menu?.find(model => model.id === row.id) ?? base.configuration['x-jevellan'].menu.find(model => model.id === row.id), offer = row.offerKey ? offered.get(row.offerKey) : undefined;
    return { id: row.id, runtime: model?.runtime ?? offer?.runtime ?? '', model: model?.model ?? offer?.id ?? '', canEnable: !model?.unavailableReason, canToggle: !model?.unavailableReason || row.enabled,
      reasonLine: `Supported efforts: ${(model?.efforts ?? offer?.efforts ?? []).join(', ')}${model?.unavailableReason ? ` · ${model.unavailableReason}` : ''}` }; });
  const canSave = !staleNotice && !!normalized.configuration, saveId = `decisions_${createHash('sha256').update(stableJson({ nonce, revision: base.revision, fields })).digest('hex')}`;
  return DecisionsSettingsEditorSchema.parse({ schema: 'decisions-settings-editor-v1', revision: base.revision, currentRevision, fields, rows, candidates, canAdd: candidates.length > 0 && !addRefusal, addRefusal,
    guide: { differsFromSuggested: Object.entries(suggestedEffortCriteria).some(([effort, text]) => fields.effortGuide[effort as keyof typeof fields.effortGuide] !== text), notice: SUGGESTED_EFFORT_GUIDE, efforts: Object.keys(base.configuration['x-jevellan'].effortGuide) },
    guardFields: GUARDS.map(([key, label, min, step]) => ({ key, label, min, step, required: key !== 'workCostCapUsd', ...(key === 'workCostCapUsd' ? { placeholder: 'No cap' } : {}) })), validation: normalized.validation, canSave, staleNotice,
    preview: { path: '/api/config/decisions/preview', request: { schema: 'decisions-settings-preview-v1', revision: base.revision, clientRequestId: nonce, fields } },
    saveRequest: canSave ? { schema: 'decisions-settings-save-v1', revision: base.revision, clientRequestId: saveId, draftRequestId: nonce, fields } : null });
}
export function jevConnectionView(summary: z.infer<typeof SecretStateSchema>, check: Connection, configuredModel: string) {
  const listed = check?.status === 'connected' && check.availableModels.includes(configuredModel);
  return JevConnectionViewSchema.parse({ schema: 'jev-connection-view-v1', saved: summary.saved, lastFour: summary.saved ? summary.lastFour : null, savedText: summary.saved ? `Saved · ••••${summary.lastFour}` : null,
    consequence: summary.saved ? null : 'Add your Jev key in Settings → Decisions. Until then you pick each step yourself.', canTest: summary.saved,
    result: !check ? null : { heading: check.status === 'connected' ? 'Connected to Jev.' : `Jev is unavailable (${check.reason ?? 'unknown'}).`, tone: check.status === 'connected' ? 'success' : 'notice',
      lines: check.status === 'connected' ? [`Saved model: ${configuredModel}. Returned models: ${check.availableModels.join(', ') || 'none listed'}.`, ...(!listed ? ['The saved model was not returned by Jev. Choose a returned model before relying on automatic decisions.'] : [])] : [],
      latencyLine: `Latency: ${check.latencyMs} ms.`, savedModelListed: !!listed } });
}
