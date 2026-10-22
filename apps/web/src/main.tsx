import { CleanupPage } from './cleanup.js';
import { NotificationsPage } from './notifications.js';
import { EkoaPage } from './ekoa.js';
import { clientId } from './client-id.js';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import {
  AuthStateSchema,
  settingsPage as settingsPageModel,
  ConfigRevisionSchema,
  AppShellViewSchema,
  APP_ROSTER_POLL_MS,
  appSignInView,
  appPostLoginPath,
  appVersionNotice,
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
import { HubWaiting, useTabStrip, useTask, type PageProps } from './components.js';
import { RuntimesPage } from './runtimes.js';
import { RiggingPage } from './rigging.js';
import { AboutPage, ConfigurationPage, DecisionsPage } from './settings.js';
import { DeviceSwitcher, DevicesPage } from './devices.js';
import { GitPage } from './git-settings.js';
import { AgentsPage } from './agents.js';
import { ProjectsPage } from './projects.js';
import { ConversationPage, ConversationSidebar, NewConversation } from './conversations.js';
import { CursorConversationPage } from './cursor-sessions.js';
import { ProjectSettingsPage } from './project-settings.js';
import { ProjectWorkPage, ProjectsSidebar } from './project-work.js';
import { projectRoute } from './project-work-model.js';
import { TaskPage } from './task-page.js';
import { ThreadPage } from './thread-page.js';
import { TerminalPage } from './terminal.js';
import { SetupPage } from './setup.js';
import { ImproverPage, useImprover } from './improver.js';
import { BrandFlag, Icon } from './icons.js';
import './style.css';
import './project-work.css';
import { InstallAppButton, PwaStatus, startPwa } from './pwa.js';

type Auth = z.infer<typeof AuthStateSchema>;

/**
 * The settings pages' tabs: a list beside the page, and below 1024 px a strip that scrolls sideways (useTabStrip). On an end
 * that hides tabs, a chevron button over the fade scrolls the strip that way; the tabs themselves stay the keyboard path.
 */
function SettingsTabs({ current, children }: { current: string; children: ReactNode }) {
  const strip = useTabStrip(current);
  const scroll = (direction: -1 | 1) => {
    const element = strip.current;
    if (!element) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollBy({ left: direction * element.clientWidth * 0.6, behavior: smooth ? 'smooth' : 'auto' });
  };
  return (
    <nav className="settings-tabs" aria-label="Settings">
      <div className="settings-tabs-strip" ref={strip}>
        {children}
      </div>
      <button type="button" className="strip-scroll strip-scroll-start" tabIndex={-1} aria-label="Earlier settings tabs" onClick={() => scroll(-1)}>
        <Icon name="chevron" size={14} />
      </button>
      <button type="button" className="strip-scroll strip-scroll-end" tabIndex={-1} aria-label="More settings tabs" onClick={() => scroll(1)}>
        <Icon name="chevron" size={14} />
      </button>
    </nav>
  );
}
function SignIn({
  auth,
  done,
  onError,
}: {
  auth: Auth;
  done(value: Auth): Promise<void>;
  onError(error: unknown): void;
}) {
  const view=appSignInView(auth);
  const [passphrase, setPassphrase] = useState('');
  const task = useTask(onError);
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <span className="wordmark">
          <BrandFlag />
          Jevellan
        </span>
        <h1>{view.title}</h1>
        <p>
          {view.help}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void task.run(async (signal) => {
              try {
                await done(
                  await api(
                    view.submit.path,
                    AuthStateSchema,
                    view.submit.method,
                    { schema: 'passphrase-input-v1', passphrase },
                    { signal, waitForHub: view.submit.waitForHub },
                  ),
                );
              } finally {
                setPassphrase('');
              }
            });
          }}
        >
          <label>
            {view.field.label}
            <input
              autoFocus
              type="password"
              required
              minLength={view.field.minLength}
              maxLength={view.field.maxLength}
              autoComplete={view.field.autoComplete}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          {view.field.hint && <p className="muted small-text">{view.field.hint}</p>}
          <button disabled={task.busy}>
            {task.busy ? view.submit.busyLabel : view.submit.label}
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

