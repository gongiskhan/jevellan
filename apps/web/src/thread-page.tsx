import { AttachmentControls, LibraryMessage, useProjectAttachments } from './project-library.js';
import { ThreadActions } from './thread-actions.js';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  formatThreadUsage, THREAD_POLL_AFTER_ACTION_MS, THREAD_POLL_LIVE_MS, threadPollDelay, threadStarting, deviceRefusal,
  ProjectWorkViewSchema, ProjectThreadOverrideEditorSchema, type ProjectThreadOverrideEditor, type ThreadOverrideEditorFields, ProjectThreadWhyViewSchema, type ProjectThreadWhyView, RESTARTED_PREFIX, SAVED_COMMITS_SENTENCE, ThreadMessageReceiptSchema, ThreadOverrideViewSchema, ThreadViewSchema,
  type ThreadTimeline, type ThreadIndex, type ThreadReport, type ThreadReportPresentation, type ThreadView,
} from '@jevellan/core/client';
import { ApiError, api, empty } from './api.js';
import { copyText, selectText } from './clipboard.js';
import { Confirm, Markdown, Modal, Panel, composerClearance, dateTime, followOnScroll, repinAtEnd, useTask, type PageProps } from './components.js';
import { LandingWhy } from './landing-route.js';
import { MergeWhy } from './merge-route.js';
import { OwnerCommands, OwnerCommandScope } from './owner-commands.js';
import { OpenTerminalButton } from './terminal.js';
import { Icon } from './icons.js';
import { MessageInput } from './message-delivery.js';
import * as copy from './project-work-copy.js';
import {
  dotClass, lineParts,
  partWords, } from './project-work-model.js';
