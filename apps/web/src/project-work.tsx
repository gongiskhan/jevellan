import {ProjectNotebookEditorSchema,projectNotebookEditor,projectNotebookCommand,projectNotebookFailure} from '@jevellan/core/client';
import { ChangesButton } from './worktree-changes.js';
import {projectClientIds,projectFailureText,projectLocalFailure,projectCoordinatorComposerFromUi,projectCoordinatorComposerState,projectCoordinatorClearedText,projectCoordinatorMessageCommand,projectCoordinatorControlCommand,projectCoordinatorTransport,type ProjectCoordinatorComposer} from '@jevellan/core/client';
import {projectChatThreadTitles,projectChatCardContext,type ProjectChatCardContext} from '@jevellan/core/client';
import { ProjectTaskEditorSchema, taskEditorCommand, type ProjectTaskEditor, type ProjectTaskEditorFields } from '@jevellan/core/client';
import { ProjectPageRequestSchema, ProjectStatusEventSchema, ProjectStatusStreamRequestSchema, matchingProjectStatusView, STATUS_REFRESH_WINDOW_MS } from '@jevellan/core/client';
import { CoordinatorOverrideDialog } from './coordinator-editor.js';
import type { ProjectGoalViews, ProjectJobsView } from '@jevellan/core/client';
import { LastDeploy } from './project-deploy.js';
import { SetupCard } from './setup-card.js';
import { EmptySchema } from '@jevellan/core/client';
import { AttachmentControls, LibraryMessage, ProjectLibraryPanel, useProjectAttachments } from './project-library.js';
import { ProjectCardsContext, projectCardKey } from './project-cards.js';
import { ThreadCard } from './thread-card.js';
import { ChatWorkCards, ChatSettingsChanges } from './chat-work-cards.js';
import { NightlyBanner, ProjectDailyPanel, type DailyView } from './project-daily.js';
import { MergeWhy } from './merge-route.js';
import { OwnerCommands, OwnerCommandScope } from './owner-commands.js';
import { TerminalLauncher } from './terminal.js';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import {
  CoordinatorMessageReceiptSchema, ProjectWaitingResponseSchema, MergeResultViewSchema, ProjectNotebookViewSchema, ProjectThreadActionsViewSchema,
  ProjectPageViewSchema, ProjectSidebarViewSchema, ProjectWorkSettingsViewSchema, ProjectWorkViewSchema, TaskReceiptSchema,
  type ProjectDecision, type ProjectLedgerEvent, type ProjectSidebarView, type ProjectWorkView,
  type ProjectWorkTask, type ProjectOverview, type OverviewPullRequest, type ProjectHeader, type ProjectCoordinatorActivity, type ProjectWorkCard, type ProjectWaitingItemsView, type ProjectWaitingItem, type ProjectWaitingResponse, type ProjectPageView, type ProjectPageRequest, type ProjectViewNotice,
} from '@jevellan/core/client';
import { ApiError, api, empty, isCancelled } from './api.js';
import { clientId } from './client-id.js';
import { Confirm, Markdown, Modal, Panel, composerClearance, followOnScroll, repinAtEnd, useDismissible, useSettingsSave, useTask, type PageProps } from './components.js';
import { Icon } from './icons.js';
import { MessageInput } from './message-delivery.js';
import * as copy from './project-work-copy.js';
import {
  PROJECT_WORK_UPDATED, chatItems, chatProposalGroups,
  projectDot, projectRoute, rowClockMs,
  toolIcon, type ChatItem, type ProjectTab, type ThreadTitles,
} from './project-work-model.js';
import { queuedRefresh } from './refresh.js';
import { projectStreamState, type ProjectStreamUpdate } from '@jevellan/core/client';
import { ProjectGoals, type GoalEntry } from './project-goals.js';
import { TaskQueue } from './task-queue.js';
import { shortTime, timeStamp } from './time.js';
import { ResponseTime } from './response-time.js';
import { SessionHistory } from './session-history.js';
import { SessionCache, SessionsCache } from './session-cache.js';

// The sidebar section remembers whether it is open; expanded by default (D55).
const sectionKey = 'jevellan-projects-sidebar';
const ProjectsSidebarState = z.object({ schema: z.literal('projects-sidebar-v1'), expanded: z.boolean() });
function readExpanded() {
  try {
    const stored = ProjectsSidebarState.safeParse(JSON.parse(localStorage.getItem(sectionKey) ?? 'null'));
    if (stored.success) return stored.data.expanded;
  } catch {
    // Keep the default when browser storage is unavailable.
  }
  return true;
}
function useSectionExpanded() {
  const [expanded, setExpanded] = useState(readExpanded);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === sectionKey || event.key === null) setExpanded(readExpanded());
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const update = (value: boolean) => {
    setExpanded(value);
    try {
      localStorage.setItem(sectionKey, JSON.stringify(ProjectsSidebarState.parse({ schema: 'projects-sidebar-v1', expanded: value })));
    } catch {
      // The toggle still works for this visit.
    }
  };
  return { expanded, update };
}

/**
 * Every registered project under New conversation (12.1): name, the magenta count of open questions and a muted count of
 * running threads. Its own navigation landmark inside the Conversations aside (D96), polled like the conversation list.
 */
export function ProjectsSidebar({ navigate, onError, selected, openHome }: Pick<PageProps, 'navigate' | 'onError'> & { selected: string; openHome(projectId?: string): void }) {
  const section = useSectionExpanded();
  const listId = useId();
  const [view, setView] = useState<ProjectSidebarView>();
  useEffect(() => {
    let stopped = false;
    let running = false;
    const controller = new AbortController();
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const next = await api('/api/project-work/sidebar', ProjectSidebarViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true });
        if (!stopped) setView(next);
      } catch (error) {
        if (!stopped) onError(error);
      } finally {
        running = false;
      }
    };
    const changed = () => void load();
    window.addEventListener(PROJECT_WORK_UPDATED, changed);
    void load();
    const timer = setInterval(changed, 5000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener(PROJECT_WORK_UPDATED, changed);
    };
  }, [onError, selected]);
  const byId = new Map(view?.projects.map(row => [row.projectId, row]));
  const rows = view?.activeIds.flatMap(id => byId.get(id) ?? []) ?? [], archived = view?.archivedIds.flatMap(id => byId.get(id) ?? []) ?? [];
  useEffect(() => {
    if (view && selected.split('?')[0] === '/') openHome(view.defaultProject ?? undefined);
  }, [view, selected, openHome]);
  const current = projectRoute(selected)?.projectId;
  const waiting = view?.waitingTotal ?? 0;
  // The list is capped, so the current project's row may sit below its fold (always in the phone drawer once a few
  // projects exist): it is scrolled into the list once per project opened, without moving the page (D244).
  const list = useRef<HTMLDivElement>(null);
  const revealed = useRef<string | undefined>(undefined);
  const loaded = view !== undefined;
  useLayoutEffect(() => {
    if (!current) { revealed.current = undefined; return; }
    const element = list.current;
    const row = element?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!element || !row || !section.expanded || revealed.current === current) return;
    revealed.current = current;
    const top = row.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + row.offsetHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + row.offsetHeight - element.clientHeight;
  }, [current, loaded, section.expanded]);
  return (
    <nav className="pw-sidebar" aria-label={copy.PROJECTS}>
      <button type="button" className="pw-sidebar-toggle" aria-expanded={section.expanded} aria-controls={listId}
        onClick={() => section.update(!section.expanded)}>
        {copy.PROJECTS}
        <span className="sr-only">{copy.SECTION_SUFFIX}</span>
        {!section.expanded && waiting > 0 && (
          <span className="suggestion-count">{waiting}<span className="sr-only">{copy.WAITING_SUFFIX}</span></span>
        )}
      </button>
      <div className="pw-sidebar-list" id={listId} ref={list} hidden={!section.expanded}>
        {view && !rows.length ? (
          <p className="pw-sidebar-empty">
            {copy.NO_PROJECTS}{' '}
            <button type="button" className="text-button" onClick={() => navigate('/settings/projects')}>{copy.ADD_PROJECT}</button>
          </p>
        ) : (
          rows.map((row) => (
            <button key={row.projectId} type="button" className={`pw-sidebar-row ${current === row.projectId ? 'selected' : ''}`}
              aria-current={current === row.projectId ? 'page' : undefined} onClick={() => navigate(`/projects/${row.projectId}`)}>
              <i className={projectDot(row)} aria-hidden="true" />
              <span className="pw-sidebar-name" title={row.name}>{row.name}</span>
              {(row.running > 0 || row.waiting > 0) && (
                <span className="pw-sidebar-counts">
                  {row.running > 0 && <span className="pw-sidebar-running">{copy.runningCount(row.running)}</span>}
                  {row.waiting > 0 && <span className="suggestion-count">{row.waiting}<span className="sr-only">{copy.WAITING_SUFFIX}</span></span>}
                </span>
              )}
            </button>
          ))
        )}
      </div>
      {section.expanded && archived.length > 0 && <details className="pw-archived-projects">
        <summary>{copy.archivedProjects(archived.length)}</summary>
        {archived.map(row => <button type="button" key={row.projectId} className={`pw-sidebar-row ${current === row.projectId ? 'selected' : ''}`} aria-current={current === row.projectId ? 'page' : undefined} onClick={() => navigate(`/projects/${row.projectId}`)}>
          <i className={projectDot(row)} aria-hidden="true" /><span className="pw-sidebar-name">{row.name}</span>
        </button>)}
      </details>}
    </nav>
  );
}


