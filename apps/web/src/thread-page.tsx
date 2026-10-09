import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ProjectWorkViewSchema, RESTARTED_PREFIX, SAVED_COMMITS_SENTENCE, ThreadMessageReceiptSchema, ThreadOverrideViewSchema, ThreadViewSchema, type PlacementField, type ProjectWorkView,
  type QueuedMessage, type ThreadIndex, type ThreadReport, type ThreadView,
} from '@jevellan/core/client';
import { ApiError, api, empty } from './api.js';
import { copyText, selectText } from './clipboard.js';
import { Confirm, Markdown, Modal, Panel, composerClearance, followOnScroll, repinAtEnd, useTask, type PageProps } from './components.js';
import { Icon } from './icons.js';
import { MessageInput } from './message-delivery.js';
import * as copy from './project-work-copy.js';
import {
  THREAD_POLL_AFTER_ACTION_MS, THREAD_POLL_LIVE_MS, alignReports, composerBlock, deviceBlock, deviceChoices, deviceRefusal, dotClass, effortChoices, fallbackChip, lineParts, mainIsolationBlock, nearestEffort,
  mergeThreadToolTurns, overrideForm, overrideOffered, overrideReady, overrideRequest, partWords, placementLine, pullRequestBadges, reportBadge, threadActions, threadLiveText,
  threadPollDelay, threadReason, threadStarting, transcriptNotice, whyFields, withoutEchoedSummaries, withoutReportCalls, type OverrideForm, type OverrideMode,
} from './project-work-model.js';
import { RouteLink, Stamp, afterDialogs, deviceNames, failureText, runtimeNames, updated, useClientIds, useLocalError } from './project-work.js';
import { TranscriptTurn } from './session-transcript.js';
import { shortTime } from './time.js';

/**
 * The thread page (12.3): the header with the state, its reason, the placement and the pull request; the native transcript
 * with each report card after the turn it reports (D56); and the composer. The view is read every 1.5 s while live work
 * runs and every 10 s otherwise (D79), and at once after every action. The page follows the newest entry unless the reader
 * scrolled up, like the session pages, with Jump to latest in the composer.
 */