import { RouteLink, Stamp, afterDialogs, deviceNames, failureText, updated, useClientIds, useLocalError } from './project-work.js';
import { TranscriptTurn } from './session-transcript.js';
import { shortTime } from './time.js';
import { SessionHistory } from './session-history.js';
import { SessionCache } from './session-cache.js';
import { imageReferences, sessionImages, turnImages } from './thread-image-refs.js';
import { ThreadImageGallery, ThreadImageStrip } from './thread-images.js';
const readableSessionText = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, at => dateTime(at));

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
  const [sessionOpen, setSessionOpen] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string>();
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

  const { error: actionError, setError: setActionError, fail } = useLocalError(onError);
  const allow = useTask((failure) => { fail(failure); kick.current(); });
  const turns = view?.transcript?.turns; const reports = view?.reports;

  const images = useMemo(() => sessionImages(turns ?? [], reports ?? []), [turns, reports]);
  const openImage = useCallback((ref: string) => { if (imageReferences(ref).length) { following.current = false; setBehind(true); setSelectedImage(ref); } }, []);

  const transcriptItems = view?.timeline?.items ?? [];


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
  const details = view.presentation;
  const actions = details?.actions;
  const controls = details?.controls;
  const line = view.card?.placementLine ?? '';
  const notice = details?.transcriptNotice;
  const fallback = view.placementNotice;
  const reason = details?.reason;
  const allowTurns = () => void allow.run(async (signal) => {
    setActionError('');
    const next = await api(`${base}/allow-turns`, ThreadViewSchema, 'POST', empty, { signal });
    acted(next);
    if (next.presentation) message(next.presentation.actions.allowedNotice);
  });

  return (
    <OwnerCommandScope value={{ projectId, threadId, deviceId: thread.ownerDeviceId, cwd: 'worktree', deviceName: deviceNames(data), navigate, onError }}>
    <div className="conversation-page pw-page pw-thread-page" ref={page}>
      <div className="section-heading conversation-heading pw-heading pw-thread-heading">
        <h1 aria-labelledby={titleId}>{navigation}<span id={titleId} className="session-title" title={thread.title}>{thread.title}</span></h1>
        <div className="actions">
          <button type="button" className="secondary pw-head-button pw-session-toggle" aria-label="Session information" title="Session information"
            aria-expanded={sessionOpen} aria-controls="thread-session-information" onClick={() => { if (!sessionOpen) { following.current = false; setBehind(true); } setSessionOpen(!sessionOpen); }}>
            <Icon name="settings" size={16} /><span className="pw-head-label">Session</span>
          </button>
          {images.length > 0 && <button type="button" className="secondary pw-head-button pw-keep-label" onClick={() => openImage(images[0]!)}>Images <span className="chip">{images.length}</span></button>}
          {actions?.stop && (
            <button type="button" className="secondary pw-head-button" disabled={!controls || !!actions.stopRefusal} title={actions.stopRefusal ?? (!controls ? 'Thread controls are unavailable. Refresh to continue.' : undefined)}
              aria-describedby={actions.stopRefusal ? stopNoteId : undefined} onClick={() => setConfirming('stop')}>
              <Icon name="stop" size={15} /><span className="pw-head-label">{copy.STOP}</span>
            </button>
          )}
          {actions?.discard && (
            <button type="button" className="secondary pw-head-button" disabled={!controls} onClick={() => setConfirming('discard')}>
              <Icon name="trash" size={15} /><span className="pw-head-label">{copy.DISCARD}</span>
            </button>
          )}
          {actions?.allowTurns && (
            <button type="button" className="pw-head-button pw-keep-label" disabled={allow.busy} onClick={allowTurns}>
              <Icon name="plus" size={15} /><span className="pw-head-label">{actions.allowTurnsLabel}</span>
            </button>
          )}
        </div>
        <div className="pw-thread-owner-actions"><ThreadActions projectId={projectId} thread={thread} presentation={view.card?.threadActions ?? undefined} changed={() => kick.current()} onError={onError} /></div>
        <div className="conversation-meta pw-thread-meta">
          {back}
          <span className={`chip pw-state-chip pw-state-${thread.state}`}>
            <i className={dotClass(thread.state)} aria-hidden="true" />{view.card?.stateLabel}
          </span>
          {view.card?.showLandingWhy && <>{view.card.landingLabel && <span className="chip">{view.card.landingLabel}</span>}<LandingWhy projectId={projectId} threadId={thread.id} /></>}
          {thread.pr && (
            <>
              <a className="chip pw-pr-chip" href={thread.pr.url} target="_blank" rel="noopener noreferrer" title={copy.OPEN_PULL_REQUEST}>
                <Icon name="pull-request" size={13} />{copy.pullRequestNumber(thread.pr.number)}
              </a>
              <MergeWhy projectId={projectId} threadId={thread.id} commit={thread.pr.headSha} buttonLabel="Why this merge" compact />
              {view.card?.headerBadges.map((badge) => <span key={badge.text} className={`chip pw-badge pw-tone-${badge.tone}`}>{badge.text}</span>)}
            </>
          )}
          {fallback && <span className="chip pw-badge pw-tone-warn pw-fallback-chip">{fallback}</span>}
        </div>
        <div className="pw-thread-details">
          {reason?.text && (
            <p className="pw-thread-reason" title={reason.text}>
              {reason.restartedAs
                ? <>{RESTARTED_PREFIX}<RouteLink href={`${project}/threads/${reason.restartedAs}`} navigate={navigate}>{reason.restartedAs}</RouteLink>.</> : readableSessionText(reason.text)}
            </p>
          )}
          {reason?.savedRef && <p className="pw-saved-ref">{SAVED_COMMITS_SENTENCE}<code>{reason.savedRef}</code>.</p>}
          {/* Why Stop and Restart wait while the thread is attached, and why an ended main thread still holds the checkout (phase 8). */}
          {actions?.stopRefusal && <p className="pw-thread-note" id={stopNoteId}>{actions.stopRefusal}</p>}
          {view.checkoutHeld && <p className="pw-thread-note pw-tone-warn" role="status">{view.checkoutHeld}</p>}
          <div className="pw-session-badges">
            {controls?.usage && <span className="chip pw-session-badge">{formatThreadUsage(controls.usage.tokens, controls.usage.costUsd)}</span>}
            <button type="button" className="chip pw-session-badge" aria-label="Model and account details" aria-expanded={sessionOpen} onClick={() => { if (!sessionOpen) { following.current = false; setBehind(true); } setSessionOpen(!sessionOpen); }}>
              <Icon name="agents" size={13} />{thread.modelLabel}<span className="pw-session-account">{thread.accountLabel}</span><Icon name="chevron" size={12} />
            </button>
            <span className="pw-session-device"><Icon name="devices" size={13} />{view.deviceName}</span>
          </div>
          <section id="thread-session-information" className="pw-session-panel" aria-label="Session information" hidden={!sessionOpen}>
            <p className="pw-placement-line"><Parts line={line} /></p>
            <div className="actions pw-session-actions">
              <OpenTerminalButton props={props} projectId={projectId} threadId={threadId} deviceId={thread.ownerDeviceId} />
              {controls?.browserTakeover && <OpenTerminalButton props={props} projectId={projectId} threadId={threadId} deviceId={thread.ownerDeviceId} takeover label="Take over in browser" />}
              <button type="button" className="secondary" aria-pressed={why} onClick={() => setWhy(!why)}><Icon name="why" size={15} />{copy.WHY}</button>
              {!!view.overrideEditorPath && <button type="button" className="secondary" onClick={() => setOverriding(true)}><Icon name="tune" size={15} />{copy.OVERRIDE}</button>}
            </div>
            {controls?.attachPanel && <TakeOver device={view.deviceName} command={view.attachCommand} message={message} />}
            <SessionCache rows={thread.sessionCache} sessionKey={thread.cacheSessionKey} timezone={thread.sessionCache?.at(-1)?.timezone ?? 'UTC'} />
            <SessionHistory entries={view.sessionHistory} path={`/api/projects/${projectId}/threads/${thread.id}`} />
            {!!view.notices?.length && <details><summary>{copy.SESSION_NOTICES} ({view.notices.length})</summary><ol>{view.notices.map((notice, index) => <li key={index}><time dateTime={notice.at}>{dateTime(notice.at)}</time>: {readableSessionText(notice.text)}</li>)}</ol></details>}
          </section>
        </div>
      </div>
      {loadError && <p className="notice" role="status">{loadError}</p>}
      {actionError && <p className="error">{actionError}</p>}
      <div className="cursor-transcript pw-transcript" aria-label={copy.TRANSCRIPT_LABEL}>
        {notice && <p className="pw-transcript-note">{notice}</p>}
        {transcriptItems.map((item) => item.kind === 'turn'
          ? <Fragment key={item.turn.id}>{item.fixLabel && <p className="pw-fix-label">{item.fixLabel}</p>}<TranscriptTurn projectId={view.thread.projectId} turn={item.turn} onOpenImage={openImage} focus active={item.active} prepared={item.groups} userLabel={copy.PROMPT} collapseLongUser={thread.state === 'attached' ? 0 : copy.PROMPT_COLLAPSE_CHARACTERS} /><ThreadImageStrip base={base} files={turnImages(item.turn)} open={openImage} /></Fragment>
          : <ReportCard key={`report-${item.report.turn}-${item.report.synthesized ? 'synthesized' : 'recorded'}`} report={item.report} presentation={item.presentation} base={base} openImage={openImage} />)}
        {!!view.timeline?.queued.length && (
          <section className="pw-queued" aria-labelledby={queuedId}>
            <h3 id={queuedId}>{copy.QUEUED_MESSAGES}</h3>
            {view.timeline.queued.map((queued) => <QueuedEntry projectId={view.thread.projectId} key={queued.message.id} queued={queued} />)}
          </section>
        )}
      </div>
      <ThreadComposer base={base} view={view} behind={behind} jump={jump} onError={onError}
        sent={() => { following.current = true; kick.current(); }} refused={() => kick.current()} />
      <div ref={bottom} />
      {selectedImage && <ThreadImageGallery base={base} files={images.includes(selectedImage) ? images : [...images, selectedImage]} selected={selectedImage} select={setSelectedImage} close={() => setSelectedImage(undefined)} />}
      {why && <WhyPanel view={view} projectId={projectId} onError={props.onError} close={() => setWhy(false)} />}
      {overriding && (
        <OverrideDialog props={props} view={view} projectId={projectId} close={() => setOverriding(false)} applied={() => { updated(); kick.current(); }} />
      )}
      {confirming === 'stop' && controls && (
        <ConfirmAction title={controls.stop.title} action={controls.stop.action} onError={onError} close={() => setConfirming(undefined)}
          body={controls.stop.body}
          run={async (signal) => acted(await api(`${base}/stop`, ThreadViewSchema, 'POST', { schema: 'thread-stop-request-v1' }, { signal }))} />
      )}
      {confirming === 'discard' && controls && (
        <ConfirmAction title={controls.discard.title} action={controls.discard.action} body={controls.discard.body}
          onError={onError} close={() => setConfirming(undefined)}
          run={async (signal) => {
            const next = await api(`${base}/discard`, ThreadViewSchema, 'POST', empty, { signal });
            acted(next);
            afterDialogs(message, next.presentation?.controls?.discard.notice ?? controls.discard.notice);
          }} />
      )}
    </div>
    </OwnerCommandScope>
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
function ReportCard({ report, presentation, base, openImage }: { report: ThreadReport; presentation: ThreadReportPresentation; base: string; openImage(ref: string): void }) {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const badge = presentation.badge;
  const tests = report.testsRun; const options = report.options ?? [];
  return (
    <section className={`pw-report pw-report-${report.status}`} aria-labelledby={headingId}>
      {presentation.fixLabel && <p className="pw-fix-label">{presentation.fixLabel}</p>}
      <details className="pw-report-disclosure" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="pw-report-head">
        <h3 id={headingId}>{presentation.heading}</h3>
        {presentation.synthesizedNotice && <span className="pw-report-note">{presentation.synthesizedNotice}</span>}
        <span className={`chip pw-badge pw-tone-${badge.tone}`}>{badge.text}</span>
        {!expanded && <span className="pw-report-preview">{presentation.preview}</span>}
      </summary>
      {expanded && <>
      <LibraryMessage projectId={presentation.projectId} text={report.summary} onOpenImage={openImage} />
      <ThreadImageStrip base={base} files={imageReferences(report.summary)} open={openImage} />
      <OwnerCommands commands={report.ownerCommands} />
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
          <strong className={`pw-tone-${presentation.tests?.tone}`}>
            <Icon name={presentation.tests?.icon ?? 'check'} size={14} />{presentation.tests?.label}
          </strong>
          <code>{tests.command}</code>
          {tests.summary && <p>{tests.summary}</p>}
        </div>
      )}
      </>}
      </details>
    </section>
  );
}

