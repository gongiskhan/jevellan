import { clientId } from './client-id.js';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { AuthStateSchema, ConfigRevisionSchema, DeviceRosterSchema, type Configuration } from '@jevellan/core/client';
import { ApiError, api, authState, empty, hubWaiting, isCancelled, loadSettings, type SettingsData } from './api.js';
import { HubWaiting, useTask, type PageProps } from './components.js';
import { RuntimesPage } from './runtimes.js';
import { RiggingPage } from './rigging.js';
import { AboutPage, ConfigurationPage, DecisionsPage } from './settings.js';
import { DeviceSwitcher, DevicesPage } from './devices.js';
import { ProjectsPage } from './projects.js';
import { ConversationPage, ConversationSidebar, NewConversation } from './conversations.js';
import { SetupPage } from './setup.js';
import './style.css';

type Auth = z.infer<typeof AuthStateSchema>;
const settingsPages = [['runtimes', 'Runtimes'], ['rigging', 'Rigging'], ['decisions', 'Decisions'], ['devices', 'Devices'], ['projects', 'Projects'], ['configuration', 'Configuration'], ['about', 'About']] as const;
function SignIn({ auth, done, onError }: { auth: Auth; done(value: Auth): Promise<void>; onError(error: unknown): void }) {
  const [passphrase, setPassphrase] = useState(''); const task = useTask(onError);
  return <main className="auth-screen"><div className="auth-card"><span className="wordmark">Jevellan</span><h1>{auth.configured ? 'Welcome back' : 'Set your passphrase'}</h1><p>{auth.configured ? 'Sign in to your conversations and agents.' : 'Use one passphrase to sign in to Jevellan on your devices.'}</p><form onSubmit={(event) => { event.preventDefault(); void task.run(async (signal) => { try { await done(await api(`/api/auth/${auth.configured ? 'login' : 'setup'}`, AuthStateSchema, 'POST', { schema: 'passphrase-input-v1', passphrase }, { signal, waitForHub: auth.configured })); } finally { setPassphrase(''); } }); }}><label>Passphrase<input autoFocus type="password" required minLength={8} maxLength={1024} autoComplete={auth.configured ? 'current-password' : 'new-password'} value={passphrase} onChange={(event) => setPassphrase(event.target.value)}/></label>{!auth.configured && <p className="muted small-text">At least 8 characters.</p>}<button disabled={task.busy}>{task.busy ? 'Signing in…' : auth.configured ? 'Sign in' : 'Set passphrase'}</button></form></div><p className="auth-footer">Autonomous development, coordinated.</p></main>;
}
function App() {
  const [auth, setAuth] = useState<Auth>(); const [data, setData] = useState<SettingsData>(); const [path, setPath] = useState(window.location.pathname + window.location.search); const [sidebar, setSidebar] = useState(false); const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [theme, setTheme] = useState(() => localStorage.getItem('jevellan-theme') ?? 'system');
  const reload = useCallback(async (signal?: AbortSignal) => { setData(await loadSettings(signal)); }, []);
  const onError = useCallback((error: unknown) => {
    if (isCancelled(error)) return;
    setNotice({ text: error instanceof Error ? error.message : 'The request could not complete.', error: true });
    if (error instanceof ApiError && error.status === 401) { void authState().then(setAuth).catch(() => undefined); setData(undefined); }
    else if (error instanceof ApiError && error.status === 409) { void authState().then(setAuth).catch(() => undefined); void reload().catch(() => undefined); }
  }, [reload]);
  useEffect(() => { const controller = new AbortController(); void authState(controller.signal).then(async (state) => { setAuth(state); if (state.authenticated) await reload(controller.signal); }).catch(onError); return () => controller.abort(); }, [onError, reload]);
  useEffect(() => { const changed = () => { hubWaiting.stop(); setPath(window.location.pathname + window.location.search); }; window.addEventListener('popstate', changed); return () => window.removeEventListener('popstate', changed); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('jevellan-theme', theme); }, [theme]);
  useEffect(() => {
    if (!auth?.authenticated) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = () => { timer = setTimeout(() => { void api('/hub/devices/roster', DeviceRosterSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(roster => setData(current => current ? { ...current, roster, devices: { currentDeviceId: roster.currentDeviceId, devices: roster.devices.map(row => row.device) } } : current)).catch(error => { if (!controller.signal.aborted) onError(error); }).finally(() => { if (!controller.signal.aborted) refresh(); }); }, 30_000); };
    refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [auth?.authenticated, onError]);
  const navigate = useCallback((next: string) => { hubWaiting.stop(); history.pushState({}, '', next); setPath(next); setSidebar(false); }, []);
  const message = useCallback((text: string) => setNotice({ text, error: false }), []);
  const saveConfig = async (configuration: Configuration, signal?: AbortSignal) => { await api('/hub/config', ConfigRevisionSchema, 'PUT', { schema: 'config-write-v1', revision: data!.config.revision, configuration, clientRequestId: `config_${clientId()}` }, { signal, waitForHub: true }); await reload(signal); message('Settings saved.'); };
  const setup = path.split('?')[0] === '/setup'; const settings = path.startsWith('/settings'); const currentPage = path.split('?')[0]!.split('/')[2] ?? 'runtimes';
  const feedback = notice && <div className={`toast ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice(undefined)}>×</button></div>;
  if (!auth) return <><main className="loading"><span className="wordmark">Jevellan</span><p>Connecting…</p><button className="secondary" onClick={() => location.reload()}>Reload</button></main>{feedback}</>;
  if (!auth.authenticated) return <><SignIn auth={auth} onError={onError} done={async (state) => { setAuth(state); await reload(); navigate(auth.configured ? setup ? path : '/settings/runtimes' : '/setup'); }}/>{feedback}</>;
  if (!data) return <><main className="loading"><span className="wordmark">Jevellan</span><p>Loading your workspace…</p><button className="secondary" onClick={() => void reload().catch(onError)}>Try again</button></main>{feedback}</>;
  const props: PageProps = { data, reload, saveConfig, message, onError, navigate };
  return <div className="app-shell">
    {sidebar && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebar(false)}/>}
    <aside className={`sidebar ${sidebar ? 'open' : ''}`} aria-label="Conversations"><button className="wordmark" onClick={() => navigate('/')}>Jevellan</button><button className="new-conversation" onClick={() => navigate('/')}>＋ New conversation</button><ConversationSidebar data={data} navigate={navigate} onError={onError} selected={path}/><button className={`settings-link ${settings ? 'selected' : ''}`} onClick={() => navigate('/settings/runtimes')}>Settings</button></aside>
    <div className="workspace"><header className="app-header"><div><button className="menu-button icon-button" aria-label="Open navigation" aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}>☰</button><span className="breadcrumb">{setup ? 'Get started' : settings ? 'Settings' : 'Conversations'}</span></div><DeviceSwitcher props={props}/></header>
      {settings && <nav className="settings-tabs" aria-label="Settings">{settingsPages.map(([id, label]) => <button key={id} className={currentPage === id ? 'selected' : ''} aria-current={currentPage === id ? 'page' : undefined} onClick={() => navigate(`/settings/${id}`)}>{label}</button>)}</nav>}
      <main className="page-content">{setup ? <SetupPage {...props} path={path} key={path}/> : !settings ? path.startsWith('/conversations/') ? <ConversationPage {...props} id={path.split('/')[2]!.split('?')[0]!} key={path}/> : <NewConversation {...props}/> : currentPage === 'projects' ? <ProjectsPage {...props}/> : currentPage === 'rigging' ? <RiggingPage {...props}/> : currentPage === 'decisions' ? <DecisionsPage {...props} key={data.config.revision}/> : currentPage === 'devices' ? <DevicesPage {...props}/> : currentPage === 'configuration' ? <ConfigurationPage {...props}/> : currentPage === 'about' ? <><AboutPage {...props}/><section className="card"><h2>Appearance</h2><label>Theme<select value={theme} onChange={(event) => setTheme(event.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><button className="secondary" onClick={() => void api('/api/auth/logout', AuthStateSchema, 'POST', empty).then((state) => { setAuth(state); setData(undefined); }).catch(onError)}>Sign out</button></section></> : <RuntimesPage {...props} key={path}/>}</main>
    </div>{feedback}
  </div>;
}

createRoot(document.getElementById('root')!).render(<><App/><HubWaiting/></>);
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
