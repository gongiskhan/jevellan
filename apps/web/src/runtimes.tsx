import { AccountForm, ReplaceKey } from './account-editor.js';
import { clientId } from './client-id.js';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  AccountViewSchema, ConfigRevisionSchema, type RuntimeSettingsRow, type RuntimeSettingsSave,
  AccountsSettingsViewSchema, ACCOUNT_VIEW_REFRESH_MS, type AccountsSettingsView, type AccountSettingsRow,
  LoginViewSchema,
  type AccountView,
} from '@jevellan/core/client';
import { api, empty, isCancelled } from './api.js';
import {
  Modal,
  SectionHeading,
  dateTime,
  useRequestId,
  useSettingsSave,
  useTask,
  type PageProps,
} from './components.js';

type Login = z.infer<typeof LoginViewSchema>;
function Usage({ windows }: { windows: AccountSettingsRow['usage'] }) {
  return <div className="usage-windows">{windows.map(window => <div className="usage" key={window.key}>
    <div><span>{window.label}</span><span>{window.valueLabel}</span></div>
    <progress aria-label={`${window.label} usage`} max={100} value={window.value ?? 0} />
    {window.resetAt && <small>{window.resetLabel} {dateTime(window.resetAt)}</small>}
  </div>)}</div>;
}
function LoginPanel({ initial, props, close, readRow }: { initial: Login; props: PageProps; close(): void; readRow: AccountSettingsRow | undefined }) {
  const save = useSettingsSave();
  const [login, setLogin] = useState(initial);
  const [code, setCode] = useState('');
  const [requestError, setRequestError] = useState('');
  const reportError = (error: unknown) =>
    setRequestError(error instanceof Error ? error.message : 'Sign-in could not complete. Try again.');
  const task = useTask(reportError);
  const closing = useTask(reportError);
  const requestId = useRequestId();
  const loginPath = `/api/logins/${login.id}${login.deviceId === props.data.devices.currentDeviceId ? '' : `?deviceId=${encodeURIComponent(login.deviceId)}`}`;
  useEffect(() => {
    if (!['pending', 'checking'].includes(login.state)) return;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api(loginPath, LoginViewSchema, 'GET', undefined, {
          signal: controller.signal,
          waitForHub: true,
        });
        if (!active) return;
        if (next.state === 'done') await props.reload(controller.signal);
        if (active) {
          setRequestError('');
          setLogin(next);
        }
      } catch (error) {
        if (active && !isCancelled(error)) {
          setRequestError(error instanceof Error ? error.message : 'Could not check sign-in. Retrying…');
          timer = setTimeout(() => void poll(), 2000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [login, loginPath, props.reload]);
  const startAgain = () =>
    task.run(async (signal) => {
      setRequestError('');
      await api(loginPath, LoginViewSchema, 'DELETE', empty, { signal, waitForHub: true });
      const path = `/api/accounts/${login.accountId}/login${login.deviceId === props.data.devices.currentDeviceId ? '' : `?deviceId=${encodeURIComponent(login.deviceId)}`}`;
      const next = await api(
        path,
        LoginViewSchema,
        'POST',
        { schema: 'login-start-v1', clientRequestId: requestId({ previousLoginId: login.id }) },
        { signal, waitForHub: true },
      );
      if (next.accountId !== login.accountId || next.deviceId !== login.deviceId)
        throw new Error('The login returned for a different account or device. Reload Settings.');
      setCode('');
      setLogin(next);
    });
  const account = props.data.accounts.find((view) => view.account.id === login.accountId);
  const availability = readRow?.devices.find(device => device.id === login.deviceId)?.availability ?? readRow?.availability;
  return (
    <Modal
      title={`Log in · ${account?.account.label ?? 'Account'}`}
      close={() => {
        if (!['pending', 'checking'].includes(login.state)) {
          close();
          return;
        }
        void closing.run(async (signal) => {
          await api(loginPath, LoginViewSchema, 'DELETE', empty, { signal, waitForHub: true });
          close();
        });
      }}
    >
      {login.deviceId !== props.data.devices.currentDeviceId && (
        <p className="muted">
          On{' '}
          {props.data.devices.devices.find((device) => device.id === login.deviceId)?.name ??
            'the selected device'}
        </p>
      )}
      {login.state === 'done' ? (
        <div className="success" role="status">
          {account?.account.identity?.email
            ? `Signed in as ${account.account.identity.email}`
            : 'Signed in successfully.'}
          {availability && <p>{availability.label}.</p>}
          {account && !account.account.enabled && <>
            <p>Sign-in saved your credentials. Enable this account to let Jevellan use it.</p>
            <button disabled={task.busy} onClick={() => void task.run(async signal => {
              await save(`/hub/accounts/${account.account.id}`, AccountViewSchema, 'PATCH', {
                schema: 'update-account-v1', revision: account.revision, label: account.account.label, enabled: true,
                ceilingPct: account.account.ceilingPct, ...(account.account.paidUse ? { paidUse: account.account.paidUse } : {}),
              }, signal);
              await props.reload(signal);
            })}>Enable account</button>
          </>}
        </div>
      ) : (
        <>
          {login.state === 'pending' && (
            <>
              <p>{login.instructions}</p>
              {login.url ? (
                <a className="button-link" href={login.url} target="_blank" rel="noreferrer">
                  Open sign-in page ↗
                </a>
              ) : (
                <p className="muted">Preparing the sign-in link…</p>
              )}
            </>
          )}
          {login.userCode && (
            <div className="verification-code">
              <span>Verification code</span>
              <strong>{login.userCode}</strong>
            </div>
          )}
          {login.acceptsCode && login.state === 'pending' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void task.run(async (signal) => {
                  try {
                    const next = await api(
                      loginPath,
                      LoginViewSchema,
                      'POST',
                      { schema: 'login-code-v1', code },
                      { signal, waitForHub: true },
                    );
                    setLogin(next);
                    if (next.state === 'done') await props.reload(signal);
                  } finally {
                    setCode('');
                  }
                });
              }}
            >
              <label>
                {account?.account.runtime === 'codex' ? 'Callback address' : 'Authorization code'}
                <input
                  required
                  type="password"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <button disabled={task.busy}>Continue</button>
            </form>
          )}
          {login.state === 'pending' && !login.acceptsCode && !login.userCode && login.url && (
            <p role="status">Code sent. Waiting for sign-in to finish…</p>
          )}
          {login.error && (
            <p role="alert" className="error">
              {login.error}
            </p>
          )}
          {login.state === 'checking' && <p role="status">Checking the account…</p>}
          {(login.state === 'failed' ||
            login.state === 'cancelled' ||
            (login.state === 'pending' && !login.acceptsCode && !login.userCode)) && (
            <button
              className="secondary"
              disabled={task.busy || closing.busy}
              onClick={() => void startAgain()}
            >
              Start again
            </button>
          )}
        </>
      )}
      {requestError && (
        <p role="alert" className="error">
          {requestError}
        </p>
      )}
    </Modal>
  );
}
export function RuntimesPage(props: PageProps & { embedded?: boolean }) {
  const [settingsView, setSettingsView] = useState<AccountsSettingsView>();
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshMs = ACCOUNT_VIEW_REFRESH_MS;
    const refresh = async () => {
      try {
        const next = await api('/api/accounts/view', AccountsSettingsViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true });
        if (!controller.signal.aborted) { refreshMs = next.refreshMs; setSettingsView(next); }
      } catch (error) { if (!controller.signal.aborted) props.onError(error); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), refreshMs); }
    };
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [props.data.accounts, props.data.runtimes, props.data.offered, props.data.roster, props.onError]);
  const save = useSettingsSave();
  const { data } = props;
  const runtimeRequestId = useRequestId();
  const [adding, setAdding] = useState<string>();
  const [editing, setEditing] = useState<AccountView>();
  const [replacing, setReplacing] = useState<AccountView>();
  const [login, setLogin] = useState<Login>();
  const task = useTask(props.onError);
  const begin = async (id: string, signal: AbortSignal, deviceId = data.devices.currentDeviceId) => {
    const result = await api(
      `/api/accounts/${id}/login${deviceId === data.devices.currentDeviceId ? '' : `?deviceId=${encodeURIComponent(deviceId)}`}`,
      LoginViewSchema,
      'POST',
      { schema: 'login-start-v1', clientRequestId: `login_${clientId()}` },
      { signal, waitForHub: true },
    );
    if (result.deviceId !== deviceId || result.accountId !== id)
      throw new Error('The login returned for a different account or device. Reload Settings.');
    setLogin(result);
  };
  const updateRuntime = (row: RuntimeSettingsRow, patch: RuntimeSettingsSave['patch']) => task.run(async signal => {
    const body = { ...row.write.body, patch };
    await api(row.write.path, ConfigRevisionSchema, row.write.method, { ...body, clientRequestId: `runtime_${runtimeRequestId(body)}` }, { signal, waitForHub: true });
    await props.reload(signal); props.message(row.savedNotice);
  });
  const openedAccount = useRef(false);
  useEffect(() => {
    if (openedAccount.current) return;
    const query = new URLSearchParams(window.location.search);
    const view = data.accounts.find((entry) => entry.account.id === query.get('account'));
    if (!view) return;
    openedAccount.current = true;
    const card = document.getElementById(`account-${view.account.id}`);
    card?.scrollIntoView({ block: 'center' });
    card?.focus({ preventScroll: true });
    if (query.get('login') === '1') {
      if (view.account.kind === 'api-key') setReplacing(view);
      else void task.run((signal) => begin(view.account.id, signal));
    }
  }, [data.accounts, task]);
  return (
    <>
      {!props.embedded && (
        <>
          <SectionHeading title="Runtimes" />
          <p className="intro">Choose the runtimes and accounts your agents can use.</p>
        </>
      )}
      {data.runtimes.map((runtime) => {
        const settings = data.runtimeSettings?.rows.find(row => row.id === runtime.id);
        return (
        <section className="card runtime-card" key={runtime.id}>
          <div className="card-heading">
            <div>
              <h2>{runtime.displayName}</h2>
              <p className="muted">
                {runtime.capabilities.readOnlyEnforced
                  ? 'Read-only actions enforced'
                  : 'Read-only actions unavailable'}
              </p>
            </div>
            {settings && <label className="toggle">
              <input type="checkbox" aria-label={settings.enabled.ariaLabel} checked={settings.enabled.checked} disabled={task.busy}
                onChange={event => { void updateRuntime(settings, { enabled: event.target.checked }); }} />
              <span>{settings.enabled.label}</span>
            </label>}

          </div>
          {settings && <label className="runtime-cache-window">{settings.cache.label}
            <input type="number" min={settings.cache.min} max={settings.cache.max} step={settings.cache.step} aria-label={settings.cache.ariaLabel}
              key={settings.cache.value} defaultValue={settings.cache.value} disabled={task.busy} onBlur={event => {
                if (!event.currentTarget.validity.valid || !event.currentTarget.value) return;
                void updateRuntime(settings, { cacheWindowMinutes: event.currentTarget.value });
              }} />
          </label>}
          {settings?.ownSetup && <div className="native-setup">
            <label className="toggle"><input type="checkbox" aria-label={settings.ownSetup.label} checked={settings.ownSetup.checked} disabled={task.busy}
              onChange={event => { void updateRuntime(settings, { useOwnSetup: event.target.checked }); }} /><span>{settings.ownSetup.label}</span></label>
            <p className="muted">{settings.ownSetup.help}</p>
            <details><summary>{settings.ownSetup.inventoryTitle}</summary>{settings.ownSetup.lines.map((line, index) => <p key={index} className="muted">{line}</p>)}</details>
          </div>}
          <div className="model-chips">
            {settingsView?.runtimes.find(row => row.id === runtime.id)?.models.map(model => <span className="chip" key={model.id} title={model.title}>{model.label}</span>)}
            {settingsView?.runtimes.find(row => row.id === runtime.id)?.emptyModelsText && <span className="muted">{settingsView.runtimes.find(row => row.id === runtime.id)!.emptyModelsText}</span>}
          </div>
          <div className="subheading">
            <h3>Accounts</h3>
            <button className="secondary small" onClick={() => setAdding(runtime.id)}>
              Add account
            </button>
          </div>
          {settingsView?.runtimes.find(row => row.id === runtime.id)?.accounts.map(row => {
              const view = row.view, account = view.account, availability = row.availability;
              return (
                <article className="account" id={`account-${account.id}`} tabIndex={-1} key={account.id}>
                  <div className="account-heading">
                    <div>
                      <strong>{account.label}</strong>
                      <span className="muted">
                        {row.kindLabel}{row.secretLine && ` · ${row.secretLine}`}
                      </span>
                    </div>
                    <span className={`status status-${availability.tone}`}>
                      <i />
                      {availability.label}
                    </span>
                  </div>
                  {row.usage.length > 0 && <Usage windows={row.usage} />}
                  {row.usageCheckedAt && <p className="muted small-text">{row.usageCheckedLabel} {dateTime(row.usageCheckedAt)}</p>}
                  {row.paidUseLine && <p className="muted small-text">{row.paidUseLine}</p>}
                  {row.notices.map(notice => <p className="notice" key={notice.id}>{notice.text}{notice.at && dateTime(notice.at)}{notice.suffix}</p>)}
                  <div className="actions">
                    {account.kind === 'subscription' && account.credential !== 'per-device' && (
                      <button
                        className="secondary small"
                        disabled={task.busy}
                        onClick={() => void task.run((signal) => begin(account.id, signal))}
                      >
                        Log in
                      </button>
                    )}
                    <button
                      className="secondary small"
                      disabled={task.busy}
                      onClick={() =>
                        void task.run(async (signal) => {
                          await api(`/api/accounts/${account.id}/check`, AccountViewSchema, 'POST', empty, {
                            signal,
                            waitForHub: true,
                          });
                          await props.reload(signal);
                        })
                      }
                    >
                      Check now
                    </button>
                    <button className="text-button" onClick={() => setEditing(view)}>
                      Edit
                    </button>
                    {account.kind === 'api-key' && (
                      <button className="text-button" onClick={() => setReplacing(view)}>
                        Replace key
                      </button>
                    )}
                    <button
                      className="text-button"
                      disabled={task.busy}
                      onClick={() =>
                        void task.run(async (signal) => {
                          await save(
                            `/hub/accounts/${account.id}`,
                            AccountViewSchema,
                            'PATCH',
                            {
                              schema: 'update-account-v1',
                              revision: view.revision,
                              label: account.label,
                              enabled: !account.enabled,
                              ceilingPct: account.ceilingPct,
                              ...(account.paidUse ? { paidUse: account.paidUse } : {}),
                            },
                            signal,
                          );
                          await props.reload(signal);
                        })
                      }
                    >
                      {account.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                  {row.devices.length > 0 && <div className="device-grid">
                    {row.devices.map(device => <div key={device.id}>
                      <span>{device.name}</span><span className={`status status-${device.availability.tone}`}><i />{device.availability.label}</span>
                      <button className="text-button" disabled={!device.available || task.busy} onClick={() => void task.run(signal => begin(account.id, signal, device.id))}>{device.loginLabel}</button>
                    </div>)}
                    {row.deviceNote && <p className="muted small-text">{row.deviceNote}</p>}
                  </div>}
                </article>
              );
            })}
          {settingsView && !settingsView.runtimes.find(row => row.id === runtime.id)?.accounts.length && (
            <p className="empty-inline">No accounts added yet.</p>
          )}
          <button
            className="text-button"
            onClick={() => props.navigate(`/settings/rigging?runtime=${runtime.id}`)}
          >
            Rigging for {runtime.displayName} →
          </button>
        </section>);
      })}
      {(adding || editing) && (
        <AccountForm
          runtime={adding ?? editing!.account.runtime}
          {...(editing ? { existing: editing } : {})}
          onError={props.onError}
          close={() => {
            setAdding(undefined);
            setEditing(undefined);
          }}
          done={async (account, startLogin, signal) => {
            await props.reload(signal);
            if (startLogin) await begin(account.account.id, signal);
            setAdding(undefined);
            setEditing(undefined);
          }}
        />
      )}
      {replacing && <ReplaceKey view={replacing} close={() => setReplacing(undefined)} props={props} />}
      {login && <LoginPanel initial={login} props={props} close={() => setLogin(undefined)} readRow={settingsView?.runtimes.flatMap(row => row.accounts).find(row => row.view.account.id === login.accountId)} />}
    </>
  );
}
