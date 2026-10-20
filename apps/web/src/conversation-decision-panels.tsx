import { ConversationDecisionWhyViewSchema, ConversationPublicSchema, StepCorrectionEditorSchema, type ConversationDecisionWhyView, type DecisionRecord, type StepCorrectionEditor } from '@jevellan/core/client';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { api, isCancelled } from './api.js';
import { Modal, Panel, dateTime, useTask, type PageProps } from './components.js';

type View = z.infer<typeof ConversationPublicSchema>;
function ProbabilityOptions({ section }: { section: ConversationDecisionWhyView['action'] | NonNullable<ConversationDecisionWhyView['model']> | NonNullable<ConversationDecisionWhyView['effort']> }) {
  return section.options.length ? <>{section.options.map(option => <div className={`why-option ${option.selected ? 'win' : ''}`} key={option.id}>
    <span>{option.label}</span><progress aria-label={option.progressLabel} max={1} value={option.p} /><span>{option.p.toFixed(2)}</span>
  </div>)}</> : <p className="why-line"><b>{section.chosenLabel}</b></p>;
}

export function ConversationWhyPanel({ decision, props, close }: { decision: Pick<DecisionRecord, 'id' | 'conversationId'>; props: PageProps; close(): void }) {
  const [view, setView] = useState<ConversationDecisionWhyView>(), [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController(); setView(undefined); setError(undefined);
    void api(`/api/conversations/${decision.conversationId}/decision-why`, ConversationDecisionWhyViewSchema, 'POST', { schema: 'conversation-decision-why-request-v1', decisionId: decision.id }, { signal: controller.signal, waitForHub: true })
      .then(value => { if (!controller.signal.aborted) { if (value.conversationId !== decision.conversationId || value.decisionId !== decision.id) throw new Error('The returned explanation belongs to another decision.'); setView(value); } })
      .catch(cause => { if (!controller.signal.aborted && !isCancelled(cause)) { setError(cause instanceof Error ? cause.message : 'Could not read this explanation.'); props.onError(cause); } });
    return () => controller.abort();
  }, [decision.id, decision.conversationId, props.data.config.revision, props.onError]);
  return <Panel title="Why this step" {...(view?.eyebrow ? { eyebrow: view.eyebrow } : {})} close={close}>
    {error && <p className="notice" role="alert">{error}</p>}
    {!view && !error && <p role="status">Loading explanation…</p>}
    {view && <>
      <section className="why-section"><h3>Next step <span className="why-source">{view.action.sourceLabel}</span></h3>
        {view.action.guardReason && <p className="why-line">{view.action.guardReason}</p>}<ProbabilityOptions section={view.action} />
      </section>
      {view.model && <section className="why-section"><h3>Model <span className="why-source">{view.model.sourceLabel}</span></h3>
        {view.model.keepCurrent && <p className="why-line">Keep the current model? <b>{view.model.keepCurrent.p.toFixed(2)}</b>{view.model.keepCurrent.outcome}</p>}
        <ProbabilityOptions section={view.model} />
        {view.model.preferredLine && <p className="why-line">{view.model.preferredLine}</p>}
        {!!view.model.excluded.length && <ul className="why-rank">{view.model.excluded.map(row => <li className="excluded" key={row.id}>{row.text}</li>)}</ul>}
      </section>}
      {view.effort && <section className="why-section"><h3>Effort <span className="why-source">{view.effort.sourceLabel}</span></h3>
        {view.effort.mapping && <p className="why-line">{view.effort.mapping.requested} → <b>{view.effort.mapping.effective}</b> ({view.effort.mapping.reason})</p>}
        <ProbabilityOptions section={view.effort} />
      </section>}
      {!!view.notices.length && <section className="why-section">{view.notices.map((notice, i) => <p className="notice" key={i}>{notice.text}
        {notice.action && <button className="text-button" onClick={() => props.navigate(notice.action!.href)}>{notice.action.label}</button>}
      </p>)}</section>}
      {view.memory && <section className="why-section"><section className="why-memory" aria-label="Memory selection"><h3>Memory</h3>
        <p className="muted small-text">{view.memory.sourceLabel}</p><h4>Chosen memory</h4>
        {view.memory.chosen.length ? <ul aria-label="Chosen memory">{view.memory.chosen.map(note => <li key={note}>{note}</li>)}</ul> : <p>No memory notes were selected.</p>}
        <details><summary>Candidates ({view.memory.candidates.length})</summary>
          {view.memory.candidates.length ? <ul aria-label="Memory candidates">{view.memory.candidates.map(note => <li key={note.id}>{note.id}{note.selected ? ' · chosen' : ''}{note.score === null ? '' : ` · score ${note.score}`}</li>)}</ul> : <p>No candidate notes were found.</p>}
        </details>
      </section></section>}
      <section className="why-section"><h3>Corrections used</h3>
        {!view.corrections.length ? <p className="why-line">None</p> : view.corrections.map(row => <div className="why-correction" key={row.id}>
          <p>{!row.unavailable && <><strong>{row.heading}</strong> · </>}{row.line}</p>{row.context && <p className="muted small-text">{row.context}</p>}
        </div>)}
      </section>
      {view.accounts && <section className="why-section"><h3>Account</h3><ul className="why-rank">{view.accounts.map(row => <li key={row.id} className={row.selected ? 'chosen' : row.excluded ? 'excluded' : ''}>{row.label}: {row.reason}{row.selected ? ' · selected' : ''}</li>)}</ul></section>}
      <section className="why-section why-jev"><h3>Jev</h3>
        {view.jev.model ? <><p>{view.jev.model} · {view.jev.latencyMs} ms</p>{view.jev.calls.map((call, i) => <p key={i}>{call.label} · {call.model} · {call.tokens} tokens · {call.latencyMs} ms</p>)}</> : <p>{view.jev.noCallLine}</p>}
        <p>{dateTime(view.at)}</p>
      </section>
    </>}
  </Panel>;
}

