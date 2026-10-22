import { clientId } from './client-id.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  RiggingDiskCancelledSchema,
  RiggingDiskDetailSchema,
  riggingDiskPresentation, RiggingEditorViewSchema, riggingDiskRoute, riggingDiskEditor, riggingDiskSave, riggingDiskSaved, riggingPromotionDefaults, riggingPromotionChoices, riggingMoveInput, riggingMoveMessage, riggingDeliveryStatus, riggingCancelMessage, riggingPendingMessage, riggingPromotionMessage, type RiggingEditorView,
  RiggingDiskResultSchema,
  RiggingPromotionInputSchema,
  RiggingSaveSchema,
  type RiggingDiskItem,
} from '@jevellan/core/client';
import { api, isCancelled } from './api.js';
import { dateTime, Markdown, Modal, useTask, type PageProps } from './components.js';

type Detail = z.infer<typeof RiggingDiskDetailSchema>;
const route = riggingDiskRoute;
type PromotionInput = z.infer<typeof RiggingPromotionInputSchema>;
function MakeManaged({
  item,
  editor,
  props,
  promote,
  close,
}: {
  item: RiggingDiskItem;
  editor: RiggingEditorView;
  props: PageProps;
  promote(input: PromotionInput, signal: AbortSignal): Promise<void>;
  close(): void;
}) {
  const [defaults] = useState(() => riggingPromotionDefaults(item,`promote_${clientId()}`));
  const [name, setName] = useState(defaults.name);
  const [runtimes, setRuntimes] = useState(defaults.runtimes);
  const requestId = defaults.requestId;
  const [submitted, setSubmitted] = useState(false);
  const task = useTask(props.onError);
  return (
    <Modal title="Make managed" close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          void task.run(async (signal) => {
            await promote(
              {
                schema: 'rigging-promotion-input-v1',
                requestId,
                fingerprint: item.fingerprint,
                name,
                runtimes,
              },
              signal,
            );
            close();
          });
        }}
      >
        <p>
          Save this {item.kind} in Rigging, then use its runtime toggles to choose where it is installed.{' '}
          {item.fileCount > 1 && `All ${item.fileCount} files in the bundle are preserved.`}
        </p>
        <label>
          Name
          <input
            autoFocus
            required
            maxLength={128}
            value={name}
            disabled={submitted}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset>
          <legend>Install for</legend>
          {riggingPromotionChoices(item,editor.runtimes,runtimes,submitted).map((runtime) => (
            <label className="toggle" key={runtime.id}>
              <input
                type="checkbox"
                checked={runtime.checked}
                disabled={runtime.disabled}
                onChange={(event) => setRuntimes({ ...runtimes, [runtime.id]: event.target.checked })}
              />
              {runtime.label}{runtime.suffix}
            </label>
          ))}
        </fieldset>
        <p className="muted small-text">
          Instructions stay editable. Bundled files are retained when the instructions change.
        </p>
        <div className="form-actions">
          <button type="button" className="secondary" disabled={task.busy} onClick={close}>
            Close
          </button>
          <button disabled={task.busy}>{task.busy ? 'Saving…' : submitted ? 'Retry' : 'Make managed'}</button>
        </div>
      </form>
    </Modal>
  );
}
function DiskEditor({
  initial,
  props,
  reload,
  close,
}: {
  initial: Detail;
  props: PageProps;
  reload(signal?: AbortSignal): Promise<void>;
  close(): void;
}) {
  const saved = useRef(initial);
  const [detail, setDetail] = useState(initial);
  const [draft, setDraft] = useState(initial.content);
  const latest = useRef(draft);
  const pending = useRef<Promise<void> | undefined>(undefined);
  const active = useRef(true);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState('Saved');
  const request = useRef<AbortController | undefined>(undefined);
  latest.current = draft;
  async function flush(): Promise<void> {
    if (
      !active.current ||
      !riggingDiskSave(saved.current,latest.current) && !pending.current
    )
      return;
    if (pending.current) {
      await pending.current;
      if (latest.current !== saved.current.content) await flush();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const operation = (async () => {
      try {
        while (active.current && latest.current !== saved.current.content) {
          if (active.current) setStatus('Saving…');
          const value = latest.current;
          const next = await api(
            route(saved.current.item),
            RiggingDiskDetailSchema,
            'PUT',
            riggingDiskSave(saved.current,value),
            { signal: controller.signal, waitForHub: true },
          );
          const accepted = riggingDiskSaved(saved.current,value,latest.current,next);
          saved.current = accepted.detail;
          if (active.current) {
            setDetail(next);
            setStatus('Saved');
          }
          // JSON is formatted by the server. Retain newer typing, otherwise use its exact saved representation.
          if (latest.current === value) {
            latest.current = accepted.draft;
            if (active.current) setDraft(accepted.draft);
          }
        }
        if (active.current) await reload(controller.signal);
      } catch (error) {
        if (active.current) setStatus('Not saved');
        if (!isCancelled(error)) props.onError(error);
        throw error;
      }
    })();
    pending.current = operation;
    try {
      await operation;
    } finally {
      if (pending.current === operation) pending.current = undefined;
      if (request.current === controller) request.current = undefined;
    }
  }
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!riggingDiskSave(saved.current,draft)) return;
    setStatus('Unsaved changes');
    const timer = setTimeout(() => void flushRef.current().catch(() => undefined), 600);
    return () => clearTimeout(timer);
  }, [draft, detail.item.editable]);
  const policy = riggingDiskEditor(detail);
  const row = riggingDiskPresentation(detail.item,props.data.accounts.map(view=>({id:view.account.id,runtime:view.account.runtime,label:view.account.label})));
  return (
    <Modal
      title={detail.item.name}
      close={() => {
        if (pending.current) {
          request.current?.abort();
          close();
        } else
          void flush()
            .then(close)
            .catch(() => undefined);
      }}
    >
      <p className="muted">
        {row.accountLabel} · {row.runtimeLabel} · {row.stateLabel}
      </p>
      <p className="rigging-ref">{detail.item.address.ref}</p>
      {policy.notices.map((notice,index)=><p className="notice" key={index}>{notice}</p>)}
      <div className="subheading">
        <span role="status" className="muted save-status">
          {policy.editable ? status : 'Read-only'}
        </span>
        <button className="text-button" onClick={() => setPreview(!preview)}>
          {preview ? 'Source' : 'Preview'}
        </button>
      </div>
      {preview || !policy.editable ? (
        policy.markdown ? (
          <Markdown>{draft}</Markdown>
        ) : (
          <pre>{draft}</pre>
        )
      ) : (
        <label>
          Content
          <textarea
            className="code-editor"
            rows={14}
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
      )}
      {policy.editable && (
        <p className="muted small-text">Local edits save automatically on this account.</p>
      )}
      {status === 'Not saved' && (
        <button
          className="secondary"
          onClick={() =>
            void api(route(detail.item), RiggingDiskDetailSchema)
              .then((next) => {
                const accepted = riggingDiskSaved(saved.current,saved.current.content,saved.current.content,next);
                saved.current = accepted.detail;
                latest.current = accepted.draft;
                setDetail(next);
                setDraft(next.content);
                setStatus('Saved');
                props.message(policy.reloadMessage);
              })
              .catch(props.onError)
          }
        >
          Discard draft and reload
        </button>
      )}
    </Modal>
  );
}