function ProjectStatusBanner({ projectId, banner, props }: { projectId: string; banner: NonNullable<ProjectHeader['banner']>; props: PageProps }) {
  const local = useLocalError(props.onError), task = useTask(local.fail), save = useSettingsSave();
  return <div className="pw-project-status" role="status"><p>{banner.text}</p>
    <button type="button" className="secondary" disabled={task.busy} onClick={() => void task.run(async signal => {
      await save(`/api/projects/${projectId}/work-settings`, ProjectWorkSettingsViewSchema, 'PUT', banner.request, signal);
      updated();
    })}>{banner.actionLabel}</button>{local.error && <p className="error">{local.error}</p>}
  </div>;
}

// ---------- shared pieces of the Projects pages ----------

export const updated = () => window.dispatchEvent(new Event(PROJECT_WORK_UPDATED));
/**
 * A success toast from a dialog that closes in the same update. The app's toast joins the dialog that is open when it
 * mounts, so a message sent while its dialog closes would land in the closing dialog and never show; this waits (a few
 * frames at most) until no dialog is open (D229).
 */
export function afterDialogs(message: (text: string) => void, text: string) {
  let frames = 0;
  const send = () => {
    if (document.querySelector('dialog[open]') && ++frames < 30) requestAnimationFrame(send);
    else message(text);
  };
  requestAnimationFrame(send);
}
export const failureText = projectFailureText;

/**
 * A request failure shown where it happened. Sign-in failures still go to the app's handler; every other refusal (Projects
 * answer 409 for revision conflicts, placement refusals, merge refusals and remote work) stays out of its global 409 reload.
 */
export function useLocalError(onError: (error: unknown) => void) {
  const [error, setError] = useState('');
  const fail = useCallback((failure: unknown) => {
    const model = projectLocalFailure(failure, { schema: 'project-local-failure-context-v1', cancelled: isCancelled(failure), ...(failure instanceof ApiError ? { apiStatus: failure.status } : {}) });
    if (model.route === 'global') onError(failure);
    else if (model.route === 'local') setError(model.text!);
  }, [onError]);
  return { error, setError, fail };
}

/** Idempotency ids: one id per payload until it succeeds, then a fresh one, so a retried send never repeats a message (PJ2e). */
export function useClientIds(prefix: string) {
  const state = useRef<ReturnType<typeof projectClientIds> | undefined>(undefined);
  state.current ??= projectClientIds(clientId);
  return { id: (value: unknown) => state.current!.id(prefix, value), done: () => state.current!.done() };
}

/** The clock for elapsed times; `interval` follows what the rows show (`rowClockMs`). */
function useNow(interval: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/** An in-app link: a plain click navigates without a reload; modified and middle clicks keep the browser's behavior. */
export function RouteLink({ href, navigate, className, children }: { href: string; navigate(path: string): void; className?: string; children: ReactNode }) {
  return (
    <a className={className} href={href} onClick={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(href);
    }}>{children}</a>
  );
}

export function Stamp({ at, label }: { at: string; label?: string }) {
  const stamp = timeStamp(at);
  return stamp ? <time dateTime={at} title={stamp.title}>{label ?? stamp.label}</time> : null;
}

export const runtimeNames = (data: PageProps['data']) => (runtime: string) => data.runtimes.find((entry) => entry.id === runtime)?.displayName ?? runtime;
export const deviceNames = (data: PageProps['data']) => (deviceId: string) => data.devices.devices.find((entry) => entry.id === deviceId)?.name ?? deviceId;
const TABS: readonly ProjectTab[] = ['chat', 'overview'];
const OVERVIEW_TABS = ['threads', 'pull-requests', 'queue', 'routines', 'library'] as const;

/**
 * The project page (12.2): the coordinator chat with Waiting for you, Running, Pull requests and Concluded beside it from
 * 840 px of page width (D53), or one of them at a time under the tab bar. One work view feeds everything; it is read on
 * open, after every chat event, every 5 s (thread indexes change without chat events) and after every Projects mutation.
 * The chat streams from the coordinator's device; when a move changes that device the chat starts over from the new
 * device's history (3.5.3, D272).
 */
