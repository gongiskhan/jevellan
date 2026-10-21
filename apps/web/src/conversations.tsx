import { ConversationSettlementContextSchema, ConversationSettlementEditorSchema, ConversationSettlementDraftSchema, ConversationSettlementPendingSchema, conversationSettlementContext, conversationSettlementEditor } from '@jevellan/core/client';
import { ConversationControlContextSchema, ConversationControlEditorSchema, ConversationControlDraftSchema, ConversationControlPendingSchema, conversationControlContext, conversationControlEditor, conversationControlPreview } from '@jevellan/core/client';
import { ConversationMessageDraftRequestSchema, ConversationMessageDraftSchema, ConversationMessagePendingSchema, conversationMessageEditor } from '@jevellan/core/client';
import { conversationControlsView } from '@jevellan/core/client';
import { ConversationStartResultSchema } from '@jevellan/core/client';
import { PROJECT_SETUP_WAITING_LABEL } from '@jevellan/core/client';
import { ConversationCreationDraftSchema, type ConversationCreationPending } from '@jevellan/core/client';
import { ConversationNewSourceSchema, conversationNewSource, conversationNewView, type ConversationNewSource } from '@jevellan/core/client';
import { conversationSidebarDrop, conversationSidebarRename, conversationSidebarCanRename } from '@jevellan/core/client';
import { conversationSidebarView, type ConversationSidebarFilter } from '@jevellan/core/client';
import { ConversationListSourceSchema, conversationListRefresh, conversationListUpdateKey, CONVERSATION_LIST_POLL_MS, CONVERSATION_UPDATED_EVENT } from '@jevellan/core/client';
import { conversationActionLabel as actionLabel, conversationPagePresentation, conversationPagePresentationForStream } from '@jevellan/core/client';
import { ConversationTranscriptViewSchema, conversationTranscriptProjection, selectConversationTranscriptView, conversationNoticeHidden, type ConversationTranscriptView } from '@jevellan/core/client';
import { ConversationStatusStreamRequestSchema, ConversationStatusEventSchema, STATUS_REFRESH_WINDOW_MS } from '@jevellan/core/client';
import { conversationPlansView, planApprovalRequest, planChangesMessage } from '@jevellan/core/client';
import { ConversationCorrectionDialog as ChangeStep, ConversationWhyPanel as Why } from './conversation-decision-panels.js';
import { PlanReview, type PlanReviewActions } from './plan-review.js';
import { BranchChangeNotice, branchChangeText } from './branch-change-notice.js';
import { useShellVisibility } from './shell-visibility.js';
import { ChangesDiff } from './changes-diff.js';
import { conversationTurns } from './conversation-transcript.js';
import { TranscriptTurn } from './session-transcript.js';
import { mergeTranscriptTurns } from './transcript-groups.js';
import { createPortal } from 'react-dom';
import { useSessionDrag } from './session-drag.js';
import { clientId } from './client-id.js';
import { useSessionList } from './session-list.js';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import {
  GitBranchChangeSchema, type GitBranchChange,
  ComposerInitialSchema,
  ConversationChangesSchema,
  ConversationEventSchema,
  ConversationListSchema,
  ProjectsListSchema,
  ConversationNoticeSchema,
  ConversationPublicSchema,
  ConversationReadSchema,
  type Action,
  type DecisionRecord,
  type Effort,
  type LedgerEvent,
  type Project,
} from '@jevellan/core/client';
import { api, empty } from './api.js';
import { ProjectForm } from './projects.js';
import { waitForProjectSetup } from './project-setup.js';
import { queuedRefresh } from './refresh.js';
import { ComposerOverride, ComposerChoices } from './composer-choices.js';
import { Icon } from './icons.js';
import { useCursorSessions } from './cursor-sessions.js';
import { MessageDelivery, MessageInput, LatestUserMessage } from './message-delivery.js';
import { EvidenceLink, EvidencePanel, type EvidenceTarget } from './evidence.js';
import { Markdown, Modal, Panel, composerClearance, followOnScroll, repinAtEnd, useDismissible, useTask, type PageProps } from './components.js';

