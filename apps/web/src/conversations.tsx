import { clientId } from './client-id.js';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ActionSchema,
  ComposerInitialSchema,
  CorrectionsListSchema,
  ConversationChangesSchema,
  ConversationEventSchema,
  ConversationListSchema,
  ConversationNoticeSchema,
  ConversationPublicSchema,
  ConversationReadSchema,
  ProjectsListSchema,
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
import { changeComposerDraft, ComposerOverride } from './composer-choices.js';
import { Icon } from './icons.js';
import { EvidenceLink, EvidencePanel, type EvidenceTarget } from './evidence.js';
import { Markdown, Modal, Panel, dateTime, useDismissible, useTask, type PageProps } from './components.js';

type View = z.infer<typeof ConversationPublicSchema>;
type Step = View['stretches'][number];
// The daemon's pause text when no decision client is configured (packages/conversations MANUAL_NOTICE).
const MANUAL_PICK_NOTICE = 'Pick the next step, model and effort.';
const stateLabel = (state: string) =>
  ({
    'waiting-for-you': 'Waiting for you',
    running: 'Running',
    done: 'Done',
    cancelled: 'Cancelled',
    blocked: 'Blocked',
    idle: 'Ready',
  })[state] ?? state;
const actionLabel = (action: string) =>
  action === 'ask-you'
    ? 'Ask you'
    : action
        .split('-')
        .map((word) => word[0]!.toUpperCase() + word.slice(1))
        .join(' ');
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
  const [conversations, setConversations] = useState<z.infer<typeof ConversationListSchema>['conversations']>(
    [],
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  useEffect(() => {
    let stopped = false;
    let running = false;
    const controller = new AbortController();
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const [list, projects] = await Promise.all([
          api('/api/conversations', ConversationListSchema, 'GET', undefined, {
            signal: controller.signal,
            waitForHub: true,
          }),
          api('/hub/projects', ProjectsListSchema, 'GET', undefined, {
            signal: controller.signal,
            waitForHub: true,
          }),
        ]);
        if (!stopped) {
          setConversations(list.conversations);
          setProjects(projects.projects.map((row) => row.project));
        }
      } catch (error) {
        if (!stopped) onError(error);
      } finally {
        running = false;
      }
    };
    const changed = () => void load();
    window.addEventListener('jevellan-conversation-updated', changed);
    void load();
    const timer = setInterval(changed, 5000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('jevellan-conversation-updated', changed);
    };
  }, [onError, selected]);
  const inFilter = (label: string, state: string) =>
    label === 'All' ||
    (label === 'Running' && state === 'running') ||
    (label === 'Waiting for you' && ['waiting-for-you', 'blocked'].includes(state)) ||
    (label === 'Done' && ['done', 'cancelled'].includes(state));
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id;
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = conversations.filter((entry) =>
    terms.every((term) => `${entry.title} ${projectName(entry.projectId)}`.toLowerCase().includes(term)),
  );
  const visible = matching.filter((entry) => inFilter(filter, entry.state));
  const waiting = conversations.filter((entry) => inFilter('Waiting for you', entry.state)).length;
  const open = conversations.find((entry) => selected === `/conversations/${entry.id}`);
  useEffect(() => {
    // The tab shows at a glance when conversations need you, even from another window.
    document.title = `${waiting ? `(${waiting}) ` : ''}${open ? `${open.title} · ` : ''}Jevellan`;
  }, [waiting, open?.title]);
  return (
    <>
      <div className="filter-chips" role="group" aria-label="Conversation filters">
        {['All', 'Running', 'Waiting for you', 'Done'].map((label) => (
          <button
            key={label}
            className={label === filter ? 'selected' : ''}
            aria-pressed={label === filter}
            onClick={() => setFilter(label)}
          >
            {label}
            {label !== 'All' &&
              label !== 'Done' &&
              matching.some((entry) => inFilter(label, entry.state)) && (
                <span className="count" aria-hidden="true">
                  {matching.filter((entry) => inFilter(label, entry.state)).length}
                </span>
              )}
          </button>
        ))}
      </div>
      {conversations.length > 6 && (
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
      <div className="conversation-list">
        {!conversations.length ? (
          <p className="empty-conversations">No conversations yet. Start one to put your agents to work.</p>
        ) : !visible.length ? (
          <p className="empty-conversations">
            {terms.length ? 'No conversations match this search.' : 'No conversations in this view.'}
          </p>
        ) : (
          visible.map((entry) => (
            <button
              className={`conversation-row ${selected === `/conversations/${entry.id}` ? 'selected' : ''}`}
              key={entry.id}
              onClick={() => navigate(`/conversations/${entry.id}`)}
            >
              <i className={`state-dot state-${entry.state}`} aria-hidden="true" />
              <strong title={entry.title}>{entry.title}</strong>
              <span className="row-time">{shortTime(entry.updatedAt)}</span>
              <span className="row-meta">
                {stateLabel(entry.state)} · {projectName(entry.projectId)} ·{' '}
                {data.devices.devices.find((device) => device.id === entry.ownerDeviceId)?.name ??
                  entry.ownerDeviceId}
              </span>
            </button>
          ))
        )}
      </div>
    </>
  );
}

export function NewConversation(props: PageProps & { embedded?: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [message, setMessage] = useState('');
  const task = useTask(props.onError);
  const [waitingForSetup, setWaitingForSetup] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [choices, setChoices] = useState(() =>
    ComposerInitialSchema.parse({ schema: 'composer-initial-v1', once: {}, pins: {} }),
  );
  const pending = useRef<{ signature: string; id: string; clientMessageId: string } | undefined>(undefined);
  const device = props.data.devices.devices.find((entry) => entry.id === props.data.devices.currentDeviceId)!;
  useEffect(() => {
    const controller = new AbortController();
    void api('/hub/projects', ProjectsListSchema, 'GET', undefined, {
      signal: controller.signal,
      waitForHub: true,
    })
      .then((value) => {
        setProjects(value.projects.map((row) => row.project));
        setProjectId(value.projects[0]?.project.id ?? '');
      })
      .catch(props.onError);
    return () => controller.abort();
  }, [props.onError]);
  const project = projects.find((entry) => entry.id === projectId);
  const available =
    project?.paths[device.id] && (!project.allowedDevices || project.allowedDevices.includes(device.id));
  return (
    <div className={props.embedded ? 'new-conversation-embedded' : 'new-conversation-page'}>
      {!props.embedded && (
        <>
          <h1>New conversation</h1>
          <p className="intro">Give your agents a project and an objective.</p>
        </>
      )}
      {!props.data.accounts.length && (
        <p className="notice">
          Add an account to Claude Code or Codex first.{' '}
          <button className="text-button" onClick={() => props.navigate('/settings/runtimes')}>
            Open Runtimes →
          </button>
        </p>
      )}
      {!props.data.jev.saved && (
        <p className="notice">
          Add your Jev key in Settings → Decisions. Until then you pick each step yourself.
        </p>
      )}
      <form
        className="card new-conversation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async (signal) => {
            const signature = JSON.stringify({ projectId, message, choices });
            if (pending.current?.signature !== signature)
              pending.current = {
                signature,
                id: `conversation_${clientId()}`,
                clientMessageId: `message_${clientId()}`,
              };
            try {
              await waitForProjectSetup(projectId, signal, () => setWaitingForSetup(true));
            } finally {
              setWaitingForSetup(false);
            }
            const created = await api(
              '/api/conversations',
              ConversationPublicSchema,
              'POST',
              {
                schema: 'start-conversation-v1',
                id: pending.current.id,
                clientMessageId: pending.current.clientMessageId,
                projectId,
                title: message.split('\n')[0]!.slice(0, 100),
                message,
                ...(Object.keys(choices.once).length || Object.keys(choices.pins).length ? { choices } : {}),
              },
              { signal, waitForHub: true },
            );
            props.navigate(`/conversations/${created.conversation.id}`);
          });
        }}
      >
        <div className="new-conversation-fields">
          <div>
            <label>
              Project
              <select required value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="" disabled>
                  {projects.length ? 'Choose a project' : 'Add a project first'}
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
                <option value="here">This device: {device.name}</option>
                <option value="automatic" disabled>
                  Choose automatically
                </option>
              </select>
            </label>
            <small>
              Coming later: Jevellan will pick a free machine and avoid ones where other agents are working.
            </small>
          </div>
        </div>
        {project && !available && (
          <p className="notice">
            {project.name} isn’t set up on {device.name}. Add its path in Settings → Projects, or switch
            device.
          </p>
        )}
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
          once={choices.once}
          pins={choices.pins}
          config={props.data.config.configuration['x-jevellan']}
          actions={ActionSchema.options.filter(
            (action) => action !== 'integrate' && action !== 'done' && (action !== 'test' || !!project?.testCommand),
          )}
          disabled={task.busy}
          change={(field, value, mode) => setChoices((current) => changeComposerDraft(current, field, value, mode))}
        />
        <button disabled={task.busy || !available || !props.data.accounts.length || !message.trim()}>
          {task.busy ? 'Starting…' : 'Start'}
        </button>
      </form>
      {waitingForSetup && <p role="status">Finishing project setup…</p>}
      {addingProject && (
        <ProjectForm
          {...props}
          row={undefined}
          knownPublic={false}
          close={() => setAddingProject(false)}
          saved={async (signal) => {
            const result = await api('/hub/projects', ProjectsListSchema, 'GET', undefined, {
              signal,
              waitForHub: true,
            });
            const added = result.projects.find(
              (row) => !projects.some((project) => project.id === row.project.id),
            );
            setProjects(result.projects.map((row) => row.project));
            if (added) setProjectId(added.project.id);
            setAddingProject(false);
            props.message('Project added.');
          }}
        />
      )}
    </div>
  );
}

