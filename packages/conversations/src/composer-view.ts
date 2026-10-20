import { ComposerChoiceSchema, ComposerInitialSchema, ConversationComposerViewSchema, EffortSchema, newId,
  type Action, type ComposerChoice, type Configuration } from '@jevellan/core';

type Initial = ReturnType<typeof ComposerInitialSchema.parse>;
type Settings = Configuration['x-jevellan'];
type Field = 'action' | 'model' | 'effort';

/** Pure replay shared by an unsaved draft and the durable composer ledger. */
export function applyComposerChoice(initial: Initial, raw: unknown): Initial {
  const choice = ComposerChoiceSchema.parse(raw), next = ComposerInitialSchema.parse(initial);
  const key = choice.field === 'model' ? 'modelId' : choice.field === 'runtime' ? 'runtimeId' : choice.field === 'account' ? 'accountId' : choice.field;
  if (choice.value === null) {
    delete next.once[key];
    if (key !== 'action') delete next.pins[key];
  } else if (choice.field === 'action') next.once.action = choice.value;
  else {
    if (choice.mode === 'pin') delete next.once[key];
    const target = choice.mode === 'pin' ? next.pins : next.once;
    if (choice.field === 'model') target.modelId = choice.value;
    else if (choice.field === 'runtime') target.runtimeId = choice.value;
    else if (choice.field === 'account') target.accountId = choice.value;
    else target.effort = choice.value;
  }
  return ComposerInitialSchema.parse(next);
}

function label(settings: Settings, field: Field, value: string): string {
  if (field === 'model') return settings.menu.find(model => model.id === value)?.label ?? value;
  if (field === 'effort') return value;
  return value === 'ask-you' ? 'Ask you' : value.split('-').map(part => part[0]!.toUpperCase() + part.slice(1)).join(' ');
}

export function conversationComposerView(input: { projectId: string; conversationId?: string; generation: number; initial: Initial; settings: Settings; allowed: Action[] }) {
  const initial = ComposerInitialSchema.parse(input.initial), { settings } = input;
  const fields = (['action', 'model', 'effort'] as const).map(field => {
    const key = field === 'model' ? 'modelId' : field;
    const pinned = key === 'action' ? undefined : initial.pins[key], once = initial.once[key];
    const selected = once ?? pinned ?? '', kept = !!pinned && once === undefined;
    const choice = (value: string | null, mode: ComposerChoice['mode'] = 'once') => ComposerChoiceSchema.parse({
      schema: 'composer-choice-v1', clientRequestId: newId('choice'), generation: input.generation, field, mode, value,
    });
    const values: Array<{ value: string; disabled: boolean }> = field === 'action' ? input.allowed.filter(value => value !== 'integrate').map(value => ({ value, disabled: false }))
      : field === 'effort' ? EffortSchema.options.map(value => ({ value, disabled: false }))
        : settings.menu.map(model => ({ value: model.id, disabled: !model.enabled || !settings.runtimes[model.runtime]?.enabled }));
    if (selected && !values.some(option => option.value === selected)) values.unshift({ value: selected, disabled: true });
    const scope = !selected ? null : kept ? 'kept' : pinned ? 'once-then-pin' : 'once';
    return {
      id: field, label: field === 'action' ? 'Next step' : field === 'model' ? 'Model' : 'Effort', selected, scope,
      scopeLabel: !scope ? null : kept ? 'Kept for this conversation' : pinned ? `Once, then ${label(settings, field, pinned)}` : 'Next decision only',
      options: [{ value: '', label: 'Auto', disabled: false, choice: choice(null) }, ...values.map(option => ({
        ...option, label: `${label(settings, field, option.value)}${option.disabled ? ' · unavailable' : ''}`, choice: choice(option.value),
      }))],
      keep: field !== 'action' && selected && !kept ? choice(selected, 'pin') : null,
      clear: selected || pinned ? choice(null, field === 'action' ? 'once' : 'pin') : null,
    };
  });
  const summary = (['action', 'model', 'effort'] as const).flatMap(field => {
    const key = field === 'model' ? 'modelId' : field, value = initial.once[key] ?? (key === 'action' ? undefined : initial.pins[key]);
    return value ? [label(settings, field, value)] : [];
  }).join(' · ') || null;
  return ConversationComposerViewSchema.parse({ schema: 'conversation-composer-view-v1', projectId: input.projectId,
    conversationId: input.conversationId ?? null, initial, summary, fields });
}
