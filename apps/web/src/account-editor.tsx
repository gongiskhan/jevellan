import { useEffect, useRef, useState } from 'react';
import { AccountEditorViewSchema, AccountEditorSavedSchema, type AccountEditorView, type AccountEditorFields, type AccountEditorPreview, type AccountView } from '@jevellan/core/client';
import { api } from './api.js';
import { Modal, useRequestId, useTask, type PageProps } from './components.js';
import { EndpointFields } from './endpoint-fields.js';

type Props = { runtime: string; existing?: AccountView; done(account: AccountView, startLogin: boolean, signal: AbortSignal): Promise<void>; close(): void; onError(error: unknown): void; replaceOnly?: boolean };
export function AccountForm(props: Props) { return <AccountEditor {...props} />; }
export function ReplaceKey({ view, close, props }: { view: AccountView; close(): void; props: PageProps }) {
  return <AccountEditor runtime={view.account.runtime} existing={view} replaceOnly close={close} onError={props.onError} done={async (_account, _startLogin, signal) => { await props.reload(signal); close(); }} />;
}
function AccountEditor({ runtime, existing, done, close, onError, replaceOnly = false }: Props) {
  const [template, setTemplate] = useState<AccountEditorView>(), [view, setView] = useState<AccountEditorView>(), [fields, setFields] = useState<AccountEditorFields>();
  const [credential, setCredential] = useState(''), [confirmedBody, setConfirmedBody] = useState<string>(), [commandBusy, setCommandBusy] = useState(false);
  const generation = useRef(0), previewController = useRef<AbortController | undefined>(undefined), callbacks = useRef({ onError }); callbacks.current = { onError };
  const task = useTask(onError), requestId = useRequestId();
  const readPath = `/api/accounts/editor?runtime=${encodeURIComponent(runtime)}${existing ? `&accountId=${encodeURIComponent(existing.account.id)}&mode=${replaceOnly ? 'replace-key' : 'edit'}` : ''}`;
  const load = async (signal: AbortSignal) => {
    const next = await api(readPath, AccountEditorViewSchema, 'GET', undefined, { signal, waitForHub: true });
    if (!signal.aborted) { setTemplate(next); setView(next); setFields(next.fields); setConfirmedBody(undefined); }
  };
  useEffect(() => {
    const controller = new AbortController();
    void api(readPath, AccountEditorViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(next => { if (!controller.signal.aborted) { setTemplate(next); setView(next); setFields(next.fields); setConfirmedBody(undefined); } }).catch(error => { if (!controller.signal.aborted) callbacks.current.onError(error); });
    return () => { controller.abort(); previewController.current?.abort(); };
  }, [readPath]);
  const body = template && fields ? JSON.stringify({ schema: 'account-editor-preview-v1', context: template.context, fields, credentialPresent: Boolean(credential) }) : null;
  useEffect(() => {
    if (!body || commandBusy) return;
    const controller = new AbortController(), epoch = ++generation.current; previewController.current?.abort(); previewController.current = controller;
    void api('/api/accounts/editor/preview', AccountEditorViewSchema, 'POST', JSON.parse(body), { signal: controller.signal, waitForHub: true }).then(next => {
      if (!controller.signal.aborted && generation.current === epoch) { setView(next); setConfirmedBody(body); }
    }).catch(error => { if (!controller.signal.aborted) callbacks.current.onError(error); });
    return () => controller.abort();
  }, [body, commandBusy]);
  const command = (value: NonNullable<AccountEditorPreview['command']>) => {
    if (!template || !fields || commandBusy) return;
    const controller = new AbortController(), epoch = ++generation.current; previewController.current?.abort(); previewController.current = controller;
    let present = Boolean(credential); setCommandBusy(true); setConfirmedBody(undefined);
    if (value.kind === 'select-kind') { present = false; setCredential(''); setFields({ ...fields, kind: value.value }); }
    void api(template.request.previewPath, AccountEditorViewSchema, 'POST', { schema: 'account-editor-preview-v1', context: template.context, fields, credentialPresent: present, command: value }, { signal: controller.signal, waitForHub: true }).then(next => {
      if (!controller.signal.aborted && generation.current === epoch) { setFields(next.fields); setView(next); }
    }).catch(error => { if (!controller.signal.aborted) callbacks.current.onError(error); }).finally(() => { if (!controller.signal.aborted && generation.current === epoch) setCommandBusy(false); });
  };
  const edit = (patch: Partial<AccountEditorFields>) => { setFields(current => current && { ...current, ...patch }); };
  const confirmed = Boolean(view && body && confirmedBody === body), blocked = task.busy || commandBusy;
  const password = view && <label>{view.credential.label}<input type="password" autoComplete="off" autoFocus={!view.showDetails} required={view.credential.required} maxLength={view.credential.maxLength} disabled={blocked} value={credential} onChange={event => setCredential(event.target.value)} /></label>;
  return <Modal title={view?.title ?? 'Account'} close={close}>
    {!view || !fields || !template ? <p role="status">Loading account…</p> : <form onSubmit={event => {
      event.preventDefault(); if (!confirmed || !view.canSave) return;
      void task.run(async signal => {
        try {
          const draft = { schema: 'account-editor-save-v1', context: template.context, fields, ...(credential ? { credential } : {}) };
          const saved = await api(view.request.savePath, AccountEditorSavedSchema, 'POST', { ...draft, clientRequestId: requestId(draft) }, { signal, waitForHub: true });
          await done(saved.account, saved.startLogin, signal);
        } finally { setCredential(''); }
      });
    }}>
      {view.showDetails && <>
        <label>{view.inputs.label.label}<input autoFocus required maxLength={view.inputs.label.maxLength} placeholder={view.inputs.label.placeholder} disabled={blocked} value={fields.label} onChange={event => edit({ label: event.target.value })} /></label>
        {view.inputs.kind.visible && <label>{view.inputs.kind.label}<select disabled={blocked} value={fields.kind} onChange={event => command({ kind: 'select-kind', value: event.target.value as AccountEditorFields['kind'] })}>{view.inputs.kind.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
      </>}
      {view.credential.notice && <p className="notice">{view.credential.notice}</p>}
      {view.endpoint.visible && <EndpointFields value={fields.endpoint} metadata={view.endpoint} disabled={blocked} change={endpoint => edit({ endpoint })} command={command} />}
      {view.credential.visible && (view.credential.detailsLabel ? <details><summary>{view.credential.detailsLabel}</summary>{password}</details> : password)}
      {view.credential.help && <p className="muted">{view.credential.help}</p>}
      {view.paid.visible && <label>{view.paid.label}<select disabled={blocked} required value={fields.paidUse} onChange={event => edit({ paidUse: event.target.value as AccountEditorFields['paidUse'] })}><option value="" disabled>{view.paid.emptyLabel}</option>{view.paid.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
      {view.showDetails && <label>{view.inputs.ceiling.label}<input type="number" required min={view.inputs.ceiling.min} max={view.inputs.ceiling.max} step={view.inputs.ceiling.step} disabled={blocked} value={fields.ceilingPct} onChange={event => edit({ ceilingPct: event.target.value })} /></label>}
      {view.staleNotice && <p className="notice">{view.staleNotice} <button type="button" className="text-button" disabled={blocked} onClick={() => void task.run(async signal => { setCredential(''); await load(signal); })}>{view.reloadLabel}</button></p>}
      {confirmed && view.validation.map((item, index) => <p role="status" className="error" key={`${item.field}:${index}`}>{item.message}</p>)}
      <div className="form-actions"><button type="button" className="secondary" onClick={close}>{view.cancelLabel}</button><button disabled={blocked || !confirmed || !view.canSave}>{task.busy ? view.busyLabel : view.submitLabel}</button></div>
    </form>}
  </Modal>;
}