export function useRiggingDisk(props: PageProps) {
  const [view, setView] = useState<RiggingEditorView>();
  const inventory = view?.inventory;
  const [editing, setEditing] = useState<Detail>();
  const [promoting, setPromoting] = useState<RiggingDiskItem>();
  const [showInstalled, setShowInstalled] = useState(false);
  const task = useTask(props.onError);
  const filter = new URLSearchParams(window.location.search).get('runtime') ?? '';
  const endpoint=`/api/rigging/view?showInstalled=${showInstalled}${filter?`&runtime=${encodeURIComponent(filter)}`:''}`;
  const reload = useCallback(async (signal?: AbortSignal) => {setView(await api(endpoint,RiggingEditorViewSchema,'GET',undefined,{signal,waitForHub:true}));},[endpoint]);
  useEffect(() => { const abort=new AbortController();void reload(abort.signal).catch(error=>{if(!isCancelled(error))props.onError(error);});return()=>abort.abort();},[reload,props.data.rigging,props.data.accounts,props.onError]);
  const transition = async (
    item: Pick<RiggingDiskItem, 'runtime' | 'accountId' | 'id' | 'fingerprint'>,
    action: 'park' | 'restore',
    signal: AbortSignal,
    requestId = `rigging_${clientId()}`,
  ) => {
    let cancelled = false;
    try {
      await api(
        route(item),
        RiggingDiskResultSchema,
        'POST',
        riggingMoveInput(item,action,requestId),
        { signal, waitForHub: true },
      );
      props.message(riggingMoveMessage(action));
    } catch (error) {
      cancelled = isCancelled(error);
      throw error;
    } finally {
      if (!cancelled && !signal.aborted) await reload(signal);
    }
  };
  const label = (accountId: string) =>
    props.data.accounts.find((view) => view.account.id === accountId)?.account.label ?? accountId;
  const promote = async (
    item: Pick<RiggingDiskItem, 'runtime' | 'accountId' | 'id'>,
    request: PromotionInput,
    signal: AbortSignal,
  ) => {
    let cancelled = false;
    try {
      const result = await api(`${route(item)}/promote`, RiggingSaveSchema, 'POST', request, {
        signal,
        waitForHub: true,
      });
      props.message(riggingDeliveryStatus(result.application,true));
    } catch (error) {
      cancelled = isCancelled(error);
      throw error;
    } finally {
      if (!cancelled && !signal.aborted) {
        await props.reload(signal);
        await reload(signal);
      }
    }
  };
  const rows=view?.sections.flatMap(section=>section.disk)??[];
  const items=rows.map(row=>row.item);
  return {
    view, items,
    controls: (
      <div className="rigging-discovery-controls">
        <label className="toggle">
          <input
            type="checkbox"
            checked={showInstalled}
            onChange={(event) => setShowInstalled(event.target.checked)}
          />
          Show installed account copies
        </label>
        <button className="text-button" disabled={task.busy} onClick={() => void task.run(reload)}>
          Refresh local items
        </button>
      </div>
    ),
    notices: (
      <>
        {inventory?.errors
          .map((entry, index) => (
            <p role="alert" className="error" key={`${entry.accountId}/${index}`}>
              {label(entry.accountId)}: {entry.message}
            </p>
          ))}
        {inventory?.pending
          .map((entry) => (
            <div className="notice rigging-pending" key={entry.requestId}>
              <span>
                {riggingPendingMessage(entry.action,entry.ref,label(entry.accountId))}
              </span>
              <button
                className="secondary small"
                disabled={task.busy}
                onClick={() =>
                  void task.run((signal) =>
                    transition({ ...entry, id: entry.itemId }, entry.action, signal, entry.requestId),
                  )
                }
              >
                Retry
              </button>
              <button
                className="text-button"
                disabled={task.busy}
                onClick={() =>
                  void task.run(async (signal) => {
                    await api(
                      route({ ...entry, id: entry.itemId }),
                      RiggingDiskCancelledSchema,
                      'PATCH',
                      { schema: 'rigging-disk-cancel-v1', requestId: entry.requestId },
                      { signal, waitForHub: true },
                    );
                    await reload(signal);
                    props.message(riggingCancelMessage());
                  })
                }
              >
                Keep files as they are
              </button>
            </div>
          ))}
      </>
    ),
    promotions: inventory?.promotions
      .map((entry) => (
        <div className="notice rigging-pending" key={entry.request.requestId}>
          <span>
            {riggingPromotionMessage(entry.request.name,label(entry.accountId))}
          </span>
          <button
            className="secondary small"
            disabled={task.busy}
            onClick={() =>
              void task.run((signal) => promote({ ...entry, id: entry.itemId }, entry.request, signal))
            }
          >
            Retry
          </button>
          {entry.canCancel && (
            <button
              className="text-button"
              disabled={task.busy}
              onClick={() =>
                void task.run(async (signal) => {
                  await api(
                    `${route({ ...entry, id: entry.itemId })}/promote`,
                    RiggingDiskCancelledSchema,
                    'PATCH',
                    { schema: 'rigging-disk-cancel-v1', requestId: entry.request.requestId },
                    { signal, waitForHub: true },
                  );
                  await reload(signal);
                  props.message(riggingCancelMessage(true));
                })
              }
            >
              Keep files as they are
            </button>
          )}
        </div>
      )),
    rows: (kind: string) =>
      rows
        .filter((row) => row.item.kind === kind)
        .map((row) => {const item=row.item;return (
          <div className="rigging-row rigging-disk-row" key={item.id} data-state={item.state}>
            <button
              className="item-name"
              onClick={() =>
                void task.run(async (signal) =>
                  setEditing(
                    await api(route(item), RiggingDiskDetailSchema, 'GET', undefined, {
                      signal,
                      waitForHub: true,
                    }),
                  ),
                )
              }
            >
              <strong>{item.name}</strong>
              <span className="muted">
                {row.origin}{row.driftLabel?` · ${row.driftLabel}`:''} · {row.accountLabel} · {row.runtimeLabel}
              </span>
              {item.state === 'parked' && (
                <span className="muted small-text">{dateTime(item.updatedAt)}</span>
              )}
            </button>
            {row.actions.some(action=>action.action==='park') && (
              <button
                className="secondary small"
                disabled={task.busy}
                onClick={() => void task.run((signal) => transition(item, 'park', signal))}
              >
                {row.actions.find(action=>action.action==='park')?.label}
              </button>
            )}
            {row.actions.some(action=>action.action==='promote') && (
              <button className="secondary small" disabled={task.busy} onClick={() => setPromoting(item)}>
                Make managed
              </button>
            )}
            {row.actions.some(action=>action.action==='restore') && (
              <button
                className="secondary small"
                disabled={task.busy}
                onClick={() => void task.run((signal) => transition(item, 'restore', signal))}
              >
                Restore locally
              </button>
            )}
          </div>
        );}),
    editor: (
      <>
        {editing && (
          <DiskEditor
            key={editing.item.id}
            initial={editing}
            props={props}
            reload={reload}
            close={() => setEditing(undefined)}
          />
        )}{' '}
        {promoting && view && (
          <MakeManaged
            item={promoting}
            editor={view}
            props={props}
            promote={(input, signal) => promote(promoting, input, signal)}
            close={() => setPromoting(undefined)}
          />
        )}
      </>
    ),
  };
}
