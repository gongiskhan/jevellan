import { clientId } from './client-id.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  RiggingDiskCancelledSchema,
  RiggingDiskDetailSchema,
  RiggingDiskListSchema,
  RiggingDiskResultSchema,
  RiggingPromotionInputSchema,
  RiggingSaveSchema,
  type RiggingDiskItem,
} from '@jevellan/core/client';
import { api, isCancelled } from './api.js';
import { dateTime, Markdown, Modal, useTask, type PageProps } from './components.js';

type Detail = z.infer<typeof RiggingDiskDetailSchema>;
const route = (item: Pick<RiggingDiskItem, 'runtime' | 'accountId' | 'id'>) =>
  `/api/rigging/homes/${item.runtime}/${item.accountId}/${item.id}`;
type PromotionInput = z.infer<typeof RiggingPromotionInputSchema>;
function MakeManaged({
  item,
  props,
  promote,
  close,
}: {
  item: RiggingDiskItem;
  props: PageProps;
  promote(input: PromotionInput, signal: AbortSignal): Promise<void>;
  close(): void;
}) {
  const [name, setName] = useState(item.name);
  const [runtimes, setRuntimes] = useState<Record<string, boolean>>({ [item.runtime]: true });
  const [requestId] = useState(() => `promote_${clientId()}`);
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
          {props.data.runtimes.map((runtime) => (
            <label className="toggle" key={runtime.id}>
              <input
                type="checkbox"
                checked={runtimes[runtime.id] ?? false}
                disabled={
                  submitted || runtime.id === item.runtime || !runtime.riggingKinds.includes(item.kind)
                }
                onChange={(event) => setRuntimes({ ...runtimes, [runtime.id]: event.target.checked })}
              />
              {runtime.displayName}
              {!runtime.riggingKinds.includes(item.kind)
                ? ' · Not supported'
                : runtime.id === item.runtime
                  ? ' · Current account'
                  : ''}
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
      !saved.current.item.editable ||
      (!pending.current && latest.current === saved.current.content)
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
            { schema: 'rigging-disk-write-v1', fingerprint: saved.current.item.fingerprint, content: value },
            { signal: controller.signal, waitForHub: true },
          );
          saved.current = next;
          if (active.current) {
            setDetail(next);
            setStatus('Saved');
          }
          // JSON is formatted by the server. Retain newer typing, otherwise use its exact saved representation.
          if (latest.current === value) {
            latest.current = next.content;
            if (active.current) setDraft(next.content);
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
    if (!detail.item.editable || draft === saved.current.content) return;
    setStatus('Unsaved changes');
    const timer = setTimeout(() => void flushRef.current().catch(() => undefined), 600);
    return () => clearTimeout(timer);
  }, [draft, detail.item.editable]);
  const label =
    props.data.accounts.find((view) => view.account.id === detail.item.accountId)?.account.label ??
    detail.item.accountId;
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
        {label} · {detail.item.runtime === 'claude' ? 'Claude Code' : 'Codex'} ·{' '}
        {detail.item.state === 'owned'
          ? 'Installed copy'
          : detail.item.state === 'parked'
            ? 'Parked on this device'
            : 'Loose local item'}
      </p>
      <p className="rigging-ref">{detail.item.address.ref}</p>
      {detail.item.fileCount > 1 && (
        <p className="muted small-text">
          This bundle has {detail.item.fileCount} files. Editing changes its instructions; parking preserves
          the whole bundle.
        </p>
      )}
      {detail.item.state === 'owned' && (
        <p className="notice">
          Edit the local item or package that installs this copy. Its delivered content is read-only here.
        </p>
      )}
      {detail.item.problem && <p className="notice">{detail.item.problem}</p>}
      {detail.redacted && <p className="notice">Credentials are hidden. This content is read-only.</p>}
      <div className="subheading">
        <span role="status" className="muted">
          {detail.item.editable ? status : 'Read-only'}
        </span>
        <button className="text-button" onClick={() => setPreview(!preview)}>
          {preview ? 'Source' : 'Preview'}
        </button>
      </div>
      {preview || !detail.item.editable ? (
        detail.format === 'markdown' ? (
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
      {detail.item.editable && (
        <p className="muted small-text">Local edits save automatically on this account.</p>
      )}
      {status === 'Not saved' && (
        <button
          className="secondary"
          onClick={() =>
            void api(route(detail.item), RiggingDiskDetailSchema)
              .then((next) => {
                saved.current = next;
                latest.current = next.content;
                setDetail(next);
                setDraft(next.content);
                setStatus('Saved');
                props.message('Current file reloaded. The unsaved draft was discarded.');
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
  const [inventory, setInventory] = useState<z.infer<typeof RiggingDiskListSchema>>();
  const [editing, setEditing] = useState<Detail>();
  const [promoting, setPromoting] = useState<RiggingDiskItem>();
  const [showInstalled, setShowInstalled] = useState(false);
  const task = useTask(props.onError);
  const reload = useCallback(async (signal?: AbortSignal) => {
    setInventory(
      await api('/api/rigging/homes', RiggingDiskListSchema, 'GET', undefined, { signal, waitForHub: true }),
    );
  }, []);
  useEffect(() => {
    let active = true;
    void api('/api/rigging/homes', RiggingDiskListSchema)
      .then((value) => {
        if (active) setInventory(value);
      })
      .catch(props.onError);
    return () => {
      active = false;
    };
  }, [props.data.rigging, props.data.accounts, props.onError]);
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
        { schema: 'rigging-disk-transition-v1', requestId, action, fingerprint: item.fingerprint },
        { signal, waitForHub: true },
      );
      props.message(action === 'park' ? 'Item parked on this device.' : 'Item restored to this account.');
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
      props.message(
        result.application.accounts.some((account) => account.error)
          ? 'Managed item saved. Delivery needs attention.'
          : 'Managed item saved and delivered.',
      );
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
  const filter = new URLSearchParams(window.location.search).get('runtime') ?? '';
  const items =
    inventory?.items.filter(
      (item) =>
        (!filter || filter === item.runtime) && (showInstalled || item.state !== 'owned' || item.drifted),
    ) ?? [];
  return {
    items,
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
          .filter((entry) => !filter || entry.runtime === filter)
          .map((entry, index) => (
            <p role="alert" className="error" key={`${entry.accountId}/${index}`}>
              {label(entry.accountId)}: {entry.message}
            </p>
          ))}
        {inventory?.pending
          .filter((entry) => !filter || entry.runtime === filter)
          .map((entry) => (
            <div className="notice rigging-pending" key={entry.requestId}>
              <span>
                {entry.action === 'park' ? 'Parking' : 'Restoring'} {entry.ref} on {label(entry.accountId)}{' '}
                needs to finish.
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
                    props.message('Current files kept. The pending move was cancelled.');
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
      .filter((entry) => !filter || entry.runtime === filter)
      .map((entry) => (
        <div className="notice rigging-pending" key={entry.request.requestId}>
          <span>
            Making {entry.request.name} managed on {label(entry.accountId)} needs to finish.
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
                  props.message('Current files kept. The pending promotion was cancelled.');
                })
              }
            >
              Keep files as they are
            </button>
          )}
        </div>
      )),
    rows: (kind: string) =>
      items
        .filter((item) => item.kind === kind)
        .map((item) => (
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
                {item.state === 'owned'
                  ? 'Installed copy'
                  : item.state === 'parked'
                    ? item.address.bucket?.startsWith('manual_')
                      ? 'Local · Parked'
                      : 'Package · Parked'
                    : 'Local · Loose'}
                {item.drifted ? ' · Changed outside Rigging' : ''} · {label(item.accountId)} ·{' '}
                {item.runtime === 'claude' ? 'Claude Code' : 'Codex'}
              </span>
              {item.state === 'parked' && (
                <span className="muted small-text">{dateTime(item.updatedAt)}</span>
              )}
            </button>
            {item.canPark && (
              <button
                className="secondary small"
                disabled={task.busy}
                onClick={() => void task.run((signal) => transition(item, 'park', signal))}
              >
                {item.drifted ? 'Park changed copy' : 'Park'}
              </button>
            )}
            {item.state === 'loose' && item.editable && ['skill', 'rule', 'command'].includes(item.kind) && (
              <button className="secondary small" disabled={task.busy} onClick={() => setPromoting(item)}>
                Make managed
              </button>
            )}
            {item.state === 'parked' && (
              <button
                className="secondary small"
                disabled={task.busy}
                onClick={() => void task.run((signal) => transition(item, 'restore', signal))}
              >
                Restore locally
              </button>
            )}
          </div>
        )),
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
        {promoting && (
          <MakeManaged
            item={promoting}
            props={props}
            promote={(input, signal) => promote(promoting, input, signal)}
            close={() => setPromoting(undefined)}
          />
        )}
      </>
    ),
  };
}
