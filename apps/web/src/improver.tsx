import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ImproverRunSchema, ConfigRevisionSchema, ImproverEditorViewSchema, improverMonitorPolicy, improverNoticeSeen, improverMutationPlan, improverDiff, improverCardSeed, improverCardEditor, improverActionRequest, improverRevisionRequest, improverReportView, improverReportUndo, improverSettingsForm, improverSettingsSaveInput, improverSettingsSaved, improverEditorResult, improverLogRows, IMPROVER_ACTION_MESSAGES, IMPROVER_SETTINGS_SAVED, type ImproverEditorView,
  ImproverStateSchema,
  ImproverSummarySchema,
  MemoryCareReportRowSchema,
  MemoryNoteSchema,
  ProjectImproverLogSchema,
  ProjectRevisionRecordSchema,
  ProjectSuggestionRowSchema,
  RoutingImproverLogSchema,
  RoutingRevisionRecordSchema,
  RoutingSuggestionRowSchema,
  type DocumentSchema,
  type ImproverCard,
  type ImproverSettings,
  type MemoryCareReportRow,
} from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Markdown, Modal, Panel, SectionHeading, dateTime, useTask, useSettingsSave, type PageProps } from './components.js';

type State = z.infer<typeof ImproverStateSchema>;
type Summary = z.infer<typeof ImproverSummarySchema>;
type Log = z.infer<typeof RoutingImproverLogSchema> | z.infer<typeof ProjectImproverLogSchema>;
// The badge and the quiet notice line use the cheap summary; the page itself loads the full state.
export function useImprover(enabled: boolean, onError: (error: unknown) => void) {
  const [summary, setSummary] = useState<Summary>();
  const [state, setState] = useState<State>();
  const [editor,setEditor]=useState<ImproverEditorView>();
  const [watching, setWatching] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await api('/api/improver/view', ImproverEditorViewSchema, 'GET', undefined, {
      signal,
      waitForHub: true,
    });
    setEditor(result);setState(result.state);
    setSummary({ schema: 'improver-summary-v1', pending: result.state.pending, notice: result.state.notice });
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (!improverMonitorPolicy(enabled,watching,undefined,running).shouldLoad) return;
      running = true;
      try {
        if (watching) await refresh(controller.signal);
        else
          setSummary(
            await api(
              '/api/improver',
              ImproverSummarySchema,
              'POST',
              { schema: 'improver-request-v1', operation: 'summary' },
              { signal: controller.signal, waitForHub: true },
            ),
          );
      } catch (error) {
        if (!controller.signal.aborted) onError(error);
      } finally {
        running = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), improverMonitorPolicy(enabled,watching,undefined,false).intervalMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [enabled, refresh, onError, watching]);
  const policy=improverMonitorPolicy(enabled,watching,summary,false),notice=policy.notice;
  return {
    state: enabled ? state : undefined, editor:enabled?editor:undefined,
    refresh,
    watch: setWatching,
    count: policy.count,
    notice,
    unseen: policy.unseen,
    consume: () => {
      if (!notice) return;
      setSummary((current) => (current ? { ...current, notice: null } : current));
      void api(
        '/api/improver',
        ImproverSummarySchema,
        'POST',
        improverNoticeSeen(notice),
        { waitForHub: true },
      ).catch(() => undefined);
    },
  };
}
export type Monitor = ReturnType<typeof useImprover>;

// A mutation keeps the same request identifier while its body is unchanged, so retries are idempotent.
function useMutation(deviceId:string|undefined) {
  const pending = useRef<ReturnType<typeof improverMutationPlan>['pending'] | undefined>(undefined);
  return async <T,>(schema:DocumentSchema<T>,body:Record<string,unknown>,place:'root'|'input',signal?:AbortSignal):Promise<T>=>{
    if(!deviceId)throw Error('Wait for the improver view before changing it.');
    const plan=improverMutationPlan(body,place,pending.current,clientId());pending.current=plan.pending;
    const result = await api(
      '/api/improver',
      schema,
      'POST',
      plan.request,
      { signal, waitForHub: true },
    );
    improverEditorResult({schema:'improver-editor-device-request-v1',operation:'command',deviceId,input:plan.request},{schema:'improver-editor-result-v1',deviceId,operation:'command',result});
    pending.current = undefined;
    return result;
  };
}