export function ProjectWorkPage(props: PageProps & { id: string; navigation: ReactNode }) {
  const { id, navigation, onError, message, navigate, data } = props;
  const here = data.devices.currentDeviceId;
  const titleId = useId(); const tabsId = useId(); const chatId = useId(); const sideId = useId();
  const [view, setView] = useState<ProjectWorkView>();
  const [overview, setOverview] = useState<ProjectOverview>();
  const [cards, setCards] = useState<ProjectWorkCard[]>([]);
  const cardModels = useMemo(() => new Map(cards.map(card => [projectCardKey(card.kind, card.id), card])), [cards]);
  const [header, setHeader] = useState<ProjectHeader>();
  const [taskEditorRevision, setTaskEditorRevision] = useState('');
  const [waiting, setWaiting] = useState<ProjectWaitingItemsView>();
  const [notices, setNotices] = useState<ProjectViewNotice[]>([]);
  const ackKnown = useRef<string[] | undefined>(undefined);
  const acceptPage = useRef<(page: ProjectPageView) => void>(() => {});
  const [coordinatorActivity, setCoordinatorActivity] = useState<ProjectCoordinatorActivity>();
  const viewer = useRef({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language });
  const [goals, setGoals] = useState<GoalEntry[]>([]);
  const [daily, setDaily] = useState<DailyView>();
  const [goalViews, setGoalViews] = useState<ProjectGoalViews>();
  const [routines, setRoutines] = useState<ProjectJobsView>();
  const [tasks, setTasks] = useState<ProjectWorkTask[]>([]);
  const chatCardContext = useMemo(() => projectChatCardContext({ schema: 'project-chat-card-context-v1', projectId: view?.project.id ?? id, tasks: view ? tasks : [], threads: view?.threads ?? [], cards: view ? cards : [] }), [id, view?.project.id, view?.threads, tasks, cards]);
  const [loadError, setLoadError] = useState('');
  const [events, setEvents] = useState<ProjectLedgerEvent[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [stream, setStream] = useState<'connecting' | 'open' | 'reconnecting' | 'closed'>('connecting');
  const [tab, setTab] = useState<ProjectTab>();
  const [overviewTab, setOverviewTab] = useState<typeof OVERVIEW_TABS[number]>('threads');
  const [resolvedDays, setResolvedDays] = useState(14);
  const resolvedWindow = useRef(resolvedDays);
  const [dialog, setDialog] = useState<'new-thread' | 'coordinator'>();
  const [notebook, setNotebook] = useState(false);
  const [merging, setMerging] = useState<OverviewPullRequest>();
  const [sent, setSent] = useState<{ text: string; known: string[] }>();
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // Withdrawal toasts start after the chat history the first view already covered (D84, D218).
  const after = useRef<number | undefined>(undefined);
  const seen = useRef(new Set<number>());
  const refresh = useRef(() => {});
  useEffect(() => { resolvedWindow.current = resolvedDays; refresh.current(); }, [resolvedDays]);
  const now = useNow(rowClockMs(view?.threads ?? [], Date.now()));

  useEffect(() => {
    setCoordinatorActivity(undefined); setNotices([]);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    // The chat stream resumes by itself after a dropped connection; a refused one (the coordinator lives elsewhere) is
    // reopened from the last event with a growing delay, and the view's notices explain the coordinator meanwhile.
    let source: EventSource | undefined; let retry: ReturnType<typeof setTimeout> | undefined; let stopped = false;
    const pageRequest = () => ProjectPageRequestSchema.parse({ schema: 'project-page-request-v1', ...viewer.current, resolvedDays: resolvedWindow.current, ...(ackKnown.current ? { ackKnown: ackKnown.current } : {}) });
    const state = projectStreamState({ schema: 'project-stream-context-v1', projectId: id, hereDeviceId: here, ...(after.current === undefined ? {} : { baseline: after.current }) });
    const apply = (update: ProjectStreamUpdate) => {
      if (update.events !== undefined) { setEvents(update.events); setHistoryLoaded(true); }
      if (update.notices !== undefined) setNotices(update.notices);
      if (update.coordinatorActivity !== undefined) setCoordinatorActivity(update.coordinatorActivity);
      if (update.refresh) refresh.current();
    };
    const open = () => {
      const query = new URLSearchParams({ statusView: JSON.stringify(ProjectStatusStreamRequestSchema.parse({ schema: 'project-status-stream-request-v1', page: pageRequest() })) });
      if (state.after) query.set('after', String(state.after));
      const current = new EventSource(`/api/projects/${id}/coordinator/events?${query}`);
      source = current; setStream('connecting');
      current.onopen = () => { if (stopped || current !== source) return; state.opened(); setStream('open'); };
      current.onerror = () => {
        if (stopped || current !== source) return;
        if (current.readyState !== EventSource.CLOSED) { setStream('reconnecting'); return; }
        setStream('closed');
        if (!stopped) { retry = setTimeout(open, state.retryDelay()); }
      };
      current.addEventListener('status-view', (frame: MessageEvent<string>) => {
        if (stopped || current !== source) return;
        try {
          const value = ProjectStatusEventSchema.parse(JSON.parse(frame.data));
          if (matchingProjectStatusView(value, pageRequest())) reads.push(value.view);
        } catch (failure) { stopped = true; current.close(); setStream('closed'); onError(failure); }
      });
      current.addEventListener('cursor', (frame: MessageEvent<string>) => {
        if (stopped || current !== source) return;
        apply(state.cursor(frame.data));
      });
      current.addEventListener('project', (frame: MessageEvent<string>) => {
        if (stopped || current !== source) return;
        try {
          apply(state.frame(frame.data));
        } catch (failure) {
          stopped = true; current.close(); setStream('closed'); onError(failure);
        }
      });
    };
    // The chat shows one device's ledger: the coordinator's, or this device's before any assignment. When a move changes that
    // device the chat starts over from the new device's history, whose event ids overlap the old one's, so neither the cursor nor
    // the shown events carry over (3.5.3, D272). An open stream to the old device never fails by itself, so the view decides.
    const restart = () => {
      source?.close(); clearTimeout(retry); setHistoryLoaded(false);
      seen.current = new Set(); setEvents([]); setCoordinatorActivity(undefined); setNotices([]);
      if (!stopped) open();
    };
    const accept = (pageView: ProjectPageView) => {
      if (stopped || pageView.work.project.id !== id) return;

        const next = pageView.work;
        const result = state.snapshot({ schema: 'project-stream-snapshot-v1', projectId: next.project.id, coordinatorDeviceId: next.coordinator.deviceId ?? null, lastEventId: next.lastEventId });
        if (result.initial) setTab(new URLSearchParams(location.search).get('view') === 'overview' ? 'overview' : pageView.overview.defaultSurface);
        after.current = result.baseline;
        if (result.moved) restart();
        apply(result.update);
        setView(next); setTaskEditorRevision(pageView.changeToken); setLoadError('');
        setTasks(pageView.tasks); setGoals(pageView.goals); setGoalViews(pageView.goalViews); setDaily(pageView.daily); setRoutines(pageView.routines); setOverview(pageView.overview); setHeader(pageView.header); setCards(pageView.cards); setWaiting(pageView.waiting);
    };
    acceptPage.current = accept;
    const reads = queuedRefresh(
      signal => api(`/api/projects/${id}/status-view`, ProjectPageViewSchema, 'POST',
        pageRequest(), { signal, waitForHub: true }),
      accept,
      (failure) => {
        const model = projectLocalFailure(failure, { schema: 'project-local-failure-context-v1', cancelled: isCancelled(failure), ...(failure instanceof ApiError ? { apiStatus: failure.status } : {}) });
        if (model.route === 'global') onError(failure);
        else if (model.route === 'local') setLoadError(model.text!);
      },
    );
    const read = () => void reads.request();
    refresh.current = () => { clearTimeout(debounce); debounce = setTimeout(read, STATUS_REFRESH_WINDOW_MS); };
    read();
    const poll = setInterval(read, 5000);
    window.addEventListener(PROJECT_WORK_UPDATED, read);
    open();
    return () => {
      stopped = true; if (acceptPage.current === accept) acceptPage.current = () => {}; reads.stop(); clearTimeout(debounce); clearTimeout(retry); clearInterval(poll);
      window.removeEventListener(PROJECT_WORK_UPDATED, read); source?.close();
    };
  }, [id, onError, here]);

  const loaded = view !== undefined;
  useEffect(() => {
    if (after.current === undefined) return;
    for (const notice of notices) {
      if (notice.id <= after.current || seen.current.has(notice.id)) continue;
      seen.current.add(notice.id); message(notice.text);
    }
  }, [notices, loaded, message]);

  // Two columns or tabs follow the page width (D53); the sticky tabs and side column sit under the sticky heading.
  const page = useRef<HTMLDivElement>(null); const heading = useRef<HTMLDivElement>(null); const chat = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = page.current; const head = heading.current; if (!element || !head) return;
    const measure = () => {
      setWide(element.getBoundingClientRect().width >= 840);
      element.style.setProperty('--pw-sticky-top', `${Math.round(head.getBoundingClientRect().height)}px`);
      const layout = element.querySelector('.pw-layout');
      if (layout) element.style.setProperty('--pw-layout-top', `${Math.ceil(layout.getBoundingClientRect().top + window.scrollY)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element); observer.observe(head);
    return () => observer.disconnect();
  }, [daily?.mergesHeld, daily?.window?.id, daily?.window?.state]);
  const current = tab ?? 'chat';
  const chatShown = wide || current === 'chat';
  // Follow the newest chat entry while the chat is on screen, unless the reader scrolled up (as the reading pages do).
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    const follows = followOnScroll(pinned, 160);
    const scrolled = () => setBehind(!follows());
    // Only scrolling up unpins; a resize re-pins once the end is in view (see followOnScroll and repinAtEnd).
    const resized = () => repinAtEnd(pinned, 160, () => setBehind(false));
    window.addEventListener('scroll', scrolled, { passive: true }); window.addEventListener('resize', resized);
    return () => { window.removeEventListener('scroll', scrolled); window.removeEventListener('resize', resized); };
  }, []);
  useEffect(() => {
    const element = chat.current; if (!element || !chatShown) return;
    const follow = () => { repinAtEnd(pinned, 160, () => setBehind(false)); if (pinned.current) window.scrollTo({ top: document.documentElement.scrollHeight }); };
    follow();
    const observer = new ResizeObserver(follow); observer.observe(element);
    return () => observer.disconnect();
  }, [chatShown, loaded]);
  const choose = (next: ProjectTab) => {
    setTab(next);
    if (next === 'chat') pinned.current = true;
    else window.scrollTo({ top: 0 });
  };

  const deviceName = useMemo(() => deviceNames(data), [data]);
  const threads = view?.threads;
  const titles = useMemo<ThreadTitles>(() => {
    return projectChatThreadTitles(threads ?? []);
  }, [threads]);
  const items = useMemo(() => chatItems(events, titles), [events, titles]);
  const proposalGroups = useMemo(() => chatProposalGroups(items, tasks), [items, tasks]);
  const menu = useDismissible();
  const menuMoveNote = useId();
  const control = useTask(onError);
  // A refused move (the coordinator started a turn meanwhile) stays on the page, never the app's global 409 reload, until the
  // coordinator's device changes or the menu offers the move again.
  const moveFailure = useLocalError(onError);
  const moving = useTask(moveFailure.fail);
  const { setError: setMoveError } = moveFailure;
  const movable = view?.coordinator.canMoveHere; const coordinatorId = view?.coordinator.deviceId;
  useEffect(() => setMoveError(''), [coordinatorId, setMoveError]);
  useEffect(() => { if (movable) setMoveError(''); }, [movable, setMoveError]);
  const closeMenu = () => { if (menu.current) menu.current.open = false; };

  if (!view || !overview || !header || !waiting || !routines) {
    return (
      <div className="conversation-page pw-page" ref={page}>
        <div className="section-heading conversation-heading" ref={heading}>
          <h1 aria-labelledby={titleId}>{navigation}<span id={titleId} className="session-title" /></h1>
        </div>
        {loadError ? <p className="error">{loadError}</p> : (
          <p className="page-loading" role="status"><span className="activity-spinner" aria-hidden="true" />{copy.LOADING_PROJECT}</p>
        )}
      </div>
    );
  }

  // Select a newer engine projection; turn interpretation and eligibility stay on the server.
  const coordinatorUi = header.live && coordinatorActivity && coordinatorActivity.seq > header.atEventId ? header.live[coordinatorActivity.state] : header.current;
  const chip = coordinatorUi.chip;
  const coordinator = view.coordinator;
  const composerModel = projectCoordinatorComposerFromUi(id, here, coordinatorUi);
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const drafts = overview.waiting.draftIds.flatMap(id => taskById.get(id) ?? []);
  const open = waiting.open.filter(item => !answered.has(item.decision.id));
  const byId = new Map(view.threads.map(thread => [thread.id, thread]));
  const rows = (ids: readonly string[]) => ids.flatMap(id => byId.get(id) ?? []);
  const waitingThreads = rows(overview.waiting.threadIds);
  const pulls = overview.pullRequests, recentPulls = overview.recentlyMerged;
  const stop = () => void control.run(async (signal) => {
    const command = projectCoordinatorControlCommand(id, 'stop'), request = projectCoordinatorTransport(command);
    setView(await api(request.path, ProjectWorkViewSchema, 'POST', command.body, { signal, waitForHub: request.waitForHub })); updated();
  });
  const fresh = () => void control.run(async (signal) => {
    const command = projectCoordinatorControlCommand(id, 'fresh'), request = projectCoordinatorTransport(command);
    setView(await api(request.path, ProjectWorkViewSchema, 'POST', command.body, { signal, waitForHub: request.waitForHub })); updated();
    message(copy.FRESH_STARTED);
  });
  // Move coordinator here (brief 9.8, 3.5.3): the answer is the view with this device's coordinator; the page's next read sees the
  // device change and starts the chat over from this device's history.
  const moveHere = async (signal: AbortSignal) => {
    const command = projectCoordinatorControlCommand(id, 'move'), request = projectCoordinatorTransport(command);
    try { setView(await api(request.path, ProjectWorkViewSchema, 'POST', command.body, { signal, waitForHub: request.waitForHub })); }
    finally { updated(); }
  };
  const move = () => void moving.run(async (signal) => { setMoveError(''); await moveHere(signal); });
  const answeredQuestion = (decision: ProjectDecision, result: ProjectWaitingResponse) => {
    acceptPage.current(result.page);
    if (result.feedback) {
      ackKnown.current = result.feedback.known;
      setAnswered(previous => new Set([...previous, decision.id])); setSent(result.feedback);
    }
    updated();
  };
  const answerView: Omit<ProjectPageRequest, 'schema'> = { ...viewer.current, resolvedDays, ...(ackKnown.current ? { ackKnown: ackKnown.current } : {}) };
  const sectionHeading = (sectionId: string, title: string, count: number) => (
    <div className="pw-section-heading">
      <h3 id={sectionId}>{title}</h3>{' '}
      <span className="pw-count">{count}</span>
    </div>
  );
  const sidePanel = !wide && current !== 'chat' ? { role: 'tabpanel', 'aria-labelledby': `${tabsId}-${current}` } : {};
  const chatPanel = !wide && current === 'chat' ? { role: 'tabpanel', 'aria-labelledby': `${tabsId}-chat` } : {};

  return (
    <ProjectCardsContext.Provider value={cardModels}>
    <OwnerCommandScope value={{ projectId: id, deviceId: coordinator.deviceId ?? undefined, cwd: 'checkout', deviceName, deviceForThread: threadId => view.threads.find(thread => thread.id === threadId)?.ownerDeviceId, navigate, onError }}>
    <div className="conversation-page pw-page" ref={page}>
      <div className="section-heading conversation-heading pw-heading" ref={heading}>
        <h1 aria-labelledby={titleId}>{navigation}<span id={titleId} className="session-title" title={view.project.name}>{view.project.name}</span></h1>
        <div className="actions">
          <button type="button" className="secondary pw-head-button" aria-label={copy.TAB_LABELS.terminal} title={copy.TAB_LABELS.terminal} aria-pressed={current === 'terminal'} onClick={() => choose(current === 'terminal' ? 'chat' : 'terminal')}><Icon name="runtimes" size={15} /></button>
          <ChangesButton path={`/api/projects/${id}/changes`} title={`Uncommitted changes · ${view.project.name}`} />
          <button type="button" className="secondary pw-head-button" onClick={() => setDialog('coordinator')}><Icon name="tune" size={15} /><span className="pw-head-label">Override coordinator</span></button>
          <button type="button" className="pw-head-button" onClick={() => setDialog('new-thread')}>
            <Icon name="plus" size={15} /><span className="pw-head-label">{copy.NEW_THREAD}</span>
          </button>
          <button type="button" className="secondary pw-head-button" aria-pressed={notebook} onClick={() => setNotebook(!notebook)}>
            <Icon name="file" size={15} /><span className="pw-head-label">{copy.NOTEBOOK}</span>
          </button>
          <details className="conversation-menu" ref={menu}>
            <summary aria-label={copy.PROJECT_MENU}><Icon name="more" /></summary>
            <div>
              <button type="button" onClick={() => { closeMenu(); navigate(`/projects/${id}/settings`); }}>{copy.PROJECT_SETTINGS}</button>
              <button type="button" disabled={control.busy || !coordinatorUi.controls.canSuggestSetup} onClick={() => { closeMenu(); void control.run(async signal => { await api(`/api/projects/${id}/setup-request`, EmptySchema, 'POST', { schema: 'project-run-request-v1', clientRequestId: `setup_${clientId()}` }, { signal, waitForHub: true }); updated(); }); }}>{copy.SUGGEST_SETUP}</button>
              {coordinatorUi.controls.canMove && (
                <button type="button" disabled={moving.busy || !coordinatorUi.controls.moveEnabled} aria-describedby={coordinatorUi.controls.moveRefusal ? menuMoveNote : undefined}
                  onClick={() => { closeMenu(); move(); }}>{copy.MOVE_COORDINATOR}</button>
              )}
              {coordinatorUi.controls.canMove && coordinatorUi.controls.moveRefusal && <p className="pw-menu-note" id={menuMoveNote}>{coordinatorUi.controls.moveRefusal}</p>}
            </div>
          </details>
        </div>
        <div className="conversation-meta pw-coordinator">
          <span className={`chip pw-chip pw-chip-${chip.tone}`}>
            {chip.tone === 'running' && <span className="activity-spinner" aria-hidden="true" />}{chip.label}
          </span>
          {chip.session && <span className="pw-session">{chip.session}</span>}
        </div>
        <div className="conversation-meta pw-context">
          {coordinatorUi.contextLine && <span aria-label="Coordinator context">{coordinatorUi.contextLine}</span>}
          <button type="button" className="secondary" disabled={control.busy || !coordinatorUi.controls.canFresh} onClick={fresh}>{copy.FRESH_COORDINATOR}</button>
          <SessionCache view={view.cacheView} />
        </div>
      </div>
      {loadError && <p className="notice" role="status">{loadError}</p>}
      <SessionHistory view={view.historyView} />
      <SessionsCache view={view.cacheView} />
      {coordinatorUi.contextNotice && <p className="notice" role="status">{coordinatorUi.contextNotice}</p>}
      {header.banner && <ProjectStatusBanner projectId={id} banner={header.banner} props={props} />}
      {routines && <NightlyBanner view={routines} />}
      {coordinatorUi.unavailableNotice && <p className="notice">{coordinatorUi.unavailableNotice}</p>}
      {coordinatorUi.offlineNotice && <OfflineNotice text={coordinatorUi.offlineNotice} canMove={coordinatorUi.controls.canMove} enabled={coordinatorUi.controls.moveEnabled} refusal={coordinatorUi.controls.moveRefusal ?? undefined} moving={moving.busy} move={move} />}
      {moveFailure.error && <p className="error" role="alert">{moveFailure.error}</p>}
      {stream === 'reconnecting' && <p className="notice" role="status">{copy.RECONNECTING}</p>}
      <div className="pw-tabs" role="tablist" aria-label={copy.PROJECT_SECTIONS} onKeyDown={(event) => {
        const index = TABS.indexOf(current);
        const next = event.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length] : event.key === 'ArrowLeft' ? TABS[(index + TABS.length - 1) % TABS.length]
          : event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS.at(-1) : undefined;
        if (!next) return;
        event.preventDefault(); choose(next); document.getElementById(`${tabsId}-${next}`)?.focus();
      }}>
        {TABS.map((name) => (
          <button key={name} type="button" role="tab" id={`${tabsId}-${name}`} className="pw-tab" aria-selected={current === name}
            aria-controls={name === 'chat' ? chatId : sideId} tabIndex={current === name ? 0 : -1} onClick={() => choose(name)}>
            {name === 'overview' ? copy.OVERVIEW : copy.TAB_LABELS.chat}
            {name === 'overview' && overview.waiting.count > 0 && <>{' '}<span className="suggestion-count">{overview.waiting.count}</span></>}
          </button>
        ))}
      </div>
      {current === 'terminal' && <div className="pw-terminal-tab"><TerminalLauncher props={props} projectId={id} threads={view.threads} {...(coordinator.deviceId ? { coordinatorDeviceId: coordinator.deviceId } : {})} /></div>}
      <div className="pw-layout" data-tab={current}>
        <div className="pw-chat" id={chatId} ref={chat} {...chatPanel}>
          {!historyLoaded ? <p className="page-loading" role="status">{copy.LOADING_CHAT}</p> : items.length ? (
            <div className="timeline pw-timeline" aria-label={copy.CHAT_LABEL}>
              {items.map((item) => <ChatEntry key={item.id} item={item} projectId={id} navigate={navigate} cardContext={chatCardContext} settings={view.settings} changed={updated} onError={onError}
                startAll={proposalGroups.get(item.id) ?? []} />)}
            </div>
          ) : <p className="pw-chat-empty">{copy.EMPTY_CHAT}</p>}
          <Composer model={composerModel}
            behind={behind && chatShown} jump={() => { pinned.current = true; setBehind(false); window.scrollTo({ top: document.documentElement.scrollHeight }); }}
            stopping={control.busy} stop={stop} onError={onError} />
        </div>
        <div className="pw-side" id={sideId} {...sidePanel}>
          <div className="pw-overview-head"><h2 className="pw-overview-title">{copy.OVERVIEW}</h2><LastDeploy projectId={id} fail={onError} /></div>
          <div className="pw-overview-tabs" role="tablist" aria-label={copy.OVERVIEW}>
            {OVERVIEW_TABS.filter(name => name !== 'pull-requests' || overview.showPullRequestsTab).map(name => <button key={name} role="tab" className="pw-tab" aria-selected={overviewTab === name} onClick={() => setOverviewTab(name)}>{name === 'routines' ? copy.ROUTINES : name === 'library' ? copy.LIBRARY : copy.TAB_LABELS[name]}</button>)}
          </div>
          <section className="pw-section" hidden={overviewTab !== 'threads'} data-tab="waiting" aria-labelledby={`${sideId}-waiting`}>
            {sectionHeading(`${sideId}-waiting`, overview.waiting.label, overview.waiting.count)}
            {sent && waiting.showSent && <p className="pw-sent" role="status"><Icon name="check" size={14} />{sent.text}</p>}
            {drafts.length > 0 && goalViews && <div className="pw-proposed"><h4>{copy.PROPOSED_TASKS}</h4><TaskQueue projectId={id} tasks={drafts} goals={goals} view={goalViews.queue} scope="proposed" navigate={navigate} changed={updated} onError={onError} /></div>}
            {open.length ? open.map((item) => (
              <DecisionCard key={item.decision.id} item={item} query={answerView} now={now} answered={answeredQuestion} onError={onError} />
            )) : overview.waiting.isEmpty && <p className="pw-empty">{overview.waiting.emptyText}</p>}
            {waitingThreads.map(thread => <ThreadCard key={thread.id} projectId={id} thread={thread} navigate={navigate} changed={updated} onError={onError} />)}
            {waiting.answered.length > 0 && <AnsweredList items={waiting.answered} now={now} />}
          </section>
          <div hidden={overviewTab !== 'library'}>{overviewTab === 'library' && <ProjectLibraryPanel projectId={id} onError={onError} />}</div>
          <section className="pw-section" hidden={overviewTab !== 'queue'} data-tab="queue" aria-labelledby={`${sideId}-queue`}>
            {sectionHeading(`${sideId}-queue`, 'Queue', overview.queueCount)}
            {goalViews && <TaskQueue projectId={id} tasks={tasks} goals={goals} view={goalViews.queue} grouped navigate={navigate} changed={updated} onError={onError} />}
          </section>
          {(() => { const quiet = overview.sections.filter(section => section.visible && !section.threadIds.length);
            return quiet.length > 0 && <div className="pw-quiet-sections" hidden={overviewTab !== 'threads'} aria-label="Empty sections">
              {quiet.map(section => <span key={section.id} className="pw-quiet" title={section.emptyText}>{section.label}<span className="pw-quiet-count">0</span></span>)}
              {quiet.some(section => section.showOlder) && <button className="text-button small" onClick={() => setResolvedDays(days => days + 14)}>{copy.SHOW_OLDER}</button>}
            </div>; })()}
          {overview.sections.filter(section => section.visible && section.threadIds.length > 0).map(section => <section key={section.id} className="pw-section" hidden={overviewTab !== 'threads'} aria-labelledby={`${sideId}-${section.id}`}>
            {sectionHeading(`${sideId}-${section.id}`, section.label, section.threadIds.length)}
            {section.threadIds.length ? <div className="pw-list">{rows(section.threadIds).map(thread => <ThreadCard key={thread.id} projectId={id} thread={thread} navigate={navigate} changed={updated} onError={onError} />)}</div> : <p className="pw-empty">{section.emptyText}</p>}
            {section.showOlder && <button className="secondary small" onClick={() => setResolvedDays(days => days + 14)}>{copy.SHOW_OLDER}</button>}
          </section>)}
          <section className="pw-section" hidden={overviewTab !== 'pull-requests'} data-tab="pull-requests" aria-labelledby={`${sideId}-pulls`}>
            {sectionHeading(`${sideId}-pulls`, copy.PULL_REQUESTS, pulls.length)}
            {view.githubNotice && <p role="status" className="notice">{view.githubNotice}</p>}
            {pulls.length ? pulls.map((row) => (
              <PullRequestRow key={row.entry.threadId} projectId={id} model={row} navigate={navigate} merge={() => setMerging(row)} />
            )) : <p className="pw-empty">{copy.NO_OPEN_PULL_REQUESTS}</p>}
            {recentPulls.length > 0 && <details><summary>Recently merged · last 7 days</summary>{recentPulls.map(row => <PullRequestRow key={row.entry.threadId} projectId={id} model={row} navigate={navigate} merge={() => undefined} />)}</details>}
          </section>
          <section className="pw-section" hidden={overviewTab !== 'routines'} data-tab="routines" aria-labelledby={`${sideId}-daily`}>
            {sectionHeading(`${sideId}-daily`, 'Nightly', overview.nightlyCount)}
            {routines && <ProjectDailyPanel view={routines} changed={updated} onError={onError} />}
          </section>
          <section className="pw-section" hidden={overviewTab !== 'routines'} data-tab="routines" aria-labelledby={`${sideId}-goals`}>
            {sectionHeading(`${sideId}-goals`, 'Goals', overview.goalCount)}
            {goalViews && <ProjectGoals view={goalViews} changed={updated} onError={onError} />}
          </section>
        </div>
      </div>
      {dialog === 'new-thread' && <NewThreadDialog props={props} view={view} refreshRevision={taskEditorRevision} coordinatorUi={coordinatorUi} move={moveHere} close={() => setDialog(undefined)} />}
      {dialog === 'coordinator' && <CoordinatorOverrideDialog props={props} view={view} close={() => setDialog(undefined)} />}
      {merging?.entry.pr && (
        <MergeDialog projectId={id} model={merging} onError={onError}
          close={() => setMerging(undefined)} merged={() => { setMerging(undefined); updated(); }} />
      )}
      {notebook && <NotebookPanel projectId={id} projectName={view.project.name} revision={view.notebookRevision} onError={onError} close={() => setNotebook(false)} />}
    </div>
    </OwnerCommandScope>
    </ProjectCardsContext.Provider>
  );
}

/**
 * The 9.8 notice while the coordinator's device is offline (no heartbeat for 10 minutes, or revoked), with Move coordinator here
 * when the move rule lets this device take the coordinator over (D80, D269, D272). When this device cannot run the coordinator the
 * button stays visible but disabled, with the reason on its own line under it (D282), so phones see why without a tooltip.
 */
function OfflineNotice({ text, canMove, enabled, refusal, moving, move }: { text: string; canMove: boolean; enabled: boolean; refusal?: string | undefined; moving: boolean; move(): void }) {
  const note = useId();
  return (
    <div className="notice pw-offline">
      <p>{text}</p>
      {/* Both labels share one cell, so the button keeps its width while it moves and the notice never reflows. */}
      {canMove && (
        <button type="button" className="secondary pw-move" disabled={moving || !enabled} aria-describedby={refusal ? note : undefined} onClick={move}>
          <span aria-hidden={moving}>{copy.MOVE_COORDINATOR}</span><span aria-hidden={!moving}>{copy.MOVING_COORDINATOR}</span>
        </button>
      )}
      {canMove && refusal && <p className="pw-move-refusal" id={note}>{refusal}</p>}
    </div>
  );
}

/** One chat entry (12.2): owner messages right-aligned, Markdown replies, muted tool one-liners, event cards and notices. */
function ChatEntry({ item, projectId, navigate, cardContext, settings, changed, onError, startAll }: {
  item: ChatItem; projectId: string; navigate(path: string): void; cardContext: ProjectChatCardContext;
  settings: ProjectWorkView['settings']; changed(): void; onError(error: unknown): void; startAll: string[];
}) {
  const thread = (threadId: string) => `/projects/${projectId}/threads/${threadId}`;
  switch (item.kind) {
    case 'routed': return <ChatWorkCards {...{ item, projectId, cardContext, startAll, navigate, changed, onError }} />;
    case 'setup': return <SetupCard projectId={projectId} proposalId={item.proposalId} changed={changed} onError={onError} />;
    case 'settings': return <ChatSettingsChanges projectId={projectId} change={item.change} settings={settings} changed={changed} onError={onError} />;
    case 'owner':
      return (
        <article className="user-message pw-owner">
          <div className="message-heading"><strong>{item.heading}</strong><Stamp at={item.at} /></div>
          <LibraryMessage projectId={projectId} text={item.text} />
          {!item.delivered && <p className="pw-pending">{copy.WAITING_FOR_COORDINATOR}</p>}
        </article>
      );
    case 'reply':
      return <div className="pw-reply"><Markdown>{item.text}</Markdown>{item.at && <ResponseTime at={item.at} />}</div>;
    case 'tool': {
      const content = <><Icon name={toolIcon(item.tool)} size={14} /><span>{item.summary}</span></>;
      const className = `pw-tool${item.ok ? '' : ' failed'}`;
      return item.threadId
        ? <RouteLink className={className} href={thread(item.threadId)} navigate={navigate}>{content}</RouteLink>
        : <p className={className}>{content}</p>;
    }
    case 'event':
      return (
        <article className={`pw-event${item.delivered ? '' : ' pending'}`}>
          <p className="pw-event-text">{item.text}</p>
          {item.detail && <p className="pw-event-detail">{item.detail}</p>}
          {(item.threadId || !item.delivered) && (
            <p className="pw-event-foot">
              {item.threadId && <RouteLink className="text-button" href={thread(item.threadId)} navigate={navigate}>{copy.OPEN_THREAD}</RouteLink>}
              {!item.delivered && <span className="pw-pending">{copy.WAITING_FOR_COORDINATOR}</span>}
            </p>
          )}
        </article>
      );
    case 'notice':
      return <p className={item.tone === 'error' ? 'error' : 'notice'}>{item.text}</p>;
  }
}

/**
 * The chat composer: a growing textarea, Enter sends and Shift+Enter breaks the line, a send icon, and while a coordinator
 * turn runs the working line with a Stop icon button. Owner messages queue for the next turn, so Send stays available.
 */
function Composer({ model, behind, jump, stopping, stop, onError }: {
  model: ProjectCoordinatorComposer; behind: boolean; jump(): void; stopping: boolean; stop(): void; onError(error: unknown): void;
}) {
  const projectId = model.projectId, busy = model.working, offline = model.offline, offlineText = model.offlineText;
  const [text, setText] = useState('');
  const attachments = useProjectAttachments(projectId, onError);
  const send = useTask(onError);
  const ids = useClientIds('message');
  const state = projectCoordinatorComposerState(model, { schema: 'project-coordinator-composer-input-v1', text, attachmentCount: attachments.entries.length, sending: send.busy, stopping });
  return (
    <form onPaste={attachments.paste} onDragOver={attachments.dragOver} onDrop={attachments.drop} className="composer card pw-composer" ref={composerClearance} onSubmit={(event) => {
      event.preventDefault();
      if (!state.canSend) return;
      const typed = text;
      void send.run(async (signal) => {
        const prepared = await attachments.prepare(typed, signal), value = prepared.text;
        const command = projectCoordinatorMessageCommand(projectId, ids.id(value), value), request = projectCoordinatorTransport(command);
        await api(request.path, CoordinatorMessageReceiptSchema, 'POST', command.body, { signal, waitForHub: request.waitForHub });
        ids.done(); prepared.clear();
        setText((current) => projectCoordinatorClearedText(current, typed));
        updated();
      });
    }}>
      {(busy || behind) && (
        <div className="cursor-live-bar ordinary-live-bar">
          {busy && <span role="status"><span className="activity-spinner" aria-hidden="true" />{copy.COORDINATOR_WORKING}</span>}
          {behind && <button type="button" className="text-button pw-jump jump-latest" onClick={jump}>{copy.JUMP_TO_LATEST}<Icon name="chevron" size={14} /></button>}
        </div>
      )}
      <AttachmentControls attachments={attachments} disabled={send.busy || offline} />
      <div className="message-input-row">
        <MessageInput value={text} change={setText} label={copy.CHAT_INPUT_LABEL} placeholder={copy.CHAT_PLACEHOLDER} />
        <div className="message-actions">
          {state.showStop && (
            <button type="button" className="pw-stop-icon" aria-label={copy.STOP} title={copy.STOP_COORDINATOR} disabled={!state.canStop} onClick={stop}>
              <Icon name="stop" size={18} />
            </button>
          )}
          <button type="submit" className="send-icon" aria-label={copy.SEND} title={offline ? offlineText : undefined}
            disabled={!state.canSend}><Icon name="send" size={20} /></button>
        </div>
      </div>
    </form>
  );
}

/**
 * A question for the owner (12.2): its source and age, the question as Markdown, the options with their details, and an
 * answer in the owner's own words. Every answer is idempotent by its client id.
 */
function DecisionCard({ item, query, now, answered, onError }: {
  item: ProjectWaitingItem; query: Omit<ProjectPageRequest, 'schema'>; now: number; answered(decision: ProjectDecision, result: ProjectWaitingResponse): void; onError(error: unknown): void;
}) {
  const { decision, number } = item;
  const { error, setError, fail } = useLocalError(onError);
  const task = useTask(fail), ids = useClientIds('answer');
  const [text, setText] = useState(''); const questionId = useId();
  const answer = (value: { optionLabel: string } | { text: string }) => void task.run(async signal => {
    setError('');
    const result = await api(item.respondPath, ProjectWaitingResponseSchema, 'POST', { schema: 'project-waiting-respond-request-v1',
      answer: { ...item.requestBase, clientRequestId: ids.id({ decision: decision.id, revision: decision.revision, ...value }), ...value }, view: query }, { signal, waitForHub: true });
    ids.done(); answered(decision, result);
  });
  return (
    <OwnerCommandScope value={{ threadId: item.commandScope.threadId, decisionId: item.commandScope.decisionId, cwd: item.commandScope.cwd, ...(item.commandScope.clearDevice ? { deviceId: undefined } : {}) }}>
    <section className="answer-card pw-decision" aria-labelledby={questionId}>
      <p className="pw-source"><span className="pw-question-number" aria-label={`Question ${number}`}>{number}</span> {item.source} · <Stamp at={decision.createdAt} label={shortTime(decision.createdAt, now)} /></p>
      <div className="pw-question" id={questionId}>{item.paragraphs ? <div className="pw-deploy-question">{item.paragraphs.map((line, index) => <p key={index}>{line.strong ? <strong>{line.text}</strong> : line.text}</p>)}</div> : <Markdown>{decision.question}</Markdown>}</div>
      <OwnerCommands commands={decision.ownerCommands} />
      {decision.merge?.reason && <p>{decision.merge.reason}</p>}{decision.merge?.failures?.map((failure, index) => <details key={index}><summary>{failure.what}</summary><pre>{failure.output}</pre></details>)}
      {decision.options.length > 0 && <div className="answer-options pw-options">{decision.options.map(option => <button key={option.label} type="button" className="secondary pw-option" disabled={task.busy} onClick={() => answer({ optionLabel: option.label })}>
        <span>{option.label}</span>{option.detail && <small>{option.detail}</small>}
      </button>)}</div>}
      {item.allowsFreeText && <form className="pw-answer" onSubmit={event => { event.preventDefault(); if (!task.busy && text.trim()) answer({ text: text.trim() }); }}>
        <MessageInput value={text} change={setText} label={copy.ANSWER_IN_OWN_WORDS} placeholder={copy.ANSWER_IN_OWN_WORDS} />
        <button className="small" disabled={task.busy || !text.trim()}>{copy.SEND}</button>
      </form>}
      {error && <p className="error">{error}</p>}
    </section>
    </OwnerCommandScope>
  );
}

/** The last 10 answered questions, collapsed (12.2, D52). */
function AnsweredList({ items, now }: { items: readonly ProjectWaitingItem[]; now: number }) {
  return (
    <details className="pw-answered">
      <summary>{copy.ANSWERED} <span className="pw-count">{items.length}</span></summary>
      <ul>
        {items.map(({ decision, source, answerSummary }) => (
          <li key={decision.id}>
            <p className="pw-source">
              {source}
              {decision.answeredAt && <> · <Stamp at={decision.answeredAt} label={shortTime(decision.answeredAt, now)} /></>}
            </p>
            <p className="pw-answered-question">{decision.question}</p>
            {answerSummary !== null && (
              <p className="pw-answered-answer"><Icon name="check" size={13} />{answerSummary}</p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * A pull request (12.2): the GitHub link, the checks and conflict badges, Merge (disabled with its reason on conflicts or
 * failing checks, allowed while checks run) and Open on GitHub; a branch-only thread shows its branch and reason (D58).
 */
function PullRequestRow({ projectId, model, navigate, merge }: { projectId: string; model: OverviewPullRequest; navigate(path: string): void; merge(): void }) {
  const { entry, held: hold, taskId } = model;
  const blockId = useId();
  const thread = `/projects/${projectId}/threads/${entry.threadId}`;
  const pr = entry.pr;
  if (!pr) {
    return (
      <article className="pw-pr">
        <RouteLink className="pw-pr-title" href={thread} navigate={navigate}>{entry.title}</RouteLink>
        {entry.branch && <code className="pw-branch">{entry.branch}</code>}
        {entry.reason && <p className="pw-pr-reason">{entry.reason}</p>}
      </article>
    );
  }
  const badge = model.checks!; const block = model.mergeRefusal;
  return (
    <article className="pw-pr">
      <a className="pw-pr-title" href={pr.url} target="_blank" rel="noopener noreferrer">{copy.pullRequestTitle(pr.number, entry.title)}</a>
      <div className="pw-badges">
        <span className={`chip pw-badge pw-tone-${badge.tone}`}>{badge.text}</span>
        {model.conflicts && <span className="chip pw-badge pw-tone-danger">{copy.CONFLICTS}</span>}
      </div>
      {hold && <p className="pw-pr-reason">Merges are held while the nightly window runs.</p>}
      <div className="pw-pr-actions">
        <MergeWhy projectId={projectId} threadId={entry.threadId} commit={pr.headSha} />
        <RouteLink className="text-button pw-open-thread" href={thread} navigate={navigate}>{copy.OPEN_THREAD}</RouteLink>
        {taskId && <RouteLink className="text-button" href={`/projects/${projectId}/tasks/${taskId}`} navigate={navigate}>Open task</RouteLink>}
        <a className="button-link secondary small" href={pr.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} />{copy.OPEN_ON_GITHUB}</a>
        {model.showMerge && <span className="pw-merge" title={block ?? undefined}>
          <button type="button" className="small" disabled={!!block} title={block ?? undefined} aria-describedby={block ? blockId : undefined} onClick={merge}>
            {copy.MERGE}
          </button>
          {block && <span className="sr-only" id={blockId}>{block}</span>}
        </span>}
      </div>
    </article>
  );
}

/** Merge confirmation comes from the thread owner's engine, with the projected project fallback if unreachable. */
function MergeDialog({ projectId, model, close, merged, onError }: {
  projectId: string; model: OverviewPullRequest; close(): void; merged(): void; onError(error: unknown): void;
}) {
  const { error, setError, fail } = useLocalError(onError), entry = model.entry;
  const task = useTask(fail);
  const [confirmation, setConfirmation] = useState<OverviewPullRequest['mergeConfirmation']>();
  useEffect(() => {
    const controller = new AbortController(); setConfirmation(undefined);
    api(`/api/projects/${projectId}/threads/${entry.threadId}/actions-view`, ProjectThreadActionsViewSchema, 'GET', undefined, { signal: controller.signal })
      .then(view => setConfirmation(view.mergeConfirmation ?? model.mergeConfirmation), (failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) onError(failure);
        setConfirmation(model.mergeConfirmation);
      });
    return () => controller.abort();
  }, [projectId, entry.threadId, model.mergeConfirmation, onError]);
  const copyView = confirmation ?? model.mergeConfirmation;
  return (
    <Confirm title={copyView?.title ?? ''} action={copyView?.actionLabel ?? ''} busy={task.busy || confirmation === undefined} close={close}
      confirm={() => void task.run(async (signal) => {
        setError('');
        const result = await api(`/api/projects/${projectId}/threads/${entry.threadId}/pr/merge`, MergeResultViewSchema, 'POST', empty, { signal });
        if (result.merged) merged(); else setError(result.message ?? copy.MERGE_FAILED);
      })}>
      {confirmation === undefined ? <p className="muted">{copy.LOADING}</p> : <p className="pw-confirm-body">{confirmation?.body}</p>}
      {error && <p className="error">{error}</p>}
    </Confirm>
  );
}

/**
 * New thread (12.2): title, task and the collapsible placement choices, each Automatic by default. Choices the placement
 * phase gates refuse are disabled with their sentence (D88, D221). While the coordinator device is offline no thread can
 * start, so the dialog says so with Move coordinator here instead of failing (D9a); after the move the form starts the thread
 * on this device's coordinator. A started thread opens its page (D74).
 */
function NewThreadDialog({ props, view, refreshRevision, coordinatorUi, move, close }: { props: PageProps; view: ProjectWorkView; refreshRevision: string; coordinatorUi: ProjectHeader['current']; move(signal: AbortSignal): Promise<void>; close(): void }) {
  const { error, setError, fail } = useLocalError(props.onError), task = useTask(fail), moving = useTask(fail), ids = useClientIds('thread_req');
  const [draft, setDraft] = useState<ProjectTaskEditorFields>(), [model, setModel] = useState<ProjectTaskEditor>(), [confirmed, setConfirmed] = useState('');
  const path = `/api/projects/${view.project.id}/tasks/editor`, snapshot = draft ? JSON.stringify(draft) : '', deviceNote = useId();
  useEffect(() => {
    const controller = new AbortController();
    void api(path, ProjectTaskEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(next => {
      setModel(next); setDraft(next.fields); setConfirmed(JSON.stringify(next.fields));
    }).catch(reason => { if (!controller.signal.aborted) fail(reason); });
    return () => controller.abort();
  }, [path, fail]);
  useEffect(() => {
    if (!snapshot) return;
    const controller = new AbortController();
    void api(`${path}/preview`, ProjectTaskEditorSchema, 'POST', { schema: 'project-task-editor-preview-v1', fields: JSON.parse(snapshot) }, { signal: controller.signal, waitForHub: true }).then(next => {
      if (!controller.signal.aborted) { setModel(next); setConfirmed(snapshot); }
    }).catch(reason => { if (!controller.signal.aborted) fail(reason); });
    return () => controller.abort();
  }, [path, snapshot, fail, refreshRevision, props.data.config.revision, props.data.roster]);
  const change = (patch: Partial<ProjectTaskEditorFields>) => setDraft(previous => previous ? { ...previous, ...patch } : previous);
  return <Modal title={copy.NEW_THREAD} close={close}>
    {!draft || !model ? <p role="status">{copy.LOADING}</p> : <form className="pw-new-thread" onSubmit={event => {
      event.preventDefault(); if (coordinatorUi.offline || confirmed !== snapshot) return;
      void task.run(async signal => {
        setError(''); if (!model.plan) throw new Error(model.validation.join(' '));
        const created = await api(`/api/projects/${view.project.id}/tasks`, TaskReceiptSchema, 'POST', { schema: 'project-task-editor-save-v1', clientRequestId: ids.id(draft), fields: draft }, { signal, waitForHub: true });
        ids.done(); updated(); afterDialogs(props.message, model.savedNotice); close(); if (created.taskId) props.navigate(`/projects/${view.project.id}`);
      });
    }}>
      {coordinatorUi.offlineNotice && <OfflineNotice text={coordinatorUi.offlineNotice} canMove={coordinatorUi.controls.canMove} enabled={coordinatorUi.controls.moveEnabled} refusal={coordinatorUi.controls.moveRefusal ?? undefined} moving={moving.busy} move={() => void moving.run(async signal => { setError(''); await move(signal); })} />}
      <label>{copy.TITLE}<input required maxLength={model.limits.title} value={draft.title} onChange={event => change({ title: event.target.value })} /></label>
      <label>{copy.TASK}<textarea aria-label={copy.TASK} required maxLength={model.limits.task} rows={6} value={draft.task} onChange={event => change({ task: event.target.value })} /></label>
      <label>Type<select value={draft.type} onChange={event => change({ type: event.target.value })}>{model.types.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Goal<select value={draft.goalId} onChange={event => change({ goalId: event.target.value })}><option value="">Asks</option>{model.goals.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
      <label className="check"><input type="checkbox" checked={draft.now} onChange={event => change({ now: event.target.checked })} />Start now</label>
      <label>After<select multiple value={draft.after} onChange={event => change({ after: Array.from(event.target.selectedOptions, option => option.value) })}>{model.afterTasks.map(row => <option value={row.id} key={row.id}>{row.label}</option>)}</select></label>
      <label>From branch<input maxLength={model.limits.fromBranch} value={draft.fromBranch} onChange={event => change({ fromBranch: event.target.value })} placeholder="Optional existing branch on origin" /></label>
      <label>Needs<input value={draft.needs} placeholder="residential, mac" onChange={event => change({ needs: event.target.value })} /></label>
      <details className="pw-placement" onToggle={event => { if (event.currentTarget.open) event.currentTarget.querySelector('.pw-placement-fields')?.scrollIntoView({ block: 'nearest' }); }}>
        <summary>Choose where it runs</summary><div className="form-grid pw-placement-fields">
          <label>{copy.MODEL}<select value={draft.modelId} onChange={event => setDraft(taskEditorCommand(draft, model.models, { type: 'model', value: event.target.value }))}>
            <option value="">{copy.AUTOMATIC}</option>{model.models.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
          </select></label>
          <label>{copy.EFFORT}<select value={draft.effort} onChange={event => change({ effort: event.target.value })}><option value="">{copy.AUTOMATIC}</option>{model.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
          <div className="pw-field"><label>{copy.DEVICE}<select value={draft.deviceId} aria-describedby={model.deviceNote ? deviceNote : undefined} onChange={event => change({ deviceId: event.target.value })}>
            <option value="">{copy.AUTOMATIC}</option>{model.devices.map(row => <option key={row.id} value={row.id} disabled={row.disabled}>{row.label}</option>)}
          </select></label>{model.deviceNote && <p className="pw-field-note" id={deviceNote}>{model.deviceNote}</p>}</div>
        </div>
      </details>
      {error && <p className="error">{error}</p>}
      <div className="form-actions"><button type="button" className="secondary" onClick={close}>{copy.CANCEL}</button><button disabled={task.busy || coordinatorUi.offline || confirmed !== snapshot}>{task.busy ? copy.STARTING : copy.START_THREAD}</button></div>
    </form>}
    {error && (!draft || !model) && <p className="error">{error}</p>}
  </Modal>;
}

/**
 * The coordinator's notebook in the inspector (12.2): Markdown to read, Edit to change it with the revision it was read
 * at. When the coordinator wrote in between, the save is refused and Reload shows its version. The panel follows the
 * coordinator's writes while it is only being read.
 */
function NotebookPanel({ projectId, projectName, revision, close, onError }: {
  projectId: string; projectName: string; revision: number; close(): void; onError(error: unknown): void;
}) {
  const { error, setError, fail } = useLocalError(onError);
  const task = useTask(fail);
  const [notebook, setNotebook] = useState<z.infer<typeof ProjectNotebookEditorSchema>>();
  const [draft, setDraft] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const reading = draft === undefined;
  // Edit focuses the text without scrolling: the panel is stuck beside the chat, and a plain focus (React's autoFocus)
  // scrolls the page to the panel's place at its top, away from where the reader left the chat (D243).
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!reading) editor.current?.focus({ preventScroll: true }); }, [reading]);
  useEffect(() => {
    if (!reading) return;
    const controller = new AbortController();
    api(`/api/projects/${projectId}/notebook/editor`, ProjectNotebookEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })
      .then((value) => { setNotebook(value); setError(''); }, (failure: unknown) => { if (!controller.signal.aborted) fail(failure); });
    return () => controller.abort();
  }, [projectId, revision, reading, fail, setError]);
  const content = notebook?.content ?? '';
  const stamp = notebook?.updatedAt ? timeStamp(notebook.updatedAt) : null;
  return (
    <Panel title={copy.NOTEBOOK} eyebrow={projectName} close={close}>
      {!notebook ? (
        error ? <p className="error">{error}</p> : <p className="page-loading" role="status"><span className="activity-spinner" aria-hidden="true" />{copy.LOADING_NOTEBOOK}</p>
      ) : reading ? (
        <div className="pw-notebook">
          <div className="pw-notebook-bar">
            <span className="pw-notebook-meta">{notebook.updatedBy && stamp ? copy.notebookUpdated(notebook.updatedBy, stamp.label) : ''}</span>
            <button type="button" className="secondary small" onClick={() => { setConflict(false); setError(''); setDraft(content); }}>{copy.EDIT}</button>
          </div>
          {error && <p className="error">{error}</p>}
          {notebook.hasContent ? <Markdown>{content}</Markdown> : <p className="pw-empty">{notebook.labels.empty}</p>}
        </div>
      ) : (
        <form className="pw-notebook-edit" onSubmit={(event) => {
          event.preventDefault();
          void task.run(async (signal) => {
            setError(''); setConflict(false);
            try {
              const command = projectNotebookCommand(projectId, notebook.revision, draft!);
              const stored = await api(notebook.paths.save, ProjectNotebookViewSchema, 'PUT', command.body, { signal, waitForHub: true });
              setNotebook(projectNotebookEditor(projectId, stored)); setDraft(undefined); updated();
            } catch (failure) {
              const refusal = projectNotebookFailure({ schema: 'project-notebook-failure-context-v1', ...(failure instanceof ApiError ? { apiStatus: failure.status, apiCode: failure.code } : {}) });
              if (refusal.conflict) { setConflict(true); return; }
              throw failure;
            }
          });
        }}>
          <textarea ref={editor} className="pw-notebook-text" aria-label={notebook.labels.content} value={draft} maxLength={notebook.policy.contentMax}
            onChange={(event) => setDraft(event.target.value)} />
          {conflict && (
            <p className="error">{notebook.labels.conflict}
              <button type="button" className="text-button" onClick={() => { setConflict(false); setDraft(undefined); }}>{copy.RELOAD}</button>
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => { setConflict(false); setError(''); setDraft(undefined); }}>{copy.CANCEL}</button>
            <button disabled={task.busy}>{task.busy ? copy.SAVING : copy.SAVE}</button>
          </div>
        </form>
      )}
    </Panel>
  );
}
