import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ThreadMessageReceiptSchema, ThreadViewSchema, type QueuedMessage, type ThreadReport, type ThreadView } from '@jevellan/core/client';
import { ApiError, api, empty } from './api.js';
import { Confirm, Markdown, useTask, type PageProps } from './components.js';
import { Icon } from './icons.js';
import { MessageInput } from './message-delivery.js';
import * as copy from './project-work-copy.js';
import {
  THREAD_POLL_AFTER_ACTION_MS, alignReports, composerBlock, dotClass, placementLine, pullRequestBadges, reportBadge, threadActions, threadLiveText,
  threadPollDelay, transcriptNotice, withoutReportCalls,
} from './project-work-model.js';
import { RouteLink, Stamp, afterDialogs, failureText, runtimeNames, updated, useClientIds, useLocalError } from './project-work.js';
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
  const titleId = useId(); const queuedId = useId();
  const [view, setView] = useState<ThreadView>();
  const [loadError, setLoadError] = useState('');
  const [confirming, setConfirming] = useState<'stop' | 'discard'>();
  const latest = useRef<ThreadView | undefined>(undefined);
  const fastUntil = useRef(0);
  const kick = useRef(() => {});
  const base = `/api/projects/${projectId}/threads/${threadId}`;
  const project = `/projects/${projectId}`;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined; let reading = false; let again = false;
    const load = async () => {
      clearTimeout(timer);
      if (reading) { again = true; return; }
      reading = true;
      try {
        const next = await api(base, ThreadViewSchema, 'GET', undefined, { signal: controller.signal });
        if (!controller.signal.aborted) { latest.current = next; setView(next); setLoadError(''); }
      } catch (failure) {
        if (!controller.signal.aborted) {
          if (failure instanceof ApiError && failure.status === 401) onError(failure);
          else setLoadError(failureText(failure));
        }
      } finally {
        reading = false;
        if (!controller.signal.aborted) {
          if (again) { again = false; void load(); }
          else timer = setTimeout(() => void load(), threadPollDelay(latest.current?.thread.state, Date.now(), fastUntil.current));
        }
      }
    };
    kick.current = () => { fastUntil.current = Date.now() + THREAD_POLL_AFTER_ACTION_MS; void load(); };
    void load();
    return () => { controller.abort(); clearTimeout(timer); kick.current = () => {}; };
  }, [base, onError]);
  /** Every action answers the thread view; the page shows it, tells the sidebar and keeps reading quickly for a moment. */
  const acted = (next: ThreadView) => { latest.current = next; setView(next); updated(); kick.current(); };

  // Follow the newest entry unless the reader scrolled up (as the session pages do); the first load opens at the end.
  const page = useRef<HTMLDivElement>(null); const bottom = useRef<HTMLDivElement>(null);
  const following = useRef(true); const opened = useRef(false);
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    const scrolled = () => {
      following.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 180;
      setBehind(!following.current);
    };
    window.addEventListener('scroll', scrolled, { passive: true });
    return () => window.removeEventListener('scroll', scrolled);
  }, []);
  useEffect(() => {
    if (!view) return;
    if (!opened.current || following.current) { bottom.current?.scrollIntoView({ block: 'end' }); opened.current = true; }
  }, [view]);
  const loaded = view !== undefined;
  useEffect(() => {
    const element = page.current; if (!element) return;
    const observer = new ResizeObserver(() => { if (following.current) bottom.current?.scrollIntoView({ block: 'end' }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);
  const jump = () => { following.current = true; setBehind(false); bottom.current?.scrollIntoView({ block: 'end' }); };

  const runtimeName = useMemo(() => runtimeNames(data), [data]);
  const { error: actionError, setError: setActionError, fail } = useLocalError(onError);
  const allow = useTask((failure) => { fail(failure); kick.current(); });
  const turns = view?.transcript?.turns; const reports = view?.reports;
  const state = view?.thread.state; const finished = view?.thread.turns ?? 0;
  const items = useMemo(() => withoutReportCalls(alignReports(turns ?? [], reports ?? [], state === 'running' ? finished + 1 : finished), reports ?? []),
    [turns, reports, state, finished]);

  const back = <RouteLink className="text-button pw-back" href={project} navigate={navigate}><Icon name="back" size={14} />{copy.BACK_TO_PROJECT}</RouteLink>;
  if (!view) {
    return (
      <div className="conversation-page pw-page pw-thread-page" ref={page}>
        <div className="section-heading conversation-heading pw-heading">
          <h1 aria-labelledby={titleId}>{navigation}<span id={titleId} className="session-title" /></h1>
          <div className="conversation-meta pw-thread-meta">{back}</div>
        </div>
        {loadError ? <p className="error">{loadError}</p> : (
          <p className="page-loading" role="status"><span className="activity-spinner" aria-hidden="true" />{copy.LOADING_THREAD}</p>
        )}
      </div>
    );
  }

  const thread = view.thread;
  const actions = threadActions(view);
  const line = placementLine(thread, view, runtimeName(thread.runtime));
  const notice = transcriptNotice(view);
  const allowTurns = () => void allow.run(async (signal) => {
    setActionError('');
    acted(await api(`${base}/allow-turns`, ThreadViewSchema, 'POST', empty, { signal }));
    message(copy.MORE_TURNS_ALLOWED);
  });

  return (
    <div className="conversation-page pw-page pw-thread-page" ref={page}>
      <div className="section-heading conversation-heading pw-heading pw-thread-heading">
        <h1 aria-labelledby={titleId}>{navigation}<span id={titleId} className="session-title" title={thread.title}>{thread.title}</span></h1>
        {(actions.stop || actions.discard || actions.allowTurns) && (
          <div className="actions">
            {actions.stop && (
              <button type="button" className="secondary pw-head-button" onClick={() => setConfirming('stop')}>
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
        )}
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
        </div>
        <div className="pw-thread-details">
          {thread.stateReason && <p className="pw-thread-reason">{thread.stateReason}</p>}
          <p className="pw-placement-line" title={line}>{line}</p>
        </div>
      </div>
      {loadError && <p className="notice" role="status">{loadError}</p>}
      {actionError && <p className="error">{actionError}</p>}
      <div className="cursor-transcript pw-transcript" aria-label={copy.TRANSCRIPT_LABEL}>
        {notice && <p className="pw-transcript-note">{notice}</p>}
        {items.map((item) => item.kind === 'turn'
          ? <TranscriptTurn key={item.turn.id} turn={item.turn} userLabel={copy.PROMPT} collapseLongUser={copy.PROMPT_COLLAPSE_CHARACTERS} />
          : <ReportCard key={`report-${item.report.turn}-${item.report.synthesized ? 'synthesized' : 'recorded'}`} report={item.report} />)}
        {view.queuedMessages.length > 0 && (
          <section className="pw-queued" aria-labelledby={queuedId}>
            <h3 id={queuedId}>{copy.QUEUED_MESSAGES}</h3>
            {view.queuedMessages.map((queued) => <QueuedEntry key={queued.id} queued={queued} />)}
          </section>
        )}
      </div>
      <ThreadComposer base={base} view={view} behind={behind} jump={jump} onError={onError}
        sent={() => { following.current = true; kick.current(); }} refused={() => kick.current()} />
      <div ref={bottom} />
      {confirming === 'stop' && (
        <ConfirmAction title={copy.STOP_THREAD_TITLE} action={copy.STOP} onError={onError} close={() => setConfirming(undefined)}
          body={thread.isolation === 'worktree' ? `${copy.STOP_THREAD_BODY} ${copy.STOP_KEEPS_WORKTREE}` : copy.STOP_THREAD_BODY}
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
 * message, so only the reason shows (D81, D231). Refusals stay here, and the page reads the thread again.
 */
function ThreadComposer({ base, view, behind, jump, sent, refused, onError }: {
  base: string; view: ThreadView; behind: boolean; jump(): void; sent(): void; refused(): void; onError(error: unknown): void;
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
    <form className="composer card pw-composer pw-thread-composer" onSubmit={(event) => {
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
              {behind && <button type="button" className="text-button pw-jump" onClick={jump}>{copy.JUMP_TO_LATEST}<Icon name="chevron" size={14} /></button>}
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
    </form>
  );
}