export function DiffView({text,label}:{text:string;label?:string}){
 const view=improverDiff(text);if(view.emptyMessage)return <p className="muted small-text">{view.emptyMessage}</p>;
 return <pre className="git-diff" aria-label={label}>{view.rows.map((row,index)=><span key={index} className={row.tone}>{row.text}{'\n'}</span>)}</pre>;
}

function NotePanel({
  projectId,
  permalink,
  close,
  onError,
}: {
  projectId: string;
  permalink: string;
  close(): void;
  onError(error: unknown): void;
}) {
  const [note, setNote] = useState<z.infer<typeof MemoryNoteSchema>>();
  useEffect(() => {
    const controller = new AbortController();
    void api(
      `/api/projects/${projectId}/memory?permalink=${encodeURIComponent(permalink)}`,
      MemoryNoteSchema,
      'GET',
      undefined,
      { signal: controller.signal },
    )
      .then(setNote)
      .catch((error) => {
        if (!controller.signal.aborted) onError(error);
      });
    return () => controller.abort();
  }, [projectId, permalink, onError]);
  return (
    <Panel title={note?.title ?? permalink} eyebrow="memory" close={close}>
      {note ? <Markdown>{note.content}</Markdown> : <p role="status">Loading note…</p>}
    </Panel>
  );
}