/** A message that waits for the thread's next turn (D81, D231). */
function QueuedEntry({ queued: item, projectId }: { queued: ThreadTimeline['queued'][number]; projectId: string }) {
  const { message: queued, presentation } = item;
  return (
    <details className="pw-queued-message">
      <summary>
      <span className="pw-source">
        {presentation.sourceLabel} · <Stamp at={queued.at} label={shortTime(queued.at)} />
        {presentation.interruptsLabel && <> · {presentation.interruptsLabel}</>}
      </span>
        <span className="pw-queued-preview">{presentation.preview}</span>
      </summary>
      <LibraryMessage projectId={projectId} text={queued.text} />
    </details>
  );
}

/**
 * The thread composer (12.3): a growing textarea and the send icon, with Interrupt current turn while a turn runs. Messages
 * are idempotent by client id. An attached thread disables it; completed work keeps the owner composer (D834).
 * Discarded/replaced threads show their closure. Refusals stay here, and the page reads the thread again. Under it, the
 * terminal controls live in the session information panel.
 */
function ThreadComposer({ base, view, behind, jump, sent, refused, onError }: {
  base: string; view: ThreadView; behind: boolean; jump(): void; sent(): void; refused(): void; onError(error: unknown): void;
}) {
  const [text, setText] = useState('');
  const attachments = useProjectAttachments(view.thread.projectId, onError);
  const [interrupt, setInterrupt] = useState(false);
  const { error, setError, fail } = useLocalError(onError);
  const send = useTask((failure) => { fail(failure); refused(); });
  const ids = useClientIds('message');
  const running = view.presentation?.composer.running ?? false;
  // A choice made for a turn that has ended never carries over to the next one.
  useEffect(() => { if (!running) setInterrupt(false); }, [running]);
  const live = view.presentation?.live.text;
  const activity = view.presentation?.live.activity;
  const block = view.presentation?.composer.block ?? (view.presentation ? null : 'Thread details are unavailable. Refresh to continue.');
  const ended = view.presentation?.composer.ended ?? true;
  const continuation = view.presentation?.composer.continueNotice;
  return (
    <form onPaste={attachments.paste} onDragOver={attachments.dragOver} onDrop={attachments.drop} className="composer card pw-composer pw-thread-composer" ref={composerClearance} onSubmit={(event) => {
      event.preventDefault();
      const typed = text;
      if (send.busy || block || (!typed.trim() && !attachments.entries.length)) return;
      void send.run(async (signal) => {
        setError('');
        const prepared = await attachments.prepare(typed, signal);
        const body = { text: prepared.text, interrupt: running && interrupt };
        await api(`${base}/messages`, ThreadMessageReceiptSchema, 'POST',
          { schema: 'thread-message-request-v1', clientMessageId: ids.id(body), ...body }, { signal, waitForHub: true });
        ids.done(); prepared.clear();
        setText((current) => current === typed ? '' : current);
        setInterrupt(false);
        sent();
      });
    }}>
      {(live || behind) && (
        <div className="cursor-live-bar ordinary-live-bar">
          {live && <span role="status"><span className="pw-live-title"><span className="activity-spinner" aria-hidden="true" />{live}</span>{activity && <small className="pw-live-activity">{activity}</small>}</span>}
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
      {continuation && <p className="pw-composer-note">{continuation}</p>}
      {!ended && (
        <fieldset className="pw-fields" disabled={!!block}>
          {/* A composer that takes no message takes no files either, so it keeps no Attach row (an attached page fits the phone). */}
          {!block && <AttachmentControls attachments={attachments} disabled={send.busy} />}
          <div className="message-input-row">
            <MessageInput value={text} change={setText} label={copy.THREAD_PLACEHOLDER} placeholder={copy.THREAD_PLACEHOLDER} />
            <div className="message-actions">
              <button type="submit" className="send-icon" aria-label={copy.SEND} disabled={send.busy || !!block || (!text.trim() && !attachments.entries.length)}><Icon name="send" size={20} /></button>
            </div>
          </div>
        </fieldset>
      )}

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

/** Layout and value formatting only; the owner device supplies every placement explanation. */
function WhyPanel({ view, projectId, close, onError }: { view: ThreadView; projectId: string; close(): void; onError(error: unknown): void }) {
  const [model, setModel] = useState<ProjectThreadWhyView>(), fail = useRef(onError); fail.current = onError;
  const threadId = view.thread.id, at = view.thread.updatedAt;
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/projects/${projectId}/threads/${threadId}/why-view`, ProjectThreadWhyViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })
      .then(value => { if (!controller.signal.aborted) setModel(value); }).catch(error => { if (!controller.signal.aborted) fail.current(error); });
    return () => controller.abort();
  }, [projectId, threadId, at]);
  return <Panel title={copy.WHY_TITLE} eyebrow={model?.title ?? view.thread.title} close={close}>
    {!model ? <p role="status">Loading explanation…</p> : <div className="pw-why">
      {model.followup && <section className="why-section"><h3>Follow-up classification</h3><p>{model.followup}</p></section>}
      {model.memory && <section className="why-section"><h3>Project memory</h3><p>{model.memory.summary}</p><ul>{model.memory.notes.map(note => <li key={note.permalink}><strong>{note.title}</strong>: {note.reason}</li>)}</ul></section>}
      <section className="why-section"><h3>{copy.WHY_PLACEMENT} <span className="why-source">{model.placement.sourceLabel}</span></h3>
        <p className="why-line">{model.placement.fixedLine}</p>
        {model.placement.reasonLine && <p>{model.placement.reasonLine}</p>}
        {model.placement.constraintsLine && <p>{model.placement.constraintsLine}</p>}
        {model.placement.fallbackNotice && <p className="notice pw-why-error">{model.placement.fallbackNotice}</p>}
      </section>
      {model.fields.map(field => <section className="why-section" key={field.field}>
        <h3>{field.label} <span className="why-source">{field.sourceLabel}</span></h3>
        {field.mappedEffort && <p className="why-line">{field.mappedEffort.requested} → <b>{field.mappedEffort.effective}</b> {field.mappedEffort.note}</p>}
        {field.bars.map(bar => <div className={`why-option${bar.chosen ? ' win' : ''}`} key={bar.option}><span title={bar.label}>{bar.label}</span><progress aria-label={`${bar.label} ${copy.PROBABILITY}`} max={1} value={bar.p} /><span>{bar.p.toFixed(2)}</span></div>)}
        {field.showValue && <p className="why-line"><b>{field.valueLabel}</b></p>}
        {(field.listed.length > 0 || field.excluded.length > 0) && <ul className="why-rank">
          {field.listed.map(row => <li key={row.id} className={row.chosen ? 'chosen' : undefined}>{row.label}{row.chosen ? ` · ${copy.CHOSEN}` : ''}</li>)}
          {field.excluded.map(row => <li key={row.id} className={row.reason === null ? undefined : 'excluded'}>{row.label}{row.reason === null ? '' : `: ${row.reason}`}</li>)}
        </ul>}
      </section>)}
      {model.account.showStandalone && <section className="why-section"><h3>{copy.ACCOUNT}</h3><p className="why-line"><b>{model.account.label}</b></p></section>}
      {model.account.showCandidates && <section className="why-section">
        {model.account.retainedMessage && <p>{model.account.retainedMessage}</p>}<h3>Accounts when chosen</h3>{model.account.notice && <p className="notice">{model.account.notice}</p>}
        <ul>{model.account.candidates.map(row => <li key={row.id}><b>{row.label}</b>{row.chosen ? ' · chosen' : ''}: {row.detail}</li>)}</ul>
      </section>}
      {model.escalations.length > 0 && <section className="why-section"><h3>{copy.ESCALATION_HISTORY}</h3><ol>{model.escalations.map((row, index) => <li key={index}>{dateTime(row.at)}: {row.line}</li>)}</ol></section>}
      {model.devices.length > 0 && <section className="why-section"><h3>Devices when placed</h3>{model.devices.map(row => <p key={row.id}>{row.line}</p>)}</section>}
      {model.task && <section className="why-section"><h3>Task</h3><p>{model.task.line}</p>{model.task.needsLine && <p>{model.task.needsLine}</p>}</section>}
      {model.corrections.length > 0 && <section className="why-section"><h3>Corrections shown to Jev</h3><ol className="why-rank">{model.corrections.map((line, index) => <li key={index}>{line}</li>)}</ol></section>}
      <section className="why-section why-jev"><h3>{copy.JEV}</h3>{model.jev.lines.length ? model.jev.lines.map((line, index) => <p key={index}><Parts line={line} /></p>) : <p>{model.jev.emptyLine}</p>}<p>{copy.PLACED} <Stamp at={model.jev.placedAt} /></p></section>
    </div>}
  </Panel>;
}

/** Engine-provided fields/choices; local state only holds the draft and guards in-flight requests. */
function OverrideDialog({ props, view, projectId, close, applied }: { props: PageProps; view: ThreadView; projectId: string; close(): void; applied(): void }) {
  const { error, setError, fail } = useLocalError(props.onError), operation = useTask(fail), ids = useClientIds('override');
  const [editor, setEditor] = useState<ProjectThreadOverrideEditor>(), [fields, setFields] = useState<ThreadOverrideEditorFields>();
  const modeNote = useId(), deviceNote = useId(), threadId = view.thread.id;
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/projects/${projectId}/threads/${threadId}/override-editor`, ProjectThreadOverrideEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })
      .then(value => { if (!controller.signal.aborted) { setEditor(value); setFields(value.fields); } }).catch(error => { if (!controller.signal.aborted) fail(error); });
    return () => controller.abort();
  }, [projectId, threadId, fail]);
  const preview = (patch: Partial<ThreadOverrideEditorFields>, changed: 'mode' | 'model' | 'effort' | 'device') => {
    if (!editor || !fields) return;
    const previous = fields, draft = { ...fields, ...patch };
    void operation.run(async signal => {
      setFields(draft);
      try {
        const value = await api(editor.request.previewPath, ProjectThreadOverrideEditorSchema, 'POST', { schema: 'thread-override-editor-preview-request-v1', changed, fields: draft }, { signal, waitForHub: true });
        setEditor(value); setFields(value.fields);
      } catch (error) { if (!signal.aborted) setFields(previous); throw error; }
    });
  };
  return <Modal title={copy.OVERRIDE} close={close}>{!editor || !fields ? <p role="status">Loading editor…</p> : <form className="pw-override" onSubmit={event => {
    event.preventDefault(); if (!editor.apply.enabled) return;
    void operation.run(async signal => {
      setError('');
      const result = await api(editor.request.savePath, ThreadOverrideViewSchema, 'POST', { ...editor.request.base, clientRequestId: ids.id(fields), fields }, { signal, waitForHub: true });
      ids.done(); updated();
      if (result.newThreadId) { afterDialogs(props.message, copy.THREAD_RESTARTED); close(); props.navigate(`/projects/${projectId}/threads/${result.newThreadId}`); }
      else { afterDialogs(props.message, copy.OVERRIDE_APPLIED); close(); applied(); }
    });
  }}>
    <fieldset className="pw-override-modes" disabled={operation.busy}><legend className="sr-only">{copy.OVERRIDE_MODES}</legend>
      {editor.choices.modes.map(mode => <Fragment key={mode.value}><label className={mode.enabled ? undefined : 'pw-disabled'}>
        <input type="radio" name="pw-override-mode" checked={fields.mode === mode.value} disabled={!mode.enabled} aria-describedby={`${modeNote}-${mode.value}`}
          onChange={() => preview({ mode: mode.value }, 'mode')} />{mode.label}</label>
        <p className={`pw-field-note pw-radio-note${mode.enabled ? '' : ' pw-refused'}`} id={`${modeNote}-${mode.value}`}>{mode.help}</p></Fragment>)}
    </fieldset>
    <fieldset className="pw-fields" disabled={operation.busy}><div className="form-grid pw-override-fields">
      <label>{copy.MODEL}<select value={fields.modelId} onChange={event => preview({ modelId: event.target.value }, 'model')}>{editor.choices.models.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
      <label>{copy.EFFORT}<select value={fields.effort} onChange={event => preview({ effort: event.target.value as ThreadOverrideEditorFields['effort'] }, 'effort')}>{editor.choices.efforts.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
      {editor.showDevice && <div className="pw-field"><label>{copy.DEVICE}<select value={fields.deviceId} aria-describedby={editor.deviceNotice ? deviceNote : undefined} onChange={event => preview({ deviceId: event.target.value }, 'device')}>{editor.choices.devices.map(choice => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</option>)}</select></label>{editor.deviceNotice && <p className="pw-field-note" id={deviceNote}>{editor.deviceNotice}</p>}</div>}
    </div><label>{copy.OVERRIDE_NOTE}<textarea rows={2} maxLength={editor.constraints.noteMax} value={fields.note} placeholder={copy.OVERRIDE_NOTE_PLACEHOLDER} onChange={event => setFields({ ...fields, note: event.target.value })} /></label></fieldset>
    {error && <p className="error">{error}</p>}
    <div className="form-actions"><button type="button" className="secondary" onClick={close}>{copy.CANCEL}</button><button className={editor.apply.tone === 'danger' ? 'danger' : undefined} title={editor.apply.refusal ?? undefined} disabled={operation.busy || !editor.apply.enabled}>{operation.busy ? copy.APPLYING : copy.APPLY}</button></div>
  </form>}</Modal>;
}