type View = z.infer<typeof ConversationPublicSchema>;
type Step = View['stretches'][number];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const shortTime = (at: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10_080) return new Date(at).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export function ConversationSidebar({
  data,
  navigate,
  onError,
  selected,
}: Pick<PageProps, 'data' | 'navigate' | 'onError'> & { selected: string }) {
  const cursor = useCursorSessions();
  const shells = useShellVisibility();
  const presentation = useSessionList();
  const task = useTask(onError);
  const [actions, setActions] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; title: string; cursor: boolean }>();
  const [title, setTitle] = useState('');
  const [pendingOrder, setPendingOrder] = useState<string[]>();
  const [conversations, setConversations] = useState<z.infer<typeof ConversationListSchema>['conversations']>(
    [],
  );
  const [projects, setProjects] = useState<Array<Pick<Project, 'id' | 'name'>>>([]);
  const [filter, setFilter] = useState<ConversationSidebarFilter>('All');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const refresh = conversationListRefresh(
      signal => api('/api/conversation-list/view', ConversationListSourceSchema, 'GET', undefined, { signal, waitForHub: true }),
      value => { setConversations(value.conversations); setProjects(value.projects); },
      onError,
    );
    const changed = () => void refresh.request();
    window.addEventListener(CONVERSATION_UPDATED_EVENT, changed);
    changed();
    const timer = setInterval(changed, CONVERSATION_LIST_POLL_MS);
    return () => { refresh.stop(); clearInterval(timer); window.removeEventListener(CONVERSATION_UPDATED_EVENT, changed); };
  }, [onError, selected]);
  const view = conversationSidebarView({ schema: 'conversation-sidebar-facts-v1',
    source: { schema: 'conversation-list-source-v1', deviceId: data.devices.currentDeviceId, conversations, projects,
      readPolicy: { schema: 'conversation-list-read-policy-v1', pollMs: CONVERSATION_LIST_POLL_MS, updatedEvent: CONVERSATION_UPDATED_EVENT } },
    native: cursor, devices: data.devices.devices.map(({ id, name }) => ({ id, name })), preferences: presentation.preferences,
  }, { schema: 'conversation-sidebar-request-v1', filter, q: search, shells: shells.visible, selected, pendingOrder, dragOrder: undefined });
  const combined = view.allRows;
  const drag = useSessionDrag({ disabled: task.busy || !presentation.ready,
    start: () => setActions(undefined), drop: (id, target, after) => drop(id, target, after) });
  const visible = drag.drag ? conversationSidebarView({ schema: 'conversation-sidebar-facts-v1',
    source: { schema: 'conversation-list-source-v1', deviceId: data.devices.currentDeviceId, conversations, projects,
      readPolicy: { schema: 'conversation-list-read-policy-v1', pollMs: CONVERSATION_LIST_POLL_MS, updatedEvent: CONVERSATION_UPDATED_EVENT } },
    native: cursor, devices: data.devices.devices.map(({ id, name }) => ({ id, name })), preferences: presentation.preferences,
  }, { schema: 'conversation-sidebar-request-v1', filter, q: search, shells: shells.visible, selected, pendingOrder, dragOrder: drag.drag.order }).rows : view.rows;
  const dragged = combined.find(entry => entry.id === drag.drag?.id);
  const drop = (id: string, target: string, after: boolean) => void task.run(async () => {
    const prepared = conversationSidebarDrop(combined, presentation.preferences, { schema: 'conversation-sidebar-drop-v1', revision: presentation.preferences.revision, id, target, after });
    if (!prepared.request) return;
    setPendingOrder(prepared.previewOrder);
    try { await presentation.save({ operation: 'order', order: prepared.request.order }); }
    finally { setPendingOrder(undefined); }
  });
  useEffect(() => { document.title = view.documentTitle; }, [view.documentTitle]);
  return (
    <>
      <div className="filter-chips" role="group" aria-label="Conversation filters">
        {(['All', 'Running', 'Waiting for you', 'Done'] as const).map((label) => (
          <button
            key={label}
            className={label === filter ? 'selected' : ''}
            aria-pressed={label === filter}
            onClick={() => setFilter(label)}
          >
            {label}
            {label !== 'All' &&
              label !== 'Done' &&
              view.counts[label] > 0 && (
                <span className="count" aria-hidden="true">
                  {view.counts[label]}
                </span>
              )}
          </button>
        ))}
      </div>
      <button type="button" className="shell-visibility-switch" role="switch" aria-checked={shells.visible}
        title="Show Cursor, Claude Code and Codex shell sessions" onClick={() => shells.update(!shells.visible)}>
        <span>Shell sessions</span><span className="switch-track" aria-hidden="true" />
      </button>
      {view.searchable && (
        <label className="conversation-search">
          <span className="sr-only">Search conversations</span>
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder="Search conversations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      )}
      {view.sortByActivity && <button className="text-button session-sort" disabled={task.busy || !presentation.ready}
        onClick={() => void task.run(() => presentation.save({ operation: 'order', order: [] }))}>Sort by activity</button>}
      <span id="session-drag-help" className="sr-only">Drag to reorder. On touch screens, hold first. With a keyboard, use Alt and the up or down arrow.</span>
      <span className="sr-only" role="status">{dragged ? `Dragging ${dragged.title}. Release to place it; Escape cancels.` : ''}</span>
      <div className={`conversation-list ${drag.drag ? 'session-drag-active' : ''}`} ref={drag.list}>
        {view.emptyText ? (
          <p className="empty-conversations">{view.emptyText}</p>
        ) : (
          visible.map((entry) => (
            <div className={`conversation-list-entry ${drag.drag?.id === entry.id ? 'session-drag-source' : ''} ${drag.drag?.target === entry.id ? drag.drag.after ? 'session-drop-after' : 'session-drop-before' : ''}`} data-session-id={entry.id} key={entry.id} onKeyDown={event => { if (event.key === 'Escape') setActions(undefined); }}>
            <button
              className={`conversation-row ${selected === entry.route ? 'selected' : ''}`}
              onClick={() => navigate(entry.route)}
              aria-describedby="session-drag-help" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onDragStart={event => event.preventDefault()}
            >
              <i className={entry.state === 'running' ? 'activity-spinner' : `state-dot state-${entry.state}`} aria-hidden="true" />
              <strong title={entry.title}>{entry.title}</strong>
              <span className="row-time">{shortTime(entry.updatedAt)}</span>
              <span className="row-meta">
                {entry.stateLabel} · {entry.projectLabel} · {entry.deviceLabel}
              </span>
            </button>
            <button type="button" className="session-settings icon-button" aria-label={`Actions for ${entry.title}`} title="Session actions"
              aria-expanded={actions === entry.id} onClick={() => setActions(actions === entry.id ? undefined : entry.id)}><Icon name="more" size={16} /></button>
            {actions === entry.id && <div className="session-row-actions" role="group" aria-label={`Actions for ${entry.title}`}>
              <button className="text-button" disabled={task.busy || !presentation.ready} onClick={() => { setRenaming(entry); setTitle(entry.title); setActions(undefined); }}>Rename</button>
              {entry.actions.includes('settings') && <button className="text-button" onClick={() => { setActions(undefined); if (entry.cursor) navigate('/settings/devices'); else { navigate(entry.route); window.dispatchEvent(new Event('jevellan-conversation-settings')); } }}><Icon name="gear" size={14} /> Settings</button>}
            </div>}
            </div>
          ))
        )}
      </div>
      {drag.drag && dragged && createPortal(<div className="session-drag-preview" aria-hidden="true"
        style={{ width: Math.min(drag.drag.width, window.innerWidth - 24), left: Math.max(12, Math.min(drag.drag.x - drag.drag.width / 2, window.innerWidth - drag.drag.width - 12)), top: Math.max(8, drag.drag.y - 58) }}>
        <strong>{dragged.title}</strong><span>{dragged.runtimeLabel} · {dragged.projectLabel} · {dragged.deviceLabel}</span>
      </div>, document.body)}
      {renaming && <Modal title="Rename session" close={() => setRenaming(undefined)}>
        <form onSubmit={event => { event.preventDefault(); void task.run(async () => {
          const prepared = conversationSidebarRename(renaming, title, `rename_${clientId()}`, presentation.preferences);
          if (prepared.kind === 'native') await presentation.save({ operation: 'rename', id: prepared.request.id, title: prepared.request.title });
          else {
            await api(prepared.path, ConversationPublicSchema, 'POST', prepared.request);
            window.dispatchEvent(new Event(CONVERSATION_UPDATED_EVENT));
          }
          setRenaming(undefined);
        }); }}>
          <label>Name<input autoFocus required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <div className="actions"><button disabled={task.busy || !conversationSidebarCanRename(title)}>{task.busy ? 'Saving…' : 'Save name'}</button><button type="button" className="secondary" onClick={() => setRenaming(undefined)}>Cancel</button></div>
        </form>
      </Modal>}
      {view.unavailable.length > 0 && <details className="cursor-source-notice"><summary>Some native sessions are unavailable</summary>{view.unavailable.map(text => <p key={text}>{text}</p>)}</details>}
    </>
  );
}

export function NewConversation(props: PageProps & { embedded?: boolean }) {
  const [sourceState, setSource] = useState<ConversationNewSource>();
  const [projectId, setProjectId] = useState('');
  const [message, setMessage] = useState('');
  const task = useTask(props.onError);
  const [waitingForSetup, setWaitingForSetup] = useState(false);
  const [branchChange, setBranchChange] = useState<{ projectId: string; change: GitBranchChange }>();
  const [addingProject, setAddingProject] = useState(false);
  const [choices, setChoices] = useState(() =>
    ComposerInitialSchema.parse({ schema: 'composer-initial-v1', once: {}, pins: {} }),
  );
  const pending = useRef<ConversationCreationPending | undefined>(undefined);
  const device = props.data.devices.devices.find((entry) => entry.id === props.data.devices.currentDeviceId)!;
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/conversation-new/source', ConversationNewSourceSchema, 'GET', undefined, {
      signal: controller.signal,
      waitForHub: true,
    })
      .then((value) => {
        setSource(value);
        setProjectId(value.defaultProjectId);
      })
      .catch(props.onError);
    return () => controller.abort();
  }, [props.onError]);
  const source = sourceState ? { ...sourceState, device: { id: device.id, name: device.name }, accountCount: props.data.accounts.length, jevSaved: props.data.jev.saved }
    : conversationNewSource({ schema: 'conversation-new-facts-v1', projects: [], device: { id: device.id, name: device.name }, accountCount: props.data.accounts.length, jevSaved: props.data.jev.saved });
  const view = conversationNewView(source, { schema: 'conversation-new-request-v1', projectId, message, busy: task.busy });
  const projects = source.projects;
  return (
    <div className={props.embedded ? 'new-conversation-embedded' : 'new-conversation-page'}>
      {!props.embedded && (
        <>
          <h1>New conversation</h1>
          <p className="intro">Give your agents a project and an objective.</p>
        </>
      )}
      {view.notices.map(notice => <p className="notice" key={notice.kind}>{notice.text}{notice.kind === 'account' && <> <button className="text-button" onClick={() => props.navigate(notice.route)}>{notice.buttonLabel}</button></>}</p>)}
      <form
        className="card new-conversation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async (signal) => {
            const draft = await api('/api/conversation-new/draft', ConversationCreationDraftSchema, 'POST', {
              schema: 'conversation-creation-intent-v1', projectId, message, choices, ...(pending.current ? { previous: pending.current } : {}),
            }, { signal, waitForHub: true });
            pending.current = draft.pending;
            if (!draft.request) throw new Error(draft.refusal ?? 'The request could not be prepared.');
            try {
              await waitForProjectSetup(projectId, signal, () => setWaitingForSetup(true), change => {
                setBranchChange({ projectId, change });
              }, change => props.message(branchChangeText(change)));
            } finally {
              setWaitingForSetup(false);
            }
            const created = await api(
              '/api/conversation-new/start',
              ConversationStartResultSchema,
              'POST',
              { schema: 'conversation-start-request-v1', deviceId: device.id, start: draft.request, waitSeconds: 0 },
              { signal, waitForHub: true },
            );
            if (!created.view) throw new Error(created.setup.refusal ?? created.setup.summary);
            props.navigate(`/conversations/${created.view.conversation.id}`);
          });
        }}
      >
        <div className="new-conversation-fields">
          <div>
            <label>
              Project
              <select required value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="" disabled>
                  {view.projectPlaceholder}
                </option>
                {projects.map((entry) => (
                  <option value={entry.id} key={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="project-picker-actions">
              <button type="button" className="text-button" onClick={() => setAddingProject(true)}>
                <Icon name="plus" size={14} />
                Add project
              </button>
            </div>
          </div>
          <div className="device-field">
            <label>
              Device
              <select defaultValue="here">
                {view.deviceOptions.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
              </select>
            </label>
            <small>{view.deviceHint}</small>
          </div>
        </div>
        {view.unavailableNotice && <p className="notice">{view.unavailableNotice}</p>}
        <label>
          <span className="sr-only">Message</span>
          <textarea
            required
            rows={4}
            placeholder="What should we build or fix?"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </label>
        <ComposerOverride
          projectId={projectId} revision={props.data.config.revision} initial={choices} update={setChoices} disabled={task.busy} run={task.run}
        />
        <button disabled={!view.canStart}>
          {view.startLabel}
        </button>
      </form>
      {branchChange?.projectId === projectId && <BranchChangeNotice change={branchChange.change} />}
      {waitingForSetup && <p role="status">{PROJECT_SETUP_WAITING_LABEL}</p>}
      {addingProject && (
        <ProjectForm
          {...props}
          row={undefined}
          knownPublic={false}
          close={() => setAddingProject(false)}
          saved={async (signal) => {
            const result = await api('/api/conversation-new/source', ConversationNewSourceSchema, 'GET', undefined, {
              signal,
              waitForHub: true,
            });
            const next = conversationNewView(result, { schema: 'conversation-new-request-v1', projectId, previousProjectIds: projects.map(project => project.id) });
            setSource(result);
            if (next.addedProjectId) setProjectId(next.addedProjectId);
            setAddingProject(false);
            props.message('Project added.');
          }}
        />
      )}
    </div>
  );
}

export function ConversationPage({ id, navigation, ...props }: PageProps & { id: string; navigation?: ReactNode }) {
  // The heading also holds the phone navigation button, so it is named by its title alone.
  const titleId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener('jevellan-conversation-settings', open);
    return () => window.removeEventListener('jevellan-conversation-settings', open);
  }, []);
  const [view, setView] = useState<View>();
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [transcripts, setTranscripts] = useState<Record<number, ConversationTranscriptView>>({});
  const rememberTranscript = useCallback((value: ConversationTranscriptView) => { if (value.conversationId === id) setTranscripts(current => ({ ...current, [value.step]: value })); }, [id]);
  const [connected, setConnected] = useState(false);
  const followedPoint = useRef(false);
  useEffect(() => {
    if (followedPoint.current) return;
    const point = new URLSearchParams(window.location.search).get('stretch');
    if (!point || !/^[1-9][0-9]*$/.test(point)) return;
    const element = document.getElementById(`stretch-${point}`);
    if (!element) return;
    followedPoint.current = true;
    element.scrollIntoView({ block: 'start' });
    element.focus({ preventScroll: true });
  }, [events, view]);
  // Follow new activity like a chat: stay pinned to the newest content unless the reader scrolled up.
  const pinned = useRef(!new URLSearchParams(window.location.search).get('stretch'));
  const [behind, setBehind] = useState(!pinned.current);
  useEffect(() => {
    const follows = followOnScroll(pinned, 160);
    const scrolled = () => setBehind(!follows());
    // Only scrolling up unpins; a resize re-pins once the end is in view (see followOnScroll and repinAtEnd).
    const resized = () => repinAtEnd(pinned, 160, () => setBehind(false));
    window.addEventListener('scroll', scrolled, { passive: true });
    window.addEventListener('resize', resized);
    return () => {
      window.removeEventListener('scroll', scrolled);
      window.removeEventListener('resize', resized);
    };
  }, []);
  const page = useRef<HTMLDivElement>(null);
  const loaded = !!view;
  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const follow = () => {
      repinAtEnd(pinned, 160, () => setBehind(false));
      if (pinned.current) window.scrollTo({ top: document.documentElement.scrollHeight });
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);
  const conversationMenu = useDismissible();
  const [correcting, setCorrecting] = useState<Step>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [settling, setSettling] = useState(false);
  const [editingConversation, setEditingConversation] = useState<'rename' | 'finish'>();
  const [editingMessage, setEditingMessage] = useState<{ id: number; text: string }>();
  const messageAction = useRef<z.infer<typeof ConversationMessagePendingSchema> | undefined>(undefined);
  const [message, setMessage] = useState('');
  const [why, setWhy] = useState<DecisionRecord>();
  const [changes, setChanges] = useState<z.infer<typeof ConversationChangesSchema>>();
  const [content, setContent] = useState<EvidenceTarget>();
  const task = useTask(props.onError);
  const input = useRef<HTMLTextAreaElement>(null);
  const messageId = useRef<z.infer<typeof ConversationMessagePendingSchema> | undefined>(undefined);
  const listUpdateKey = conversationListUpdateKey(view?.conversation);
  useEffect(() => {
    if (listUpdateKey !== null) window.dispatchEvent(new Event(CONVERSATION_UPDATED_EVENT));
  }, [listUpdateKey]);
  useEffect(() => {
    void api('/hub/projects', ProjectsListSchema)
      .then((value) => setProjects(value.projects.map((entry) => entry.project)))
      .catch(props.onError);
  }, [props.onError]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false; let initialReady = false;
    const refresh = queuedRefresh(
      (signal) => api(`/api/conversations/${id}`, ConversationPublicSchema, 'GET', undefined, { signal }),
      value => { initialReady = true; setView(value); },
      props.onError,
    );
    void refresh.request();
    const query = new URLSearchParams({ statusView: JSON.stringify(ConversationStatusStreamRequestSchema.parse({ schema: 'conversation-status-stream-request-v1' })) });
    const stream = new EventSource(`/api/conversations/${id}/events?${query}`);
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.addEventListener('status-view', (event: MessageEvent<string>) => {
      if (stopped || !initialReady) return;
      try {
        const value = ConversationStatusEventSchema.parse(JSON.parse(event.data));
        if (value.view.conversation.id === id) refresh.push(value.view);
      } catch (error) { stream.close(); props.onError(error); }
    });
    stream.addEventListener('conversation', (event: MessageEvent<string>) => {
      try {
        const value = ConversationEventSchema.parse(JSON.parse(event.data));
        setEvents((previous) =>
          previous.some((entry) => entry.id === value.event.id)
            ? previous
            : [...previous, value.event].sort((a, b) => a.id - b.id),
        );
        clearTimeout(timer);
        timer = setTimeout(() => void refresh.request(), STATUS_REFRESH_WINDOW_MS);
      } catch (error) {
        stream.close();
        props.onError(error);
      }
    });
    return () => {
      stopped = true;
      refresh.stop();
      clearTimeout(timer);
      stream.close();
    };
  }, [id, props.onError]);
  const prepareMessage = (intent: z.infer<typeof ConversationMessageDraftRequestSchema>['intent'], pending: z.infer<typeof ConversationMessagePendingSchema> | undefined, signal: AbortSignal) =>
    api(`/api/conversations/${id}/message-draft`, ConversationMessageDraftSchema, 'POST', {
      schema: 'conversation-message-draft-request-v1', intent, ...(pending ? { pending } : {}),
    }, { signal });
  const submit = (kind: 'message' | 'note') =>
    task.run(async signal => {
      const draft = await prepareMessage({ mode: 'compose', kind, text: message }, messageId.current, signal);
      messageId.current = draft.pending ?? undefined;
      if (!draft.command) return;
      const value = await api(`/api/conversations/${id}/message-command`, ConversationPublicSchema, 'POST', draft.command, { signal });
      messageId.current = undefined;
      setView(value);
      setMessage('');
    });
  const resendMessage = async (eventId: number, text: string, signal: AbortSignal, mode: 'resend' | 'retry' = 'resend') => {
    const draft = await prepareMessage({ mode, eventId, text }, messageAction.current, signal);
    if (draft.command?.operation === 'message') messageAction.current = draft.pending ?? undefined;
    if (!draft.command) return;
    const value = await api(`/api/conversations/${id}/message-command`, ConversationPublicSchema, 'POST', draft.command, { signal });
    if (draft.command.operation === 'message') {
      messageAction.current = undefined;
      setEditingMessage(undefined);
    }
    setView(value);
  };
  const answer = (option: number) => task.run(async signal => {
    const draft = await prepareMessage({ mode: 'answer', option }, undefined, signal);
    if (draft.command) setView(await api(`/api/conversations/${id}/message-command`, ConversationPublicSchema, 'POST', draft.command, { signal }));
  });
  const read = (
    ref: string,
    title: string,
    stretch?: number,
    source?: 'step' | 'working-tree',
    output = false,
  ) => setContent({ ref, title, stretch, source, output });
  if (!view)
    return (
      <p className="page-loading" role="status">
        <span className="activity-spinner" aria-hidden="true" />
        Loading conversation…
      </p>
    );
  const device = props.data.devices.devices.find((entry) => entry.id === view.conversation.ownerDeviceId);
  const controls = view.controls ?? conversationControlsView(view);
  const messageEditor = conversationMessageEditor(view, message);
  const editedMessageEditor = conversationMessageEditor(view, editingMessage?.text ?? '');
  const running = controls.running;
  const plans = view.plans ?? conversationPlansView(view, props.data.config.configuration['x-jevellan'].guards.pauseAfterPlan);
  const project = projects.find((entry) => entry.id === view.conversation.projectId);
  const settlementTarget = controls.settlement.target;
  const kept = controls.settlement.kept;
  const checkpointBlock = controls.recovery.checkpoint;
  const finishing = controls.finishing;
  const blockedFinish = controls.blockedFinish;
  const pagePresentation = conversationPagePresentationForStream(view, events);
  const pickerShown = pagePresentation.picker.shown;
  const branchChange = events.map(event => GitBranchChangeSchema.safeParse(event.data)).findLast(change => change.success)?.data;
  return (
    <div className="conversation-page" ref={page}>
      <div className="section-heading conversation-heading">
        <h1 aria-labelledby={titleId}>
          {navigation}
          <button
            id={titleId}
            className="conversation-title"
            title="Rename conversation"
            onClick={() => setEditingConversation('rename')}
          >
            {view.conversation.title}
          </button>
        </h1>
        <div className="conversation-meta" aria-label="Conversation details">
          <span className="chip">{project?.name ?? view.conversation.projectId}</span>
          <span className="chip">{device?.name ?? view.conversation.ownerDeviceId}</span>
          <span className={`chip state-${controls.state}`}>
            {running && <span className="activity-spinner" aria-hidden="true" />}{controls.stateLabel}
          </span>
        </div>
        <div className="actions">
          {running && (
            <button
              className="secondary"
              disabled={task.busy}
              onClick={() =>
                void task.run(async () =>
                  setView(
                    await api(`/api/conversations/${id}/control-command`, ConversationPublicSchema, 'POST', { schema: 'conversation-control-command-v1', operation: 'cancel', body: empty }),
                  ),
                )
              }
            >
              Cancel
            </button>
          )}
          <details className="conversation-menu" ref={conversationMenu}>
            <summary aria-label="Conversation menu">
              <Icon name="more" />
            </summary>
            <div>
              <button
                onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  setEditingConversation('rename');
                }}
              >
                Rename
              </button>
              <button
                disabled={!controls.canFinishOutside}
                onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  setEditingConversation('finish');
                }}
              >
                Finished outside Jevellan
              </button>
            </div>
          </details>
        </div>
        <LatestUserMessage text={view.messages.at(-1)?.text} />
      </div>
      {branchChange && <BranchChangeNotice change={branchChange} />}
      {!connected && (
        <p className="notice" role="status">
          Reconnecting…
        </p>
      )}
      {view.conversation.outcome && (
        <section className="notice">
          <strong>Finished outside Jevellan</strong>
          {view.conversation.outcome.reason && <p>{view.conversation.outcome.reason}</p>}
        </section>
      )}
      {blockedFinish && (
        <section className="card">
          <h2>Finish outside Jevellan</h2>
          <p>{blockedFinish.reason}</p>
          <button
            disabled={task.busy}
            onClick={() =>
              void task.run(async () =>
                setView(
                  await api(
                    `/api/conversations/${id}/control-command`,
                    ConversationPublicSchema,
                    'POST',
                    { schema: 'conversation-control-command-v1', operation: 'finish', body: blockedFinish.request },
                  ),
                ),
              )
            }
          >
            Retry finishing
          </button>
        </section>
      )}
      <div className="timeline" aria-label="Conversation timeline">
        {events.map((event) => {
          if (event.type === 'user-message' || event.type === 'note')
            return (
              <article className="user-message" key={event.id}>
                <div className="message-heading">
                  <strong>{event.type === 'note' ? 'Your note' : 'You'}</strong>
                  <ConversationTime value={event.t} />
                </div>
                {editingMessage?.id === event.id ? <form className="message-editor" onSubmit={edit => {
                  edit.preventDefault();
                  if (editedMessageEditor.canSendEdited) void task.run(signal => resendMessage(event.id, editingMessage.text, signal));
                }}>
                  <label htmlFor={`edit-message-${event.id}`}>Edit message</label>
                  <textarea id={`edit-message-${event.id}`} autoFocus value={editingMessage.text} onChange={change => setEditingMessage({ id: event.id, text: change.target.value })} />
                  <p className="muted small-text">Sends a revised message. Earlier messages and work stay in the history.</p>
                  <div className="user-message-actions">
                    <button type="submit" disabled={task.busy || !editedMessageEditor.canSendEdited}>Send edited message</button>
                    <button type="button" className="secondary" disabled={task.busy} onClick={() => setEditingMessage(undefined)}>Cancel</button>
                  </div>
                </form> : <>
                  <Markdown>{String(object(event.data).text ?? '')}</Markdown>
                  <div className="user-message-actions">
                    <button type="button" className="secondary" disabled={task.busy || !controls.messageActions.canRetry}
                      aria-label="Retry message"
                      title="Retry this request; previous work stays in the history"
                      onClick={() => void task.run(signal => resendMessage(event.id, String(object(event.data).text ?? ''), signal, 'retry'))}>Retry</button>
                    <button type="button" className="secondary" disabled={task.busy || !controls.messageActions.canEdit}
                      aria-label="Edit message"
                      onClick={() => setEditingMessage({ id: event.id, text: String(object(event.data).text ?? '') })}>Edit</button>
                  </div>
                </>}
              </article>
            );
          if (event.type === 'stretch-start') {
            const step = view.stretches.find((entry) => entry.n === event.stretch);
            if (!step) return null;
            const review = plans.reviews.find(entry => entry.step === step.n);
            return (
              <StepBlock
                key={event.id}
                step={step}
                view={view}
                transcriptView={transcripts[step.n]}
                rememberTranscript={rememberTranscript}
                events={events.filter((entry) => entry.stretch === step.n)}
                props={props}
                correct={() => setCorrecting(step)}
                why={() => setWhy(view.decisions.find((entry) => entry.id === step.decisionId))}
                selected={!!why && why.id === step.decisionId}
                planReview={review?.offered ? {
                  busy: task.busy || running,
                  approve: async () => { setView(await api(`/api/conversations/${id}/approve-plan`, ConversationPublicSchema, 'POST', planApprovalRequest(review))); },
                  changes: async (text, clientMessageId) => { setView(await api(`/api/conversations/${id}/messages`, ConversationPublicSchema, 'POST', planChangesMessage(review, text, clientMessageId))); },
                } : undefined}
                changes={() =>
                  void task.run(async () =>
                    setChanges(
                      await api(`/api/conversations/${id}/changes/${step.n}`, ConversationChangesSchema),
                    ),
                  )
                }
                read={(pointer, title) => read(pointer, title, step.n)}
              />
            );
          }
          const branchChange = GitBranchChangeSchema.safeParse(event.data);
          if (branchChange.success) return <BranchChangeNotice key={event.id} change={branchChange.data} presentation={view.branchChanges?.find(row => row.eventId === event.id)?.view} />;
          const notice = ConversationNoticeSchema.safeParse(event.data);
          const noticeStep = event.stretch ?? view.stretches.at(-1)?.n;
          if (notice.success && notice.data.kind === 'closing' && conversationNoticeHidden(transcripts[noticeStep ?? 0], event, {
            projectId: view.conversation.projectId, conversationId: id, step: noticeStep ?? 0, head: events.at(-1)?.id ?? 0, running: view.stretches.find(row => row.n === noticeStep)?.status === 'running',
            events: events.filter(entry => entry.stretch === noticeStep), summaries: view.handoffs.map(row => row.summary), summary: view.handoffs.find(row => row.stretch === noticeStep)?.summary,
          })) return null;
          if (notice.success)
            return (
              <p key={event.id} className={notice.data.kind === 'error' ? 'error' : 'notice'}>
                {notice.data.text}
              </p>
            );
          return null;
        })}
      </div>
      {/* A "Pick the next step:" pause heads the picker. Without the picker it keeps only its cause,
          and while work runs again it no longer applies. */}
      {pagePresentation.pause.notice !== null && <p className="notice">{pagePresentation.pause.notice}</p>}
      {controls.recovery.externalRetry && (
        <div className="actions">
          <button
            disabled={task.busy || view.busy}
            onClick={() =>
              void task.run(async () =>
                setView(
                  await api(`/api/conversations/${id}/retry-external`, ConversationPublicSchema, 'POST', {
                    schema: 'retry-external-activity-v1',
                    waitId: view.externalWait!.id,
                    generation: view.conversation.generation,
                  }),
                ),
              )
            }
          >
            Retry
          </button>
        </div>
      )}
      {controls.recovery.decision && (
        <div className="actions decision-recovery">
          <button
            className="secondary"
            disabled={task.busy}
            onClick={() =>
              void task.run(async () =>
                setView(
                  await api(`/api/conversations/${id}/resume`, ConversationPublicSchema, 'POST', {
                    schema: 'resume-decision-v1',
                    generation: view.conversation.generation,
                  }),
                ),
              )
            }
          >
            Try automatic again
          </button>
          {controls.recovery.accountIds.map((accountId) => (
            <button
              key={accountId}
              className="text-button"
              onClick={() => props.navigate(`/settings/runtimes?account=${encodeURIComponent(accountId)}`)}
            >
              Review{' '}
              {props.data.accounts.find((entry) => entry.account.id === accountId)?.account.label ??
                accountId}
            </button>
          ))}
        </div>
      )}
      {checkpointBlock && (
        <section className="card">
          <h2>Changes need your review</h2>
          <p>Check the files before accepting them as this work’s changes.</p>
          <button
            disabled={task.busy}
            onClick={() =>
              void task.run(async () =>
                setChanges(
                  await api(
                    `/api/conversations/${id}/changes/${checkpointBlock.stretch}`,
                    ConversationChangesSchema,
                  ),
                ),
              )
            }
          >
            Review changes
          </button>
        </section>
      )}
      {controls.recovery.redos.map((entry) => (
        <RetryRedo key={entry.id} entry={entry} view={view} update={setView} onError={props.onError} />
      ))}
      {plans.notice && (
        <p className="plan-waiting" role="status">{plans.notice.text} <button className="text-button" onClick={() => document.getElementById(plans.notice!.target ?? '')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{plans.notice.label}</button></p>
      )}
      {controls.question && (
        <section className="answer-card" aria-label="Answer the question">
          <p className="answer-question">{controls.question.text}</p>
          <div className="answer-options">
            {controls.question.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className={option.primary ? '' : 'secondary'}
                disabled={task.busy}
                title={option.detail}
                onClick={() => void answer(option.index)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="muted small-text">Or type a different answer below.</p>
        </section>
      )}
      {pickerShown && (
        <ManualPicker
          view={view}
          props={props}
          update={setView}
          heading={pagePresentation.picker.heading ?? undefined}
        />
      )}
      {kept && <p className="notice">Settle this work’s changes before starting another request.</p>}
      <form className="composer card" ref={composerClearance} onSubmit={event => {
        event.preventDefault();
        if (!task.busy && messageEditor.canSend) void submit('message');
      }}>
        {(running || behind) && <div className="cursor-live-bar ordinary-live-bar">
          {running && <ConversationActivity view={view} events={events} />}
          {behind && <button type="button" className="text-button jump-latest" onClick={() => { pinned.current = true; setBehind(false); window.scrollTo({ top: document.documentElement.scrollHeight }); }}>Jump to latest ↓</button>}
        </div>}
        <div className="message-input-row">
          <MessageInput inputRef={input} value={message} change={setMessage} label="Message"
            placeholder={running ? 'Steer this work…' : 'What would you like to do next?'} />
          <MessageDelivery running={running} presentation={view.delivery} disabled={task.busy || !messageEditor.canSend}
            queue={() => void submit('note')} />
        </div>
      </form>
      {settingsOpen && <Panel title="Conversation settings" close={() => setSettingsOpen(false)}>
          <ComposerChoices
            projectId={view.conversation.projectId} revision={props.data.config.revision} conversationId={id} generation={view.conversation.generation}
            disabled={task.busy || !!finishing} run={task.run}
            afterSave={async signal => setView(await api(`/api/conversations/${id}`, ConversationPublicSchema, 'GET', undefined, { signal, waitForHub: true }))}
          />
            {controls.settlement.shown && (
              <button
                type="button"
                className="secondary"
                disabled={!project}
                onClick={() => setSettling(true)}
              >
                {controls.settlement.label}
              </button>
            )}
      </Panel>}
      {editingConversation && (
        <EditConversation
          kind={editingConversation}
          view={view}
          update={setView}
          close={() => setEditingConversation(undefined)}
          onError={props.onError}
        />
      )}
      {settling && settlementTarget && project && (
        <SettleWork
          view={view}
          project={project}
          workId={settlementTarget.id}
          update={setView}
          close={() => setSettling(false)}
          onError={props.onError}
        />
      )}
      {correcting && (
        <ChangeStep
          step={correcting}
          view={view}
          props={props}
          update={setView}
          close={() => setCorrecting(undefined)}
        />
      )}
      {why && (
        <Why
          decision={why}
          props={props}
          close={() => setWhy(undefined)}
          key={why.id}
        />
      )}
      {changes && (
        <Panel title="Changes" eyebrow={`step ${changes.stretch}`} close={() => setChanges(undefined)}>
          <details className="changed-files"><summary>{changes.files.length} changed files <span className="muted small-text">Browse recorded files</span></summary><div className="changed-file-list" aria-label="Changed files">
            {changes.files.map((file) => (
              <p key={`${file.source}/${file.path}`}>
                <EvidenceLink
                  value={file.path}
                  file
                  open={(ref) => read(ref, file.path, changes.stretch, file.source)}
                />
                <span className="muted small-text">
                  {' '}
                  · {file.source === 'step' ? 'Recorded step' : 'Working copy'}
                </span>
              </p>
            ))}
          </div></details>
          <ChangesDiff text={changes.diff} view={changes.diffView} />
          {changes.uncommitted && (
            <>
              <h3>Uncommitted changes</h3>
              <ChangesDiff text={changes.uncommitted} view={changes.uncommittedView} label="Working copy diff" />
            </>
          )}
          {changes.recovery && (
            <AcceptChanges
              changes={changes}
              view={view}
              update={setView}
              close={() => setChanges(undefined)}
              refresh={() =>
                api(`/api/conversations/${id}/changes/${changes.stretch}`, ConversationChangesSchema).then(
                  setChanges,
                )
              }
              onError={props.onError}
            />
          )}
          {changes.evidence.length > 0 && (
            <>
              <h3>Agent evidence</h3>
              {changes.evidence.map((item, i) => (
                <p key={i}>
                  {item.kind}:{' '}
                  <EvidenceLink
                    value={item.ref}
                    file={item.kind === 'file' || item.kind === 'screenshot'}
                    open={(ref) => read(ref, item.note ?? ref, changes.stretch)}
                  />
                  {item.note ? ` — ${item.note}` : ''}
                </p>
              ))}
            </>
          )}
          <h3>Jevellan verification</h3>
          {!changes.verifications.length && <p className="muted">No verification receipt yet.</p>}
          {changes.verifications.map((receipt) => (
            <div className="verification-receipt" key={receipt.id}>
              <strong>
                {receipt.passed &&
                receipt.headStable &&
                (receipt.treeClean ||
                  (receipt.worktreeBefore === receipt.worktreeAfter && !!receipt.worktreeBefore))
                  ? 'Passed'
                  : 'Failed'}
              </strong>
              <p>
                <code>{receipt.command}</code>
                <br />
                Commit <code>{receipt.commit}</code>
              </p>
              <button
                className="text-button"
                onClick={() =>
                  void read(receipt.outputRef, 'Verification output', changes.stretch, undefined, true)
                }
              >
                Read output
              </button>
            </div>
          ))}
        </Panel>
      )}
      {content && (
        <EvidencePanel
          key={JSON.stringify(content)}
          id={id}
          target={content}
          close={() => setContent(undefined)}
        />
      )}
    </div>
  );
}
function ConversationActivity({ view, events }: { view: View; events: LedgerEvent[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const step = view.stretches.findLast((entry) => entry.status === 'running');
  const { phase, title, description, since } = (view.presentation ?? conversationPagePresentation(view)).activity;
  const elapsed = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const latestTool =
    step && events.findLast((event) => event.stretch === step.n && event.type === 'tool-start');
  const tool = latestTool && object(latestTool.data);
  const pending =
    tool && !events.some((event) => event.type === 'tool-end' && object(event.data).id === tool.id);
  return (
    <section className="conversation-activity" aria-label="Current activity">
      <span className="activity-spinner" aria-hidden="true" />
      <div>
        <strong role="status">{title}</strong>
        <p>{phase === 'running' && pending ? `Using ${String(tool.name)}…` : description}</p>
      </div>
      <time aria-label="Time in this stage">
        {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
      </time>
    </section>
  );
}
function EditConversation({
  kind,
  view,
  update,
  close,
  onError,
}: {
  kind: 'rename' | 'finish';
  view: View;
  update(value: View): void;
  close(): void;
  onError(error: unknown): void;
}) {
  const [context] = useState<z.infer<typeof ConversationControlContextSchema>>(() => conversationControlContext(view));
  const [editor, setEditor] = useState(() => conversationControlEditor(view, { schema: 'conversation-control-editor-request-v1', kind, context }));
  const [value, setValue] = useState(editor.initialValue);
  const task = useTask(onError);
  const pending = useRef<z.infer<typeof ConversationControlPendingSchema> | undefined>(undefined);
  const preview = conversationControlPreview(editor, value);
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/conversations/${view.conversation.id}/control-editor`, ConversationControlEditorSchema, 'POST', {
      schema: 'conversation-control-editor-request-v1', kind, context,
    }, { signal: controller.signal }).then(model => { if (!controller.signal.aborted) setEditor(model); }).catch(error => { if (!controller.signal.aborted) onError(error); });
    return () => controller.abort();
  }, [view.conversation.id, kind, context, onError]);
  return (
    <Modal title={editor.dialogTitle} close={close}>
      <form onSubmit={event => {
        event.preventDefault();
        void task.run(async signal => {
          const draft = await api(`/api/conversations/${view.conversation.id}/control-draft`, ConversationControlDraftSchema, 'POST', {
            schema: 'conversation-control-draft-request-v1', kind: editor.kind, context: editor.context, value, ...(pending.current ? { pending: pending.current } : {}),
          }, { signal });
          pending.current = draft.pending ?? undefined;
          if (!draft.command) return;
          update(await api(`/api/conversations/${view.conversation.id}/control-command`, ConversationPublicSchema, 'POST', draft.command, { signal }));
          close();
        });
      }}>
        {editor.multiline ? <>
          {editor.help && <p>{editor.help}</p>}
          <label>{editor.label}
            <textarea rows={4} maxLength={editor.maxLength} required={editor.required} autoFocus value={value} onChange={event => setValue(event.target.value)} />
            {editor.optionalLabel && <span className="muted small-text">{editor.optionalLabel}</span>}
          </label>
        </> : <label>{editor.label}
          <input required={editor.required} maxLength={editor.maxLength} autoFocus value={value} onChange={event => setValue(event.target.value)} />
        </label>}
        <div className="form-actions">
          <button type="button" className="secondary" disabled={task.busy} onClick={close}>Cancel</button>
          <button disabled={task.busy || !preview.canSave}>{task.busy ? 'Saving…' : editor.submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

function AcceptChanges({
  changes,
  view,
  update,
  close,
  refresh,
  onError,
}: {
  changes: z.infer<typeof ConversationChangesSchema>;
  view: View;
  update(value: View): void;
  close(): void;
  refresh(): Promise<void>;
  onError(error: unknown): void;
}) {
  const task = useTask(onError);
  const request = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const review = changes.recovery!;
  const step = view.stretches.find((entry) => entry.n === changes.stretch)!;
  return (
    <section className="card">
      <h3>Accept reviewed changes</h3>
      <p>
        {review.mode === 'acknowledge'
          ? 'Continue acknowledges the files shown here. This project follows its own Git rules; Jevellan will not commit or push these changes.'
          : 'Continue saves the files shown here as this work’s checkpoint. You can then choose the next step or publish after verification.'}
      </p>
      {review.reason && <p className="notice">{review.reason}</p>}
      <div className="actions">
        <button
          disabled={
            task.busy ||
            view.busy ||
            !review.fingerprint ||
            review.generation !== view.conversation.generation
          }
          onClick={() =>
            void task.run(async () => {
              const fingerprint = review.fingerprint!;
              if (request.current?.fingerprint !== fingerprint)
                request.current = { fingerprint, id: `adopt_${clientId()}` };
              update(
                await api(
                  `/api/conversations/${view.conversation.id}/adopt-changes`,
                  ConversationPublicSchema,
                  'POST',
                  {
                    schema: 'adopt-changes-v1',
                    clientRequestId: request.current.id,
                    workId: step.workId,
                    stretch: step.n,
                    generation: review.generation,
                    fingerprint,
                  },
                ),
              );
              close();
            })
          }
        >
          {task.busy ? 'Accepting…' : 'Continue'}
        </button>
        <button className="secondary" disabled={task.busy} onClick={() => void task.run(refresh)}>
          Refresh changes
        </button>
      </div>
    </section>
  );
}
function RetryRedo({
  entry,
  view,
  update,
  onError,
}: {
  entry: View['redos'][number];
  view: View;
  update(value: View): void;
  onError(error: unknown): void;
}) {
  const task = useTask(onError);
  const request = useRef<{ generation: number; id: string } | undefined>(undefined);
  return (
    <section className="card">
      <h2>Resume correction · step {entry.fromStretch}</h2>
      <p>{entry.reason ?? 'Undo and redo did not finish.'}</p>
      <p className="muted">
        Completed undo changes are kept. A redo step that already started will not run twice.
      </p>
      <button
        disabled={task.busy}
        onClick={() =>
          void task.run(async () => {
            if (request.current?.generation !== view.conversation.generation)
              request.current = { generation: view.conversation.generation, id: `retry_${clientId()}` };
            update(
              await api(
                `/api/conversations/${view.conversation.id}/retry-redo`,
                ConversationPublicSchema,
                'POST',
                {
                  schema: 'retry-redo-v1',
                  clientRequestId: request.current.id,
                  id: entry.id,
                  generation: request.current.generation,
                },
              ),
            );
            request.current = undefined;
          })
        }
      >
        {task.busy ? 'Resuming…' : 'Retry undo and redo'}
      </button>
    </section>
  );
}
function SettleWork({
  view,
  project,
  workId,
  update,
  close,
  onError,
}: {
  view: View;
  project: Project;
  workId: string;
  update(value: View): void;
  close(): void;
  onError(error: unknown): void;
}) {
  const [context] = useState<z.infer<typeof ConversationSettlementContextSchema>>(() => conversationSettlementContext(view, workId));
  const [editor, setEditor] = useState(() => conversationSettlementEditor(view, project, { schema: 'conversation-settlement-editor-request-v1', context }));
  const [confirming, setConfirming] = useState<z.infer<typeof ConversationSettlementEditorSchema>['choices'][number] | null>(null);
  const task = useTask(onError);
  const pending = useRef<z.infer<typeof ConversationSettlementPendingSchema> | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/conversations/${view.conversation.id}/settlement-editor`, ConversationSettlementEditorSchema, 'POST', {
      schema: 'conversation-settlement-editor-request-v1', context,
    }, { signal: controller.signal }).then(model => { if (!controller.signal.aborted) setEditor(model); }).catch(error => { if (!controller.signal.aborted) onError(error); });
    return () => controller.abort();
  }, [view.conversation.id, context, onError]);
  const choose = (choice: z.infer<typeof ConversationSettlementEditorSchema>['choices'][number]['choice']) =>
    task.run(async signal => {
      const draft = await api(`/api/conversations/${view.conversation.id}/settlement-draft`, ConversationSettlementDraftSchema, 'POST', {
        schema: 'conversation-settlement-draft-request-v1', context: editor.context, choice, ...(pending.current ? { pending: pending.current } : {}),
      }, { signal });
      pending.current = draft.pending;
      update(await api(`/api/conversations/${view.conversation.id}/settlement-command`, ConversationPublicSchema, 'POST', draft.command, { signal }));
      close();
    });
  const confirmation = confirming && editor.confirmation;
  return (
    <Modal title={confirmation ? confirmation.title : editor.title} close={close}>
      {confirmation ? <>
        {confirmation.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        <div className="actions">
          <button disabled={task.busy} onClick={() => void choose(confirming!.choice)}>{confirmation.submitLabel}</button>
          <button className="secondary" disabled={task.busy} onClick={() => setConfirming(null)}>{confirmation.backLabel}</button>
        </div>
      </> : <>
        <p>{editor.intro}</p>
        <div className={editor.confirmation ? 'settlement-choices' : undefined}>
          {editor.choices.map(option => <div key={option.choice}>
            <button className={option.secondary ? 'secondary' : undefined} disabled={task.busy} onClick={() => option.confirm ? setConfirming(option) : void choose(option.choice)}>{option.label}</button>
            {option.description && <p>{option.description}</p>}
          </div>)}
        </div>
      </>}
    </Modal>
  );
}

function ManualPicker({
  view,
  props,
  update,
  heading,
}: {
  view: View;
  props: PageProps;
  update(value: View): void;
  heading: string | undefined;
}) {
  const config = props.data.config.configuration['x-jevellan'];
  const models = config.menu.filter((model) => model.enabled && config.runtimes[model.runtime]?.enabled);
  const preferredModel = () =>
    [view.conversation.once.modelId, view.conversation.pins.modelId, view.conversation.current?.modelId].find(
      (id) => models.some((entry) => entry.id === id),
    ) ??
    models[0]?.id ??
    '';
  const preferredEffort = () =>
    view.conversation.once.effort ??
    view.conversation.pins.effort ??
    view.conversation.current?.effort ??
    'high';
  const [action, setAction] = useState<Action>(view.conversation.once.action ?? 'reply');
  const [model, setModel] = useState(preferredModel);
  const [effort, setEffort] = useState<Effort>(preferredEffort);
  const [remember, setRemember] = useState(false);
  const task = useTask(props.onError);
  useEffect(() => {
    setAction(view.conversation.once.action ?? 'reply');
    setModel(preferredModel());
    setEffort(preferredEffort());
  }, [
    view.conversation.once.action,
    view.conversation.once.modelId,
    view.conversation.once.effort,
    view.conversation.pins.modelId,
    view.conversation.pins.effort,
  ]);
  const planWaiting =
    config.guards.pauseAfterPlan &&
    view.conversation.work?.latestPlanRef &&
    view.conversation.work.approvedPlanRef !== view.conversation.work.latestPlanRef;
  const allowed = view.allowed.filter((entry) => !planWaiting || entry === 'plan');
  const chosen = allowed.includes(action) ? action : allowed[0];
  return (
    <form
      className="manual-picker card"
      onSubmit={(event) => {
        event.preventDefault();
        void task.run(async () =>
          update(
            await api(`/api/conversations/${view.conversation.id}/manual`, ConversationPublicSchema, 'POST', {
              schema: 'manual-step-v1',
              generation: view.conversation.generation,
              action: chosen,
              modelId: model || undefined,
              effort,
              remember,
            }),
          ),
        );
      }}
    >
      <h2>{heading ?? 'Pick the next step'}</h2>
      <div className="manual-fields">
        <label>
          Action
          <select value={chosen} onChange={(event) => setAction(event.target.value as Action)}>
            {allowed.map((entry) => (
              <option key={entry} value={entry}>
                {actionLabel(entry)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select
            value={model}
            disabled={chosen === 'done'}
            onChange={(event) => setModel(event.target.value)}
          >
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Effort
          <select
            value={effort}
            disabled={chosen === 'done'}
            onChange={(event) => setEffort(event.target.value as Effort)}
          >
            {['low', 'medium', 'high', 'xhigh', 'max'].map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="manual-footer">
        {chosen === 'reply' && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            This request explicitly asks to remember something.
          </label>
        )}
        <button disabled={task.busy || !chosen || (chosen !== 'done' && !model)}>
          {task.busy ? 'Starting…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}
function StepBlock({
  step,
  view,
  events,
  props,
  correct,
  why,
  changes,
  read,
  selected,
  planReview,
  transcriptView,
  rememberTranscript,
}: {
  step: Step;
  view: View;
  events: LedgerEvent[];
  props: PageProps;
  correct(): void;
  why(): void;
  changes(): void;
  read(pointer: string, title: string): void;
  selected: boolean;
  planReview?: PlanReviewActions | undefined;
  transcriptView?: ConversationTranscriptView | undefined;
  rememberTranscript(value: ConversationTranscriptView): void;
}) {
  const handoff = view.handoffs.find((entry) => entry.stretch === step.n);
  const model = props.data.config.configuration['x-jevellan'].menu.find((entry) => entry.id === step.modelId);
  const account = props.data.accounts.find((entry) => entry.account.id === step.accountId);
  const source = view.transcriptSources?.find(row => row.step === step.n), conversationId = view.conversation.id;
  const sourceTail = source?.tail, sourceRunning = source?.running;
  useEffect(() => {
    if (sourceTail === undefined) return;
    const abort = new AbortController(); let active = true;
    void api(`/api/conversations/${conversationId}/transcript-view`, ConversationTranscriptViewSchema, 'POST', { schema: 'conversation-transcript-request-v1', step: step.n }, { signal: abort.signal })
      .then(value => { if (active) rememberTranscript(value); }).catch(() => { /* Live stream projection remains readable during reconnects. */ });
    return () => { active = false; abort.abort(); };
  }, [conversationId, step.n, sourceTail, sourceRunning, rememberTranscript]);
  const snapshot = selectConversationTranscriptView(transcriptView, { projectId: view.conversation.projectId, conversationId, step: step.n, head: events.at(-1)?.id ?? 0, running: step.status === 'running', events, summary: handoff?.summary });
  const { transcript, activity, fallbackAnswer, finalTurns } = conversationTranscriptProjection(snapshot);
  const answerResult = handoff?.result?.type === 'answer' ? handoff.result : undefined;
  const finalTurnIds = new Set(finalTurns.map(turn => turn.id));
  const actionable = !!view.conversation.work && view.stretches.findLast(entry => entry.workId === view.conversation.work!.id && entry.status !== 'undone')?.n === step.n;
  const editable =
    step.status !== 'undone' &&
    [view.conversation.work?.id, view.closedWorks.at(-1)?.id].includes(step.workId);
  const presentation = step.presentation;
  const review = (view.plans ?? conversationPlansView(view, props.data.config.configuration['x-jevellan'].guards.pauseAfterPlan)).reviews.find(entry => entry.step === step.n);
  const findings = [
    ...events
      .filter((event) => event.type === 'finding')
      .map((event) => ({
        claim: String(object(event.data).claim ?? ''),
        pointer: String(object(event.data).pointer ?? ''),
      })),
    ...(handoff?.findings ?? []),
  ].filter(
    (finding, index, all) =>
      all.findIndex((entry) => entry.claim === finding.claim && entry.pointer === finding.pointer) === index,
  );
  const tokens = step.usage.inputTokens + step.usage.outputTokens;
  return (
    <article
      id={`stretch-${step.n}`}
      tabIndex={-1}
      className={`stretch-block card ${step.status === 'undone' ? 'undone' : ''} ${step.status === 'running' ? 'running' : ''} ${selected ? 'selected' : ''}`}
    >
      <div className="stretch-head assistant-reply-heading">
        <h2>
          Step {step.n} · {actionLabel(step.action)}
        </h2>
        <span className="assistant-model">{model?.label ?? step.modelId}</span>
        {presentation?.statusBadge && (
          <span className={`assistant-step-status status-${presentation.statusBadge.tone}`}>
            {presentation.statusBadge.spinner && <span className="activity-spinner" aria-hidden="true" />}
            {presentation.statusBadge.label}
          </span>
        )}
        {presentation?.corrections.map(entry => <span className="assistant-correction" key={entry.id}>{entry.text}</span>)}
        <StretchTiming step={step} />
      </div>
      {presentation?.notices.map((notice, index) => <div className="notice" key={index}>{notice.text}
        {notice.action && <button className="text-button" onClick={() => props.navigate(notice.action!.href)}>{notice.action.label}</button>}
      </div>)}
      {!!transcript.length && <div className="step-transcript cursor-transcript" aria-label={`Step ${step.n} transcript`}>
        {activity.map(item => item.kind === 'response'
          ? answerResult && finalTurnIds.has(item.id) ? null : <TranscriptTurn key={item.id} turn={item.turn} onOpen={ref => read(ref, ref)} />
          : <ConversationTools key={item.id} turns={item.turns} read={read} />)}
      </div>}
      {answerResult && <StepResult kind="answer" id={view.conversation.id} pointer={answerResult.ref} fallback={handoff!.summary} onError={props.onError} open={(ref) => read(ref, ref)} />}
      {fallbackAnswer && !answerResult && <Markdown onOpen={(ref) => read(ref, ref)}>{fallbackAnswer}</Markdown>}
      {handoff?.result?.type === 'plan' && <PlanReview id={view.conversation.id} pointer={handoff.result.ref} step={step.n} actions={planReview} approved={review?.approved ?? false} presentation={review} onError={props.onError} open={ref => read(ref, ref)} />}
      {actionable && handoff?.blockers.map((blocker, i) => <p className="notice" key={i}>{blocker}</p>)}
      {actionable && handoff?.question && view.openQuestion?.stretch !== step.n && <p className="notice">{handoff.question}</p>}
      <div className="stretch-links">
        <button className="secondary" onClick={changes}>
          <Icon name="diff" size={14} />
          Changes
          {!!handoff?.changedFiles.length && (
            <span className="muted" aria-hidden="true">
              · {handoff.changedFiles.length} file{handoff.changedFiles.length === 1 ? '' : 's'}
            </span>
          )}
        </button>
        <button className="secondary why-link" aria-pressed={selected} onClick={why}>
          <Icon name="why" size={14} />
          Why
        </button>
        {editable && <button className="secondary" onClick={correct} aria-label={`Change step ${step.n}`}>Change step</button>}
        {handoff?.result && handoff.result.type !== 'plan' && (
          <button className="secondary" onClick={() => read(handoff.result!.ref, 'Full result')}>
            Read full result
          </button>
        )}
      </div>
      <details className="step-details">
        <summary>Step details{findings.length > 0 && <span> · {findings.length} finding{findings.length === 1 ? '' : 's'}</span>}</summary>
        <div className="model-chips">
          <button className="chip action" disabled={!editable} onClick={correct} aria-label={`Change action for step ${step.n}`}>{step.action}</button>
          <button className="chip model" disabled={!editable} onClick={correct} aria-label={`Change model for step ${step.n}`}>{model?.label ?? step.modelId}</button>
          <button className="chip" disabled={!editable} onClick={correct} aria-label={`Change effort for step ${step.n}`}>
            {step.effortRequested === step.effortEffective ? step.effortEffective : `${step.effortRequested} → ${step.effortEffective}`}
          </button>
          <span className="chip">{account?.account.label ?? step.accountId}</span>
          <span className="chip">{props.data.devices.devices.find((entry) => entry.id === step.deviceId)?.name ?? step.deviceId}</span>
          {(tokens > 0 || step.usage.costUsd !== undefined) && <span className="chip dim">
            {tokens > 0 && `${compactNumber(tokens)} tokens`}
            {step.usage.costUsd !== undefined && `${tokens > 0 ? ' · ' : ''}$${step.usage.costUsd.toFixed(3)}${step.usage.costSource === 'estimated' ? ' est.' : ''}`}
          </span>}
        </div>
        {handoff && (
          <div className="handoff">
            <h3>
              Recorded summary{' '}
              <span className={`chip status-${handoff.status === 'done' ? 'completed' : handoff.status}`}>
                {handoff.status}
              </span>
            </h3>
            <Markdown onOpen={(ref) => read(ref, ref)}>{handoff.summary}</Markdown>
            {handoff.blockers.length > 0 && <><h3>Recorded blockers</h3><ul>{handoff.blockers.map((blocker, i) => <li key={i}>{blocker}</li>)}</ul></>}
            {handoff.question && <><h3>Recorded question</h3><p>{handoff.question}</p></>}
            {handoff.failedApproaches.length > 0 && <><h3>Attempted approaches</h3><ul>{handoff.failedApproaches.map((attempt, i) => <li key={i}>{attempt}</li>)}</ul></>}
          </div>
        )}
        {answerResult && finalTurns.length > 0 && <div className="recorded-response"><h3>Streamed reply</h3>{finalTurns.map(turn => <TranscriptTurn key={turn.id} turn={turn} onOpen={ref => read(ref, ref)} />)}</div>}
        {findings.length > 0 && (
          <ul className="findings">
            {findings.map((finding, i) => (
              <li key={i}>
                {finding.claim} <EvidenceLink value={finding.pointer} open={(ref) => read(ref, ref)} />
              </li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}
function ConversationTools({ turns, read }: { turns: ReturnType<typeof conversationTurns>; read(pointer: string, title: string): void }) {
  return <div className="conversation-tools conversation-tool-list">{mergeTranscriptTurns(turns).map(turn => <TranscriptTurn key={turn.id} turn={turn} onOpen={ref => read(ref, ref)} />)}</div>;
}
const conversationTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fullConversationTime = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'long' });
function ConversationTime({ value }: { value: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>Time unavailable</span>;
  return <time dateTime={value} title={fullConversationTime.format(date)}>{conversationTime.format(date)}</time>;
}
function StretchTiming({ step }: { step: Step }) {
  const timing = step.presentation?.timing;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!timing?.ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timing?.ticking, timing?.clockStartAt]);
  if (!timing) return <div className="stretch-timing">Timing unavailable</div>;
  const milliseconds = timing.clockStartAt ? Math.max(0, now - Date.parse(timing.clockStartAt)) : timing.durationMs;
  return <div className="stretch-timing" aria-label={`Step ${step.n} timing, local time`}>
    <span>Started <ConversationTime value={timing.startedAt} /></span>
    <span>{timing.endedAt ? <>{timing.endLabel} <ConversationTime value={timing.endedAt} /></> : timing.endLabel}</span>
    {milliseconds !== null && <span>{timing.durationLabel} <b>{duration(Math.floor(milliseconds / 1000))}</b></span>}
    <span className="timing-zone" title={Intl.DateTimeFormat().resolvedOptions().timeZone}>Local time</span>
  </div>;
}
const duration = (seconds: number) =>
  seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
const compactNumber = (value: number) =>
  value < 1000
    ? String(value)
    : value < 1_000_000
      ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
      : `${(value / 1_000_000).toFixed(1)}M`;
function StepResult({
  kind,
  fallback,
  id,
  pointer,
  onError,
  open,
}: {
  kind: 'plan' | 'answer';
  fallback?: string;
  id: string;
  pointer: string;
  onError(error: unknown): void;
  open(ref: string): void;
}) {
  const [content, setContent] = useState('');
  useEffect(() => {
    let stopped = false;
    void api(`/api/conversations/${id}/read?pointer=${encodeURIComponent(pointer)}`, ConversationReadSchema)
      .then((value) => {
        if (!stopped)
          setContent(
            typeof value.content === 'string' ? value.content : JSON.stringify(value.content, null, 2),
          );
      })
      .catch(onError);
    return () => {
      stopped = true;
    };
  }, [id, pointer, onError]);
  return (
    <div className={kind === 'plan' ? 'plan-result' : 'answer-result'}>
      <Markdown onOpen={open}>{content || fallback || `Loading the full ${kind}…`}</Markdown>
    </div>
  );
}
