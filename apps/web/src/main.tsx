import { clientId } from './client-id.js';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import {
  AuthStateSchema,
  ConfigRevisionSchema,
  DeviceRosterSchema,
  type Configuration,
} from '@jevellan/core/client';
import {
  ApiError,
  api,
  authState,
  empty,
  hubWaiting,
  isCancelled,
  loadSettings,
  type SettingsData,
} from './api.js';
import { HubWaiting, useTask, type PageProps } from './components.js';
import { RuntimesPage } from './runtimes.js';
import { RiggingPage } from './rigging.js';
import { AboutPage, ConfigurationPage, DecisionsPage } from './settings.js';
import { DeviceSwitcher, DevicesPage } from './devices.js';
import { GitPage } from './git-settings.js';
import { ProjectsPage } from './projects.js';
import { ConversationPage, ConversationSidebar, NewConversation } from './conversations.js';
import { CursorConversationPage } from './cursor-sessions.js';
import { SetupPage } from './setup.js';
import { ImproverPage, useImprover } from './improver.js';
import { BrandFlag, Icon, type IconName } from './icons.js';
import './style.css';
import { InstallAppButton, PwaStatus, startPwa } from './pwa.js';

type Auth = z.infer<typeof AuthStateSchema>;
const settingsPages = [
  ['runtimes', 'Runtimes', 'runtimes'],
  ['rigging', 'Rigging', 'rigging'],
  ['decisions', 'Decisions', 'decisions'],
  ['improver', 'Improver', 'improver'],
  ['devices', 'Devices', 'devices'],
  ['projects', 'Projects', 'projects'],
  ['git', 'Git', 'git'],
  ['configuration', 'Configuration', 'configuration'],
  ['about', 'About', 'about'],
] as const satisfies ReadonlyArray<readonly [string, string, IconName]>;
function SignIn({
  auth,
  done,
  onError,
}: {
  auth: Auth;
  done(value: Auth): Promise<void>;
  onError(error: unknown): void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const task = useTask(onError);
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <span className="wordmark">
          <BrandFlag />
          Jevellan
        </span>
        <h1>{auth.configured ? 'Welcome back' : 'Set your passphrase'}</h1>
        <p>
          {auth.configured
            ? 'Sign in to your conversations and agents.'
            : 'Use one passphrase to sign in to Jevellan on your devices.'}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void task.run(async (signal) => {
              try {
                await done(
                  await api(
                    `/api/auth/${auth.configured ? 'login' : 'setup'}`,
                    AuthStateSchema,
                    'POST',
                    { schema: 'passphrase-input-v1', passphrase },
                    { signal, waitForHub: auth.configured },
                  ),
                );
              } finally {
                setPassphrase('');
              }
            });
          }}
        >
          <label>
            Passphrase
            <input
              autoFocus
              type="password"
              required
              minLength={8}
              maxLength={1024}
              autoComplete={auth.configured ? 'current-password' : 'new-password'}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          {!auth.configured && <p className="muted small-text">At least 8 characters.</p>}
          <button disabled={task.busy}>
            {task.busy ? 'Signing in…' : auth.configured ? 'Sign in' : 'Set passphrase'}
          </button>
        </form>
      </div>
      <p className="auth-footer">Autonomous development, coordinated.</p>
    </main>
  );
}

