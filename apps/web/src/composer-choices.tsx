import { ComposerChoiceSchema, ComposerInitialSchema, EffortSchema, type Action, type Configuration, type Conversation } from '@jevellan/core/client';

type Field = 'action' | 'model' | 'effort';
type Mode = 'once' | 'pin';
type Initial = ReturnType<typeof ComposerInitialSchema.parse>;
export function changeComposerDraft(current: Initial, field: Field, value: string | null, mode: Mode): Initial {
  const choice = ComposerChoiceSchema.parse({ schema: 'composer-choice-v1', clientRequestId: 'draft', generation: 0, field, value, mode });
  const next = structuredClone(current); const key = field === 'model' ? 'modelId' : field;
  if (choice.value === null) { delete next.once[key]; if (key !== 'action') delete next.pins[key]; }
  else if (choice.field === 'action') next.once.action = choice.value;
  else if (choice.mode === 'pin') { delete next.once[key]; if (choice.field === 'model') next.pins.modelId = choice.value; else next.pins.effort = choice.value; }
  else if (choice.field === 'model') next.once.modelId = choice.value;
  else next.once.effort = choice.value;
  return ComposerInitialSchema.parse(next);
}
export function ComposerChoices({ once, pins, config, actions, disabled, change }: {
  once: Conversation['once']; pins: Conversation['pins']; config: Configuration['x-jevellan']; actions: Action[]; disabled: boolean;
  change(field: Field, value: string | null, mode: Mode): void;
}) {
  const label = (field: Field, value: string) => field === 'model' ? config.menu.find((model) => model.id === value)?.label ?? value : field === 'action' ? value === 'ask-you' ? 'Ask you' : value.split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ') : value;
  return <div className="composer-choices" role="group" aria-label="Choices for the next step">{(['action', 'model', 'effort'] as const).map((field) => {
    const key = field === 'model' ? 'modelId' : field; const pinned = key === 'action' ? undefined : pins[key]; const selected = once[key] ?? pinned ?? '';
    const kept = !!pinned && once[key] === undefined;
    const options = field === 'action' ? actions.filter((action) => action !== 'integrate').map((value) => ({ value, disabled: false })) : field === 'effort' ? EffortSchema.options.map((value) => ({ value, disabled: false })) : config.menu.map((model) => ({ value: model.id, disabled: !model.enabled || !config.runtimes[model.runtime]?.enabled }));
    return <div className="composer-choice" key={field} data-field={field}><label>{field === 'action' ? 'Next step' : field === 'model' ? 'Model' : 'Effort'}<select disabled={disabled} value={selected} onChange={(event) => change(field, event.target.value || null, 'once')}><option value="">Auto</option>{selected && !options.some((option) => option.value === selected) && <option value={selected} disabled>{label(field, selected)} · unavailable</option>}{options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{label(field, option.value)}{option.disabled ? ' · unavailable' : ''}</option>)}</select></label>
      <div className="composer-choice-mode">{selected && <small>{kept ? 'Kept for this conversation' : pinned ? `Once, then ${label(field, pinned)}` : 'Next decision only'}</small>}
      {field !== 'action' && selected && !kept && <button type="button" className="text-button" disabled={disabled} aria-label={`Keep ${field} for this conversation`} onClick={() => change(field, selected, 'pin')}>Keep for this conversation</button>}
      {(selected || pinned) && <button type="button" className="text-button" disabled={disabled} aria-label={`${field === 'action' ? 'Next step' : field === 'model' ? 'Model' : 'Effort'} back to Auto`} onClick={() => change(field, null, field === 'action' ? 'once' : 'pin')}>Back to Auto</button>}</div>
    </div>;
  })}</div>;
}
