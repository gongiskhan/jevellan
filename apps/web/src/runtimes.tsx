import { clientId } from './client-id.js';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { AccountViewSchema, LoginViewSchema, type AccountView, type AccountStatus } from '@jevellan/core/client';
import { api, empty, isCancelled } from './api.js';
import { Modal, SectionHeading, dateTime, useRequestId, useSettingsSave, useTask, type PageProps } from './components.js';
import { deviceAvailable } from './devices.js';

const statusLabels: Record<string, string> = { ready: 'Ready', 'needs-login': 'Needs login', expired: 'Expired', revoked: 'Revoked', checking: 'Checking', unknown: 'Unknown', missing: 'Needs login' };
const paidLabels = { always: 'Always', 'when-subscriptions-run-out': "Only when this runtime’s subscriptions run out", never: 'Never automatically' };
type Login = z.infer<typeof LoginViewSchema>;
function currentStatus(view: AccountView, deviceId: string) { return [...view.statuses].filter((status) => view.account.credential === 'shared' || status.deviceId === deviceId).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]; }
function Usage({ status }: { status: AccountStatus | undefined }) {
  return <div className="usage-windows">{(['fiveHour', 'weekly'] as const).map((window) => {
    const value = window === 'fiveHour' ? status?.usage?.fiveHourPct : status?.usage?.weeklyPct;
    const reset = window === 'fiveHour' ? status?.usage?.fiveHourResetsAt : status?.usage?.weeklyResetsAt;
    const label = window === 'fiveHour' ? 'Five hours' : 'Week';
    return <div className="usage" key={window}><div><span>{label}</span><span>{value === undefined ? 'Unknown' : `${value}%`}</span></div><progress aria-label={`${label} usage`} max={100} value={value ?? 0}/>{reset && <small>Resets {dateTime(reset)}</small>}</div>;
  })}</div>;
}
function AccountForm({ runtime, existing, done, close, onError }: { runtime: string; existing?: AccountView; done(account: AccountView, startLogin: boolean, signal: AbortSignal): Promise<void>; close(): void; onError(error: unknown): void }) {
  const [label, setLabel] = useState(existing?.account.label ?? ''); const [kind, setKind] = useState(existing?.account.kind ?? 'subscription');
  const [ceiling, setCeiling] = useState(existing?.account.ceilingPct ?? 90); const [paid, setPaid] = useState<string>(existing?.account.paidUse ?? ''); const [secret, setSecret] = useState(''); const task = useTask(onError);
  const requestId = useRequestId();
  return <Modal title={existing ? 'Edit account' : 'Add account'} close={close}><form onSubmit={(event) => { event.preventDefault(); void task.run(async (signal) => {
    try {
      const value = existing ? { schema: 'update-account-v1', revision: existing.revision, label, enabled: existing.account.enabled, ceilingPct: ceiling, ...(kind === 'api-key' ? { paidUse: paid } : {}) } : { schema: 'add-account-v1', runtime, label, kind, ceilingPct: ceiling, ...(kind === 'api-key' ? { paidUse: paid } : {}), ...(secret ? { secret } : {}) };
      const account = await api(existing ? `/hub/accounts/${existing.account.id}` : '/hub/accounts', AccountViewSchema, existing ? 'PATCH' : 'POST', { ...value, clientRequestId: requestId({ accountId: existing?.account.id, value }) }, { signal, waitForHub: true });
      await done(account, !existing && kind === 'subscription' && !secret, signal);
    } finally { setSecret(''); }
  }); }}>
    <label>Label<input autoFocus required maxLength={128} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Personal"/></label>
    {!existing && <label>Kind<select value={kind} onChange={(event) => { setKind(event.target.value as 'subscription' | 'api-key'); setPaid(''); setSecret(''); }}><option value="subscription">Subscription</option><option value="api-key">API key</option></select></label>}
    {kind === 'subscription' && runtime === 'claude' && <p className="notice">Anthropic's terms restrict third-party tools from offering Claude subscription logins without their approval. Using your own token here is your decision.</p>}
    {!existing && kind === 'api-key' && <label>API key<input type="password" autoComplete="off" required value={secret} onChange={(event) => setSecret(event.target.value)}/></label>}
    {!existing && kind === 'subscription' && runtime === 'claude' && <details><summary>Use an existing token</summary><label>Subscription token<input type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)}/></label></details>}
    {kind === 'api-key' && <label>When may Jevellan use this key?<select required value={paid} onChange={(event) => setPaid(event.target.value)}><option value="" disabled>Choose when</option>{Object.entries(paidLabels).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label>}
    <label>Usage ceiling (%)<input type="number" min={0} max={100} required value={ceiling} onChange={(event) => setCeiling(Number(event.target.value))}/></label>
    <div className="form-actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button disabled={task.busy}>{task.busy ? 'Saving…' : existing ? 'Save account' : 'Add account'}</button></div>
  </form></Modal>;
}
function ReplaceKey({ view, close, props }: { view: AccountView; close(): void; props: PageProps }) {
  const save = useSettingsSave();
  const [secret, setSecret] = useState(''); const task = useTask(props.onError);
  return <Modal title="Replace API key" close={close}><form onSubmit={(event) => { event.preventDefault(); void task.run(async (signal) => { try { await save(`/hub/accounts/${view.account.id}/credential`, AccountViewSchema, 'PUT', { schema: 'replace-credential-v1', revision: view.revision, secret }, signal); await props.reload(signal); close(); } finally { setSecret(''); } }); }}><label>New API key<input autoFocus type="password" autoComplete="off" required value={secret} onChange={(event) => setSecret(event.target.value)}/></label><p className="muted">The saved key is replaced when you submit this form.</p><button disabled={task.busy}>{task.busy ? 'Checking…' : 'Replace key'}</button></form></Modal>;
}
function LoginPanel({ initial, props, close }: { initial: Login; props: PageProps; close(): void }) {
  const [login, setLogin] = useState(initial); const [code, setCode] = useState(''); const [requestError, setRequestError] = useState('');
  const reportError = (error: unknown) => setRequestError(error instanceof Error ? error.message : 'Sign-in could not complete. Try again.');
  const task = useTask(reportError); const closing = useTask(reportError); const requestId = useRequestId();
  const loginPath = `/api/logins/${login.id}${login.deviceId === props.data.devices.currentDeviceId ? '' : `?deviceId=${encodeURIComponent(login.deviceId)}`}`;
  useEffect(() => {
    if (!['pending', 'checking'].includes(login.state)) return;
    let active = true; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api(loginPath, LoginViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true });
        if (!active) return;
        if (next.state === 'done') await props.reload(controller.signal);
        if (active) { setRequestError(''); setLogin(next); }
      } catch (error) {
        if (active && !isCancelled(error)) { setRequestError(error instanceof Error ? error.message : 'Could not check sign-in. Retrying…'); timer = setTimeout(() => void poll(), 2000); }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [login, loginPath, props.reload]);
  const startAgain = () => task.run(async signal => {
    setRequestError('');
    await api(loginPath, LoginViewSchema, 'DELETE', empty, { signal, waitForHub: true });
    const path = `/api/accounts/${login.accountId}/login${login.deviceId === props.data.devices.currentDeviceId ? '' : `?deviceId=${encodeURIComponent(login.deviceId)}`}`;
    const next = await api(path, LoginViewSchema, 'POST', { schema: 'login-start-v1', clientRequestId: requestId({ previousLoginId: login.id }) }, { signal, waitForHub: true });
    if (next.accountId !== login.accountId || next.deviceId !== login.deviceId) throw new Error('The login returned for a different account or device. Reload Settings.');
    setCode(''); setLogin(next);
  });
  const account = props.data.accounts.find((view) => view.account.id === login.accountId);
  return <Modal title={`Log in · ${account?.account.label ?? 'Account'}`} close={() => { if (!['pending', 'checking'].includes(login.state)) { close(); return; } void closing.run(async (signal) => { await api(loginPath, LoginViewSchema, 'DELETE', empty, { signal, waitForHub: true }); close(); }); }}>
    {login.deviceId !== props.data.devices.currentDeviceId && <p className="muted">On {props.data.devices.devices.find(device => device.id === login.deviceId)?.name ?? 'the selected device'}</p>}
    {login.state === 'done' ? <div className="success" role="status">{account?.account.identity?.email ? `Signed in as ${account.account.identity.email}` : 'Signed in. This account is Ready.'}</div> : <>
      {login.state === 'pending' && <><p>{login.instructions}</p>{login.url ? <a className="button-link" href={login.url} target="_blank" rel="noreferrer">Open sign-in page ↗</a> : <p className="muted">Preparing the sign-in link…</p>}</>}
      {login.userCode && <div className="verification-code"><span>Verification code</span><strong>{login.userCode}</strong></div>}
      {login.acceptsCode && login.state === 'pending' && <form onSubmit={(event) => { event.preventDefault(); void task.run(async (signal) => { try { const next = await api(loginPath, LoginViewSchema, 'POST', { schema: 'login-code-v1', code }, { signal, waitForHub: true }); setLogin(next); if (next.state === 'done') await props.reload(signal); } finally { setCode(''); } }); }}><label>{account?.account.runtime === 'codex' ? 'Callback address' : 'Authorization code'}<input required type="password" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)}/></label><button disabled={task.busy}>Continue</button></form>}
      {login.state === 'pending' && !login.acceptsCode && !login.userCode && login.url && <p role="status">Code sent. Waiting for sign-in to finish…</p>}
      {login.error && <p role="alert" className="error">{login.error}</p>}{login.state === 'checking' && <p role="status">Checking the account…</p>}
      {(login.state === 'failed' || login.state === 'cancelled' || login.state === 'pending' && !login.acceptsCode && !login.userCode) && <button className="secondary" disabled={task.busy || closing.busy} onClick={() => void startAgain()}>Start again</button>}
    </>}
    {requestError && <p role="alert" className="error">{requestError}</p>}
  </Modal>;
}
export function RuntimesPage(props: PageProps & { embedded?: boolean }) {
  const save = useSettingsSave();
  const { data } = props; const [adding, setAdding] = useState<string>(); const [editing, setEditing] = useState<AccountView>(); const [replacing, setReplacing] = useState<AccountView>(); const [login, setLogin] = useState<Login>(); const task = useTask(props.onError);
  const begin = async (id: string, signal: AbortSignal, deviceId = data.devices.currentDeviceId) => { const result = await api(`/api/accounts/${id}/login${deviceId === data.devices.currentDeviceId ? '' : `?deviceId=${encodeURIComponent(deviceId)}`}`, LoginViewSchema, 'POST', { schema: 'login-start-v1', clientRequestId: `login_${clientId()}` }, { signal, waitForHub: true }); if (result.deviceId !== deviceId || result.accountId !== id) throw new Error('The login returned for a different account or device. Reload Settings.'); setLogin(result); };
  const openedAccount = useRef(false);
  useEffect(() => {
    if (openedAccount.current) return;
    const query = new URLSearchParams(window.location.search);
    const view = data.accounts.find((entry) => entry.account.id === query.get('account'));
    if (!view) return;
    openedAccount.current = true;
    const card = document.getElementById(`account-${view.account.id}`);
    card?.scrollIntoView({ block: 'center' }); card?.focus({ preventScroll: true });
    if (query.get('login') === '1') {
      if (view.account.kind === 'api-key') setReplacing(view);
      else void task.run((signal) => begin(view.account.id, signal));
    }
  }, [data.accounts, task]);
  return <>{!props.embedded && <><SectionHeading title="Runtimes"/><p className="intro">Choose the runtimes and accounts your agents can use.</p></>}
    {data.runtimes.map((runtime) => <section className="card runtime-card" key={runtime.id}><div className="card-heading"><div><h2>{runtime.displayName}</h2><p className="muted">{runtime.capabilities.readOnlyEnforced ? 'Read-only actions enforced' : 'Read-only actions unavailable'}</p></div><label className="toggle"><input type="checkbox" aria-label={`Enable ${runtime.displayName}`} checked={runtime.enabled} disabled={task.busy} onChange={(event) => { const configuration = structuredClone(data.config.configuration); configuration['x-jevellan'].runtimes[runtime.id] = { enabled: event.target.checked }; void task.run((signal) => props.saveConfig(configuration, signal)); }}/><span>Enabled</span></label></div>
      <div className="model-chips">{data.offered.find((offered) => offered.runtime === runtime.id)?.models.map((model) => <span className="chip" key={model.id} title={`${model.id} · ${model.efforts.join(', ')}`}>{model.label}</span>) ?? <span className="muted">Models appear after an account is checked.</span>}</div>
      <div className="subheading"><h3>Accounts</h3><button className="secondary small" onClick={() => setAdding(runtime.id)}>Add account</button></div>
      {data.accounts.filter((view) => view.account.runtime === runtime.id).map((view) => {
        const account = view.account; const status = currentStatus(view, data.devices.currentDeviceId);
        return <article className="account" id={`account-${account.id}`} tabIndex={-1} key={account.id}><div className="account-heading"><div><strong>{account.label}</strong><span className="muted">{account.kind === 'api-key' ? 'API key' : 'Subscription'}{view.secret && ` · Saved · ••••${view.secret.lastFour}`}</span></div><span className={`status status-${account.enabled ? status?.auth : 'disabled'}`}><i/>{account.enabled ? statusLabels[status?.auth ?? 'missing'] : 'Disabled'}</span></div>
          <Usage status={status}/>{account.paidUse && <p className="muted small-text">{paidLabels[account.paidUse]}</p>}{status?.coolingUntil && Date.parse(status.coolingUntil) > Date.now() && <p className="notice">Cooling until {dateTime(status.coolingUntil)}</p>}{status?.lastError && <p className="notice">{status.lastError}</p>}
          <div className="actions">{account.kind === 'subscription' && account.credential !== 'per-device' && <button className="secondary small" disabled={task.busy} onClick={() => void task.run((signal) => begin(account.id, signal))}>Log in</button>}<button className="secondary small" disabled={task.busy} onClick={() => void task.run(async (signal) => { await api(`/api/accounts/${account.id}/check`, AccountViewSchema, 'POST', empty, { signal, waitForHub: true }); await props.reload(signal); })}>Check now</button><button className="text-button" onClick={() => setEditing(view)}>Edit</button>{account.kind === 'api-key' && <button className="text-button" onClick={() => setReplacing(view)}>Replace key</button>}<button className="text-button" disabled={task.busy} onClick={() => void task.run(async (signal) => { await save(`/hub/accounts/${account.id}`, AccountViewSchema, 'PATCH', { schema: 'update-account-v1', revision: view.revision, label: account.label, enabled: !account.enabled, ceilingPct: account.ceilingPct, ...(account.paidUse ? { paidUse: account.paidUse } : {}) }, signal); await props.reload(signal); })}>{account.enabled ? 'Disable' : 'Enable'}</button></div>
          {account.credential === 'per-device' && <div className="device-grid">{data.roster.devices.filter(row => !row.revoked).map((row) => { const device = row.device; const here = device.id === data.devices.currentDeviceId; const available = deviceAvailable(row, data.devices.currentDeviceId); const state = view.statuses.find((entry) => entry.deviceId === device.id); return <div key={device.id}><span>{device.name}</span><span className={`status status-${available ? state?.auth : 'missing'}`}><i/>{available ? statusLabels[state?.auth ?? 'missing'] : 'Offline'}</span><button className="text-button" disabled={!available || task.busy} onClick={() => void task.run((signal) => begin(account.id, signal, device.id))}>{here ? 'Log in here' : `Log in on ${device.name}`}</button></div>; })}<p className="muted small-text">Codex sign-ins are kept per device for now.</p></div>}
        </article>;
      })}
      {!data.accounts.some((view) => view.account.runtime === runtime.id) && <p className="empty-inline">No accounts added yet.</p>}
      <button className="text-button" onClick={() => props.navigate(`/settings/rigging?runtime=${runtime.id}`)}>Rigging for {runtime.displayName} →</button>
    </section>)}
    {(adding || editing) && <AccountForm runtime={adding ?? editing!.account.runtime} {...(editing ? { existing: editing } : {})} onError={props.onError} close={() => { setAdding(undefined); setEditing(undefined); }} done={async (account, startLogin, signal) => { await props.reload(signal); if (startLogin) await begin(account.account.id, signal); setAdding(undefined); setEditing(undefined); }}/>}
    {replacing && <ReplaceKey view={replacing} close={() => setReplacing(undefined)} props={props}/>}{login && <LoginPanel initial={login} props={props} close={() => setLogin(undefined)}/>}
  </>;
}