export function ConversationPage({ id, ...props }: PageProps & { id: string }) {
  const [view, setView] = useState<View>();
  const [events, setEvents] = useState<LedgerEvent[]>([]);
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
  useEffect(() => {
    const scrolled = () => {
      pinned.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener('scroll', scrolled, { passive: true });
    return () => window.removeEventListener('scroll', scrolled);
  }, []);
  const page = useRef<HTMLDivElement>(null);
  const loaded = !!view;
  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const follow = () => {
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
  const [message, setMessage] = useState('');
  const [why, setWhy] = useState<DecisionRecord>();
  const [changes, setChanges] = useState<z.infer<typeof ConversationChangesSchema>>();
  const [content, setContent] = useState<EvidenceTarget>();
  const task = useTask(props.onError);
  const input = useRef<HTMLTextAreaElement>(null);
  const messageId = useRef(`message_${clientId()}`);
  useEffect(() => {
    if (view) window.dispatchEvent(new Event('jevellan-conversation-updated'));
  }, [view?.conversation.id, view?.conversation.state, view?.conversation.title]);
  useEffect(() => {
    void api('/hub/projects', ProjectsListSchema)
      .then((value) => setProjects(value.projects.map((entry) => entry.project)))
      .catch(props.onError);
  }, [props.onError]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = queuedRefresh(
      (signal) => api(`/api/conversations/${id}`, ConversationPublicSchema, 'GET', undefined, { signal }),
      setView,
      props.onError,
    );
    void refresh.request();
    const stream = new EventSource(`/api/conversations/${id}/events`);
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.addEventListener('conversation', (event: MessageEvent<string>) => {
      try {
        const value = ConversationEventSchema.parse(JSON.parse(event.data));
        setEvents((previous) =>
          previous.some((entry) => entry.id === value.event.id)
            ? previous
            : [...previous, value.event].sort((a, b) => a.id - b.id),
        );
        clearTimeout(timer);
        timer = setTimeout(() => void refresh.request(), 40);
      } catch (error) {
        stream.close();
        props.onError(error);
      }
    });
    return () => {
      refresh.stop();
      clearTimeout(timer);
      stream.close();
    };
  }, [id, props.onError]);
  const submit = (kind: 'message' | 'note') =>
    task.run(async () => {
      if (!message.trim()) return;
      const value = await api(`/api/conversations/${id}/messages`, ConversationPublicSchema, 'POST', {
        schema: 'conversation-message-v1',
        clientMessageId: messageId.current,
        text: message,
        kind,
      });
      messageId.current = `message_${clientId()}`;
      setView(value);
      setMessage('');
    });
  // Picking an offered answer sends it as the message and records which option it was.
  const answer = (option: number) =>
    task.run(async () => {
      const open = view?.openQuestion; const label = open?.options[option]?.label; if (!open || !label) return;
      setView(
        await api(`/api/conversations/${id}/messages`, ConversationPublicSchema, 'POST', {
          schema: 'conversation-message-v1',
          clientMessageId: `answer_${clientId()}`,
          text: label,
          kind: 'message',
          answer: { stretch: open.stretch, option },
        }),
      );
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
  const running = view.busy || view.conversation.state === 'running';
  const plan = view.conversation.work?.latestPlanRef;
  const project = projects.find((entry) => entry.id === view.conversation.projectId);
  const settlementTarget = view.conversation.work ?? view.closedWorks.at(-1);
  const latestSettlement = view.settlements.filter((entry) => entry.workId === settlementTarget?.id).at(-1);
  const canSettle =
    !!settlementTarget &&
    settlementTarget.closedAs !== 'done' &&
    (!!view.conversation.work ||
      !latestSettlement ||
      latestSettlement.status !== 'completed' ||
      latestSettlement.retained);
  const kept = !view.conversation.work && canSettle;
  const checkpointBlock = view.checkpointBlocks
    .filter((entry) => entry.workId === settlementTarget?.id)
    .at(-1);
  const finishing = view.finishes.find((entry) => entry.status !== 'completed');
  const pickerShown = !!(
    !running &&
    !finishing &&
    view.conversation.work &&
    !view.pause?.guard &&
    !checkpointBlock &&
    // A manual pick is offered only when Jevellan cannot decide; otherwise the next message goes to Auto.
    (view.pause?.reason.endsWith('Pick the next step:') || view.pause?.reason === MANUAL_PICK_NOTICE)
  );
  const lastNotice = events
    .map((event) => ConversationNoticeSchema.safeParse(event.data))
    .findLast((notice) => notice.success)?.data?.text;
  return (
    <div className="conversation-page" ref={page}>
      <div className="section-heading conversation-heading">
        <h1>
          <button
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
          <span className={`chip state-${running ? 'running' : view.conversation.state}`}>
            {running ? 'Working' : stateLabel(view.conversation.state)}
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
                    await api(`/api/conversations/${id}/cancel`, ConversationPublicSchema, 'POST', empty),
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
                disabled={!!finishing || !!view.conversation.outcome}
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
      </div>
      {!connected && (
        <p className="notice" role="status">
          Reconnecting…
        </p>
      )}
      {running && <ConversationActivity view={view} events={events} />}
      {view.conversation.outcome && (
        <section className="notice">
          <strong>Finished outside Jevellan</strong>
          {view.conversation.outcome.reason && <p>{view.conversation.outcome.reason}</p>}
        </section>
      )}
      {finishing?.status === 'blocked' && (
        <section className="card">
          <h2>Finish outside Jevellan</h2>
          <p>{finishing.reason}</p>
          <button
            disabled={task.busy}
            onClick={() =>
              void task.run(async () =>
                setView(
                  await api(
                    `/api/conversations/${id}/finish-outside`,
                    ConversationPublicSchema,
                    'POST',
                    finishing.request,
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
                <strong>{event.type === 'note' ? 'Your note' : 'You'}</strong>
                <p>{String(object(event.data).text ?? '')}</p>
              </article>
            );
          if (event.type === 'stretch-start') {
            const step = view.stretches.find((entry) => entry.n === event.stretch);
            if (!step) return null;
            return (
              <StepBlock
                key={event.id}
                step={step}
                view={view}
                events={events.filter((entry) => entry.stretch === step.n)}
                props={props}
                correct={() => setCorrecting(step)}
                why={() => setWhy(view.decisions.find((entry) => entry.id === step.decisionId))}
                selected={!!why && why.id === step.decisionId}
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
          const notice = ConversationNoticeSchema.safeParse(event.data);
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
      {view.pause &&
        !(view.pause.reason.endsWith('Pick the next step:') && (pickerShown || running)) &&
        // A question already posted in the timeline, or shown with its answers below, is not repeated.
        view.pause.reason !== lastNotice &&
        view.pause.reason !== view.openQuestion?.text && (
        <p className="notice">{view.pause.reason.replace(/\s*Pick the next step:$/, '')}</p>
      )}
      {!running && view.externalWait && !checkpointBlock && !finishing && (
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
      {!running && view.decisionWait && !view.pause?.guard && !checkpointBlock && (
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
          {[...new Set(view.decisionWait.reasons.flatMap((reason) => reason.accountIds))].map((accountId) => (
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
      {!running && checkpointBlock && (
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
      {!running &&
        view.redos
          .filter(
            (entry) =>
              entry.status === 'blocked' &&
              (entry.workId === (view.conversation.work ?? view.closedWorks.at(-1))?.id ||
                (entry.followingWorkId &&
                  entry.followingWorkId === view.conversation.work?.id &&
                  entry.workId === view.closedWorks.at(-1)?.id)),
          )
          .map((entry) => (
            <RetryRedo key={entry.id} entry={entry} view={view} update={setView} onError={props.onError} />
          ))}
      {!running &&
        plan &&
        props.data.config.configuration['x-jevellan'].guards.pauseAfterPlan &&
        view.conversation.work?.approvedPlanRef !== plan && (
          <div className="actions plan-actions">
            <button
              disabled={task.busy}
              onClick={() =>
                void task.run(async () =>
                  setView(
                    await api(`/api/conversations/${id}/approve-plan`, ConversationPublicSchema, 'POST', {
                      schema: 'plan-approval-v1',
                      generation: view.conversation.generation,
                      ref: plan,
                    }),
                  ),
                )
              }
            >
              Go ahead
            </button>
            <button
              className="secondary"
              onClick={() => {
                setMessage('Change the plan: ');
                input.current?.focus();
              }}
            >
              Change the plan
            </button>
          </div>
        )}
      {view.openQuestion && view.openQuestion.options.length > 0 && (
        <section className="answer-card" aria-label="Answer the question">
          <p className="answer-question">{view.openQuestion.text}</p>
          <div className="answer-options">
            {view.openQuestion.options.map((option, index) => (
              <button
                key={option.label}
                type="button"
                className={index === 0 ? '' : 'secondary'}
                disabled={task.busy}
                title={option.detail}
                onClick={() => void answer(index)}
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
          heading={view.pause?.reason.endsWith('Pick the next step:') ? view.pause.reason : undefined}
        />
      )}
      {kept && <p className="notice">Settle this work’s changes before starting another request.</p>}
      <form
        className="composer card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!kept && !finishing) void submit('message');
        }}
      >
        <label>
          <span className="sr-only">Message</span>
          <textarea
            ref={input}
            rows={2}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter starts a new line.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              running
                ? 'Send a correction, or add a note for the next step.'
                : 'What would you like to do next?'
            }
          />
        </label>
        <div className="composer-bar">
          <ComposerOverride
              once={view.conversation.once}
              pins={view.conversation.pins}
              config={props.data.config.configuration['x-jevellan']}
              actions={
                view.conversation.work
                  ? view.allowed
                  : ActionSchema.options.filter(
                      (action) =>
                        action !== 'integrate' &&
                        action !== 'done' &&
                        (action !== 'test' || !!project?.testCommand),
                    )
              }
              disabled={task.busy || !!finishing}
              change={(field, value, mode) =>
                void task.run(async () =>
                  setView(
                    await api(`/api/conversations/${id}/choices`, ConversationPublicSchema, 'POST', {
                      schema: 'composer-choice-v1',
                      clientRequestId: `choice_${clientId()}`,
                      generation: view.conversation.generation,
                      field,
                      value,
                      mode,
                    }),
                  ),
                )
              }
            />
          <div className="actions">
            <button disabled={task.busy || kept || !!finishing || !message.trim()}>
              {running ? 'Send correction' : 'Send'}
            </button>
            {running && (
              <button
                type="button"
                className="secondary"
                disabled={task.busy || kept || !!finishing || !message.trim()}
                onClick={() => void submit('note')}
              >
                Add note
              </button>
            )}
            {!running && !finishing && canSettle && (
              <button
                type="button"
                className="secondary"
                disabled={!project}
                onClick={() => setSettling(true)}
              >
                {view.conversation.work ? 'Close this work' : 'Settle kept changes'}
              </button>
            )}
          </div>
        </div>
      </form>
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
          external={project?.branchPolicy === 'external'}
          props={props}
          update={setView}
          close={() => setCorrecting(undefined)}
        />
      )}
      {why && (
        <Why
          decision={why}
          stretch={view.stretches.find((entry) => entry.decisionId === why.id)}
          props={props}
          close={() => setWhy(undefined)}
          key={why.id}
        />
      )}
      {changes && (
        <Panel title="Changes" eyebrow={`step ${changes.stretch}`} close={() => setChanges(undefined)}>
          <div className="changed-file-list" aria-label="Changed files">
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
          </div>
          <Diff text={changes.diff} />
          {changes.uncommitted && (
            <>
              <h3>Uncommitted changes</h3>
              <Diff text={changes.uncommitted} />
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
const progressLabels = {
  preparing: ['Preparing your request', 'Checking the project and available accounts.'],
  deciding: ['Jev is choosing the next step', 'Classifying the request and selecting a model and effort.'],
  memory: ['Preparing context', 'Selecting relevant project memory for this step.'],
  starting: ['Starting the agent', 'The step is selected. Waiting for its first response.'],
  running: ['Agent is working', 'Responses and tool activity appear below as they arrive.'],
  saving: ['Saving this step', 'Checking changes and recording the handoff.'],
  verifying: ['Checking the result', 'Validating the work before marking it complete.'],
  publishing: ['Verifying and publishing', 'Running the final checks and saving the result.'],
} as const;
function ConversationActivity({ view, events }: { view: View; events: LedgerEvent[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const step = view.stretches.findLast((entry) => entry.status === 'running');
  const phase = view.progress?.phase ?? (step ? 'running' : 'preparing');
  const [title, description] = progressLabels[phase];
  const since = view.progress?.since ?? step?.startedAt ?? view.conversation.updatedAt;
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
  const [value, setValue] = useState(kind === 'rename' ? view.conversation.title : '');
  const task = useTask(onError);
  const original = useRef({ title: view.conversation.title, generation: view.conversation.generation });
  const pending = useRef<{ value: string; id: string } | undefined>(undefined);
  return (
    <Modal title={kind === 'rename' ? 'Rename conversation' : 'Finished outside Jevellan'} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            const text = value.trim();
            if (pending.current?.value !== text)
              pending.current = { value: text, id: `${kind}_${clientId()}` };
            const body =
              kind === 'rename'
                ? {
                    schema: 'rename-conversation-v1',
                    clientRequestId: pending.current.id,
                    previousTitle: original.current.title,
                    title: text,
                  }
                : {
                    schema: 'finish-outside-v1',
                    clientRequestId: pending.current.id,
                    generation: original.current.generation,
                    ...(text ? { reason: text } : {}),
                  };
            update(
              await api(
                `/api/conversations/${view.conversation.id}/${kind === 'rename' ? 'rename' : 'finish-outside'}`,
                ConversationPublicSchema,
                'POST',
                body,
              ),
            );
            close();
          });
        }}
      >
        {kind === 'rename' ? (
          <label>
            Title
            <input
              required
              maxLength={200}
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        ) : (
          <>
            <p>
              This stops the active step and keeps repository changes. Kept changes remain available to
              settle.
            </p>
            <label>
              What made you finish elsewhere?
              <textarea
                rows={4}
                maxLength={2000}
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <span className="muted small-text">Optional</span>
            </label>
          </>
        )}
        <div className="form-actions">
          <button type="button" className="secondary" disabled={task.busy} onClick={close}>
            Cancel
          </button>
          <button disabled={task.busy || (kind === 'rename' && !value.trim())}>
            {task.busy ? 'Saving…' : kind === 'rename' ? 'Save title' : 'Mark finished'}
          </button>
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
  const [discard, setDiscard] = useState(false);
  const task = useTask(onError);
  const request = useRef<{ choice: string; id: string } | undefined>(undefined);
  const choose = (choice: 'publish' | 'keep' | 'discard') =>
    task.run(async () => {
      if (request.current?.choice !== choice) request.current = { choice, id: `settlement_${clientId()}` };
      update(
        await api(`/api/conversations/${view.conversation.id}/settle`, ConversationPublicSchema, 'POST', {
          schema: 'settle-work-v1',
          clientRequestId: request.current.id,
          workId,
          generation: view.conversation.generation,
          choice,
        }),
      );
      close();
    });
  return (
    <Modal title={discard ? 'Discard this work' : 'Close this work'} close={close}>
      {project.branchPolicy === 'external' ? (
        <>
          <p>This project follows its own git rules. Its files stay as they are.</p>
          <button disabled={task.busy} onClick={() => void choose('keep')}>
            Close and keep changes
          </button>
        </>
      ) : discard ? (
        <>
          <p>
            This resets this work’s unpublished code and memory checkpoints to where the work started. A
            recovery ref is saved first. Uncommitted files must be checkpointed before they can be discarded.
          </p>
          <p>
            Anything outside the repository, such as databases, deployments or messages sent, is not undone.
          </p>
          <div className="actions">
            <button disabled={task.busy} onClick={() => void choose('discard')}>
              Discard checkpoints
            </button>
            <button className="secondary" disabled={task.busy} onClick={() => setDiscard(false)}>
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Choose what happens to this work’s unpublished changes.</p>
          <div className="settlement-choices">
            <div>
              <button disabled={task.busy} onClick={() => void choose('publish')}>
                Publish
              </button>
              <p>Verify the final checkpoint, bring in newer work from main, and publish.</p>
            </div>
            <div>
              <button className="secondary" disabled={task.busy} onClick={() => void choose('keep')}>
                Keep them
              </button>
              <p>
                Close the work and keep its changes. The checkout stays reserved while changes remain
                unsettled.
              </p>
            </div>
            <div>
              <button className="secondary" disabled={task.busy} onClick={() => setDiscard(true)}>
                Discard…
              </button>
              <p>Save a recovery ref, then reset unpublished checkpoints.</p>
            </div>
          </div>
        </>
      )}
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
}) {
  const handoff = view.handoffs.find((entry) => entry.stretch === step.n);
  const model = props.data.config.configuration['x-jevellan'].menu.find((entry) => entry.id === step.modelId);
  const account = props.data.accounts.find((entry) => entry.account.id === step.accountId);
  const text = events
    .filter((entry) => entry.type === 'text')
    .map((entry) => String(object(entry.data).delta ?? ''))
    .join('');
  const seconds = Math.max(
    0,
    Math.round((Date.parse(step.endedAt ?? new Date().toISOString()) - Date.parse(step.startedAt)) / 1000),
  );
  const editable =
    step.status !== 'undone' &&
    [view.conversation.work?.id, view.closedWorks.at(-1)?.id].includes(step.workId);
  const corrections = view.overrides.filter((entry) => entry.request.stretch === step.n);
  const decision = view.decisions.find((entry) => entry.id === step.decisionId);
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
  const tools = events.filter((entry) => entry.type === 'tool-start');
  const failedTools = events.filter(
    (entry) => entry.type === 'tool-end' && object(entry.data).ok === false,
  ).length;
  const tokens = step.usage.inputTokens + step.usage.outputTokens;
  return (
    <article
      id={`stretch-${step.n}`}
      tabIndex={-1}
      className={`stretch-block card ${step.status === 'undone' ? 'undone' : ''} ${step.status === 'running' ? 'running' : ''} ${selected ? 'selected' : ''}`}
    >
      <div className="stretch-head">
        <h2>
          Step {step.n} · {actionLabel(step.action)}
        </h2>
        <div className="model-chips">
          <button
            className="chip action"
            disabled={!editable}
            onClick={correct}
            aria-label={`Change action for step ${step.n}`}
          >
            {step.action}
          </button>
          <button
            className="chip model"
            disabled={!editable}
            onClick={correct}
            aria-label={`Change model for step ${step.n}`}
          >
            {model?.label ?? step.modelId}
          </button>
          <button
            className="chip"
            disabled={!editable}
            onClick={correct}
            aria-label={`Change effort for step ${step.n}`}
          >
            {step.effortRequested === step.effortEffective
              ? step.effortEffective
              : `${step.effortRequested} → ${step.effortEffective}`}
          </button>
          <span className="chip">{account?.account.label ?? step.accountId}</span>
          <span className="chip">
            {props.data.devices.devices.find((entry) => entry.id === step.deviceId)?.name ?? step.deviceId}
          </span>
          <span className="chip dim">
            {duration(seconds)}
            {tokens > 0 && ` · ${compactNumber(tokens)} tokens`}
            {step.usage.costUsd !== undefined &&
              ` · $${step.usage.costUsd.toFixed(3)}${step.usage.costSource === 'estimated' ? ' est.' : ''}`}
          </span>
          {step.status !== 'completed' && (
            <span className={`chip status-${step.status}`}>
              {step.status === 'undone' ? 'Undone' : stepStatusLabel(step.status)}
            </span>
          )}
          {corrections.map((entry) => (
            <span className="chip tag" key={entry.id}>
              corrected: {entry.changes.map((change) => `${change.field} → ${change.to}`).join(', ')}
            </span>
          ))}
        </div>
      </div>
      {decision?.notices
        .filter((notice) => notice.kind === 'preferred-needs-login')
        .map((notice, index) => (
          <div className="notice" key={index}>
            {notice.text}
            {notice.accountId && (
              <button
                className="text-button"
                onClick={() =>
                  props.navigate(
                    `/settings/runtimes?account=${encodeURIComponent(notice.accountId!)}&login=1`,
                  )
                }
              >
                Log in
              </button>
            )}
          </div>
        ))}
      {text &&
        (step.status === 'running' || step.action === 'reply' || !handoff ? (
          <Markdown onOpen={(ref) => read(ref, ref)}>{text}</Markdown>
        ) : (
          <details className="step-transcript">
            <summary>Agent response</summary>
            <Markdown onOpen={(ref) => read(ref, ref)}>{text}</Markdown>
          </details>
        ))}
      {tools.length > 0 && (
        <details className="tool-activity">
          <summary>
            {tools.length} tool call{tools.length === 1 ? '' : 's'}
            {failedTools > 0 && <span className="failed"> · {failedTools} failed</span>}
            {step.status === 'running' && latestToolName(tools) && (
              <span className="running"> · {latestToolName(tools)}</span>
            )}
          </summary>
          {tools.map((event) => {
            const tool = object(event.data);
            const end = events.find(
              (entry) => entry.type === 'tool-end' && object(entry.data).id === tool.id,
            );
            const hint = toolHint(tool.input);
            return (
              <details className="tool-call" key={event.id}>
                <summary>
                  <span className="tool-name">{String(tool.name ?? 'Tool')}</span>
                  {hint && <span className="tool-hint">{hint}</span>}
                  <span
                    className={`tool-state ${end ? (object(end.data).ok ? 'done' : 'failed') : 'running'}`}
                  >
                    {end ? (object(end.data).ok ? 'Done' : 'Failed') : 'Running'}
                  </span>
                </summary>
                <pre>{JSON.stringify(tool.input, null, 2)}</pre>
                {[
                  ...new Set(
                    [
                      object(tool.input).path,
                      object(tool.input).file_path,
                      object(tool.input).filePath,
                    ].filter((value): value is string => typeof value === 'string'),
                  ),
                ].map((path) => (
                  <p className="tool-file" key={path}>
                    <EvidenceLink value={path} file open={(ref) => read(ref, ref)} />
                  </p>
                ))}
                {end && object(end.data).output !== undefined && <pre>{String(object(end.data).output)}</pre>}
              </details>
            );
          })}
        </details>
      )}
      {handoff && (
        <div className="handoff">
          <h3>
            Handoff{' '}
            <span className={`chip status-${handoff.status === 'done' ? 'completed' : handoff.status}`}>
              {handoff.status}
            </span>
          </h3>
          <Markdown onOpen={(ref) => read(ref, ref)}>{handoff.summary}</Markdown>
          {handoff.result?.type === 'plan' && (
            <Plan
              id={view.conversation.id}
              pointer={handoff.result.ref}
              onError={props.onError}
              open={(ref) => read(ref, ref)}
            />
          )}
          {handoff.blockers.map((blocker, i) => (
            <p className="notice" key={i}>
              {blocker}
            </p>
          ))}
          {handoff.question && view.openQuestion?.stretch !== step.n && <p className="notice">{handoff.question}</p>}
        </div>
      )}
      {findings.length > 0 && (
        <ul className="findings">
          {findings.map((finding, i) => (
            <li key={i}>
              {finding.claim} <EvidenceLink value={finding.pointer} open={(ref) => read(ref, ref)} />
            </li>
          ))}
        </ul>
      )}
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
        {handoff?.result && handoff.result.type !== 'plan' && (
          <button className="secondary" onClick={() => read(handoff.result!.ref, 'Full result')}>
            Read full result
          </button>
        )}
      </div>
    </article>
  );
}
const stepStatusLabel = (status: string) =>
  ({ running: 'Running', interrupted: 'Interrupted', failed: 'Failed', 'timed-out': 'Timed out' })[status] ??
  status;
const duration = (seconds: number) =>
  seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
const compactNumber = (value: number) =>
  value < 1000
    ? String(value)
    : value < 1_000_000
      ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
      : `${(value / 1_000_000).toFixed(1)}M`;
const latestToolName = (tools: LedgerEvent[]) => {
  const name = object(tools.at(-1)?.data).name;
  return typeof name === 'string' ? name : undefined;
};
// A short, readable hint for a tool call: the file it touches or the command it runs.
const toolHint = (input: unknown) => {
  const value = object(input);
  const candidate = [
    value.file_path,
    value.filePath,
    value.path,
    value.command,
    value.cmd,
    value.pattern,
    value.query,
    value.url,
  ].find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  if (candidate) return candidate.split('\n')[0]!.slice(0, 160);
  const list = [value.command, value.args].find((entry): entry is string[] => Array.isArray(entry));
  return list ? list.join(' ').slice(0, 160) : undefined;
};
function ChangeStep({
  step,
  view,
  external,
  props,
  update,
  close,
}: {
  step: Step;
  view: View;
  external: boolean;
  props: PageProps;
  update(value: View): void;
  close(): void;
}) {
  const models = props.data.config.configuration['x-jevellan'].menu;
  const [action, setAction] = useState(step.action);
  const [modelId, setModel] = useState(step.modelId);
  const [effort, setEffort] = useState(step.effortRequested);
  const [confirm, setConfirm] = useState(false);
  const task = useTask(props.onError);
  const request = useRef<{ signature: string; id: string } | undefined>(undefined);
  const choices = {
    ...(action !== step.action ? { action } : {}),
    ...(modelId !== step.modelId ? { modelId } : {}),
    ...(effort !== step.effortRequested ? { effort } : {}),
  };
  const changed = Object.keys(choices).length > 0;
  const submit = (mode: 'noted' | 'redo') =>
    task.run(async () => {
      const body = {
        schema: 'correct-step-v1',
        generation: view.conversation.generation,
        stretch: step.n,
        mode,
        choices,
      };
      const signature = JSON.stringify(body);
      if (request.current?.signature !== signature)
        request.current = { signature, id: `correction_${clientId()}` };
      update(
        await api(`/api/conversations/${view.conversation.id}/correct`, ConversationPublicSchema, 'POST', {
          ...body,
          clientRequestId: request.current.id,
        }),
      );
      close();
    });
  const choice = `${actionLabel(action)}, ${models.find((entry) => entry.id === modelId)?.label ?? modelId}, ${effort}`;
  return (
    <Modal title="Change this step" close={close}>
      {external && (
        <p className="notice">
          This project follows its own git rules. Undo changes the conversation history; repository files are
          kept.
        </p>
      )}
      {confirm ? (
        <>
          <p>
            {external
              ? `This marks the steps from ${step.n} onwards undone in the conversation and redoes the step with ${choice}. Repository files are kept.`
              : `This undoes the code and memory changes from step ${step.n} onwards and redoes it with ${choice}. Anything outside the repository (databases, deployments, messages sent) is not undone.`}
          </p>
          {view.conversation.work && view.conversation.work.id !== step.workId && (
            <p className="muted">
              This also undoes the newer open work. Its request and notes stay with the reopened work.
            </p>
          )}
          <div className="actions">
            <button disabled={task.busy} onClick={() => void submit('redo')}>
              {task.busy ? 'Stopping and undoing…' : 'Undo and redo'}
            </button>
            <button className="secondary" disabled={task.busy} onClick={() => setConfirm(false)}>
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Step {step.n}</p>
          <label>
            Action
            <select value={action} onChange={(event) => setAction(event.target.value as Action)}>
              {[
                'reply',
                'plan',
                'implement',
                'test',
                'review',
                'adversarial-review',
                'ask-you',
                'done',
                ...(step.action === 'integrate' ? ['integrate'] : []),
              ].map((entry) => (
                <option key={entry} value={entry} disabled={entry === 'integrate'}>
                  {actionLabel(entry)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <select value={modelId} onChange={(event) => setModel(event.target.value)}>
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Effort
            <select value={effort} onChange={(event) => setEffort(event.target.value as Effort)}>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((entry) => (
                <option key={entry}>{entry}</option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button
              disabled={task.busy || !changed || action === 'integrate'}
              onClick={() => setConfirm(true)}
            >
              Override and undo
            </button>
            <button
              className="secondary"
              disabled={task.busy || !changed}
              onClick={() => void submit('noted')}
            >
              Just override
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
function Plan({
  id,
  pointer,
  onError,
  open,
}: {
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
    <div className="plan-result">
      <Markdown onOpen={open}>{content || 'Loading the full plan…'}</Markdown>
    </div>
  );
}
function Diff({ text }: { text: string }) {
  return text ? (
    <pre className="git-diff">
      {text.split('\n').map((line, index) => (
        <span
          className={line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'removal' : ''}
          key={index}
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  ) : (
    <p className="muted">No checkpoint changes in this step.</p>
  );
}
function WhyMemory({ memory }: Pick<DecisionRecord, 'memory'>) {
  if (!memory) return null;
  return (
    <section className="why-memory" aria-label="Memory selection">
      <h3>Memory</h3>
      <p className="muted small-text">
        {memory.source === 'search-rank' ? 'Selected by search rank.' : 'Selected by Jev.'}
      </p>
      <h4>Chosen memory</h4>
      {memory.chosen.length ? (
        <ul aria-label="Chosen memory">
          {memory.chosen.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : (
        <p>No memory notes were selected.</p>
      )}
      <details>
        <summary>Candidates ({memory.candidates.length})</summary>
        {memory.candidates.length ? (
          <ul aria-label="Memory candidates">
            {memory.candidates.map((note) => (
              <li key={note}>
                {note}
                {memory.chosen.includes(note) ? ' · chosen' : ''}
                {memory.scores?.[note] === undefined ? '' : ` · score ${memory.scores[note]}`}
              </li>
            ))}
          </ul>
        ) : (
          <p>No candidate notes were found.</p>
        )}
      </details>
    </section>
  );
}
function Why({
  decision,
  stretch,
  props,
  close,
}: {
  decision: DecisionRecord;
  stretch: Step | undefined;
  props: PageProps;
  close(): void;
}) {
  const [corrections, setCorrections] = useState<z.infer<typeof CorrectionsListSchema>['records']>();
  useEffect(() => {
    let active = true;
    void api(
      `/hub/overrides?ids=${encodeURIComponent(decision.correctionsShown.join(','))}`,
      CorrectionsListSchema,
    )
      .then((value) => {
        if (active) setCorrections(value.records);
      })
      .catch(props.onError);
    return () => {
      active = false;
    };
  }, [decision.id, props.onError]);
  const modelLabel = (id: string) =>
    props.data.config.configuration['x-jevellan'].menu.find((model) => model.id === id)?.label ?? id;
  const accountLabel = (id: string) =>
    props.data.accounts.find((entry) => entry.account.id === id)?.account.label ?? id;
  const bars = (
    entries: Array<[string, number | undefined]>,
    label: (value: string) => string,
    chosen: string,
    name: string,
  ) => {
    const known = entries.filter((entry): entry is [string, number] => entry[1] !== undefined);
    if (!known.length) return null;
    return known
      .sort((a, b) => b[1] - a[1])
      .map(([value, p]) => (
        <div className={`why-option ${value === chosen ? 'win' : ''}`} key={value}>
          <span>{label(value)}</span>
          <progress aria-label={`${label(value)} ${name}`} max={1} value={p} />
          <span>{p.toFixed(2)}</span>
        </div>
      ));
  };
  const sourceLabel = (source: string) =>
    ({
      jev: 'Jev',
      'only-option': 'only option',
      guard: 'guard',
      override: 'your override',
      redo: 'redo',
      manual: 'picked manually',
      kept: 'kept',
      pin: 'kept for this conversation',
    })[source] ?? source;
  return (
    <Panel
      title="Why this step"
      eyebrow={stretch ? `step ${stretch.n} · ${stretch.action}` : undefined}
      close={close}
    >
      <section className="why-section">
        <h3>
          Next step <span className="why-source">{sourceLabel(decision.action.source)}</span>
        </h3>
        {decision.action.guardReason && <p className="why-line">{decision.action.guardReason}</p>}
        {bars(
          decision.action.allowed.map((action) => [action, decision.action.probabilities?.[action]]),
          actionLabel,
          decision.action.chosen,
          'probability',
        ) ?? (
          <p className="why-line">
            <b>{actionLabel(decision.action.chosen)}</b>
          </p>
        )}
      </section>
      {decision.model && (
        <section className="why-section">
          <h3>
            Model <span className="why-source">{sourceLabel(decision.model.source)}</span>
          </h3>
          {decision.model.keepCurrentP !== undefined && (
            <p className="why-line">
              Keep the current model? <b>{decision.model.keepCurrentP.toFixed(2)}</b>
              {decision.model.source === 'kept' ? ', so it was kept.' : ', so Jev picked again.'}
            </p>
          )}
          {bars(
            decision.model.eligible.map((model) => [model.modelId, model.p]),
            modelLabel,
            decision.model.chosen,
            'model probability',
          ) ?? (
            <p className="why-line">
              <b>{modelLabel(decision.model.chosen)}</b>
            </p>
          )}
          {decision.model.preferredAny && decision.model.preferredAny.modelId !== decision.model.chosen && (
            <p className="why-line">
              Preferred across enabled models: {modelLabel(decision.model.preferredAny.modelId)}.
            </p>
          )}
          {decision.model.excluded.length > 0 && (
            <ul className="why-rank">
              {decision.model.excluded.map((model) => (
                <li className="excluded" key={model.modelId}>
                  {modelLabel(model.modelId)}: {model.reason.replaceAll('-', ' ')}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {decision.effort && (
        <section className="why-section">
          <h3>
            Effort <span className="why-source">{sourceLabel(decision.effort.source)}</span>
          </h3>
          {decision.effort.requested !== decision.effort.effective && (
            <p className="why-line">
              {decision.effort.requested} → <b>{decision.effort.effective}</b> (nearest effort this model
              supports)
            </p>
          )}
          {bars(
            Object.entries(decision.effort.probabilities ?? {}),
            (value) => value,
            decision.effort.requested,
            'effort probability',
          ) ?? (
            <p className="why-line">
              <b>{decision.effort.effective}</b>
            </p>
          )}
        </section>
      )}
      {decision.notices.length > 0 && (
        <section className="why-section">
          {decision.notices.map((notice, index) => (
            <p className="notice" key={index}>
              {notice.text}
              {notice.kind === 'preferred-needs-login' && notice.accountId && (
                <button
                  className="text-button"
                  onClick={() =>
                    props.navigate(
                      `/settings/runtimes?account=${encodeURIComponent(notice.accountId!)}&login=1`,
                    )
                  }
                >
                  Log in
                </button>
              )}
            </p>
          ))}
        </section>
      )}
      <section className="why-section">
        <WhyMemory memory={decision.memory} />
      </section>
      <section className="why-section">
        <h3>Corrections used</h3>
        {!decision.correctionsShown.length ? (
          <p className="why-line">None</p>
        ) : !corrections ? (
          <p className="why-line">Loading corrections…</p>
        ) : (
          decision.correctionsShown.map((id) => {
            const correction = corrections.find((entry) => entry.id === id);
            return (
              <div className="why-correction" key={id}>
                {correction ? (
                  <>
                    <p>
                      <strong>
                        {correction.schema === 'composer-override-v1' && correction.request.value === null
                          ? 'Back to Auto'
                          : {
                              once: 'Next decision only',
                              pin: 'Keep for this conversation',
                              noted: 'Just override',
                              redo: 'Override and undo',
                            }[correction.request.mode]}
                      </strong>{' '}
                      ·{' '}
                      {correction.changes
                        .map(
                          (change) =>
                            `${change.field}: ${change.from === null ? 'Auto' : change.field === 'model' ? modelLabel(change.from) : change.from} → ${change.to === null ? 'Auto' : change.field === 'model' ? modelLabel(change.to) : change.to}`,
                        )
                        .join(', ')}
                    </p>
                    <p className="muted small-text">{correction.context}</p>
                  </>
                ) : (
                  <p>This earlier correction is unavailable.</p>
                )}
              </div>
            );
          })
        )}
      </section>
      {decision.account && (
        <section className="why-section">
          <h3>Account</h3>
          <ul className="why-rank">
            {decision.account.ranking.map((entry) => (
              <li
                key={entry.accountId}
                className={
                  entry.accountId === decision.account?.chosen ? 'chosen' : entry.eligible ? '' : 'excluded'
                }
              >
                {accountLabel(entry.accountId)}: {entry.reason}
                {entry.accountId === decision.account?.chosen ? ' · selected' : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="why-section why-jev">
        <h3>Jev</h3>
        {decision.jev ? (
          <>
            <p>
              {decision.jev.returnedModel} · {decision.latencyMs} ms
            </p>
            {decision.jev.records?.map((call, index) => (
              <p key={index}>
                {call.kind === 'action' ? 'Next step' : call.kind === 'model' ? 'Model and effort' : 'Memory'}{' '}
                · {call.returnedModel} · {call.usage.input_tokens + call.usage.output_tokens} tokens ·{' '}
                {call.latencyMs} ms
              </p>
            ))}
          </>
        ) : (
          <p>
            {decision.action.source === 'manual' || decision.action.source === 'redo'
              ? 'This step was picked manually.'
              : 'No Jev call was needed for this choice.'}
          </p>
        )}
        <p>{dateTime(decision.at)}</p>
      </section>
    </Panel>
  );
}
