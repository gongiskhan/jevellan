import { ConfigurationSchema, type Configuration } from './schemas.js';
import { RoutingDraftSchema, RoutingFieldSchema, type RoutingDraft, type RoutingField, type RoutingGroup } from './improver-schemas.js';

export function routingFieldText(configuration: Configuration, raw: RoutingField): string {
  const field = RoutingFieldSchema.parse(raw); const settings = configuration['x-jevellan'];
  if (field.kind === 'routing-profile') return settings.routingProfile;
  if (field.kind === 'effort-guide') return settings.effortGuide[field.effort];
  const entry = settings.menu.find(model => model.id === field.modelId);
  if (!entry) throw Object.assign(new Error('The suggested model is no longer in the menu.'), { status: 409 });
  return entry.description;
}

/** Compare only the edited field so unrelated configuration changes survive. */
export function applyRoutingField(configuration: Configuration, raw: RoutingField, before: string, after: string): Configuration {
  const field = RoutingFieldSchema.parse(raw); const copy = ConfigurationSchema.parse(configuration);
  if (routingFieldText(copy, field) !== before) throw Object.assign(new Error('This field changed. Recompute the suggestion.'), { status: 409 });
  if (field.kind === 'routing-profile') copy['x-jevellan'].routingProfile = after;
  else if (field.kind === 'effort-guide') copy['x-jevellan'].effortGuide[field.effort] = after;
  else copy['x-jevellan'].menu.find(model => model.id === field.modelId)!.description = after;
  return ConfigurationSchema.parse(copy);
}

export function validateRoutingDraft(raw: unknown, configuration: Configuration, group: RoutingGroup): RoutingDraft {
  const draft = RoutingDraftSchema.parse(raw); const known = new Set(group.overrides.map(value => value.id));
  if (draft.evidenceOverrideIds.some(id => !known.has(id))) throw new Error('The suggestion cites an unknown correction.');
  applyRoutingField(configuration, draft.field, draft.before, draft.after);
  return draft;
}
