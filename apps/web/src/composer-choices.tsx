import { ConversationComposerViewSchema, type ComposerChoice, type ConversationComposerView, type ComposerInitialSchema } from '@jevellan/core/client';
import { useEffect, useRef, useState } from 'react';
import { api, isCancelled } from './api.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

type Initial = ReturnType<typeof ComposerInitialSchema.parse>;
type Run = (task: (signal: AbortSignal) => Promise<void>) => Promise<void>;
type Context = {
  projectId: string; revision?: number; conversationId?: string; generation?: number; initial?: Initial;
  update?(initial: Initial): void; afterSave?(signal: AbortSignal): Promise<void>; run: Run;
};

function useComposerModel(context: Context) {
  const [view, setView] = useState<ConversationComposerView>();
  const [loading, setLoading] = useState(false), [error, setError] = useState<string>();
  const latest = useRef(context); latest.current = context;
  const epoch = useRef(0), active = useRef(false);
  useEffect(() => {
    const current = latest.current, stamp = ++epoch.current, controller = new AbortController();
    setView(undefined); setError(undefined);
    if (!current.projectId) { setLoading(false); return; }
    setLoading(true);
    const read = current.conversationId
      ? api(`/api/conversations/${current.conversationId}/choices-view`, ConversationComposerViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })
      : api('/api/conversation-composer', ConversationComposerViewSchema, 'POST', { schema: 'conversation-composer-request-v1', projectId: current.projectId, initial: current.initial }, { signal: controller.signal, waitForHub: true });
    void read.then(value => {
      if (stamp !== epoch.current || controller.signal.aborted) return;
      if (value.projectId !== current.projectId || value.conversationId !== (current.conversationId ?? null)) throw new Error('The composer response belongs to another context.');
      setView(value);
    }).catch(cause => { if (stamp === epoch.current && !controller.signal.aborted && !isCancelled(cause)) setError(cause instanceof Error ? cause.message : 'Could not read choices.'); })
      .finally(() => { if (stamp === epoch.current && !controller.signal.aborted) setLoading(false); });
    return () => { ++epoch.current; controller.abort(); };
  }, [context.projectId, context.conversationId, context.generation, context.revision]);
  const change = (choice: ComposerChoice, accepted: () => void) => latest.current.run(async signal => {
    if (active.current) return;
    active.current = true;
    const current = latest.current, stamp = ++epoch.current;
    accepted(); setError(undefined);
    try {
      const value = current.conversationId
        ? await api(`/api/conversations/${current.conversationId}/choices-editor`, ConversationComposerViewSchema, 'POST', choice, { signal, waitForHub: true })
        : await api('/api/conversation-composer', ConversationComposerViewSchema, 'POST', { schema: 'conversation-composer-request-v1', projectId: current.projectId, initial: current.initial, choice }, { signal, waitForHub: true });
      if (signal.aborted || stamp !== epoch.current) return;
      if (value.projectId !== current.projectId || value.conversationId !== (current.conversationId ?? null)) throw new Error('The composer response belongs to another context.');
      setView(value);
      if (current.conversationId) await current.afterSave?.(signal);
      else current.update?.(value.initial);
    } catch (cause) {
      if (stamp === epoch.current && !signal.aborted && !isCancelled(cause)) setError(cause instanceof Error ? cause.message : 'Could not save choices.');
      throw cause;
    } finally { active.current = false; }
  });
  return { view, loading, error, change };
}

type Model = ReturnType<typeof useComposerModel>;
function ChoiceFields({ model, disabled }: { model: Model; disabled: boolean }) {
  const [raw, setRaw] = useState<{ field: string; value: string }>();
  const choose = (choice: ComposerChoice) => {
    void model.change(choice, () => setRaw({ field: choice.field, value: choice.value ?? '' })).finally(() => setRaw(undefined));
  };
  return <>
    {model.error && <p className="notice" role="alert">{model.error}</p>}
    {!model.view && model.loading && <p className="muted">Loading choices…</p>}
    {model.view && <div className="composer-choices" role="group" aria-label="Choices for the next step">
      {model.view.fields.map(field => <div className="composer-choice" key={field.id} data-field={field.id}>
        <label>{field.label}
          <select disabled={disabled || model.loading} value={raw?.field === field.id ? raw.value : field.selected}
            onChange={event => { const option = field.options.find(row => row.value === event.target.value); if (option) choose(option.choice); }}>
            {field.options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
          </select>
        </label>
        <div className="composer-choice-mode">
          {field.scopeLabel && <small>{field.scopeLabel}</small>}
          {field.keep && <button type="button" className="text-button" disabled={disabled || model.loading} aria-label={`Keep ${field.id} for this conversation`}
            onClick={() => choose(field.keep!)}>Keep for this conversation</button>}
          {field.clear && <button type="button" className="text-button" disabled={disabled || model.loading} aria-label={`${field.label} back to Auto`}
            onClick={() => choose(field.clear!)}>Back to Auto</button>}
        </div>
      </div>)}
    </div>}
  </>;
}

export function ComposerOverride(props: { projectId: string; revision: number; initial: Initial; update(initial: Initial): void; disabled: boolean; run: Run }) {
  const model = useComposerModel(props), [open, setOpen] = useState(false);
  const summary = model.view?.summary;
  return <>
    <button type="button" className={`override-button${summary ? ' set' : ''}`} disabled={props.disabled || model.loading || !model.view}
      aria-label={summary ? `Override: ${summary}` : 'Override'} title="Override the next step, model or effort" onClick={() => setOpen(true)}>
      <Icon name="tune" /><span>{summary ?? 'Auto'}</span>
    </button>
    {model.error && !open && <p className="notice" role="alert">{model.error}</p>}
    {open && <Modal title="Override the next step" close={() => setOpen(false)}>
      <p className="muted small-text">Jev chooses automatically. Set a value only to override it.</p>
      <ChoiceFields model={model} disabled={props.disabled} />
      <div className="form-actions"><button type="button" onClick={() => setOpen(false)}>Done</button></div>
    </Modal>}
  </>;
}

export function ComposerChoices(props: { projectId: string; revision: number; conversationId: string; generation: number; afterSave(signal: AbortSignal): Promise<void>; disabled: boolean; run: Run }) {
  return <ChoiceFields model={useComposerModel(props)} disabled={props.disabled} />;
}