// While a dialog is open the message joins it as a bar at its bottom: the dialog sits in the top layer,
// and the message usually concerns what was done in it. Otherwise it floats below the header.
function Toast({ notice, dismiss }: { notice: { text: string; error: boolean }; dismiss(): void }) {
  const [dialog, setDialog] = useState(() => document.querySelector<HTMLDialogElement>('dialog[open]'));
  useEffect(() => {
    const observer = new MutationObserver(() => setDialog(document.querySelector<HTMLDialogElement>('dialog[open]')));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);
  const toast = (
    <div className={`toast ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      <button className="icon-button" aria-label="Dismiss message" onClick={dismiss}>
        ×
      </button>
    </div>
  );
  return dialog ? createPortal(toast, dialog) : toast;
}

function App() {
  const [auth, setAuth] = useState<Auth>();
  const [data, setData] = useState<SettingsData>();
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  const [sidebar, setSidebar] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [theme, setTheme] = useState(() => localStorage.getItem('jevellan-theme') ?? 'system');
  // Confirmations leave on their own so they never sit over controls; errors stay until dismissed.
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice((current) => (current === notice ? undefined : current)), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  const reload =useCallback(async (signal?: AbortSignal) => {
    setData(await loadSettings(signal));
  }, []);
  const onError = useCallback(
    (error: unknown) => {
      if (isCancelled(error)) return;
      setNotice({
        text: error instanceof Error ? error.message : 'The request could not complete.',
        error: true,
      });
      if (error instanceof ApiError && error.status === 401) {
        void authState()
          .then(setAuth)
          .catch(() => undefined);
        setData(undefined);
      } else if (error instanceof ApiError && error.status === 409) {
        void authState()
          .then(setAuth)
          .catch(() => undefined);
        void reload().catch(() => undefined);
      }
    },
    [reload],
  );
  const improver = useImprover(auth?.authenticated === true, onError);
  useEffect(() => {
    const controller = new AbortController();
    void authState(controller.signal)
      .then(async (state) => {
        setAuth(state);
        if (state.authenticated) await reload(controller.signal);
      })
      .catch(onError);
    return () => controller.abort();
  }, [onError, reload]);
  useEffect(() => {
    const changed = () => {
      hubWaiting.stop();
      setPath(window.location.pathname + window.location.search);
    };
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('jevellan-theme', theme);
  }, [theme]);
  useEffect(() => {
    if (!auth?.authenticated) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      timer = setTimeout(() => {
        void api('/hub/devices/roster', DeviceRosterSchema, 'GET', undefined, {
          signal: controller.signal,
          waitForHub: true,
        })
          .then((roster) =>
            setData((current) =>
              current
                ? {
                    ...current,
                    roster,
                    devices: {
                      currentDeviceId: roster.currentDeviceId,
                      devices: roster.devices.map((row) => row.device),
                    },
                  }
                : current,
            ),
          )
          .catch((error) => {
            if (!controller.signal.aborted) onError(error);
          })
          .finally(() => {
            if (!controller.signal.aborted) refresh();
          });
      }, 30_000);
    };
    refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [auth?.authenticated, onError]);
  const navigate = useCallback((next: string) => {
    hubWaiting.stop();
    history.pushState({}, '', next);
    setPath(next);
    setSidebar(false);
  }, []);
  const message = useCallback((text: string) => setNotice({ text, error: false }), []);
  const saveConfig = async (configuration: Configuration, signal?: AbortSignal) => {
    await api(
      '/hub/config',
      ConfigRevisionSchema,
      'PUT',
      {
        schema: 'config-write-v1',
        revision: data!.config.revision,
        configuration,
        clientRequestId: `config_${clientId()}`,
      },
      { signal, waitForHub: true },
    );
    await reload(signal);
    message('Settings saved.');
  };
  const setup = path.split('?')[0] === '/setup';
  const settings = path.startsWith('/settings');
  const currentPage = path.split('?')[0]!.split('/')[2] ?? 'runtimes';
  const feedback = notice && <Toast notice={notice} dismiss={() => setNotice(undefined)} />;
  if (!auth)
    return (
      <>
        <main className="loading">
          <span className="wordmark">Jevellan</span>
          <p>Connecting…</p>
          <button className="secondary" onClick={() => location.reload()}>
            Reload
          </button>
        </main>
        {feedback}
      </>
    );
  if (!auth.authenticated)
    return (
      <>
        <SignIn
          auth={auth}
          onError={onError}
          done={async (state) => {
            setAuth(state);
            await reload();
            navigate(auth.configured ? (setup ? path : '/settings/runtimes') : '/setup');
          }}
        />
        {feedback}
      </>
    );
  if (!data)
    return (
      <>
        <main className="loading">
          <span className="wordmark">Jevellan</span>
          <p>Loading your workspace…</p>
          <button className="secondary" onClick={() => void reload().catch(onError)}>
            Try again
          </button>
        </main>
        {feedback}
      </>
    );
  const props: PageProps = { data, reload, saveConfig, message, onError, navigate };
  const settingsNav = (
    <nav className="settings-tabs" aria-label="Settings">
      {settingsPages.map(([id, label, icon]) => (
        <button
          key={id}
          className={currentPage === id ? 'selected' : ''}
          aria-current={currentPage === id ? 'page' : undefined}
          onClick={() => {
            if (id === 'improver') improver.consume();
            navigate(`/settings/${id}`);
          }}
        >
          <Icon name={icon} />
          {label}
          {id === 'improver' && improver.count > 0 && (
            <span className="suggestion-count" aria-hidden="true">
              {improver.count}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
  const settingsPage =
    currentPage === 'git' ? (
      <GitPage {...props} />
    ) : currentPage === 'projects' ? (
      <ProjectsPage {...props} />
    ) : currentPage === 'rigging' ? (
      <RiggingPage {...props} />
    ) : currentPage === 'decisions' ? (
      <DecisionsPage {...props} key={data.config.revision} />
    ) : currentPage === 'improver' ? (
      <ImproverPage {...props} monitor={improver} />
    ) : currentPage === 'devices' ? (
      <DevicesPage {...props} />
    ) : currentPage === 'configuration' ? (
      <ConfigurationPage {...props} />
    ) : currentPage === 'about' ? (
      <>
        <AboutPage {...props} />
        <section className="card">
          <h2>Appearance</h2>
          <label className="compact-label">
            Theme
            <select value={theme} onChange={(event) => setTheme(event.target.value)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <div className="actions">
            <button
              className="secondary"
              onClick={() =>
                void api('/api/auth/logout', AuthStateSchema, 'POST', empty)
                  .then((state) => {
                    setAuth(state);
                    setData(undefined);
                  })
                  .catch(onError)
              }
            >
              Sign out
            </button>
          </div>
        </section>
      </>
    ) : (
      <RuntimesPage {...props} key={path} />
    );
  const conversation = path.startsWith('/cursor/') || path.startsWith('/conversations/');
  const navigation = <button className="menu-button icon-button" aria-label="Open navigation" aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}><Icon name="menu" /></button>;
  const settingsLabel = settingsPages.find(([id]) => id === currentPage)?.[1] ?? 'Runtimes';
  return (
    <div className={`app-shell ${conversation ? 'reading-conversation' : ''}`}>
      {sidebar && (
        <div className="sidebar-backdrop" aria-hidden="true" onClick={() => setSidebar(false)} />
      )}
      <aside className={`sidebar ${sidebar ? 'open' : ''}`} aria-label="Conversations">
        <div className="sidebar-top">
          <button className="wordmark" onClick={() => navigate('/')}>
            <BrandFlag />
            Jevellan
          </button>
          <button
            className="icon-button sidebar-close"
            aria-label="Close navigation"
            onClick={() => setSidebar(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="sidebar-device"><DeviceSwitcher props={props} /></div>
        <button className="new-conversation" onClick={() => navigate('/')}>
          <Icon name="plus" />
          New conversation
        </button>
        {improver.notice && (
          <button
            className="improver-notice"
            onClick={() => {
              improver.consume();
              navigate('/settings/improver');
            }}
          >
            {improver.notice.lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </button>
        )}
        <ConversationSidebar data={data} navigate={navigate} onError={onError} selected={path} />
        <div className="sidebar-footer">
          <InstallAppButton navigate={navigate} />
          <button
            className={`settings-link ${settings ? 'selected' : ''}`}
            onClick={() => navigate('/settings/runtimes')}
          >
            <Icon name="settings" />
            Settings
            {improver.count > 0 && (
              <span className="suggestion-count" aria-label={`${improver.count} pending suggestions`}>
                {improver.count}
              </span>
            )}
          </button>
          <div className="sidebar-footer-row">
            <small>
              v{data.devices.devices.find((device) => device.id === data.devices.currentDeviceId)?.version}
            </small>
            <div className="theme-switch" role="group" aria-label="Theme">
              {(
                [
                  ['light', 'sun', 'Light theme'],
                  ['system', 'system', 'System theme'],
                  ['dark', 'moon', 'Dark theme'],
                ] as const
              ).map(([value, icon, label]) => (
                <button
                  key={value}
                  aria-label={label}
                  title={label}
                  aria-pressed={theme === value}
                  onClick={() => setTheme(value)}
                >
                  <Icon name={icon} size={14} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace">
        {!conversation && <header className="app-header">
          <div>
            <button
              className="menu-button icon-button"
              aria-label="Open navigation"
              aria-expanded={sidebar}
              onClick={() => setSidebar(!sidebar)}
            >
              <Icon name="menu" />
            </button>
            <span className="breadcrumb">
              {setup ? (
                'Get started'
              ) : settings ? (
                <>
                  Settings · <b>{settingsLabel}</b>
                </>
              ) : (
                'Conversations'
              )}
            </span>
          </div>
        </header>}
        <main className="page-content">
          {setup ? (
            <SetupPage {...props} path={path} key={path} />
          ) : settings ? (
            <div className="settings-layout">
              {settingsNav}
              <div className="settings-content">{settingsPage}</div>
            </div>
          ) : path.startsWith('/cursor/') ? (
            <CursorConversationPage {...props} navigation={navigation} id={path.split('/')[2]!.split('?')[0]!} key={path} />
          ) : path.startsWith('/conversations/') ? (
            <ConversationPage {...props} navigation={navigation} id={path.split('/')[2]!.split('?')[0]!} key={path} />
          ) : (
            <NewConversation {...props} />
          )}
        </main>
      </div>
      <div className="inspector" id="inspector" />
      {feedback}
    </div>
  );
}

startPwa();
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <HubWaiting />
    <PwaStatus />
  </>,
);
