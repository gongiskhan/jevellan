import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ImproverRunSchema,
  ImproverStateSchema,
  ImproverSummarySchema,
  MemoryCareReportRowSchema,
  MemoryNoteSchema,
  ProjectImproverLogSchema,
  ProjectRevisionRecordSchema,
  ProjectSuggestionRowSchema,
  ProjectsListSchema,
  RoutingImproverLogSchema,
  RoutingRevisionRecordSchema,
  RoutingSuggestionRowSchema,
  type DocumentSchema,
  type ImproverCard,
  type ImproverSettings,
  type MemoryCareReportRow,
  type Project,
} from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Markdown, Modal, Panel, SectionHeading, dateTime, useTask, type PageProps } from './components.js';

type State = z.infer<typeof ImproverStateSchema>;
type Summary = z.infer<typeof ImproverSummarySchema>;
type Log = z.infer<typeof RoutingImproverLogSchema> | z.infer<typeof ProjectImproverLogSchema>;
type RevisionRecord =
  | z.infer<typeof RoutingRevisionRecordSchema>
  | z.infer<typeof ProjectRevisionRecordSchema>;

// The badge and the quiet notice line use the cheap summary; the page itself loads the full state.
export function useImprover(enabled: boolean, onError: (error: unknown) => void) {
  const [summary, setSummary] = useState<Summary>();
  const [state, setState] = useState<State>();
  const [watching, setWatching] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await api('/api/improver', ImproverStateSchema, 'GET', undefined, {
      signal,
      waitForHub: true,
    });
    setState(result);
    setSummary({ schema: 'improver-summary-v1', pending: result.pending, notice: result.notice });
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running) return;
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
    const timer = setInterval(() => void load(), watching ? 3000 : 10_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [enabled, refresh, onError, watching]);
  const notice = enabled ? (summary?.notice ?? null) : null;
  return {
    state: enabled ? state : undefined,
    refresh,
    watch: setWatching,
    count: enabled ? (summary?.pending ?? 0) : 0,
    notice,
    unseen: notice ? 1 : 0,
    consume: () => {
      if (!notice) return;
      setSummary((current) => (current ? { ...current, notice: null } : current));
      void api(
        '/api/improver',
        ImproverSummarySchema,
        'POST',
        { schema: 'improver-request-v1', operation: 'notice-seen', id: notice.id },
        { waitForHub: true },
      ).catch(() => undefined);
    },
  };
}
export type Monitor = ReturnType<typeof useImprover>;

// A mutation keeps the same request identifier while its body is unchanged, so retries are idempotent.
function useMutation() {
  const pending = useRef<{ signature: string; id: string } | undefined>(undefined);
  return async <T,>(
    schema: DocumentSchema<T>,
    body: Record<string, unknown>,
    place: 'root' | 'input',
    signal?: AbortSignal,
  ): Promise<T> => {
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature) pending.current = { signature, id: clientId() };
    const id = pending.current.id;
    const request =
      place === 'root'
        ? { ...body, clientRequestId: id }
        : { ...body, input: { ...(body.input as object), clientRequestId: id } };
    const result = await api(
      '/api/improver',
      schema,
      'POST',
      { schema: 'improver-request-v1', ...request },
      { signal, waitForHub: true },
    );
    pending.current = undefined;
    return result;
  };
}

