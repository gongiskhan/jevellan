import { useEffect, useState } from 'react';
import { GitHubTokenStateSchema, type GitHubTokenState } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { Confirm, Modal, useSettingsSave, useTask, type PageProps } from './components.js';
import * as copy from './project-work-copy.js';
import { afterDialogs, useLocalError } from './project-work.js';
import { dateOnly, timeStamp } from './time.js';

/**
 * Settings, Git: the GitHub token card (12.4). Only the masked summary ever reaches the browser (D57); the card keeps its
 * own state from the GET, PUT and DELETE answers because the token is not part of the settings data.
 */
export function GitHubToken({ onError, message }: Pick<PageProps, 'onError' | 'message'>) {
  const [state, setState] = useState<GitHubTokenState>();
  const [dialog, setDialog] = useState<'save' | 'remove'>();
  useEffect(() => {
    const controller = new AbortController();
    api('/hub/secrets/github', GitHubTokenStateSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(setState, onError);
    return () => controller.abort();
  }, [onError]);
  const saved = state?.saved ? state : undefined;
  return (
    <section className="card pw-token">
      <h2>{copy.GITHUB_TOKEN}</h2>
      <p className="saved-secret pw-token-summary">
        {!state ? copy.LOADING : saved
          ? <time dateTime={saved.updatedAt} title={timeStamp(saved.updatedAt)?.title}>{copy.savedUpdated(dateOnly(saved.updatedAt))}</time>
          : copy.NOT_SET}
      </p>
      <p className="muted pw-token-help">{copy.GITHUB_TOKEN_HELP}</p>
      <div className="actions pw-token-actions">
        <button type="button" className="secondary" disabled={!state} onClick={() => setDialog('save')}>{saved ? copy.REPLACE : copy.ADD_TOKEN}</button>
        {saved && <button type="button" className="secondary" onClick={() => setDialog('remove')}>{copy.REMOVE}</button>}
      </div>
      {dialog === 'save' && (
        <SaveToken replacing={!!saved} onError={onError} close={() => setDialog(undefined)}
          saved={(next) => { setState(next); setDialog(undefined); afterDialogs(message, copy.TOKEN_SAVED); }} />
      )}
      {dialog === 'remove' && (
        <RemoveToken onError={onError} close={() => setDialog(undefined)}
          removed={(next) => { setState(next); setDialog(undefined); afterDialogs(message, copy.TOKEN_REMOVED); }} />
      )}
    </section>
  );
}

/** Add or Replace: a password field saved through the hub with a request id; the field is cleared whatever happens. */
function SaveToken({ replacing, close, saved, onError }: {
  replacing: boolean; close(): void; saved(state: GitHubTokenState): void; onError(error: unknown): void;
}) {
  const save = useSettingsSave();
  const { error, setError, fail } = useLocalError(onError);
  const task = useTask(fail);
  const [value, setValue] = useState('');
  return (
    <Modal title={replacing ? copy.REPLACE_TOKEN_TITLE : copy.ADD_TOKEN_TITLE} close={close}>
      <form onSubmit={(event) => {
        event.preventDefault();
        void task.run(async (signal) => {
          setError('');
          try {
            saved(await save('/hub/secrets/github', GitHubTokenStateSchema, 'PUT', { schema: 'save-secret-v1', value }, signal));
          } finally {
            setValue('');
          }
        });
      }}>
        <label>
          {copy.GITHUB_TOKEN}
          {/* showModal() focuses the element with the autofocus attribute; React's autoFocus prop does not set it. */}
          <input ref={(element) => element?.setAttribute('autofocus', '')} type="password" autoComplete="off" spellCheck={false} required value={value}
            onChange={(event) => setValue(event.target.value)} />
        </label>
        {replacing && <p className="muted">{copy.TOKEN_REPLACED_NOTE}</p>}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>{copy.CANCEL}</button>
          <button disabled={task.busy || !value}>{task.busy ? copy.SAVING : copy.SAVE_TOKEN}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Remove: a destructive confirmation; removing twice leaves the same state, so the request may wait for the hub. */
function RemoveToken({ close, removed, onError }: { close(): void; removed(state: GitHubTokenState): void; onError(error: unknown): void }) {
  const { error, setError, fail } = useLocalError(onError);
  const task = useTask(fail);
  return (
    <Confirm title={copy.REMOVE_TOKEN_TITLE} action={copy.REMOVE} danger busy={task.busy} close={close}
      confirm={() => void task.run(async (signal) => {
        setError('');
        removed(await api('/hub/secrets/github', GitHubTokenStateSchema, 'DELETE', empty, { signal, waitForHub: true }));
      })}>
      <p className="pw-confirm-body">{copy.REMOVE_TOKEN_BODY}</p>
      {error && <p className="error">{error}</p>}
    </Confirm>
  );
}
