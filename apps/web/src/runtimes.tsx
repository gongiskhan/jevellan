import { AccountForm, ReplaceKey } from './account-editor.js';
import { clientId } from './client-id.js';
import { useEffect, useRef, useState } from 'react';
import { LoginPanel, PresentedLoginSchema, sameLoginTarget, type PresentedLogin } from './account-login.js';
import {
  AccountViewSchema, ConfigRevisionSchema, type RuntimeSettingsRow, type RuntimeSettingsSave,
  AccountsSettingsViewSchema, ACCOUNT_VIEW_REFRESH_MS, type AccountsSettingsView, type AccountSettingsRow,
  type AccountAction, type AccountLoginAction,
  type AccountView,
} from '@jevellan/core/client';
import { api } from './api.js';
import {
  SectionHeading,
  dateTime,
  useRequestId,
  useSettingsSave,
  useTask,
  type PageProps,
} from './components.js';

function Usage({ windows }: { windows: AccountSettingsRow['usage'] }) {
  return <div className="usage-windows">{windows.map(window => <div className="usage" key={window.key}>
    <div><span>{window.label}</span><span>{window.valueLabel}</span></div>
    <progress aria-label={`${window.label} usage`} max={100} value={window.value ?? 0} />
    {window.resetAt && <small>{window.resetLabel} {dateTime(window.resetAt)}</small>}
  </div>)}</div>;
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
  const [login, setLogin] = useState<PresentedLogin>();
  const task = useTask(props.onError);
  const begin = async (plan: AccountLoginAction, signal: AbortSignal) => {
    const result = sameLoginTarget(await api(plan.path, PresentedLoginSchema, plan.method, { schema: 'login-start-v1', clientRequestId: `login_${clientId()}` }, { signal, waitForHub: true }), plan.expected);
    setLogin(result);
  };
  const perform = async (action: AccountAction, view: AccountView, signal: AbortSignal) => {
    if (action.kind === 'login') await begin(action, signal);
    else if (action.kind === 'editor') { if (action.mode === 'replace-key') setReplacing(view); else setEditing(view); }
    else {
      if (action.body.schema === 'update-account-v1') await save(action.path, AccountViewSchema, action.method, action.body, signal);
      else await api(action.path, AccountViewSchema, action.method, action.body, { signal, waitForHub: true });
      await props.reload(signal);
    }
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
    const row = settingsView?.runtimes.flatMap(runtime => runtime.accounts).find(row => row.view.account.id === view.account.id);
    if (!row?.deepLinkAction) return;
    openedAccount.current = true;
    const card = document.getElementById(`account-${view.account.id}`);
    card?.scrollIntoView({ block: 'center' }); card?.focus({ preventScroll: true });
    if (query.get('login') === '1') void task.run(signal => perform(row.deepLinkAction!, row.view, signal));
  }, [data.accounts, settingsView, task]);
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
                  <div className="actions">{row.actions?.map(action => <button key={action.id} className={action.style} disabled={task.busy} onClick={() => void task.run(signal => perform(action, view, signal))}>{action.label}</button>)}</div>
                  {row.devices.length > 0 && <div className="device-grid">
                    {row.devices.map(device => <div key={device.id}>
                      <span>{device.name}</span><span className={`status status-${device.availability.tone}`}><i />{device.availability.label}</span>
                      <button className="text-button" disabled={!device.available || !device.loginPlan || task.busy} onClick={() => void task.run(signal => begin(device.loginPlan!, signal))}>{device.loginLabel}</button>
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
            if (startLogin) {
              const next = await api('/api/accounts/view', AccountsSettingsViewSchema, 'GET', undefined, { signal, waitForHub: true });
              const plan = next.runtimes.flatMap(runtime => runtime.accounts).find(row => row.view.account.id === account.account.id)?.deepLinkAction;
              if (plan?.kind === 'login') await begin(plan, signal);
            }
            setAdding(undefined);
            setEditing(undefined);
          }}
        />
      )}
      {replacing && <ReplaceKey view={replacing} close={() => setReplacing(undefined)} props={props} />}
      {login && <LoginPanel initial={login} props={props} close={() => setLogin(undefined)} />}
    </>
  );
}