export function DiffView({ text, label }: { text: string; label?: string }) {
  if (!text.trim()) return <p className="muted small-text">No changes.</p>;
  return (
    <pre className="git-diff" aria-label={label}>
      {text.split('\n').map((line, index) => (
        <span
          key={index}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'addition'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'removal'
                : ''
          }
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

const kindLabel = { routing: 'Routing', 'memory-care': 'Memory care', context: 'AGENTS.md' } as const;
const statusLabel: Record<ImproverCard['status'], string> = {
  pending: 'Waiting for you',
  applying: 'Applying',
  recompute: 'Recomputing',
  expired: 'Expired',
  applied: 'Applied',
  undoing: 'Undoing',
  dismissed: 'Dismissed',
  undone: 'Undone',
};
const countsText = (counts: { merged: number; archived: number; fixedLinks: number }) =>
  `merged ${counts.merged} note${counts.merged === 1 ? '' : 's'}, archived ${counts.archived}, fixed ${counts.fixedLinks} link${counts.fixedLinks === 1 ? '' : 's'}`;

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
  const task = useTask(props.onError);
  const mutate = useMutation();
  const [dialog, setDialog] = useState<'change' | 'dismiss'>();
  const [note, setNote] = useState<string>();
  const [reason, setReason] = useState('');
  const [instruction, setInstruction] = useState('');
  const [fieldAfter, setFieldAfter] = useState(card.change.kind === 'field' ? card.change.after : '');
  const [fileAfter, setFileAfter] = useState<Record<string, string>>(() =>
    card.change.kind === 'patch'
      ? Object.fromEntries(
          card.change.files.flatMap((file) => (file.after === null ? [] : [[file.path, file.after]])),
        )
      : {},
  );
  const [requestId, setRequestId] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const routing = card.kind === 'routing';
  useEffect(() => {
    if (!card.actions.undo || !card.applied) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [card.actions.undo, card.applied]);
  const revisions: RevisionRecord[] = routing
    ? (monitor.state?.revisions ?? [])
    : (monitor.state?.projectRevisions ?? []);
  const request = revisions.find((entry) => entry.id === requestId);
  const running = revisions.find(
    (entry) =>
      entry.request.suggestionId === card.id &&
      entry.request.revision === card.revision &&
      entry.status === 'running',
  );
  const undoSeconds = card.applied
    ? Math.max(0, Math.ceil((Date.parse(card.applied.undoUntil) - now) / 1000))
    : 0;
  const act = (kind: 'apply' | 'undo' | 'dismiss', previewId: string | null = null) =>
    task.run(async (signal) => {
      const input = {
        schema: card.requests.action,
        kind,
        revision: card.revision,
        ...(kind === 'apply' ? { previewId } : kind === 'dismiss' ? { reason: reason.trim() || null } : {}),
      };
      const body = { operation: 'act', suggestionId: card.id, input };
      if (routing) await mutate(RoutingSuggestionRowSchema, body, 'input', signal);
      else await mutate(ProjectSuggestionRowSchema, body, 'input', signal);
      setDialog(undefined);
      await monitor.refresh(signal);
      if (routing) await props.reload(signal);
      props.message(
        kind === 'undo' ? 'Undoing.' : kind === 'dismiss' ? 'Suggestion dismissed.' : 'Applying.',
      );
    });
  const revise = (kind: 'text' | 'instruction') =>
    task.run(async (signal) => {
      const input =
        kind === 'instruction'
          ? {
              schema: card.requests.revision,
              kind,
              suggestionId: card.id,
              revision: card.revision,
              instruction,
            }
          : routing
            ? {
                schema: card.requests.revision,
                kind,
                suggestionId: card.id,
                revision: card.revision,
                after: fieldAfter,
              }
            : {
                schema: card.requests.revision,
                kind,
                suggestionId: card.id,
                revision: card.revision,
                files: Object.entries(fileAfter).map(([path, after]) => ({ path, after })),
              };
      const body = { operation: 'revise', input };
      const result = routing
        ? await mutate(RoutingRevisionRecordSchema, body, 'input', signal)
        : await mutate(ProjectRevisionRecordSchema, body, 'input', signal);
      setRequestId(result.id);
      await monitor.refresh(signal);
    });
  const preview = request?.status === 'complete' ? request.preview : null;
  const busy = ['applying', 'undoing', 'recompute'].includes(card.status);
  return (
    <article className="card suggestion-card" aria-label={card.title}>
      <div className="suggestion-meta model-chips">
        <span className="chip action">{kindLabel[card.kind]}</span>
        {card.projectName && <span className="chip">{card.projectName}</span>}
        <span className={`chip ${card.decided ? '' : 'state-waiting-for-you'}`}>
          {statusLabel[card.status]}
        </span>
        <span className="chip dim">{dateTime(card.updatedAt)}</span>
      </div>
      <h2>{card.title}</h2>
      <p>{card.reason}</p>
      {card.error && <p className="notice">{card.error}</p>}
      {card.counts && <p className="muted small-text">This change {countsText(card.counts)}.</p>}
      <details className="suggestion-evidence">
        {card.evidence.kind === 'corrections' ? (
          <>
            <summary>
              Based on {card.evidence.total} correction{card.evidence.total === 1 ? '' : 's'} (
              {card.evidence.withUndo} with undo)
            </summary>
            <ul>
              {card.evidence.items.map((item) => (
                <li key={item.id}>
                  <a
                    href={`/conversations/${item.conversationId}${item.stretch ? `?stretch=${item.stretch}` : ''}`}
                    onClick={(event) => {
                      event.preventDefault();
                      props.navigate(event.currentTarget.getAttribute('href')!);
                    }}
                  >
                    {item.conversationTitle ?? item.context}
                  </a>
                  <span className="muted">
                    {' '}
                    · {dateTime(item.at)} · {item.field}: {item.from ?? 'Auto'} → {item.to ?? 'Auto'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <summary>
              Based on {card.evidence.notes.length} note{card.evidence.notes.length === 1 ? '' : 's'}
            </summary>
            <ul>
              {card.evidence.notes.map((entry) => (
                <li key={entry.permalink}>
                  <button className="evidence-link" onClick={() => setNote(entry.permalink)}>
                    {entry.title}
                  </button>
                  <span className="muted"> · {entry.path}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
      <DiffView text={card.change.diff} label="Suggested change" />
      {card.check && (
        <div className="suggestion-checks">
          <p>
            Checked against {card.check.total} saved cases: {card.check.unchanged} unchanged,{' '}
            {card.check.better} better, {card.check.worse} worse.
            {card.check.evidence === 'simulated' && (
              <span className="muted"> Simulated judge responses.</span>
            )}
          </p>
          {card.check.changed.length > 0 && (
            <ul>
              {card.check.changed.map((entry) => (
                <li key={entry.caseId}>
                  {entry.title} · {entry.change}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {running && <p role="status">Preparing a revised suggestion…</p>}
      <div className="actions">
        {busy && <span className="activity-spinner" aria-hidden="true" />}
        {card.actions.apply && (
          <button disabled={task.busy || !!running} onClick={() => void act('apply')}>
            Apply
          </button>
        )}
        {card.actions.change && (
          <button
            className="secondary"
            disabled={task.busy || !!running}
            onClick={() => {
              setRequestId(undefined);
              setDialog('change');
            }}
          >
            Change it
          </button>
        )}
        {card.actions.undo && (
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
        {card.decided && !card.actions.undo && card.outcomes.at(-1)?.reason && (
          <span className="muted small-text">“{card.outcomes.at(-1)!.reason}”</span>
        )}
        {card.applied?.commit && (
          <span className="muted small-text">
            Commit <code>{card.applied.commit.slice(0, 10)}</code>
            {card.applied.published ? ' · published' : ''}
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
                disabled={task.busy || !!running || (routing && !fieldAfter.trim())}
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
                disabled={task.busy || !!running || !instruction.trim()}
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
                  <DiffView
                    text={`- ${preview.draft.before.split('\n').join('\n- ')}\n+ ${preview.draft.after.split('\n').join('\n+ ')}`}
                  />
                  <p className="muted small-text">
                    Checked against {preview.comparison.cases.length} saved cases:{' '}
                    {preview.comparison.unchanged} unchanged, {preview.comparison.better} better,{' '}
                    {preview.comparison.worse} worse.
                  </p>
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
              disabled={task.busy || !!running || !preview}
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
  const task = useTask(props.onError);
  const mutate = useMutation();
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
          {report.status === 'applied' ? 'Applied' : report.status === 'undoing' ? 'Undoing' : 'Undone'}
        </span>
        <span className="chip dim">{dateTime(report.at)}</span>
      </div>
      <h2>
        Memory care for {report.projectName}: {countsText(report.counts)}.
      </h2>
      {report.error && <p className="notice">{report.error}</p>}
      <div className="actions">
        <button className="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
          View changes
        </button>
        {report.status === 'applied' && (
          <button
            className="secondary"
            disabled={task.busy}
            onClick={() =>
              void task.run(async (signal) => {
                await mutate(
                  MemoryCareReportRowSchema,
                  {
                    operation: 'report',
                    reportId: report.id,
                    input: { schema: 'memory-care-report-action-v1', revision: row.revision, kind: 'undo' },
                  },
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
            Commit <code>{report.commit.slice(0, 10)}</code>
            {report.undoCommit ? ` · reverted in ${report.undoCommit.slice(0, 10)}` : ''}
          </span>
        )}
      </div>
      {open && <DiffView text={report.patch.diff} label="Memory care changes" />}
    </article>
  );
}

function JobSettings({ props, projects }: { props: PageProps; projects: Project[] }) {
  const current = props.data.config.configuration['x-jevellan'].improver;
  const [draft, setDraft] = useState<ImproverSettings>(current);
  const task = useTask(props.onError);
  useEffect(() => setDraft(current), [current]);
  const changed = JSON.stringify(draft) !== JSON.stringify(current);
  const configuration = props.data.config.configuration;
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
            disabled={!draft.schedule.enabled}
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
          <span className="chip dim">Suggest</span>
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
              disabled={!draft.memory.enabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  memory: { ...draft.memory, mode: event.target.value as 'apply-and-tell' | 'suggest' },
                })
              }
            >
              <option value="apply-and-tell">Apply and tell me</option>
              <option value="suggest">Suggest only</option>
            </select>
          </label>
        </div>
        {draft.memory.enabled && projects.length > 0 && (
          <fieldset className="job-projects">
            <legend>Projects for memory care</legend>
            {projects.map((project) => (
              <label key={project.id}>
                <input
                  type="checkbox"
                  checked={draft.memory.projects[project.id] !== false}
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
          <span className="chip dim">Suggest</span>
        </div>
      </div>
      <div className="form-actions">
        {changed && (
          <button className="secondary" onClick={() => setDraft(current)}>
            Revert
          </button>
        )}
        <button
          disabled={!changed || task.busy}
          onClick={() =>
            void task.run((signal) =>
              props.saveConfig(
                { ...configuration, 'x-jevellan': { ...configuration['x-jevellan'], improver: draft } },
                signal,
              ),
            )
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
  const mutate = useMutation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [log, setLog] = useState<Log>();
  const { watch, refresh } = monitor;
  useEffect(() => {
    watch(true);
    void refresh().catch(props.onError);
    return () => watch(false);
  }, [watch, refresh, props.onError]);
  useEffect(() => {
    const controller = new AbortController();
    void api('/hub/projects', ProjectsListSchema, 'GET', undefined, {
      signal: controller.signal,
      waitForHub: true,
    })
      .then((value) => setProjects(value.projects.map((row) => row.project)))
      .catch((error) => {
        if (!controller.signal.aborted) props.onError(error);
      });
    return () => controller.abort();
  }, [props.onError]);
  const state = monitor.state;
  const open = state?.cards.filter((card) => !card.decided) ?? [];
  const decided = state?.cards.filter((card) => card.decided) ?? [];
  const settings = props.data.config.configuration['x-jevellan'].improver;
  const anyEnabled = settings.routing.enabled || settings.memory.enabled || settings.context.enabled;
  return (
    <>
      <SectionHeading title="Improver">
        <button
          disabled={task.busy || !anyEnabled}
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
      ) : !open.length && !state.reports.length ? (
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
        <JobSettings props={props} projects={projects} />
        <section className="card" aria-label="Last runs">
          <h2>Last runs</h2>
          {!state?.lastRuns.some((run) => run.at) ? (
            <p className="empty-inline">No runs yet.</p>
          ) : (
            <div className="run-list">
              {state.lastRuns
                .filter((run) => run.at)
                .map((run) => (
                  <div className="run-row" key={`${run.kind}_${run.projectId ?? 'hub'}`}>
                    <div>
                      <strong>
                        {run.kind === 'routing'
                          ? 'Routing'
                          : run.kind === 'memory'
                            ? 'Memory care'
                            : 'AGENTS.md'}
                        {run.projectName ? ` · ${run.projectName}` : ''}
                      </strong>
                      <p>{run.result}</p>
                    </div>
                    <div className="run-side">
                      <span className="muted small-text">{run.at ? dateTime(run.at) : run.status}</span>
                      {run.commit ? (
                        <code>{run.commit.slice(0, 10)}</code>
                      ) : (
                        run.jobId && (
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
                                  run.kind === 'routing'
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
              {state.lastRuns.some((run) => !run.at) && (
                <details className="run-idle">
                  <summary>{state.lastRuns.filter((run) => !run.at).length} jobs have not run yet</summary>
                  <p className="muted small-text">
                    {state.lastRuns
                      .filter((run) => !run.at)
                      .map(
                        (run) =>
                          `${run.kind === 'routing' ? 'Routing' : run.kind === 'memory' ? 'Memory care' : 'AGENTS.md'}${run.projectName ? ` · ${run.projectName}` : ''}`,
                      )
                      .join(', ')}
                  </p>
                </details>
              )}
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
            {log.entries.map((entry, index) => (
              <li key={index}>
                <strong>
                  {dateTime(entry.at)} · {entry.stage}
                </strong>
                <p>{entry.note}</p>
                {'probability' in entry && entry.probability !== null && (
                  <p className="muted small-text">Preference probability: {entry.probability.toFixed(2)}</p>
                )}
              </li>
            ))}
          </ol>
        </Panel>
      )}
    </>
  );
}
