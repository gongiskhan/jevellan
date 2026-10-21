import { useEffect, useState } from 'react';
import { z } from 'zod';
import { AccountViewSchema, AccountLoginPresentationSchema, LoginViewSchema } from '@jevellan/core/client';
import { api, empty, isCancelled } from './api.js';
import { Modal, useRequestId, useSettingsSave, useTask, type PageProps } from './components.js';
export const PresentedLoginSchema = LoginViewSchema.extend({ presentation: AccountLoginPresentationSchema });
export type PresentedLogin = z.infer<typeof PresentedLoginSchema>;
/** Account/device equality is a response transport fence, independent of provider state. */
export function sameLoginTarget(next: PresentedLogin, expected: { accountId: string; deviceId: string }) {
  if (next.accountId !== expected.accountId || next.deviceId !== expected.deviceId) throw new Error('The login returned for a different account or device. Reload Settings.');
  return next;
}
export function LoginPanel({ initial, props, close }: { initial: PresentedLogin; props: PageProps; close(): void }) {
  const save = useSettingsSave(), requestId = useRequestId();
  const [login, setLogin] = useState(initial), [code, setCode] = useState(''), [requestError, setRequestError] = useState('');
  const reportError = (error: unknown) => setRequestError(error instanceof Error ? error.message : 'Sign-in could not complete. Try again.');
  const task = useTask(reportError), closing = useTask(reportError), presentation = login.presentation;
  useEffect(() => {
    if (!presentation.poll.enabled) return;
    let active = true; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = sameLoginTarget(await api(presentation.poll.path, PresentedLoginSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }), initial);
        if (!active) return;
        if (next.presentation.success) await props.reload(controller.signal);
        if (active) { setRequestError(''); setLogin(next); }
      } catch (error) {
        if (active && !isCancelled(error)) { setRequestError(error instanceof Error ? error.message : 'Could not check sign-in. Retrying…'); timer = setTimeout(() => void poll(), presentation.poll.errorDelayMs); }
      }
    };
    timer = setTimeout(() => void poll(), presentation.poll.intervalMs);
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [login, presentation, initial, props.reload]);
  const startAgain = () => task.run(async signal => {
    setRequestError(''); const cancel = presentation.close.plan, start = presentation.restart.plan;
    await api(cancel.path, PresentedLoginSchema, cancel.method, empty, { signal, waitForHub: true });
    const next = sameLoginTarget(await api(start.path, PresentedLoginSchema, start.method, { schema: 'login-start-v1', clientRequestId: requestId({ previousLoginId: login.id }) }, { signal, waitForHub: true }), start.expected);
    setCode(''); setLogin(next);
  });
  return <Modal title={presentation.title} close={() => {
    if (!presentation.close.cancel) { close(); return; }
    void closing.run(async signal => { const plan = presentation.close.plan; await api(plan.path, PresentedLoginSchema, plan.method, empty, { signal, waitForHub: true }); close(); });
  }}>
    {presentation.deviceLine && <p className="muted">{presentation.deviceLine}</p>}
    {presentation.success ? <div className="success" role="status">
      {presentation.success.identityLine}{presentation.success.availabilityLine && <p>{presentation.success.availabilityLine}</p>}
      {presentation.success.needsEnable && <><p>{presentation.success.enableText}</p><button disabled={task.busy} onClick={() => void task.run(async signal => {
        const plan = presentation.success!.enablePlan;
        await save(plan.path, AccountViewSchema, plan.method, plan.body, signal); await props.reload(signal);
        setLogin(sameLoginTarget(await api(presentation.poll.path, PresentedLoginSchema, 'GET', undefined, { signal, waitForHub: true }), initial));
      })}>{presentation.success.enablePlan.label}</button></>}
    </div> : <>
      {presentation.pending.visible && <><p>{login.instructions}</p>{login.url ? <a className="button-link" href={login.url} target="_blank" rel="noreferrer">{presentation.pending.openLabel}</a> : <p className="muted">{presentation.pending.preparingText}</p>}</>}
      {login.userCode && <div className="verification-code"><span>{presentation.verificationLabel}</span><strong>{login.userCode}</strong></div>}
      {presentation.code.visible && <form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
        try {
          const plan = presentation.code.plan;
          const next = sameLoginTarget(await api(plan.path, PresentedLoginSchema, plan.method, { schema: 'login-code-v1', code }, { signal, waitForHub: true }), initial);
          setLogin(next); if (next.presentation.success) await props.reload(signal);
        } finally { setCode(''); }
      }); }}><label>{presentation.code.label}<input required type="password" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} /></label><button disabled={task.busy}>{presentation.code.submitLabel}</button></form>}
      {presentation.pending.waitingText && <p role="status">{presentation.pending.waitingText}</p>}
      {login.error && <p role="alert" className="error">{login.error}</p>}
      {presentation.checkingText && <p role="status">{presentation.checkingText}</p>}
      {presentation.restart.visible && <button className="secondary" disabled={task.busy || closing.busy} onClick={() => void startAgain()}>{presentation.restart.label}</button>}
    </>}
    {requestError && <p role="alert" className="error">{requestError}</p>}
  </Modal>;
}
