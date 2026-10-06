import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import {
  CoordinatorMessageReceiptSchema, DecisionAnsweredViewSchema, EffortSchema, MergeResultViewSchema, ProjectEventFrameSchema, ProjectNotebookViewSchema,
  ProjectWorkListViewSchema, ProjectWorkSettingsViewSchema, ProjectWorkViewSchema, ThreadCreatedViewSchema, ThreadViewSchema,
  type Effort, type Isolation, type ProjectDecision, type ProjectLedgerEvent, type ProjectWorkListView, type ProjectWorkView, type PullRequestEntry,
  type ThreadIndex,
} from '@jevellan/core/client';
import { ApiError, api, empty, isCancelled } from './api.js';
import { clientId } from './client-id.js';
import { Confirm, Markdown, Modal, Panel, followOnScroll, repinAtEnd, useDismissible, useSettingsSave, useTask, type PageProps } from './components.js';
import { Icon } from './icons.js';
import { MessageInput } from './message-delivery.js';
import * as copy from './project-work-copy.js';
import {
  PROJECT_WORK_UPDATED, chatItems, checksBadge, coordinatorChip, decisionSource, defaultTab, deviceBlock, deviceChoices, dotClass, mainIsolationBlock, mergeBlock,
  openPullRequests, outcomeText, projectDot, projectRoute, rowClockMs, sentText, settingsRequest, showSent, sidebarProjects, threadCreateRequest, threadMeta,
  threadSections, toolIcon, withdrawals, working, type ChatItem, type ProjectTab, type ThreadForm, type ThreadTitles,
} from './project-work-model.js';
import { queuedRefresh } from './refresh.js';
import { relativeDuration, shortTime, timeStamp } from './time.js';

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
export function ProjectsSidebar({ navigate, onError, selected }: Pick<PageProps, 'navigate' | 'onError'> & { selected: string }) {
  const section = useSectionExpanded();
  const listId = useId();
  const [view, setView] = useState<ProjectWorkListView>();
  useEffect(() => {
    let stopped = false;
    let running = false;
    const controller = new AbortController();
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const next = await api('/api/project-work', ProjectWorkListViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true });
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
  const rows = view ? sidebarProjects(view) : [];
  const current = projectRoute(selected)?.projectId;
  const waiting = rows.reduce((total, row) => total + row.waiting, 0);
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
    </nav>
  );
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
export const failureText = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

/**
 * A request failure shown where it happened. Sign-in failures still go to the app's handler; every other refusal (Projects
 * answer 409 for revision conflicts, placement refusals, merge refusals and remote work) stays out of its global 409 reload.
 */
export function useLocalError(onError: (error: unknown) => void) {
  const [error, setError] = useState('');
  const fail = useCallback((failure: unknown) => {
    if (isCancelled(failure)) return;
    if (failure instanceof ApiError && failure.status === 401) onError(failure);
    else setError(failureText(failure));
  }, [onError]);
  return { error, setError, fail };
}

/** Idempotency ids: one id per payload until it succeeds, then a fresh one, so a retried send never repeats a message (PJ2e). */
export function useClientIds(prefix: string) {
  const pending = useRef<{ signature: string; id: string } | undefined>(undefined);
  return {
    id: (value: unknown) => {
      const signature = JSON.stringify(value);
      if (pending.current?.signature !== signature) pending.current = { signature, id: `${prefix}_${clientId()}` };
      return pending.current.id;
    },
    done: () => { pending.current = undefined; },
  };
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
const TABS: readonly ProjectTab[] = ['chat', 'waiting', 'threads', 'pull-requests'];

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
  const [loadError, setLoadError] = useState('');
  const [events, setEvents] = useState<ProjectLedgerEvent[]>([]);
  const [stream, setStream] = useState<'connecting' | 'open' | 'reconnecting' | 'closed'>('connecting');
  const [tab, setTab] = useState<ProjectTab>();
  const [dialog, setDialog] = useState<'new-thread' | 'settings'>();
  const [notebook, setNotebook] = useState(false);
  const [merging, setMerging] = useState<PullRequestEntry>();
  const [sent, setSent] = useState<{ text: string; known: string[] }>();
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // Withdrawal toasts start after the chat history the first view already covered (D84, D218).
  const after = useRef<number | undefined>(undefined);
  const seen = useRef(new Set<number>());
  const refresh = useRef(() => {});
  const now = useNow(rowClockMs(view?.threads ?? [], Date.now()));

  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    // The chat stream resumes by itself after a dropped connection; a refused one (the coordinator lives elsewhere) is
    // reopened from the last event with a growing delay, and the view's notices explain the coordinator meanwhile.
    let source: EventSource | undefined; let retry: ReturnType<typeof setTimeout> | undefined; let last = 0; let delay = 5000; let stopped = false;
    const open = () => {
      const current = new EventSource(`/api/projects/${id}/coordinator/events${last ? `?after=${last}` : ''}`);
      source = current; setStream('connecting');
      current.onopen = () => { delay = 5000; setStream('open'); };
      current.onerror = () => {
        if (current.readyState !== EventSource.CLOSED) { setStream('reconnecting'); return; }
        setStream('closed');
        if (!stopped) { retry = setTimeout(open, delay); delay = Math.min(delay * 2, 60_000); }
      };
      current.addEventListener('project', (frame: MessageEvent<string>) => {
        try {
          const value = ProjectEventFrameSchema.parse(JSON.parse(frame.data)).event;
          last = Math.max(last, value.id);
          setEvents((previous) => previous.some((entry) => entry.id === value.id) ? previous : [...previous, value].sort((a, b) => a.id - b.id));
          refresh.current();
        } catch (failure) {
          stopped = true; current.close(); setStream('closed'); onError(failure);
        }
      });
    };
    // The chat shows one device's ledger: the coordinator's, or this device's before any assignment. When a move changes that
    // device the chat starts over from the new device's history, whose event ids overlap the old one's, so neither the cursor nor
    // the shown events carry over (3.5.3, D272). An open stream to the old device never fails by itself, so the view decides.
    let streaming: string | undefined;
    const restart = () => {
      source?.close(); clearTimeout(retry); last = 0; delay = 5000;
      seen.current = new Set(); setEvents([]);
      if (!stopped) open();
    };
    const reads = queuedRefresh(
      (signal) => api(`/api/projects/${id}/work`, ProjectWorkViewSchema, 'GET', undefined, { signal, waitForHub: true }),
      (next) => {
        const device = next.coordinator.deviceId ?? here; const moved = streaming !== undefined && device !== streaming; streaming = device;
        if (after.current === undefined) setTab(defaultTab(next));
        if (after.current === undefined || moved) after.current = next.lastEventId;
        if (moved) restart();
        setView(next); setLoadError('');
      },
      (failure) => {
        if (failure instanceof ApiError && failure.status === 401) onError(failure);
        else setLoadError(failureText(failure));
      },
    );
    const read = () => void reads.request();
    refresh.current = () => { clearTimeout(debounce); debounce = setTimeout(read, 40); };
    read();
    const poll = setInterval(read, 5000);
    window.addEventListener(PROJECT_WORK_UPDATED, read);
    open();
    return () => {
      stopped = true; reads.stop(); clearTimeout(debounce); clearTimeout(retry); clearInterval(poll);
      window.removeEventListener(PROJECT_WORK_UPDATED, read); source?.close();
    };
  }, [id, onError, here]);

  const loaded = view !== undefined;
  useEffect(() => {
    if (after.current === undefined) return;
    for (const found of withdrawals(events, seen.current, after.current)) {
      seen.current.add(found.id);
      message(copy.questionWithdrawn(found.reason));
    }
  }, [events, loaded, message]);

  // Two columns or tabs follow the page width (D53); the sticky tabs and side column sit under the sticky heading.
  const page = useRef<HTMLDivElement>(null); const heading = useRef<HTMLDivElement>(null); const chat = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = page.current; const head = heading.current; if (!element || !head) return;
    const measure = () => {
      setWide(element.getBoundingClientRect().width >= 840);
      element.style.setProperty('--pw-sticky-top', `${Math.round(head.getBoundingClientRect().height)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element); observer.observe(head);
    return () => observer.disconnect();
  }, []);
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

  const runtimeName = useMemo(() => runtimeNames(data), [data]);
  const deviceName = useMemo(() => deviceNames(data), [data]);
  const threads = view?.threads;
  const titles = useMemo<ThreadTitles>(() => {
    const map = new Map((threads ?? []).map((thread) => [thread.id, thread.title]));
    return (threadId) => map.get(threadId);
  }, [threads]);
  const items = useMemo(() => chatItems(events, titles), [events, titles]);
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

  if (!view) {
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

  const chip = coordinatorChip(view, events, runtimeName);
  const busy = working(events, view);
  const coordinator = view.coordinator;
  const offline = coordinator.state === 'offline';
  const coordinatorDevice = coordinator.deviceName ?? (coordinator.deviceId ? deviceName(coordinator.deviceId) : '');
  const open = view.decisions.open.filter((decision) => !answered.has(decision.id));
  const sections = threadSections(view.threads, now);
  const pulls = openPullRequests(view.pullRequests);
  const stop = () => void control.run(async (signal) => {
    setView(await api(`/api/projects/${id}/coordinator/stop`, ProjectWorkViewSchema, 'POST', empty, { signal })); updated();
  });
  const fresh = () => void control.run(async (signal) => {
    setView(await api(`/api/projects/${id}/coordinator/fresh`, ProjectWorkViewSchema, 'POST', empty, { signal })); updated();
    message(copy.FRESH_STARTED);
  });
  // Move coordinator here (brief 9.8, 3.5.3): the answer is the view with this device's coordinator; the page's next read sees the
  // device change and starts the chat over from this device's history.
  const moveHere = async (signal: AbortSignal) => {
    try { setView(await api(`/api/projects/${id}/coordinator/move`, ProjectWorkViewSchema, 'POST', empty, { signal, waitForHub: true })); }
    finally { updated(); }
  };
  const move = () => void moving.run(async (signal) => { setMoveError(''); await moveHere(signal); });
  const answeredQuestion = (decision: ProjectDecision) => {
    const remaining = open.filter((entry) => entry.id !== decision.id).map((entry) => entry.id);
    setAnswered((previous) => new Set([...previous, decision.id]));
    setSent({ text: sentText(decision, titles), known: remaining });
    updated();
  };
  const sectionHeading = (sectionId: string, title: string, count: number) => (
    <div className="pw-section-heading">
      <h3 id={sectionId}>{title}</h3>{' '}
      <span className="pw-count">{count}</span>
    </div>
  );
  const meta = (thread: ThreadIndex) => threadMeta(thread, runtimeName(thread.runtime), deviceName(thread.ownerDeviceId));
  const sidePanel = !wide && current !== 'chat' ? { role: 'tabpanel', 'aria-labelledby': `${tabsId}-${current}` } : {};
  const chatPanel = !wide && current === 'chat' ? { role: 'tabpanel', 'aria-labelledby': `${tabsId}-chat` } : {};

  return (
    <div className="conversation-page pw-page" ref={page}>
      <div className="section-heading conversation-heading pw-heading" ref={heading}>
        <h1 aria-labelledby={titleId}>{navigation}<span id={titleId} className="session-title" title={view.project.name}>{view.project.name}</span></h1>
        <div className="actions">
          <button type="button" className="pw-head-button" onClick={() => setDialog('new-thread')}>
            <Icon name="plus" size={15} /><span className="pw-head-label">{copy.NEW_THREAD}</span>
          </button>
          <button type="button" className="secondary pw-head-button" aria-pressed={notebook} onClick={() => setNotebook(!notebook)}>
            <Icon name="file" size={15} /><span className="pw-head-label">{copy.NOTEBOOK}</span>
          </button>
          <details className="conversation-menu" ref={menu}>
            <summary aria-label={copy.PROJECT_MENU}><Icon name="more" /></summary>
            <div>
              <button type="button" onClick={() => { closeMenu(); setDialog('settings'); }}>{copy.PROJECT_SETTINGS}</button>
              <button type="button" disabled={control.busy || offline} onClick={() => { closeMenu(); fresh(); }}>{copy.FRESH_COORDINATOR}</button>
              {coordinator.canMoveHere && (
                <button type="button" disabled={moving.busy || !!coordinator.moveRefusal} aria-describedby={coordinator.moveRefusal ? menuMoveNote : undefined}
                  onClick={() => { closeMenu(); move(); }}>{copy.MOVE_COORDINATOR}</button>
              )}
              {coordinator.canMoveHere && coordinator.moveRefusal && <p className="pw-menu-note" id={menuMoveNote}>{coordinator.moveRefusal}</p>}
            </div>
          </details>
        </div>
        <div className="conversation-meta pw-coordinator">
          <span className={`chip pw-chip pw-chip-${chip.tone}`}>
            {chip.tone === 'running' && <span className="activity-spinner" aria-hidden="true" />}{chip.label}
          </span>
          {chip.session && <span className="pw-session">{chip.session}</span>}
        </div>
      </div>
      {loadError && <p className="notice" role="status">{loadError}</p>}
      {coordinator.state === 'unavailable' && coordinator.unavailableReason && <p className="notice">{copy.coordinatorUnavailableNotice(coordinator.unavailableReason)}</p>}
      {offline && <OfflineNotice device={coordinatorDevice} canMove={coordinator.canMoveHere} refusal={coordinator.moveRefusal} moving={moving.busy} move={move} />}
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
            {copy.TAB_LABELS[name]}
            {name === 'waiting' && open.length > 0 && <>{' '}<span className="suggestion-count">{open.length}</span></>}
          </button>
        ))}
      </div>
      <div className="pw-layout" data-tab={current}>
        <div className="pw-chat" id={chatId} ref={chat} {...chatPanel}>
          {items.length ? (
            <div className="timeline pw-timeline" aria-label={copy.CHAT_LABEL}>
              {items.map((item) => <ChatEntry key={item.id} item={item} projectId={id} navigate={navigate} />)}
            </div>
          ) : <p className="pw-chat-empty">{copy.EMPTY_CHAT}</p>}
          <Composer projectId={id} busy={busy} offline={offline} offlineText={offline ? copy.coordinatorOfflineNotice(coordinatorDevice) : ''}
            behind={behind && chatShown} jump={() => { pinned.current = true; setBehind(false); window.scrollTo({ top: document.documentElement.scrollHeight }); }}
            stopping={control.busy} stop={stop} onError={onError} />
        </div>
        <div className="pw-side" id={sideId} {...sidePanel}>
          <section className="pw-section" data-tab="waiting" aria-labelledby={`${sideId}-waiting`}>
            {sectionHeading(`${sideId}-waiting`, copy.WAITING_FOR_YOU, open.length)}
            {sent && showSent(sent, open) && <p className="pw-sent" role="status"><Icon name="check" size={14} />{sent.text}</p>}
            {open.length ? open.map((decision) => (
              <DecisionCard key={decision.id} projectId={id} decision={decision} titles={titles} now={now} answered={answeredQuestion} onError={onError} />
            )) : <p className="pw-empty">{copy.NOTHING_WAITING}</p>}
            {view.decisions.answered.length > 0 && <AnsweredList decisions={view.decisions.answered} titles={titles} now={now} />}
          </section>
          <section className="pw-section" data-tab="threads" aria-labelledby={`${sideId}-running`}>
            {sectionHeading(`${sideId}-running`, copy.RUNNING, sections.running.length)}
            {sections.running.length ? (
              <div className="pw-list">
                {sections.running.map((thread) => <ThreadRow key={thread.id} projectId={id} thread={thread} meta={meta(thread)} now={now} navigate={navigate} />)}
              </div>
            ) : <p className="pw-empty">{copy.NO_THREADS_RUNNING}</p>}
          </section>
          <section className="pw-section" data-tab="pull-requests" aria-labelledby={`${sideId}-pulls`}>
            {sectionHeading(`${sideId}-pulls`, copy.PULL_REQUESTS, pulls.length)}
            {pulls.length ? pulls.map((entry) => (
              <PullRequestRow key={entry.threadId} projectId={id} entry={entry} navigate={navigate} merge={() => setMerging(entry)} />
            )) : <p className="pw-empty">{copy.NO_OPEN_PULL_REQUESTS}</p>}
          </section>
          <section className="pw-section" data-tab="threads" aria-labelledby={`${sideId}-concluded`}>
            {sectionHeading(`${sideId}-concluded`, copy.CONCLUDED, sections.concluded.length)}
            {sections.concluded.length ? (
              <div className="pw-list">
                {sections.concluded.map((thread) => <ThreadRow key={thread.id} projectId={id} thread={thread} meta={meta(thread)} now={now} navigate={navigate} />)}
              </div>
            ) : <p className="pw-empty">{copy.NOTHING_CONCLUDED}</p>}
          </section>
        </div>
      </div>
      {dialog === 'new-thread' && <NewThreadDialog props={props} view={view} move={moveHere} close={() => setDialog(undefined)} />}
      {dialog === 'settings' && <SettingsDialog props={props} view={view} close={() => setDialog(undefined)} />}
      {merging?.pr && (
        <MergeDialog projectId={id} entry={merging} fallbackBase={view.project.baseBranch} onError={onError}
          close={() => setMerging(undefined)} merged={() => { setMerging(undefined); updated(); }} />
      )}
      {notebook && <NotebookPanel projectId={id} projectName={view.project.name} revision={view.notebookRevision} onError={onError} close={() => setNotebook(false)} />}
    </div>
  );
}

/**
 * The 9.8 notice while the coordinator's device is offline (no heartbeat for 10 minutes, or revoked), with Move coordinator here
 * when the move rule lets this device take the coordinator over (D80, D269, D272). When this device cannot run the coordinator the
 * button stays visible but disabled, with the reason on its own line under it (D282), so phones see why without a tooltip.
 */
function OfflineNotice({ device, canMove, refusal, moving, move }: { device: string; canMove: boolean; refusal?: string | undefined; moving: boolean; move(): void }) {
  const note = useId();
  return (
    <div className="notice pw-offline">
      <p>{copy.coordinatorOfflineNotice(device)}</p>
      {/* Both labels share one cell, so the button keeps its width while it moves and the notice never reflows. */}
      {canMove && (
        <button type="button" className="secondary pw-move" disabled={moving || !!refusal} aria-describedby={refusal ? note : undefined} onClick={move}>
          <span aria-hidden={moving}>{copy.MOVE_COORDINATOR}</span><span aria-hidden={!moving}>{copy.MOVING_COORDINATOR}</span>
        </button>
      )}
      {canMove && refusal && <p className="pw-move-refusal" id={note}>{refusal}</p>}
    </div>
  );
}

/** One chat entry (12.2): owner messages right-aligned, Markdown replies, muted tool one-liners, event cards and notices. */
function ChatEntry({ item, projectId, navigate }: { item: ChatItem; projectId: string; navigate(path: string): void }) {
  const thread = (threadId: string) => `/projects/${projectId}/threads/${threadId}`;
  switch (item.kind) {
    case 'owner':
      return (
        <article className="user-message pw-owner">
          <div className="message-heading"><strong>{copy.YOU}</strong><Stamp at={item.at} /></div>
          <Markdown>{item.text}</Markdown>
          {!item.delivered && <p className="pw-pending">{copy.WAITING_FOR_COORDINATOR}</p>}
        </article>
      );
    case 'reply':
      return <div className="pw-reply"><Markdown>{item.text}</Markdown></div>;
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
function Composer({ projectId, busy, offline, offlineText, behind, jump, stopping, stop, onError }: {
  projectId: string; busy: boolean; offline: boolean; offlineText: string; behind: boolean; jump(): void; stopping: boolean; stop(): void; onError(error: unknown): void;
}) {
  const [text, setText] = useState('');
  const send = useTask(onError);
  const ids = useClientIds('message');
  return (
    <form className="composer card pw-composer" onSubmit={(event) => {
      event.preventDefault();
      if (send.busy || offline || !text.trim()) return;
      const value = text;
      void send.run(async (signal) => {
        await api(`/api/projects/${projectId}/coordinator/messages`, CoordinatorMessageReceiptSchema, 'POST',
          { schema: 'coordinator-message-request-v1', clientMessageId: ids.id(value), text: value }, { signal, waitForHub: true });
        ids.done();
        setText((typed) => typed === value ? '' : typed);
        updated();
      });
    }}>
      {(busy || behind) && (
        <div className="cursor-live-bar ordinary-live-bar">
          {busy && <span role="status"><span className="activity-spinner" aria-hidden="true" />{copy.COORDINATOR_WORKING}</span>}
          {behind && <button type="button" className="text-button pw-jump jump-latest" onClick={jump}>{copy.JUMP_TO_LATEST}<Icon name="chevron" size={14} /></button>}
        </div>
      )}
      <div className="message-input-row">
        <MessageInput value={text} change={setText} label={copy.CHAT_INPUT_LABEL} placeholder={copy.CHAT_PLACEHOLDER} />
        <div className="message-actions">
          {busy && (
            <button type="button" className="pw-stop-icon" aria-label={copy.STOP} title={copy.STOP_COORDINATOR} disabled={stopping} onClick={stop}>
              <Icon name="stop" size={18} />
            </button>
          )}
          <button type="submit" className="send-icon" aria-label={copy.SEND} title={offline ? offlineText : undefined}
            disabled={send.busy || offline || !text.trim()}><Icon name="send" size={20} /></button>
        </div>
      </div>
    </form>
  );
}

/**
 * A question for the owner (12.2): its source and age, the question as Markdown, the options with their details, and an
 * answer in the owner's own words. Every answer is idempotent by its client id.
 */
function DecisionCard({ projectId, decision, titles, now, answered, onError }: {
  projectId: string; decision: ProjectDecision; titles: ThreadTitles; now: number; answered(decision: ProjectDecision): void; onError(error: unknown): void;
}) {
  const { error, setError, fail } = useLocalError(onError);
  const task = useTask(fail);
  const ids = useClientIds('answer');
  const [text, setText] = useState('');
  const questionId = useId();
  const answer = (value: { optionLabel: string } | { text: string }) => void task.run(async (signal) => {
    setError('');
    await api(`/api/projects/${projectId}/decisions/${decision.id}/answer`, DecisionAnsweredViewSchema, 'POST',
      { schema: 'decision-answer-request-v1', clientRequestId: ids.id({ decision: decision.id, ...value }), ...value }, { signal, waitForHub: true });
    ids.done();
    answered(decision);
  });
  return (
    <section className="answer-card pw-decision" aria-labelledby={questionId}>
      <p className="pw-source">{decisionSource(decision, titles)} · <Stamp at={decision.createdAt} label={shortTime(decision.createdAt, now)} /></p>
      <div className="pw-question" id={questionId}><Markdown>{decision.question}</Markdown></div>
      {decision.options.length > 0 && (
        <div className="answer-options pw-options">
          {decision.options.map((option) => (
            <button key={option.label} type="button" className="secondary pw-option" disabled={task.busy} onClick={() => answer({ optionLabel: option.label })}>
              <span>{option.label}</span>
              {option.detail && <small>{option.detail}</small>}
            </button>
          ))}
        </div>
      )}
      <form className="pw-answer" onSubmit={(event) => {
        event.preventDefault();
        if (!task.busy && text.trim()) answer({ text: text.trim() });
      }}>
        <MessageInput value={text} change={setText} label={copy.ANSWER_IN_OWN_WORDS} placeholder={copy.ANSWER_IN_OWN_WORDS} />
        <button className="small" disabled={task.busy || !text.trim()}>{copy.SEND}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** The last 10 answered questions, collapsed (12.2, D52). */
function AnsweredList({ decisions, titles, now }: { decisions: readonly ProjectDecision[]; titles: ThreadTitles; now: number }) {
  return (
    <details className="pw-answered">
      <summary>{copy.ANSWERED} <span className="pw-count">{decisions.length}</span></summary>
      <ul>
        {decisions.map((decision) => (
          <li key={decision.id}>
            <p className="pw-source">
              {decisionSource(decision, titles)}
              {decision.answeredAt && <> · <Stamp at={decision.answeredAt} label={shortTime(decision.answeredAt, now)} /></>}
            </p>
            <p className="pw-answered-question">{decision.question}</p>
            {decision.answer && (
              <p className="pw-answered-answer"><Icon name="check" size={13} />{copy.eventCopy.answer(decision.answer.optionLabel, decision.answer.text)}</p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A thread row (12.2): dot, title, meta and elapsed time, the last summary on one line, and the outcome once concluded. */
function ThreadRow({ projectId, thread, meta, now, navigate }: { projectId: string; thread: ThreadIndex; meta: string; now: number; navigate(path: string): void }) {
  const outcome = outcomeText(thread);
  const tone = thread.state === 'failed' ? 'danger' : thread.state === 'done' && outcome !== copy.NO_CHANGES_OUTCOME ? 'ok' : 'muted';
  const state = copy.STATE_LABELS[thread.state];
  return (
    <RouteLink className="pw-thread-row" href={`/projects/${projectId}/threads/${thread.id}`} navigate={navigate}>
      <i className={dotClass(thread.state)} title={state} aria-hidden="true" />
      <span className="pw-row-title">{thread.title}<span className="sr-only">, {state}</span></span>
      <span className="pw-row-end">
        {outcome && <span className={`pw-outcome pw-tone-${tone}`}>{outcome}</span>}
        {/* Attached shares idle's outline dot (D54) but holds messages until the terminal exits, so the row says it (D305). */}
        {thread.state === 'attached' && <span className="pw-outcome pw-tone-muted" aria-hidden="true">{state}</span>}
        <Stamp at={thread.createdAt} label={relativeDuration(thread.createdAt, outcome ? thread.endedAt ?? thread.updatedAt : now)} />
      </span>
      <span className="pw-row-meta" title={meta}>{meta}</span>
      {thread.lastSummary && <span className="pw-row-summary" title={thread.lastSummary}>{thread.lastSummary}</span>}
    </RouteLink>
  );
}

/**
 * A pull request (12.2): the GitHub link, the checks and conflict badges, Merge (disabled with its reason on conflicts or
 * failing checks, allowed while checks run) and Open on GitHub; a branch-only thread shows its branch and reason (D58).
 */
function PullRequestRow({ projectId, entry, navigate, merge }: { projectId: string; entry: PullRequestEntry; navigate(path: string): void; merge(): void }) {
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
  const badge = checksBadge(pr); const block = mergeBlock(pr);
  return (
    <article className="pw-pr">
      <a className="pw-pr-title" href={pr.url} target="_blank" rel="noopener noreferrer">{copy.pullRequestTitle(pr.number, entry.title)}</a>
      <div className="pw-badges">
        <span className={`chip pw-badge pw-tone-${badge.tone}`}>{badge.text}</span>
        {pr.mergeable === 'conflict' && <span className="chip pw-badge pw-tone-danger">{copy.CONFLICTS}</span>}
      </div>
      <div className="pw-pr-actions">
        <RouteLink className="text-button pw-open-thread" href={thread} navigate={navigate}>{copy.OPEN_THREAD}</RouteLink>
        <a className="button-link secondary small" href={pr.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} />{copy.OPEN_ON_GITHUB}</a>
        <span className="pw-merge" title={block ?? undefined}>
          <button type="button" className="small" disabled={!!block} title={block ?? undefined} aria-describedby={block ? blockId : undefined} onClick={merge}>
            {copy.MERGE}
          </button>
          {block && <span className="sr-only" id={blockId}>{block}</span>}
        </span>
      </div>
    </article>
  );
}

/** Squash and merge confirmation (12.2); the base branch comes from the owner's thread view (D93). */
function MergeDialog({ projectId, entry, fallbackBase, close, merged, onError }: {
  projectId: string; entry: PullRequestEntry; fallbackBase: string | null; close(): void; merged(): void; onError(error: unknown): void;
}) {
  const { error, setError, fail } = useLocalError(onError);
  const task = useTask(fail);
  const [base, setBase] = useState<string | null>();
  useEffect(() => {
    const controller = new AbortController();
    api(`/api/projects/${projectId}/threads/${entry.threadId}`, ThreadViewSchema, 'GET', undefined, { signal: controller.signal })
      .then((thread) => setBase(thread.baseBranch), (failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) onError(failure);
        setBase(fallbackBase);
      });
    return () => controller.abort();
  }, [projectId, entry.threadId, fallbackBase, onError]);
  const number = entry.pr?.number ?? 0;
  return (
    <Confirm title={copy.mergeTitle(number)} action={copy.MERGE} busy={task.busy || base === undefined} close={close}
      confirm={() => void task.run(async (signal) => {
        setError('');
        const result = await api(`/api/projects/${projectId}/threads/${entry.threadId}/pr/merge`, MergeResultViewSchema, 'POST', empty, { signal });
        if (result.merged) merged(); else setError(result.message ?? copy.MERGE_FAILED);
      })}>
      {base === undefined ? <p className="muted">{copy.LOADING}</p> : <p className="pw-confirm-body">{copy.mergeBody(entry.title, base ?? copy.UNKNOWN_BASE)}</p>}
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
function NewThreadDialog({ props, view, move, close }: { props: PageProps; view: ProjectWorkView; move(signal: AbortSignal): Promise<void>; close(): void }) {
  const { data } = props;
  const { error, setError, fail } = useLocalError(props.onError);
  const task = useTask(fail);
  const moving = useTask(fail);
  const ids = useClientIds('thread_req');
  const [form, setForm] = useState<ThreadForm>({ title: '', task: '', isolation: '', modelId: '', effort: '', deviceId: '' });
  const change = (fields: Partial<ThreadForm>) => setForm((previous) => ({ ...previous, ...fields }));
  const isolationNote = useId(); const deviceNote = useId();
  const runtimeName = runtimeNames(data);
  const models = data.config.configuration['x-jevellan'].menu.filter((entry) => entry.enabled);
  const efforts = models.find((entry) => entry.id === form.modelId)?.efforts ?? EffortSchema.options;
  const here = data.devices.currentDeviceId;
  const devices = deviceChoices(view, data.roster.devices, here, form.deviceId);
  const mainBlock = mainIsolationBlock(view);
  const remoteBlock = devices.map((choice) => deviceBlock(view, choice.id, here)).find((reason) => reason !== null) ?? null;
  const offline = view.coordinator.state === 'offline';
  const coordinatorDevice = view.coordinator.deviceName ?? deviceNames(data)(view.coordinator.deviceId ?? '');
  return (
    <Modal title={copy.NEW_THREAD} close={close}>
      <form className="pw-new-thread" onSubmit={(event) => {
        event.preventDefault();
        if (offline) return;
        void task.run(async (signal) => {
          setError('');
          const created = await api(`/api/projects/${view.project.id}/threads`, ThreadCreatedViewSchema, 'POST',
            threadCreateRequest(ids.id(form), form), { signal, waitForHub: true });
          ids.done(); updated();
          afterDialogs(props.message, created.placement);
          props.navigate(`/projects/${view.project.id}/threads/${created.threadId}`);
        });
      }}>
        {offline && <OfflineNotice device={coordinatorDevice} canMove={view.coordinator.canMoveHere} refusal={view.coordinator.moveRefusal} moving={moving.busy}
          move={() => void moving.run(async (signal) => { setError(''); await move(signal); })} />}
        <label>{copy.TITLE}<input required maxLength={120} value={form.title} onChange={(event) => change({ title: event.target.value })} /></label>
        <label>{copy.TASK}<textarea required maxLength={20000} rows={6} value={form.task} onChange={(event) => change({ task: event.target.value })} /></label>
        <details className="pw-placement">
          <summary>{copy.PLACEMENT}</summary>
          <div className="form-grid pw-placement-fields">
            <div className="pw-field">
              <label>{copy.ISOLATION}
                <select value={form.isolation} aria-describedby={mainBlock ? isolationNote : undefined}
                  onChange={(event) => change({ isolation: event.target.value as ThreadForm['isolation'] })}>
                  <option value="">{copy.AUTOMATIC}</option>
                  <option value="worktree">{copy.WORKTREE}</option>
                  <option value="main" disabled={!!mainBlock}>{copy.MAIN}</option>
                </select>
              </label>
              {mainBlock && <p className="pw-field-note" id={isolationNote}>{mainBlock}</p>}
            </div>
            <label>{copy.MODEL}
              <select value={form.modelId} onChange={(event) => {
                const next = models.find((entry) => entry.id === event.target.value);
                change({ modelId: event.target.value, ...(next && form.effort && !next.efforts.includes(form.effort) ? { effort: '' as const } : {}) });
              }}>
                <option value="">{copy.AUTOMATIC}</option>
                {models.map((entry) => <option key={entry.id} value={entry.id}>{`${runtimeName(entry.runtime)} ${entry.label}`}</option>)}
              </select>
            </label>
            <label>{copy.EFFORT}
              <select value={form.effort} onChange={(event) => change({ effort: event.target.value as ThreadForm['effort'] })}>
                <option value="">{copy.AUTOMATIC}</option>
                {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
            <div className="pw-field">
              <label>{copy.DEVICE}
                <select value={form.deviceId} aria-describedby={remoteBlock ? deviceNote : undefined} onChange={(event) => change({ deviceId: event.target.value })}>
                  <option value="">{copy.AUTOMATIC}</option>
                  {devices.map((choice) => <option key={choice.id} value={choice.id} disabled={choice.disabled}>{choice.label}</option>)}
                </select>
              </label>
              {remoteBlock && <p className="pw-field-note" id={deviceNote}>{remoteBlock}</p>}
            </div>
          </div>
        </details>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>{copy.CANCEL}</button>
          <button disabled={task.busy || offline}>{task.busy ? copy.STARTING : copy.START_THREAD}</button>
        </div>
      </form>
    </Modal>
  );
}

type SettingsBase = Pick<ProjectWorkView, 'settings' | 'settingsNotice'>;
const settingsForm = (from: SettingsBase) => ({
  defaultIsolation: from.settings.defaultIsolation, isolationChanged: false, modelId: from.settings.coordinator.modelId ?? '',
  effort: from.settings.coordinator.effort, setupCommand: from.settings.setupCommand ?? '', maxRunningThreads: String(from.settings.maxRunningThreads),
  maxRunningPerDevice: String(from.settings.maxRunningPerDevice), threadTurnCap: String(from.settings.threadTurnCap),
});
/**
 * Project settings (12.2). The dialog reads the settings when it opens (the page view may predate a save made a moment
 * ago) and keeps its fields disabled until then; it saves with the revision it read. A revision conflict stays in the
 * dialog with a Reload that reads the current settings again (never the app's global 409 reload).
 */
function SettingsDialog({ props, view, close }: { props: PageProps; view: ProjectWorkView; close(): void }) {
  const { data } = props;
  const { error, setError, fail } = useLocalError(props.onError);
  const task = useTask(fail);
  const save = useSettingsSave();
  const mainNote = useId();
  const [base, setBase] = useState<SettingsBase>(() => ({ settings: view.settings, ...(view.settingsNotice ? { settingsNotice: view.settingsNotice } : {}) }));
  const [form, setForm] = useState(() => settingsForm(base));
  const [loaded, setLoaded] = useState(false);
  const [stale, setStale] = useState(false);
  const change = (fields: Partial<typeof form>) => setForm((previous) => ({ ...previous, ...fields }));
  const runtimeName = runtimeNames(data);
  const models = data.config.configuration['x-jevellan'].menu.filter((entry) => entry.enabled || entry.id === base.settings.coordinator.modelId);
  const mainBlock = mainIsolationBlock(view);
  const path = `/api/projects/${view.project.id}/work-settings`;
  const read = useCallback(async (signal: AbortSignal) => {
    const next = await api(path, ProjectWorkSettingsViewSchema, 'GET', undefined, { signal, waitForHub: true });
    const fresh: SettingsBase = { settings: next.settings, ...(next.notice ? { settingsNotice: next.notice } : {}) };
    setBase(fresh); setForm(settingsForm(fresh)); setLoaded(true); setStale(false); setError('');
  }, [path, setError]);
  useEffect(() => {
    const controller = new AbortController();
    read(controller.signal).catch((failure: unknown) => { if (!controller.signal.aborted) { setStale(true); fail(failure); } });
    return () => controller.abort();
  }, [read, fail]);
  const reload = () => void task.run(read);
  const isolation = (value: Isolation) => change({ defaultIsolation: value, isolationChanged: true });
  return (
    <Modal title={copy.PROJECT_SETTINGS} close={close}>
      <form className="pw-settings" onSubmit={(event) => {
        event.preventDefault();
        void task.run(async (signal) => {
          setError(''); setStale(false);
          const request = settingsRequest(base, { ...form, maxRunningThreads: Number(form.maxRunningThreads),
            maxRunningPerDevice: Number(form.maxRunningPerDevice), threadTurnCap: Number(form.threadTurnCap) });
          try {
            await save(path, ProjectWorkSettingsViewSchema, 'PUT', request, signal);
          } catch (failure) {
            if (failure instanceof ApiError && failure.status === 409) setStale(true);
            throw failure;
          }
          updated(); afterDialogs(props.message, copy.SETTINGS_SAVED); close();
        });
      }}>
        <fieldset className="pw-fields" disabled={!loaded}>
          <fieldset className="pw-isolation">
            <legend>{copy.DEFAULT_ISOLATION}</legend>
            <label><input type="radio" name="pw-isolation" checked={form.defaultIsolation === 'worktree'} onChange={() => isolation('worktree')} />{copy.WORKTREE_AND_PULL_REQUEST}</label>
            <label className={mainBlock ? 'pw-disabled' : undefined}>
              <input type="radio" name="pw-isolation" checked={form.defaultIsolation === 'main'} disabled={!!mainBlock}
                aria-describedby={mainBlock ? mainNote : undefined} onChange={() => isolation('main')} />{copy.MAIN}
            </label>
            {mainBlock && <p className="pw-field-note pw-radio-note" id={mainNote}>{mainBlock}</p>}
          </fieldset>
          <div className="form-grid">
            <label>{copy.COORDINATOR_MODEL}
              <select value={form.modelId} onChange={(event) => change({ modelId: event.target.value })}>
                <option value="">{copy.AUTOMATIC_FIRST_AVAILABLE}</option>
                {models.map((entry) => <option key={entry.id} value={entry.id}>{`${runtimeName(entry.runtime)} ${entry.label}`}</option>)}
              </select>
            </label>
            <label>{copy.COORDINATOR_EFFORT}
              <select value={form.effort} onChange={(event) => change({ effort: event.target.value as Effort })}>
                {EffortSchema.options.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
          </div>
          <label>{copy.SETUP_COMMAND}
            <input value={form.setupCommand} maxLength={500} placeholder={copy.SETUP_COMMAND_PLACEHOLDER} spellCheck={false}
              onChange={(event) => change({ setupCommand: event.target.value })} />
          </label>
          <div className="form-grid pw-limits">
            <label>{copy.MAX_RUNNING_THREADS}
              <input type="number" required min={1} max={20} step={1} inputMode="numeric" value={form.maxRunningThreads}
                onChange={(event) => change({ maxRunningThreads: event.target.value })} />
            </label>
            <label>{copy.MAX_PER_DEVICE}
              <input type="number" required min={1} max={10} step={1} inputMode="numeric" value={form.maxRunningPerDevice}
                onChange={(event) => change({ maxRunningPerDevice: event.target.value })} />
            </label>
            <label>{copy.TURN_LIMIT}
              <input type="number" required min={5} max={200} step={1} inputMode="numeric" value={form.threadTurnCap}
                onChange={(event) => change({ threadTurnCap: event.target.value })} />
            </label>
          </div>
        </fieldset>
        {error && (
          <p className="error">{error}{stale && <button type="button" className="text-button" disabled={task.busy} onClick={reload}>{copy.RELOAD}</button>}</p>
        )}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>{copy.CANCEL}</button>
          <button disabled={task.busy || !loaded}>{task.busy ? copy.SAVING : copy.SAVE}</button>
        </div>
      </form>
    </Modal>
  );
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
  const [notebook, setNotebook] = useState<z.infer<typeof ProjectNotebookViewSchema>>();
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
    api(`/api/projects/${projectId}/notebook`, ProjectNotebookViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })
      .then((value) => { setNotebook(value); setError(''); }, (failure: unknown) => { if (!controller.signal.aborted) fail(failure); });
    return () => controller.abort();
  }, [projectId, revision, reading, fail, setError]);
  const content = notebook?.notebook?.content ?? '';
  const stamp = notebook?.notebook ? timeStamp(notebook.notebook.updatedAt) : null;
  return (
    <Panel title={copy.NOTEBOOK} eyebrow={projectName} close={close}>
      {!notebook ? (
        error ? <p className="error">{error}</p> : <p className="page-loading" role="status"><span className="activity-spinner" aria-hidden="true" />{copy.LOADING_NOTEBOOK}</p>
      ) : reading ? (
        <div className="pw-notebook">
          <div className="pw-notebook-bar">
            <span className="pw-notebook-meta">{notebook.notebook && stamp ? copy.notebookUpdated(notebook.notebook.updatedBy, stamp.label) : ''}</span>
            <button type="button" className="secondary small" onClick={() => { setConflict(false); setError(''); setDraft(content); }}>{copy.EDIT}</button>
          </div>
          {error && <p className="error">{error}</p>}
          {content.trim() ? <Markdown>{content}</Markdown> : <p className="pw-empty">{copy.NOTEBOOK_EMPTY}</p>}
        </div>
      ) : (
        <form className="pw-notebook-edit" onSubmit={(event) => {
          event.preventDefault();
          void task.run(async (signal) => {
            setError(''); setConflict(false);
            try {
              const stored = await api(`/api/projects/${projectId}/notebook`, ProjectNotebookViewSchema, 'PUT',
                { schema: 'notebook-request-v1', expectedRevision: notebook.revision, content: draft }, { signal, waitForHub: true });
              setNotebook(stored); setDraft(undefined); updated();
            } catch (failure) {
              if (failure instanceof ApiError && failure.status === 409 && failure.code === 'conflict') { setConflict(true); return; }
              throw failure;
            }
          });
        }}>
          <textarea ref={editor} className="pw-notebook-text" aria-label={copy.NOTEBOOK_CONTENT} value={draft} maxLength={65536}
            onChange={(event) => setDraft(event.target.value)} />
          {conflict && (
            <p className="error">{copy.NOTEBOOK_CHANGED}
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