type Draft = Record<'action' | 'modelId' | 'effort', string>;
type SaveRequest = NonNullable<StepCorrectionEditor['requests']['noted']>;
export function ConversationCorrectionDialog({ step, view, props, update, close }: { step: { n: number }; view: View; props: PageProps; update(value: View): void; close(): void }) {
  const id = view.conversation.id, key = `${id}/${step.n}`;
  const [model, setModel] = useState<StepCorrectionEditor>(), [draft, setDraft] = useState<Draft>(), [loading, setLoading] = useState(false), [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false), [retry, setRetry] = useState(false), [reload, setReload] = useState(0);
  const task = useTask(props.onError), epoch = useRef(0), context = useRef(''), raw = useRef<Draft | undefined>(undefined);
  const pending = useRef<{ key: string; body: SaveRequest } | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(), stamp = ++epoch.current;
    const same = context.current === key; context.current = key;
    if (!same) { raw.current = undefined; pending.current = undefined; setDraft(undefined); setRetry(false); setConfirm(false); }
    setLoading(true); setError(undefined);
    void api(`/api/conversations/${id}/step-editor/${step.n}`, StepCorrectionEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })
      .then(async initial => {
        if (controller.signal.aborted) throw new DOMException('Editor closed.', 'AbortError');
        if (initial.conversationId !== id || initial.stretch !== step.n || initial.preview.path !== `/api/conversations/${id}/step-preview`) throw new Error('The returned editor belongs to another step.');
        return raw.current && same ? api(initial.preview.path, StepCorrectionEditorSchema, 'POST', { ...initial.preview.request, fields: raw.current }, { signal: controller.signal, waitForHub: true }) : initial;
      })
      .then(value => { if (controller.signal.aborted || stamp !== epoch.current) return; if (value.conversationId !== id || value.stretch !== step.n) throw new Error('The returned editor belongs to another step.'); setModel(value); setDraft(value.fields); raw.current = value.fields; })
      .catch(cause => { if (!controller.signal.aborted && stamp === epoch.current && !isCancelled(cause)) { setError(cause instanceof Error ? cause.message : 'Could not read this editor.'); props.onError(cause); } })
      .finally(() => { if (!controller.signal.aborted && stamp === epoch.current) setLoading(false); });
    return () => { ++epoch.current; controller.abort(); };
  }, [id, key, step.n, view.conversation.generation, props.data.config.revision, props.onError, reload]);
  const change = (field: keyof Draft, value: string) => void task.run(async signal => {
    if (!model || !draft) return;
    const previous = draft, next = { ...draft, [field]: value }, stamp = epoch.current;
    setDraft(next); raw.current = next; setConfirm(false); setError(undefined); setRetry(false); pending.current = undefined;
    try {
      const result = await api(model.preview.path, StepCorrectionEditorSchema, 'POST', { ...model.preview.request, fields: next }, { signal, waitForHub: true });
      if (stamp !== epoch.current || signal.aborted) return;
      if (result.conversationId !== id || result.stretch !== step.n) throw new Error('The returned editor belongs to another step.');
      setModel(result); setDraft(result.fields); raw.current = result.fields;
    } catch (cause) { if (stamp !== epoch.current || signal.aborted) return; setDraft(previous); raw.current = previous; throw cause; }
  });
  const save = (body: SaveRequest) => void task.run(async signal => {
    pending.current = { key, body }; setRetry(false); setError(undefined);
    try { const result = await api(`/api/conversations/${id}/correct`, ConversationPublicSchema, 'POST', body, { signal, waitForHub: true }); pending.current = undefined; update(result); close(); }
    catch (cause) { if (!signal.aborted) { setRetry(true); setError(cause instanceof Error ? cause.message : 'Could not save this correction.'); } throw cause; }
  });
  const bound = model?.conversationId === id && model.stretch === step.n;
  return <Modal title="Change this step" close={close}>
    {error && <p className="notice" role="alert">{error}</p>}
    {retry && pending.current?.key === key && <div className="actions"><button disabled={task.busy} onClick={() => save(pending.current!.body)}>Retry correction</button><button className="secondary" disabled={task.busy} onClick={() => { pending.current = undefined; setRetry(false); setReload(value => value + 1); }}>Reload choices</button></div>}
    {loading && <p className="muted" role="status">Loading choices…</p>}
    {bound && draft && <>
      {model.consequences.externalNotice && <p className="notice">{model.consequences.externalNotice}</p>}
      {model.refusal && <p className="notice">{model.refusal}</p>}
      {confirm ? <><p>{model.consequences.redoText}</p>{model.consequences.newerWorkText && <p className="muted">{model.consequences.newerWorkText}</p>}<p className="muted">{model.consequences.guardNote}</p>
        <div className="actions"><button disabled={task.busy || loading || !model.canRedo} onClick={() => { if (model.requests.redo) save(model.requests.redo); }}>{task.busy ? 'Stopping and undoing…' : 'Undo and redo'}</button><button className="secondary" disabled={task.busy} onClick={() => setConfirm(false)}>Back</button></div>
      </> : <><p>Step {step.n}</p>
        <label>Action<select disabled={task.busy || loading} value={draft.action} onChange={event => change('action', event.target.value)}>{model.actionChoices.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></label>
        <label>Model<select disabled={task.busy || loading} value={draft.modelId} onChange={event => change('modelId', event.target.value)}>{model.modelChoices.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></label>
        <label>Effort<select disabled={task.busy || loading} value={draft.effort} onChange={event => change('effort', event.target.value)}>{model.effortChoices.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></label>
        <div className="actions"><button disabled={task.busy || loading || !model.canRedo} onClick={() => setConfirm(true)}>Override and undo</button><button className="secondary" disabled={task.busy || loading || !model.canNoted} onClick={() => { if (model.requests.noted) save(model.requests.noted); }}>Just override</button></div>
      </>}
    </>}
  </Modal>;
}