/** B5: a member on another version than its hub says so, with the one command that fixes it. */
function VersionBanner({ devices }: { devices: SettingsData['devices'] }) {
  const notice=appVersionNotice(devices);
  return notice?<div className="version-banner" role="status">{notice.beforeCommand}<code>{notice.command}</code>{notice.afterCommand}</div>:null;
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
        void api('/api/app/view', AppShellViewSchema, 'GET', undefined, {
          signal: controller.signal,
          waitForHub: true,
        })
          .then((view) =>
            setData((current) =>
              current
                ? {
                    ...current,
                    roster:view.roster,
                    devices:view.devices,
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
      }, APP_ROSTER_POLL_MS);
    };
    refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [auth?.authenticated, onError]);
  const navigate = useCallback((next: string, replace = false) => {
    hubWaiting.stop();
    if (replace) history.replaceState({}, '', next);
    else history.pushState({}, '', next);
    setPath(next);
    setSidebar(false);
  }, []);
  const openHome = useCallback((projectId?: string) => {
    // A late sidebar reply must not take the owner away from a page they opened.
    if (window.location.pathname !== '/') return;
    navigate(projectId ? `/projects/${projectId}` : '/new', true);
  }, [navigate]);
  const message = useCallback((text: string) => setNotice({ text, error: false }), []);
  const saveConfig = async (configuration: Configuration, signal?: AbortSignal) => {
    await api(
      data!.configurationWrite.path,
      ConfigRevisionSchema,
      data!.configurationWrite.method,
      {
        ...data!.configurationWrite.body,
        configuration,
        clientRequestId: `config_${clientId()}`,
      },
      { signal, waitForHub: true },
    );
    await reload(signal);
    message(data!.configurationWrite.savedNotice);
  };
  const setup = path.split('?')[0] === '/setup';
  const settings = path.startsWith('/settings');
  const currentPage = path.split('?')[0]!.split('/')[2] ?? data?.navigation.defaultPage ?? '';
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
            navigate(appPostLoginPath(appSignInView(auth),path),true);
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
    <SettingsTabs current={currentPage}>
      {data.navigation.pages.map(({id, label, icon}) => (
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
    </SettingsTabs>
  );
  const settingsPage =
    currentPage === 'notifications' ? (
      <NotificationsPage {...props} />
    ) : currentPage === 'agents' ? (
      <AgentsPage {...props} />
    ) : currentPage === 'ekoa' ? (
      <EkoaPage {...props} />
    ) : currentPage === 'git' ? (
      <GitPage {...props} />
    ) : currentPage === 'projects' ? (
      <ProjectsPage {...props} />
    ) : currentPage === 'rigging' ? (
      <RiggingPage {...props} />
    ) : currentPage === 'decisions' ? (
      <DecisionsPage {...props} />
    ) : currentPage === 'improver' ? (
      <ImproverPage {...props} monitor={improver} />
    ) : currentPage === 'cleanup' ? (
      <CleanupPage {...props} key={data.config.revision} />
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
  // Project and thread pages hide the header like conversation pages and render the navigation button themselves.
  const project = projectRoute(path);
  const conversation = path.startsWith('/cursor/') || path.startsWith('/sessions/') || path.startsWith('/conversations/') || !!project;
  const navigation = <button className="menu-button icon-button" aria-label="Open navigation" aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}><Icon name="menu" /></button>;
  const settingsLabel = settingsPageModel(data.navigation, currentPage).label;
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
        <button className="new-conversation" onClick={() => navigate('/new')}>
          <Icon name="plus" />
          New conversation
        </button>
        <ProjectsSidebar navigate={navigate} onError={onError} selected={path} openHome={openHome} />
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
        <VersionBanner devices={data.devices} />
        <main className="page-content">
          {setup ? (
            <SetupPage {...props} path={path} key={path} />
          ) : settings ? (
            <div className="settings-layout">
              {settingsNav}
              <div className="settings-content">{settingsPage}</div>
            </div>
          ) : /^\/terminals\/[A-Za-z0-9_-]+$/u.test(path) ? (
            <TerminalPage {...props} id={path.split('/')[2]!} navigation={navigation} key={path} />
          ) : project?.settings ? (
            <ProjectSettingsPage {...props} id={project.projectId} navigation={navigation} key={path} />
          ) : project?.taskId ? (
            <TaskPage {...props} projectId={project.projectId} taskId={project.taskId} key={path} />
          ) : project?.threadId ? (
            <ThreadPage {...props} navigation={navigation} projectId={project.projectId} threadId={project.threadId} key={path} />
          ) : project ? (
            <ProjectWorkPage {...props} navigation={navigation} id={project.projectId} key={path} />
          ) : path.startsWith('/cursor/') || path.startsWith('/sessions/') ? (
            <CursorConversationPage {...props} navigation={navigation} id={path.split('/')[2]!.split('?')[0]!} key={path} />
          ) : path.startsWith('/conversations/') ? (
            <ConversationPage {...props} navigation={navigation} id={path.split('/')[2]!.split('?')[0]!} key={path} />
          ) : path.split('?')[0] === '/' ? (
            <p role="status">Opening your projects…</p>
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