export function ThreadPage(props: PageProps & { projectId: string; threadId: string; navigation: ReactNode }) {
  const { projectId, threadId, navigation, navigate, onError, message, data } = props;
  const titleId = useId(); const queuedId = useId(); const stopNoteId = useId();
  const [view, setView] = useState<ThreadView>();
  const [loadError, setLoadError] = useState('');
  // Before any view: the thread's device refused or could not be reached, and the project's index row that names it (D276).
  const [held, setHeld] = useState<{ tone: 'notice' | 'error'; thread?: ThreadIndex }>();
  const [confirming, setConfirming] = useState<'stop' | 'discard'>();
  const [why, setWhy] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const latest = useRef<ThreadView | undefined>(undefined);
  const fastUntil = useRef(0);
  const kick = useRef(() => {});
  const base = `/api/projects/${projectId}/threads/${threadId}`;
  const project = `/projects/${projectId}`;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined; let reading = false; let again = false; let indexed = false;
    // The hub's index still names a thread whose device cannot answer, so the page shows its title and last state meanwhile.
    const index = async () => {
      try {
        const work = await api(`/api/projects/${projectId}/work`, ProjectWorkViewSchema, 'GET', undefined, { signal: controller.signal });
        const row = work.threads.find((entry) => entry.id === threadId);
        if (row && !controller.signal.aborted) setHeld((previous) => previous && { ...previous, thread: row });
      } catch { /* the reason alone still shows */ }
    };
    const load = async () => {
      clearTimeout(timer);
      if (reading) { again = true; return; }
      reading = true; let starting = false;
      try {
        const next = await api(base, ThreadViewSchema, 'GET', undefined, { signal: controller.signal });
        if (!controller.signal.aborted) {
          // A state change seen here (a turn ended, publication started) refreshes the sidebar's counts now, not at its next poll.
          const before = latest.current?.thread.state;
          latest.current = next; setView(next); setLoadError('');
          if (before !== undefined && before !== next.thread.state) updated();
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          if (failure instanceof ApiError && failure.status === 401) onError(failure);
          // A thread started moments ago on another device is not there yet (D274): the page keeps loading and reads again soon.
          else if (failure instanceof ApiError && failure.status === 404 && !latest.current && threadStarting(threadId, Date.now())) starting = true;
          else {
            setLoadError(failureText(failure));
            const refusal = failure instanceof ApiError && !latest.current ? deviceRefusal(failure.status) : undefined;
            setHeld((previous) => previous || refusal ? { ...previous, tone: refusal ?? 'error' } : previous);
            if (refusal && !indexed) { indexed = true; void index(); }
          }
        }
      } finally {
        reading = false;
        if (!controller.signal.aborted) {
          if (again) { again = false; void load(); }
          else timer = setTimeout(() => void load(), starting ? THREAD_POLL_LIVE_MS : threadPollDelay(latest.current?.thread.state, Date.now(), fastUntil.current));
        }
      }
    };
    kick.current = () => { fastUntil.current = Date.now() + THREAD_POLL_AFTER_ACTION_MS; void load(); };
    void load();
    return () => { controller.abort(); clearTimeout(timer); kick.current = () => {}; };
  }, [base, projectId, threadId, onError]);
  /** Every action answers the thread view; the page shows it, tells the sidebar and keeps reading quickly for a moment. */
  const acted = (next: ThreadView) => { latest.current = next; setView(next); updated(); kick.current(); };

  // Follow the newest entry unless the reader scrolled up (as the session pages do); the first load opens at the end.
  const page = useRef<HTMLDivElement>(null); const bottom = useRef<HTMLDivElement>(null);
  const following = useRef(true); const opened = useRef(false);
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    const follows = followOnScroll(following, 180);
    const scrolled = () => setBehind(!follows());
    // Only scrolling up unpins; a resize re-pins once the end is in view (see followOnScroll and repinAtEnd).
    const resized = () => repinAtEnd(following, 180, () => setBehind(false));
    window.addEventListener('scroll', scrolled, { passive: true }); window.addEventListener('resize', resized);
    return () => { window.removeEventListener('scroll', scrolled); window.removeEventListener('resize', resized); };
  }, []);
  useEffect(() => {
    if (!view) return;
    if (!opened.current || following.current) { bottom.current?.scrollIntoView({ block: 'end' }); opened.current = true; }
  }, [view]);
  const loaded = view !== undefined;
  useEffect(() => {
    const element = page.current; if (!element) return;
    const observer = new ResizeObserver(() => { repinAtEnd(following, 180, () => setBehind(false)); if (following.current) bottom.current?.scrollIntoView({ block: 'end' }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);
  const jump = () => { following.current = true; setBehind(false); bottom.current?.scrollIntoView({ block: 'end' }); };

  const runtimeName = useMemo(() => runtimeNames(data), [data]);
  const { error: actionError, setError: setActionError, fail } = useLocalError(onError);
  const allow = useTask((failure) => { fail(failure); kick.current(); });
  const turns = view?.transcript?.turns; const reports = view?.reports;
  const state = view?.thread.state; const finished = view?.thread.turns ?? 0;
  const items = useMemo(() => withoutEchoedSummaries(withoutReportCalls(alignReports(turns ?? [], reports ?? [], state === 'running' ? finished + 1 : finished), reports ?? [])),
    [turns, reports, state, finished]);

  const back = <RouteLink className="text-button pw-back" href={project} navigate={navigate}><Icon name="back" size={14} />{copy.BACK_TO_PROJECT}</RouteLink>;
  if (!view) {
    const known = held?.thread;
    return (
      <div className="conversation-page pw-page pw-thread-page" ref={page}>
        <div className="section-heading conversation-heading pw-heading">
          <h1 aria-labelledby={titleId}>{navigation}<span id={titleId} className="session-title" title={known?.title}>{known?.title}</span></h1>
          <div className="conversation-meta pw-thread-meta">
            {back}
            {known && (
              <span className={`chip pw-state-chip pw-state-${known.state}`}>
                <i className={dotClass(known.state)} aria-hidden="true" />{copy.STATE_LABELS[known.state]}
              </span>
            )}
          </div>
        </div>
        {loadError ? <p className={held?.tone ?? 'error'}>{loadError}</p> : (
          <p className="page-loading" role="status"><span className="activity-spinner" aria-hidden="true" />{copy.LOADING_THREAD}</p>
        )}
      </div>
    );
  }

  const thread = view.thread;
  const actions = threadActions(view);
  const line = placementLine(thread, view, runtimeName(thread.runtime));
  const notice = transcriptNotice(view);
  const fallback = fallbackChip(view.placement);
  const reason = threadReason(thread.stateReason);
  const allowTurns = () => void allow.run(async (signal) => {
    setActionError('');
    acted(await api(`${base}/allow-turns`, ThreadViewSchema, 'POST', empty, { signal }));
    message(copy.MORE_TURNS_ALLOWED);
  });

  return (
    <div className="conversation-page pw-page pw-thread-page" ref={page}>
      <div className="section-heading conversation-heading pw-heading pw-thread-heading">
        <h1 aria-labelledby={titleId}>{navigation}<span id={titleId} className="session-title" title={thread.title}>{thread.title}</span></h1>
        <div className="actions">
          <button type="button" className="secondary pw-head-button" aria-pressed={why} onClick={() => setWhy(!why)}>
            <Icon name="why" size={15} /><span className="pw-head-label">{copy.WHY}</span>
          </button>
          {overrideOffered(view) && (
            <button type="button" className="secondary pw-head-button" onClick={() => setOverriding(true)}>
              <Icon name="tune" size={15} /><span className="pw-head-label">{copy.OVERRIDE}</span>
            </button>
          )}
          {actions.stop && (
            <button type="button" className="secondary pw-head-button" disabled={!!actions.stopRefusal} title={actions.stopRefusal ?? undefined}
              aria-describedby={actions.stopRefusal ? stopNoteId : undefined} onClick={() => setConfirming('stop')}>
              <Icon name="stop" size={15} /><span className="pw-head-label">{copy.STOP}</span>
            </button>
          )}
          {actions.discard && (
            <button type="button" className="secondary pw-head-button" onClick={() => setConfirming('discard')}>
              <Icon name="trash" size={15} /><span className="pw-head-label">{copy.DISCARD}</span>
            </button>
          )}
          {actions.allowTurns && (
            <button type="button" className="pw-head-button pw-keep-label" disabled={allow.busy} onClick={allowTurns}>
              <Icon name="plus" size={15} /><span className="pw-head-label">{copy.ALLOW_MORE_TURNS}</span>
            </button>
          )}
        </div>
        <div className="conversation-meta pw-thread-meta">
          {back}
          <span className={`chip pw-state-chip pw-state-${thread.state}`}>
            <i className={dotClass(thread.state)} aria-hidden="true" />{copy.STATE_LABELS[thread.state]}
          </span>
          {thread.pr && (
            <>
              <a className="chip pw-pr-chip" href={thread.pr.url} target="_blank" rel="noopener noreferrer" title={copy.OPEN_PULL_REQUEST}>
                <Icon name="pull-request" size={13} />{copy.pullRequestNumber(thread.pr.number)}
              </a>
              {pullRequestBadges(thread.pr).map((badge) => <span key={badge.text} className={`chip pw-badge pw-tone-${badge.tone}`}>{badge.text}</span>)}
            </>
          )}
          {fallback && <span className="chip pw-badge pw-tone-warn pw-fallback-chip">{fallback}</span>}
        </div>
        <div className="pw-thread-details">
          {reason?.text && (
            <p className="pw-thread-reason" title={reason.text}>
              {reason.restartedAs
                ? <>{RESTARTED_PREFIX}<RouteLink href={`${project}/threads/${reason.restartedAs}`} navigate={navigate}>{reason.restartedAs}</RouteLink>.</> : reason.text}
            </p>
          )}
          {reason?.savedRef && <p className="pw-saved-ref">{SAVED_COMMITS_SENTENCE}<code>{reason.savedRef}</code>.</p>}
          {/* Why Stop and Restart wait while the thread is attached, and why an ended main thread still holds the checkout (phase 8). */}
          {actions.stopRefusal && <p className="pw-thread-note" id={stopNoteId}>{actions.stopRefusal}</p>}
          {view.checkoutHeld && <p className="pw-thread-note pw-tone-warn" role="status">{view.checkoutHeld}</p>}
          <p className="pw-placement-line" title={line}><Parts line={line} /></p>
        </div>
      </div>
      {loadError && <p className="notice" role="status">{loadError}</p>}
      {actionError && <p className="error">{actionError}</p>}
      <div className="cursor-transcript pw-transcript" aria-label={copy.TRANSCRIPT_LABEL}>
        {notice && <p className="pw-transcript-note">{notice}</p>}
        {mergeThreadToolTurns(items).map((item) => item.kind === 'turn'
          ? <TranscriptTurn key={item.turn.id} turn={item.turn} userLabel={copy.PROMPT} collapseLongUser={copy.PROMPT_COLLAPSE_CHARACTERS} />
          : <ReportCard key={`report-${item.report.turn}-${item.report.synthesized ? 'synthesized' : 'recorded'}`} report={item.report} />)}
        {view.queuedMessages.length > 0 && (
          <section className="pw-queued" aria-labelledby={queuedId}>
            <h3 id={queuedId}>{copy.QUEUED_MESSAGES}</h3>
            {view.queuedMessages.map((queued) => <QueuedEntry key={queued.id} queued={queued} />)}
          </section>
        )}
      </div>
      <ThreadComposer base={base} view={view} behind={behind} jump={jump} onError={onError} message={message}
        sent={() => { following.current = true; kick.current(); }} refused={() => kick.current()} />
      <div ref={bottom} />
      {why && <WhyPanel view={view} data={data} close={() => setWhy(false)} />}
      {overriding && (
        <OverrideDialog props={props} view={view} projectId={projectId} close={() => setOverriding(false)} applied={() => { updated(); kick.current(); }} />
      )}
      {confirming === 'stop' && (
        <ConfirmAction title={copy.STOP_THREAD_TITLE} action={copy.STOP} onError={onError} close={() => setConfirming(undefined)}
          body={`${copy.STOP_THREAD_BODY} ${thread.isolation === 'worktree' ? copy.STOP_KEEPS_WORKTREE : thread.gitPolicy === 'external' ? copy.STOP_KEEPS_CHECKOUT : copy.STOP_SAVES_MAIN_COMMITS}`}
          run={async (signal) => acted(await api(`${base}/stop`, ThreadViewSchema, 'POST', { schema: 'thread-stop-request-v1' }, { signal }))} />
      )}
      {confirming === 'discard' && (
        <ConfirmAction title={thread.branch ? copy.discardQuestion(thread.branch) : copy.DISCARD_NO_BRANCH} action={copy.DISCARD} body={copy.DISCARD_BODY}
          onError={onError} close={() => setConfirming(undefined)}
          run={async (signal) => {
            acted(await api(`${base}/discard`, ThreadViewSchema, 'POST', empty, { signal }));
            afterDialogs(message, copy.WORKTREE_DISCARDED);
          }} />
      )}
    </div>
  );
}

/**
 * A ` · ` line whose parts wrap whole (`.pw-part`), so a narrow page breaks it between parts; a part wider than the line
 * breaks between its words (`.pw-word`), so a branch name that fits a line never breaks inside, and only a word wider than
 * the line breaks. Each separator never leaves its word's line (`.pw-sep`), and the last two parts move down together
 * whenever they fit one line (`.pw-tail`), so a short last part such as `6 ms` never stands alone. The text reads as the line.
 */
function Parts({ line }: { line: string }) {
  const word = (text: string) => <span className="pw-word">{text.endsWith(' ·') ? <>{text.slice(0, -2)}<span className="pw-sep"> ·</span></> : text}</span>;
  const parts = lineParts(line).map((part) => <span className="pw-part">{spaced(partWords(part).map(word))}</span>);
  return <>{spaced([...parts.slice(0, -2), <span className="pw-tail">{spaced(parts.slice(-2))}</span>])}</>;
}
/** Nodes separated by single spaces, where the line may wrap. */
function spaced(nodes: ReactNode[]) {
  return nodes.map((node, index) => <Fragment key={index}>{index > 0 && ' '}{node}</Fragment>);
}

/** Stop and Discard (12.3): a destructive confirmation whose refusal stays in the dialog. */
function ConfirmAction({ title, action, body, run, close, onError }: {
  title: string; action: string; body: string; run(signal: AbortSignal): Promise<void>; close(): void; onError(error: unknown): void;
}) {
  const { error, setError, fail } = useLocalError(onError);
  const task = useTask(fail);
  return (
    <Confirm title={title} action={action} danger busy={task.busy} close={close}
      confirm={() => void task.run(async (signal) => { setError(''); await run(signal); close(); })}>
      <p className="pw-confirm-body">{body}</p>
      {error && <p className="error">{error}</p>}
    </Confirm>
  );
}

/** A report card (12.3): the turn and status, the summary, a question with its options, and the tests the turn ran. */
function ReportCard({ report }: { report: ThreadReport }) {
  const headingId = useId();
  const badge = reportBadge(report.status);
  const tests = report.testsRun; const options = report.options ?? [];
  return (
    <section className={`pw-report pw-report-${report.status}`} aria-labelledby={headingId}>
      <div className="pw-report-head">
        <h3 id={headingId}>{copy.reportHeading(report.turn)}</h3>
        {report.synthesized && <span className="pw-report-note">{copy.SYNTHESIZED_REPORT}</span>}
        <span className={`chip pw-badge pw-tone-${badge.tone}`}>{badge.text}</span>
      </div>
      <Markdown>{report.summary}</Markdown>
      {(report.question || options.length > 0) && (
        <div className="pw-report-question">
          {report.question && <Markdown>{report.question}</Markdown>}
          {options.length > 0 && (
            <ul className="pw-report-options">
              {options.map((option) => <li key={option.label}><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</li>)}
            </ul>
          )}
        </div>
      )}
      {tests && (
        <div className="pw-report-tests">
          <strong className={`pw-tone-${tests.passed ? 'ok' : 'danger'}`}>
            <Icon name={tests.passed ? 'check' : 'close'} size={14} />{tests.passed ? copy.TESTS_PASSED : copy.TESTS_FAILED}
          </strong>
          <code>{tests.command}</code>
          {tests.summary && <p>{tests.summary}</p>}
        </div>
      )}
    </section>
  );
}

/** A message that waits for the thread's next turn (D81, D231). */
function QueuedEntry({ queued }: { queued: QueuedMessage }) {
  return (
    <article className="pw-queued-message">
      <p className="pw-source">
        {queued.from === 'owner' ? copy.YOU : copy.COORDINATOR} · <Stamp at={queued.at} label={shortTime(queued.at)} />
        {queued.interrupt && <> · {copy.INTERRUPTS_TURN}</>}
      </p>
      <Markdown>{queued.text}</Markdown>
    </article>
  );
}

/**
 * The thread composer (12.3): a growing textarea and the send icon, with Interrupt current turn while a turn runs. Messages
 * are idempotent by client id. An attached thread disables it with the brief's sentence; a concluded thread takes no
 * message, so only the reason shows (D81, D231). Refusals stay here, and the page reads the thread again. Under it, the
 * command that takes the thread over in a terminal (phase 7), for every thread that has not concluded (D304).
 */
function ThreadComposer({ base, view, behind, jump, sent, refused, onError, message }: {
  base: string; view: ThreadView; behind: boolean; jump(): void; sent(): void; refused(): void; onError(error: unknown): void; message(text: string): void;
}) {
  const [text, setText] = useState('');
  const [interrupt, setInterrupt] = useState(false);
  const { error, setError, fail } = useLocalError(onError);
  const send = useTask((failure) => { fail(failure); refused(); });
  const ids = useClientIds('message');
  const running = view.thread.state === 'running';
  // A choice made for a turn that has ended never carries over to the next one.
  useEffect(() => { if (!running) setInterrupt(false); }, [running]);
  const live = threadLiveText(view.thread);
  const block = composerBlock(view);
  const ended = !view.canMessage && view.thread.state !== 'attached';
  return (
    <form className="composer card pw-composer pw-thread-composer" ref={composerClearance} onSubmit={(event) => {
      event.preventDefault();
      const value = text;
      if (send.busy || block || !value.trim()) return;
      const body = { text: value, interrupt: running && interrupt };
      void send.run(async (signal) => {
        setError('');
        await api(`${base}/messages`, ThreadMessageReceiptSchema, 'POST',
          { schema: 'thread-message-request-v1', clientMessageId: ids.id(body), ...body }, { signal, waitForHub: true });
        ids.done();
        setText((typed) => typed === value ? '' : typed);
        setInterrupt(false);
        sent();
      });
    }}>
      {(live || behind) && (
        <div className="cursor-live-bar ordinary-live-bar">
          {live && <span role="status"><span className="activity-spinner" aria-hidden="true" />{live}</span>}
          {((running && !block) || behind) && (
            <span className="pw-live-end">
              {running && !block && (
                <label className="toggle pw-interrupt">
                  <input type="checkbox" checked={interrupt} onChange={(event) => setInterrupt(event.target.checked)} />{copy.INTERRUPT_TURN}
                </label>
              )}
              {behind && <button type="button" className="text-button pw-jump jump-latest" onClick={jump}>{copy.JUMP_TO_LATEST}<Icon name="chevron" size={14} /></button>}
            </span>
          )}
        </div>
      )}
      {error && <p className="error pw-composer-error">{error}</p>}
      {block && <p className={`pw-composer-note${ended ? ' ended' : ''}`}>{block}</p>}
      {!ended && (
        <fieldset className="pw-fields" disabled={!!block}>
          <div className="message-input-row">
            <MessageInput value={text} change={setText} label={copy.THREAD_PLACEHOLDER} placeholder={copy.THREAD_PLACEHOLDER} />
            <div className="message-actions">
              <button type="submit" className="send-icon" aria-label={copy.SEND} disabled={send.busy || !!block || !text.trim()}><Icon name="send" size={20} /></button>
            </div>
          </div>
        </fieldset>
      )}
      {!ended && <TakeOver device={view.deviceName} command={view.attachCommand} message={message} />}
    </form>
  );
}

/**
 * Take over in a terminal (12.3, phase 7): the thread's device and the command, muted, with a copy button outside the composer's
 * fieldset, so it still works while the thread is attached. The clipboard falls back to a selection copy on the plain-HTTP
 * Tailnet URL (D304). When the browser refuses both, the command shows whole and selected with the reason under it, here
 * rather than in a toast, which on phones would sit over the very command it points to; it folds back once the selection
 * leaves the command (D305).
 */
function TakeOver({ device, command, message }: { device: string; command: string; message(text: string): void }) {
  const code = useRef<HTMLElement>(null);
  const [blocked, setBlocked] = useState(false);
  useLayoutEffect(() => { if (blocked && code.current) selectText(code.current); }, [blocked]);
  useEffect(() => {
    if (!blocked) return;
    const left = () => {
      const selection = window.getSelection();
      if (!code.current || !selection || selection.isCollapsed || !selection.containsNode(code.current, true)) setBlocked(false);
    };
    document.addEventListener('selectionchange', left);
    return () => document.removeEventListener('selectionchange', left);
  }, [blocked]);
  const copyCommand = async () => {
    if (await copyText(command)) { setBlocked(false); message(copy.COMMAND_COPIED); return; }
    if (code.current) selectText(code.current);
    setBlocked(true);
  };
  return (
    <>
      <p className={`pw-takeover${blocked ? ' blocked' : ''}`}>
        {copy.takeOverLead(device)}{' '}
        <span className="pw-takeover-command">
          <code ref={code} title={command}>{command}</code>
          <button type="button" className="icon-button" aria-label={copy.COPY_COMMAND} title={copy.COPY_COMMAND} onClick={() => void copyCommand()}>
            <Icon name="copy" size={15} />
          </button>
        </span>
      </p>
      {blocked && <p className="pw-takeover-blocked" role="status">{copy.COMMAND_SELECTED}</p>}
    </>
  );
}

const FIELD_LABELS = { isolation: copy.ISOLATION, runtime: 'Runtime', account: 'Account', model: copy.MODEL, effort: copy.EFFORT, device: copy.DEVICE } as const satisfies Record<PlacementField, string>;
/** Model labels as the Projects pages show them: `{runtime display name} {menu label}`, or the id of a model no longer in the menu. */
const modelNames = (data: PageProps['data']) => {
  const runtimeName = runtimeNames(data); const menu = data.config.configuration['x-jevellan'].menu;
  return (modelId: string) => { const entry = menu.find((model) => model.id === modelId); return entry ? `${runtimeName(entry.runtime)} ${entry.label}` : modelId; };
};

/**
 * Why (12.3): the placement record in the inspector. The source and the fixed fields, then each field with Jev's probabilities as
 * small bars (the value the thread holds now marked), the requested and effective effort, eligible and excluded models and
 * devices with their reasons, the account, the fallback error and the Jev calls (D255).
 */
function WhyPanel({ view, data, close }: { view: ThreadView; data: PageProps['data']; close(): void }) {
  const { placement, thread } = view;
  const modelName = useMemo(() => modelNames(data), [data]);
  const deviceName = useMemo(() => deviceNames(data), [data]);
  const account = data.accounts.find((entry) => entry.account.id === placement.accountId)?.account.label ?? thread.accountLabel;
  const label = (field: PlacementField, value: string) =>
    field === 'isolation' ? value === 'main' ? copy.MAIN : copy.WORKTREE : field === 'model' ? modelName(value) : field === 'device' ? deviceName(value) : field === 'account' ? value === placement.accountId ? account : data.accounts.find((entry) => entry.account.id === value)?.account.label ?? value : field === 'runtime' ? runtimeNames(data)(value) : value;
  const fixed = placement.fixed.map((field) => FIELD_LABELS[field]).join(', ');
  const ranks = (field: 'model' | 'device') => field === 'model'
    ? { chosen: placement.modelId, eligible: placement.eligibleModels, excluded: placement.excludedModels.map((entry) => ({ id: entry.modelId, reason: entry.reason })) }
    : { chosen: placement.deviceId, eligible: placement.eligibleDevices, excluded: placement.excludedDevices.map((entry) => ({ id: entry.deviceId, reason: entry.reason })) };
  return (
    <Panel title={copy.WHY_TITLE} eyebrow={thread.title} close={close}>
      <div className="pw-why">
        <section className="why-section">
          <h3>{copy.WHY_PLACEMENT} <span className="why-source">{copy.PLACEMENT_SOURCES[placement.source]}</span></h3>
          <p className="why-line">{fixed ? copy.fixedFields(fixed) : copy.FIXED_NONE}</p>
          {placement.source === 'fallback' && placement.error && <p className="notice pw-why-error">{copy.placedWithoutJev(placement.error.message)}</p>}
        </section>
        {whyFields(placement).map(({ field, value, source, bars }) => {
          const rank = field === 'model' || field === 'device' ? ranks(field) : undefined;
          // With bars the eligible options are the bars; without them the list names every eligible option and marks the chosen one.
          const listed = rank ? rank.eligible.filter((id) => !bars.some((bar) => bar.option === id)) : [];
          const mapped = field === 'effort' && placement.effortRequested !== placement.effortEffective;
          return (
            <section className="why-section" key={field}>
              <h3>{FIELD_LABELS[field]} <span className="why-source">{copy.FIELD_SOURCES[source]}</span></h3>
              {mapped && <p className="why-line">{placement.effortRequested} → <b>{placement.effortEffective}</b> {copy.NEAREST_EFFORT}</p>}
              {bars.map((bar) => (
                <div className={`why-option${bar.chosen ? ' win' : ''}`} key={bar.option}>
                  <span title={label(field, bar.option)}>{label(field, bar.option)}</span>
                  <progress aria-label={`${label(field, bar.option)} ${copy.PROBABILITY}`} max={1} value={bar.p} />
                  <span>{bar.p.toFixed(2)}</span>
                </div>
              ))}
              {!bars.length && !mapped && !listed.includes(value) && <p className="why-line"><b>{label(field, value)}</b></p>}
              {rank && (listed.length > 0 || rank.excluded.length > 0) && (
                <ul className="why-rank">
                  {listed.map((id) => (
                    <li key={id} className={id === rank.chosen ? 'chosen' : undefined}>{label(field, id)}{id === rank.chosen ? ` · ${copy.CHOSEN}` : ''}</li>
                  ))}
                  {/* A field the owner fixed leaves every other option out as not chosen: listed plainly, never as a failure (D257). */}
                  {rank.excluded.map((entry) => placement.fixed.includes(field)
                    ? <li key={entry.id}>{label(field, entry.id)}</li>
                    : <li key={entry.id} className="excluded">{label(field, entry.id)}: {entry.reason}</li>)}
                </ul>
              )}
            </section>
          );
        })}
        {!placement.fixed.includes('account') && <section className="why-section">
          <h3>{copy.ACCOUNT}</h3>
          <p className="why-line"><b>{account}</b></p>
        </section>}
        <section className="why-section why-jev">
          <h3>{copy.JEV}</h3>
          {placement.jevCalls.length ? placement.jevCalls.map((call, index) => (
            <p key={index}><Parts line={copy.jevCallLine(call.returnedModel, call.usage.input_tokens + call.usage.output_tokens, call.latencyMs)} /></p>
          )) : <p>{placement.source === 'fallback' ? copy.NO_JEV_ANSWER : copy.NO_JEV_CALL}</p>}
          <p>{copy.PLACED} <Stamp at={placement.decidedAt} /></p>
        </section>
      </div>
    </Panel>
  );
}

/**
 * Override (12.3, brief 10): From the next turn changes the model (same runtime) and the effort of the thread's next turns;
 * Restart with these choices stops this thread and starts a new one with the chosen fields fixed, refused with the server's
 * reason (an open pull request, a thread already published to main or already restarted). The fields open on the thread's
 * current choices; the project view gives the placement gates for Main and other devices. Refusals stay in the dialog (D255).
 */
function OverrideDialog({ props, view, projectId, close, applied }: { props: PageProps; view: ThreadView; projectId: string; close(): void; applied(): void }) {
  const { data } = props;
  const { error, setError, fail } = useLocalError(props.onError);
  const task = useTask(fail);
  const ids = useClientIds('override');
  const [form, setForm] = useState<OverrideForm>(() => overrideForm(view));
  const [work, setWork] = useState<ProjectWorkView>();
  const nextNote = useId(); const restartNote = useId(); const isolationNote = useId(); const deviceNote = useId();
  useEffect(() => {
    const controller = new AbortController();
    api(`/api/projects/${projectId}/work`, ProjectWorkViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })
      .then(setWork, (failure: unknown) => { if (!controller.signal.aborted) fail(failure); });
    return () => controller.abort();
  }, [projectId, fail]);
  const current = view.placement; const restart = form.mode === 'restart';
  const modelName = modelNames(data);
  const menu = data.config.configuration['x-jevellan'].menu;
  // The thread's own model stays listed even if it was disabled since, so the field shows what the thread runs.
  const listed = menu.filter((entry) => entry.enabled || entry.id === current.modelId);
  const models = restart ? listed : listed.filter((entry) => entry.runtime === current.runtime);
  const efforts = effortChoices(menu.find((entry) => entry.id === form.modelId)?.efforts, current.effortRequested);
  const here = data.devices.currentDeviceId;
  const devices = deviceChoices(work, data.roster.devices, here, form.deviceId);
  const mainBlock = work ? mainIsolationBlock(work) : null;
  const remoteBlock = work ? devices.map((choice) => deviceBlock(work, choice.id, here)).find((reason) => reason !== null) ?? null : null;
  const change = (fields: Partial<OverrideForm>) => setForm((previous) => ({ ...previous, ...fields }));
  // An effort the chosen model neither offers nor the thread requested moves to the model's nearest one.
  const fitted = (next: OverrideForm): OverrideForm => {
    const chosen = menu.find((entry) => entry.id === next.modelId);
    if (!next.effort || !chosen || effortChoices(chosen.efforts, current.effortRequested).some((choice) => choice.effort === next.effort)) return next;
    return { ...next, effort: nearestEffort(next.effort, chosen.efforts) };
  };
  const mode = (next: OverrideMode) => setForm((previous) => {
    if (next === 'restart') return { ...previous, mode: next };
    // The next turn keeps the runtime and always has a model and an effort.
    const sameRuntime = menu.some((entry) => entry.id === previous.modelId && entry.runtime === current.runtime);
    return fitted({ ...previous, mode: next, modelId: sameRuntime ? previous.modelId : current.modelId, effort: previous.effort || current.effortRequested });
  });
  const model = (modelId: string) => setForm((previous) => fitted({ ...previous, modelId }));
  const ready = overrideReady(view, form) && (!restart || work !== undefined);
  return (
    <Modal title={copy.OVERRIDE} close={close}>
      <form className="pw-override" onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void task.run(async (signal) => {
          setError('');
          const request = overrideRequest(view, form);
          const result = await api(`/api/projects/${projectId}/threads/${view.thread.id}/override`, ThreadOverrideViewSchema, 'POST',
            { ...request, clientRequestId: ids.id(request) }, { signal, waitForHub: true });
          ids.done(); updated();
          if (result.newThreadId) {
            afterDialogs(props.message, copy.THREAD_RESTARTED); close();
            props.navigate(`/projects/${projectId}/threads/${result.newThreadId}`);
          } else { afterDialogs(props.message, copy.OVERRIDE_APPLIED); close(); applied(); }
        });
      }}>
        <fieldset className="pw-override-modes">
          <legend className="sr-only">{copy.OVERRIDE_MODES}</legend>
          <label className={view.canOverride.nextTurn ? undefined : 'pw-disabled'}>
            <input type="radio" name="pw-override-mode" checked={!restart} disabled={!view.canOverride.nextTurn} aria-describedby={nextNote}
              onChange={() => mode('next-turn')} />{copy.FROM_NEXT_TURN}
          </label>
          <p className="pw-field-note pw-radio-note" id={nextNote}>{view.canOverride.nextTurn ? copy.NEXT_TURN_HELP : copy.THREAD_ENDED}</p>
          <label className={view.canOverride.restart ? undefined : 'pw-disabled'}>
            <input type="radio" name="pw-override-mode" checked={restart} disabled={!view.canOverride.restart} aria-describedby={restartNote}
              onChange={() => mode('restart')} />{copy.RESTART_WITH_CHOICES}
          </label>
          <p className={`pw-field-note pw-radio-note${view.canOverride.restart ? '' : ' pw-refused'}`} id={restartNote}>
            {view.canOverride.restart ? view.thread.isolation === 'main' ? view.thread.gitPolicy === 'external' ? copy.RESTART_HELP_MANUAL : copy.RESTART_HELP_MAIN : copy.RESTART_HELP : view.canOverride.restartReason}
          </p>
        </fieldset>
        <fieldset className="pw-fields" disabled={restart && !work}>
          <div className="form-grid pw-override-fields">
            {restart && (
              <div className="pw-field">
                <label>{copy.ISOLATION}
                  <select value={form.isolation} aria-describedby={mainBlock ? isolationNote : undefined}
                    onChange={(event) => change({ isolation: event.target.value as OverrideForm['isolation'] })}>
                    <option value="">{copy.AUTOMATIC}</option>
                    <option value="worktree">{copy.WORKTREE}</option>
                    <option value="main" disabled={!!mainBlock}>{copy.MAIN}</option>
                  </select>
                </label>
                {mainBlock && <p className="pw-field-note" id={isolationNote}>{mainBlock}</p>}
                {!mainBlock && work?.project.branchPolicy === 'external' && <p className="pw-field-note">{copy.MANUAL_MAIN_HELP}</p>}
              </div>
            )}
            <label>{copy.MODEL}
              <select value={form.modelId} onChange={(event) => model(event.target.value)}>
                {restart && <option value="">{copy.AUTOMATIC}</option>}
                {models.map((entry) => <option key={entry.id} value={entry.id}>{modelName(entry.id)}</option>)}
              </select>
            </label>
            <label>{copy.EFFORT}
              <select value={form.effort} onChange={(event) => change({ effort: event.target.value as OverrideForm['effort'] })}>
                {restart && <option value="">{copy.AUTOMATIC}</option>}
                {efforts.map((choice) => <option key={choice.effort} value={choice.effort}>{choice.runsAs ? copy.effortRunsAs(choice.effort, choice.runsAs) : choice.effort}</option>)}
              </select>
            </label>
            {restart && (
              <div className="pw-field">
                <label>{copy.DEVICE}
                  <select value={form.deviceId} aria-describedby={remoteBlock ? deviceNote : undefined} onChange={(event) => change({ deviceId: event.target.value })}>
                    <option value="">{copy.AUTOMATIC}</option>
                    {devices.map((choice) => <option key={choice.id} value={choice.id} disabled={choice.disabled}>{choice.label}</option>)}
                  </select>
                </label>
                {remoteBlock && <p className="pw-field-note" id={deviceNote}>{remoteBlock}</p>}
              </div>
            )}
          </div>
          <label>{copy.OVERRIDE_NOTE}
            <textarea rows={2} maxLength={400} value={form.note} placeholder={copy.OVERRIDE_NOTE_PLACEHOLDER} onChange={(event) => change({ note: event.target.value })} />
          </label>
        </fieldset>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>{copy.CANCEL}</button>
          <button className={restart ? 'danger' : undefined} disabled={task.busy || !ready}>{task.busy ? copy.APPLYING : copy.APPLY}</button>
        </div>
      </form>
    </Modal>
  );
}