function SuggestionCard({
  card,
  monitor,
  props,
}: {
  card: ImproverCard;
  monitor: Monitor;
  props: PageProps;
}) {
  const presentation = card.presentation, check = presentation?.check;
  const task = useTask(props.onError);
  const mutate = useMutation(monitor.editor?.deviceId);
  const [dialog, setDialog] = useState<'change' | 'dismiss'>();
  const [note, setNote] = useState<string>();
  const [reason, setReason] = useState('');
  const [instruction, setInstruction] = useState('');
  const seed=improverCardSeed(card);
  const [fieldAfter, setFieldAfter] = useState(seed.fieldAfter);
  const [fileAfter,setFileAfter]=useState<Record<string,string>>(()=>seed.fileAfter);
  const [requestId, setRequestId] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const editor=improverCardEditor(card,monitor.state,requestId,now,{fieldAfter,fileAfter,instruction});
  const {routing,request,running,preview,busy,undoSeconds}=editor;
  useEffect(() => {
    if (!card.actions.undo || !card.applied) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [card.actions.undo, card.applied]);
  const act = (kind: 'apply' | 'undo' | 'dismiss', previewId: string | null = null) =>
    task.run(async (signal) => {
      const body=improverActionRequest(card,kind,reason,previewId,'draft');
      if (routing) await mutate(RoutingSuggestionRowSchema, body, 'input', signal);
      else await mutate(ProjectSuggestionRowSchema, body, 'input', signal);
      setDialog(undefined);
      await monitor.refresh(signal);
      if (routing) await props.reload(signal);
      props.message(IMPROVER_ACTION_MESSAGES[kind]);
    });
  const revise = (kind: 'text' | 'instruction') =>
    task.run(async (signal) => {
      const body=improverRevisionRequest(card,kind,{fieldAfter,fileAfter,instruction},'draft');
      const result = routing
        ? await mutate(RoutingRevisionRecordSchema, body, 'input', signal)
        : await mutate(ProjectRevisionRecordSchema, body, 'input', signal);
      setRequestId(result.id);
      await monitor.refresh(signal);
    });
  return (
    <article className="card suggestion-card" aria-label={card.title}>
      <div className="suggestion-meta model-chips">
        <span className="chip action">{editor.kindLabel}</span>
        {card.projectName && <span className="chip">{card.projectName}</span>}
        <span className={`chip ${card.decided ? '' : 'state-waiting-for-you'}`}>
          {editor.statusLabel}
        </span>
        <span className="chip dim">{dateTime(card.updatedAt)}</span>
      </div>
      <h2>{card.title}</h2>
      <p>{card.reason}</p>
      {card.error && <p className="notice">{card.error}</p>}
      {card.counts && <p className="muted small-text">This change {editor.countsText}.</p>}
      {presentation ? <details className="suggestion-evidence">
        <summary>{presentation.evidence.summary}</summary>
        <ul>{presentation.evidence.entries.map(entry => {
          const action = entry.action;
          return <li key={entry.id}>
            {action.kind === 'conversation' ? <a href={action.href} onClick={event => { event.preventDefault(); props.navigate(action.href); }}>{entry.label}</a>
              : <button className="evidence-link" onClick={() => setNote(action.permalink)}>{entry.label}</button>}
            {(entry.at || entry.detail) && <span className="muted"> · {entry.at ? `${dateTime(entry.at)} · ` : ''}{entry.detail}</span>}
          </li>;
        })}</ul>
      </details> : <p className="muted">Evidence details unavailable.</p>}
      <DiffView text={card.change.diff} label="Suggested change" />
      {check && <div className="suggestion-checks">
        <p>{check.summary}{check.simulatedNotice && <span className="muted"> {check.simulatedNotice}</span>}</p>
        {check.cases.length > 0 && <ul>{check.cases.map(entry => <li key={entry.id}>{entry.text}</li>)}</ul>}
      </div>}
      {running && <p role="status">Preparing a revised suggestion…</p>}
      <div className="actions">
        {busy && <span className="activity-spinner" aria-hidden="true" />}
        {card.actions.apply && (
          <button disabled={task.busy || !editor.canApply} onClick={() => void act('apply')}>
            Apply
          </button>
        )}
        {card.actions.change && (
          <button
            className="secondary"
            disabled={task.busy || !editor.canChange}
            onClick={() => {
              setRequestId(undefined);
              setDialog('change');
            }}
          >
            Change it
          </button>
        )}
        {editor.canUndo && (
          <>
            <strong>Applied.</strong>
            <button className="secondary" disabled={task.busy} onClick={() => void act('undo')}>
              Undo{undoSeconds ? ` (${undoSeconds}s)` : ''}
            </button>
          </>
        )}
        {card.actions.dismiss && (
          <button className="text-button" disabled={task.busy} onClick={() => setDialog('dismiss')}>
            Dismiss
          </button>
        )}
        {editor.lastReason && (
          <span className="muted small-text">“{editor.lastReason}”</span>
        )}
        {editor.shortCommit && (
          <span className="muted small-text">
            Commit <code>{editor.shortCommit}</code>
            {editor.published ? ' · published' : ''}
          </span>
        )}
      </div>
      {note && card.projectId && (
        <NotePanel
          projectId={card.projectId}
          permalink={note}
          close={() => setNote(undefined)}
          onError={props.onError}
        />
      )}
      {dialog === 'dismiss' && (
        <Modal title="Dismiss suggestion" close={() => setDialog(undefined)}>
          <label>
            Why not? (optional)
            <input
              autoFocus
              maxLength={1200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <button className="secondary" onClick={() => setDialog(undefined)}>
              Cancel
            </button>
            <button disabled={task.busy} onClick={() => void act('dismiss')}>
              Dismiss suggestion
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'change' && (
        <Modal title="Change the suggestion" close={() => setDialog(undefined)}>
          <div className="change-columns">
            <section>
              {routing ? (
                <label>
                  Edit the after text
                  <textarea
                    rows={8}
                    value={fieldAfter}
                    onChange={(event) => setFieldAfter(event.target.value)}
                  />
                </label>
              ) : (
                Object.entries(fileAfter).map(([path, value]) => (
                  <label key={path}>
                    {path}
                    <textarea
                      rows={8}
                      className="code-editor"
                      value={value}
                      onChange={(event) =>
                        setFileAfter((current) => ({ ...current, [path]: event.target.value }))
                      }
                    />
                  </label>
                ))
              )}
              <button
                className="secondary"
                disabled={task.busy || !editor.canReviseText}
                onClick={() => void revise('text')}
              >
                Check this text
              </button>
            </section>
            <section>
              <label>
                Or say what you want instead
                <textarea
                  rows={8}
                  maxLength={4000}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Only for UI work in ekoa-code"
                />
              </label>
              <button
                className="secondary"
                disabled={task.busy || !editor.canReviseInstruction}
                onClick={() => void revise('instruction')}
              >
                Revise the suggestion
              </button>
            </section>
          </div>
          {running && <p role="status">Preparing and checking the revised suggestion…</p>}
          {request?.status === 'failed' && <p className="notice">{request.error}</p>}
          {preview && (
            <section className="change-preview" aria-label="Revised suggestion">
              <h3>Revised change</h3>
              {'draft' in preview ? (
                <>
                  {preview.presentation ? <>
                    <DiffView text={preview.presentation.diff} />
                    <p className="muted small-text">{preview.presentation.checkSummary}{preview.presentation.simulatedNotice && <> {preview.presentation.simulatedNotice}</>}</p>
                  </> : <p className="muted">Preview details unavailable.</p>}
                </>
              ) : (
                <DiffView text={preview.patch.diff} />
              )}
            </section>
          )}
          <div className="form-actions">
            <button className="secondary" onClick={() => setDialog(undefined)}>
              Cancel
            </button>
            <button
              disabled={task.busy || !editor.canApplyPreview}
              onClick={() => void act('apply', preview!.id)}
            >
              Apply this
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}

function ReportCard({
  row,
  monitor,
  props,
}: {
  row: MemoryCareReportRow;
  monitor: Monitor;
  props: PageProps;
}) {
  const { report } = row;
  const view=improverReportView(row);
  const task = useTask(props.onError);
  const mutate = useMutation(monitor.editor?.deviceId);
  const [open, setOpen] = useState(false);
  return (
    <article
      className="card suggestion-card report-card"
      aria-label={`Memory care for ${report.projectName}`}
    >
      <div className="suggestion-meta model-chips">
        <span className="chip action">Memory care</span>
        <span className="chip">{report.projectName}</span>
        <span className={`chip ${report.status === 'applied' ? 'state-done' : ''}`}>
          {view.statusLabel}
        </span>
        <span className="chip dim">{dateTime(report.at)}</span>
      </div>
      <h2>
        {view.title}
      </h2>
      {report.error && <p className="notice">{report.error}</p>}
      <div className="actions">
        <button className="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
          View changes
        </button>
        {view.actions.undo && (
          <button
            className="secondary"
            disabled={task.busy}
            onClick={() =>
              void task.run(async (signal) => {
                await mutate(
                  MemoryCareReportRowSchema,
                  improverReportUndo(row,'draft'),
                  'input',
                  signal,
                );
                await monitor.refresh(signal);
                props.message('Undoing memory care.');
              })
            }
          >
            Undo
          </button>
        )}
        {report.commit && (
          <span className="muted small-text">
            Commit <code>{view.shortCommit}</code>
            {view.shortUndoCommit ? ` · reverted in ${view.shortUndoCommit}` : ''}
          </span>
        )}
      </div>
      {open && <DiffView text={report.patch.diff} label="Memory care changes" />}
    </article>
  );
}

function JobSettings({ props, projects, monitor }: { props: PageProps; projects: ImproverEditorView['projects']; monitor:Monitor }) {
  const current = props.data.config.configuration['x-jevellan'].improver;
  const [draft, setDraft] = useState<ImproverSettings>(current);
  const task = useTask(props.onError);
  useEffect(() => setDraft(current), [current]);
  const form=improverSettingsForm(current,draft,projects,task.busy),changed=form.changed;
  const save=useSettingsSave();
  return (
    <section className="card improver-settings" aria-label="Schedule and jobs">
      <h2>Schedule and jobs</h2>
      <div className="schedule-line">
        <label className="toggle">
          <input
            type="checkbox"
            checked={draft.schedule.enabled}
            onChange={(event) =>
              setDraft({ ...draft, schedule: { ...draft.schedule, enabled: event.target.checked } })
            }
          />
          Run nightly at
        </label>
        <label className="compact-label">
          <span className="sr-only">Nightly time</span>
          <input
            type="time"
            value={draft.schedule.time}
            disabled={form.timeDisabled}
            onChange={(event) =>
              setDraft({ ...draft, schedule: { ...draft.schedule, time: event.target.value } })
            }
          />
        </label>
      </div>
      <div className="job-list">
        <div className="job-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.routing.enabled}
              onChange={(event) =>
                setDraft({ ...draft, routing: { ...draft.routing, enabled: event.target.checked } })
              }
            />
            Routing suggestions
          </label>
          <span className="chip dim">{form.routingModeLabel}</span>
        </div>
        <div className="job-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.memory.enabled}
              onChange={(event) =>
                setDraft({ ...draft, memory: { ...draft.memory, enabled: event.target.checked } })
              }
            />
            Memory care
          </label>
          <label className="compact-label">
            <span className="sr-only">Memory care mode</span>
            <select
              value={draft.memory.mode}
              disabled={form.memoryModeDisabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  memory: { ...draft.memory, mode: event.target.value as 'apply-and-tell' | 'suggest' },
                })
              }
            >
              {form.memoryModes.map(mode=><option key={mode.value} value={mode.value}>{mode.label}</option>)}
            </select>
          </label>
        </div>
        {form.showProjects && (
          <fieldset className="job-projects">
            <legend>Projects for memory care</legend>
            {form.projects.map((project) => (
              <label key={project.id}>
                <input
                  type="checkbox"
                  checked={project.checked}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      memory: {
                        ...draft.memory,
                        projects: { ...draft.memory.projects, [project.id]: event.target.checked },
                      },
                    })
                  }
                />
                {project.name}
              </label>
            ))}
          </fieldset>
        )}
        <div className="job-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.context.enabled}
              onChange={(event) =>
                setDraft({ ...draft, context: { ...draft.context, enabled: event.target.checked } })
              }
            />
            Context suggestions for AGENTS.md
          </label>
          <span className="chip dim">{form.contextModeLabel}</span>
        </div>
      </div>
      {form.validation.map(message=><p role="status" className="error" key={message}>{message}</p>)}
      <div className="form-actions">
        {changed && (
          <button className="secondary" onClick={() => setDraft(current)}>
            Revert
          </button>
        )}
        <button
          disabled={!form.canSave}
          onClick={() =>
            void task.run(async(signal)=>{
              const input=improverSettingsSaveInput({revision:props.data.config.revision,value:current},draft,'draft');
              improverSettingsSaved(input,await save('/api/config/improver',ConfigRevisionSchema,'PUT',input,signal));
              await props.reload(signal);await monitor.refresh(signal);props.message(IMPROVER_SETTINGS_SAVED);
            })
          }
        >
          Save schedule and jobs
        </button>
      </div>
    </section>
  );
}

export function ImproverPage({ monitor, ...props }: PageProps & { monitor: Monitor }) {
  const task = useTask(props.onError);
  const mutate = useMutation(monitor.editor?.deviceId);
  const [log, setLog] = useState<Log>();
  const { watch, refresh } = monitor;
  useEffect(() => {
    watch(true);
    void refresh().catch(props.onError);
    return () => watch(false);
  }, [watch, refresh, props.onError]);
  const state=monitor.state,view=monitor.editor,page=view?.page,open=page?.open??[],decided=page?.decided??[];
  return (
    <>
      <SectionHeading title="Improver">
        <button
          disabled={task.busy || !page?.canRunNow}
          onClick={() =>
            void task.run(async (signal) => {
              await mutate(ImproverRunSchema, { operation: 'run-now' }, 'root', signal);
              await monitor.refresh(signal);
              props.message('The improver is running.');
            })
          }
        >
          Run now
        </button>
      </SectionHeading>
      <p className="intro">
        Suggestions drawn from your corrections and project memory. Routing and AGENTS.md changes apply only
        when you choose Apply.
      </p>
      <h3>Waiting for you{open.length ? ` (${open.length})` : ''}</h3>
      {!state ? (
        <p role="status">Loading suggestions…</p>
      ) : page?.empty ? (
        <p className="empty-inline">No suggestions right now.</p>
      ) : (
        <div className="suggestion-list">
          {open.map((card) => (
            <SuggestionCard key={`${card.id}_${card.revision}`} card={card} monitor={monitor} props={props} />
          ))}
          {state.reports.map((row) => (
            <ReportCard key={`${row.report.id}_${row.revision}`} row={row} monitor={monitor} props={props} />
          ))}
        </div>
      )}
      <div className="improver-grid">
        <JobSettings props={props} projects={view?.projects??[]} monitor={monitor} />
        <section className="card" aria-label="Last runs">
          <h2>Last runs</h2>
          {!page?.runs.length ? (
            <p className="empty-inline">No runs yet.</p>
          ) : (
            <div className="run-list">
              {page.runs.map(({run,label,shortCommit,canOpenLog,logKind}) => (
                  <div className="run-row" key={`${run.kind}_${run.projectId ?? 'hub'}`}>
                    <div>
                      <strong>
                        {label}
                      </strong>
                      <p>{run.result}</p>
                    </div>
                    <div className="run-side">
                      <span className="muted small-text">{run.at ? dateTime(run.at) : run.status}</span>
                      {shortCommit ? (
                        <code>{shortCommit}</code>
                      ) : (
                        canOpenLog && (
                          <button
                            className="text-button"
                            onClick={() =>
                              void task.run(async (signal) => {
                                const body = {
                                  schema: 'improver-request-v1',
                                  operation: 'log',
                                  jobId: run.jobId,
                                };
                                const options = { signal, waitForHub: true };
                                setLog(
                                  logKind === 'routing'
                                    ? await api(
                                        '/api/improver',
                                        RoutingImproverLogSchema,
                                        'POST',
                                        body,
                                        options,
                                      )
                                    : await api(
                                        '/api/improver',
                                        ProjectImproverLogSchema,
                                        'POST',
                                        body,
                                        options,
                                      ),
                                );
                              })
                            }
                          >
                            Open log
                          </button>
                        )
                      )}
                    </div>
                  </div>
                ))}
              {!!page.idle.count && <details className="run-idle"><summary>{page.idle.count} jobs have not run yet</summary><p className="muted small-text">{page.idle.labels.join(', ')}</p></details>}
            </div>
          )}
        </section>
      </div>
      <section className="card" aria-label="Trial log">
        <h2>Trial log</h2>
        <p className="muted small-text">Conversations finished in Jevellan and outside it, per week.</p>
        {!state?.trialLog.weeks.length ? (
          <p className="empty-inline">No finished conversations yet.</p>
        ) : (
          <table className="trial-log">
            <thead>
              <tr>
                <th>Week of</th>
                <th>In Jevellan</th>
                <th>Outside</th>
                <th>Why they finished elsewhere</th>
              </tr>
            </thead>
            <tbody>
              {state.trialLog.weeks.map((week) => (
                <tr key={week.weekStart}>
                  <td>{week.weekStart}</td>
                  <td>{week.inJevellan}</td>
                  <td>{week.outside}</td>
                  <td>
                    {week.reasons.length ? (
                      <ul>
                        {week.reasons.map((entry) => (
                          <li key={entry.conversationId}>
                            <a
                              href={`/conversations/${entry.conversationId}`}
                              onClick={(event) => {
                                event.preventDefault();
                                props.navigate(`/conversations/${entry.conversationId}`);
                              }}
                            >
                              {entry.title}
                            </a>
                            {entry.reason ? `: ${entry.reason}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <h3>Recently decided</h3>
      {!decided.length ? (
        <p className="empty-inline">Nothing decided in the last 7 days.</p>
      ) : (
        <div className="suggestion-list">
          {decided.map((card) => (
            <SuggestionCard key={`${card.id}_${card.revision}`} card={card} monitor={monitor} props={props} />
          ))}
        </div>
      )}
      {log && (
        <Panel title="Run log" eyebrow={dateTime(log.startedAt)} close={() => setLog(undefined)}>
          <ol className="run-log">
            {improverLogRows(log).map((entry, index) => (
              <li key={index}>
                <strong>
                  {dateTime(entry.at)} · {entry.stage}
                </strong>
                <p>{entry.note}</p>
                {entry.probability !== null && (
                  <p className="muted small-text">Preference probability: {entry.probability}</p>
                )}
              </li>
            ))}
          </ol>
        </Panel>
      )}
    </>
  );
}
