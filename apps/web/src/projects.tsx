import { BranchChangeNotice } from './branch-change-notice.js';
import { clientId } from './client-id.js';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ContextPanelSchema,
  ContextReviewSchema,
  MemoryNoteSchema,
  MemorySearchSchema,
  ProjectsListSchema,
  ProjectViewSchema,
  ProjectVisibilitySchema,
  ProjectFoldersSchema,
  type Project,
} from '@jevellan/core/client';
import { api } from './api.js';
import {
  Markdown,
  Modal,
  SectionHeading,
  dateTime,
  useSettingsSave,
  useTask,
  type PageProps,
} from './components.js';

type ProjectView = z.infer<typeof ProjectViewSchema>;
export function ProjectsPage(props: PageProps & { embedded?: boolean }) {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [visibility, setVisibility] = useState<Record<string, z.infer<typeof ProjectVisibilitySchema>>>({});
  const [editing, setEditing] = useState<ProjectView | 'new'>();
  const [memory, setMemory] = useState<Project>();
  const [context, setContext] = useState<Project>();
  const reload = async (signal?: AbortSignal) =>
    setProjects(
      (await api('/hub/projects', ProjectsListSchema, 'GET', undefined, { signal, waitForHub: true }))
        .projects,
    );
  useEffect(() => {
    void api('/hub/projects', ProjectsListSchema)
      .then((value) => setProjects(value.projects))
      .catch(props.onError);
  }, [props.onError]);
  useEffect(() => {
    let active = true;
    setVisibility({});
    for (const row of projects)
      if (row.project.paths[props.data.devices.currentDeviceId])
        void api(`/api/projects/${row.project.id}/visibility`, ProjectVisibilitySchema)
          .then((value) => {
            if (active) setVisibility((previous) => ({ ...previous, [row.project.id]: value }));
          })
          .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projects, props.data.devices.currentDeviceId]);
  return (
    <>
      {props.embedded ? (
        <div className="setup-project-actions">
          <button onClick={() => setEditing('new')}>Add project</button>
        </div>
      ) : (
        <>
          <SectionHeading title="Projects">
            <div className="actions">
              <button className="secondary" onClick={() => props.navigate('/settings/git')}>
                Git settings
              </button>
              <button onClick={() => setEditing('new')}>Add project</button>
            </div>
          </SectionHeading>
          <p className="intro">
            Choose where your agents work, how changes reach git, and where project memory lives.
          </p>
        </>
      )}
      {!projects.length && <p className="empty-inline">Add a checked-out project to start a conversation.</p>}
      <div className="project-list">
        {projects.map((row) => {
          const path = row.project.paths[props.data.devices.currentDeviceId];
          return (
            <section className="card project-card" key={row.project.id}>
              <div className="card-heading">
                <h2>{row.project.name}</h2>
                <button className="secondary small" onClick={() => setEditing(row)}>
                  Edit
                </button>
              </div>
              <div className="model-chips">
                <span className="chip">
                  {row.project.branchPolicy === 'main' ? 'Work on main' : 'Leave git to me'}
                </span>
                <span className="chip">
                  {row.project.memory.mode === 'repo' ? 'Memory in repository' : 'Memory on each device'}
                </span>
                {row.project.testCommand && <span className="chip dim">{row.project.testCommand}</span>}
                {row.project.context.state === 'needs-decision' && (
                  <span className="chip state-blocked">Context needs a decision</span>
                )}
              </div>
              <p className={path ? 'project-path' : 'project-path muted'}>
                {path ?? 'Not checked out on this device'}
              </p>
              {visibility[row.project.id]?.visibility === 'PUBLIC' && <PublicMemoryNotice />}
              <div className="actions">
                <button className="secondary small" onClick={() => setMemory(row.project)}>
                  Browse memory
                </button>
                <button className="secondary small" disabled={!path} onClick={() => setContext(row.project)}>
                  Context
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {editing && (
        <ProjectForm
          {...props}
          row={editing === 'new' ? undefined : editing}
          knownPublic={editing !== 'new' && visibility[editing.project.id]?.visibility === 'PUBLIC'}
          close={() => setEditing(undefined)}
          saved={async (signal) => {
            await reload(signal);
            setEditing(undefined);
            props.message('Project saved.');
          }}
        />
      )}
      {memory && (
        <MemoryViewer
          project={memory}
          isPublic={visibility[memory.id]?.visibility === 'PUBLIC'}
          onError={props.onError}
          close={() => setMemory(undefined)}
        />
      )}
      {context && (
        <ContextPanel
          {...props}
          project={context}
          close={() => {
            setContext(undefined);
            void reload().catch(props.onError);
          }}
        />
      )}
    </>
  );
}
function PublicMemoryNotice() {
  return (
    <p className="notice public-memory-notice">
      This repository is public. Memory committed here is public too.
    </p>
  );
}
export function ProjectForm({
  row,
  knownPublic,
  close,
  saved,
  ...props
}: PageProps & {
  row: ProjectView | undefined;
  knownPublic: boolean;
  close(): void;
  saved(signal: AbortSignal): Promise<void>;
}) {
  const [project, setProject] = useState<Project>(
    () =>
      row?.project ?? {
        schema: 'project-v1',
        id: `project_${clientId()}`,
        name: '',
        paths: { [props.data.devices.currentDeviceId]: '' },
        branchPolicy: 'main',
        memory: { mode: 'repo', dir: '.jevellan/memory' },
        context: { state: 'none' },
      },
  );
  const [folders, setFolders] = useState<z.infer<typeof ProjectFoldersSchema>>();
  const [createContext, setCreateContext] = useState(true);
  const task = useTask(props.onError);
  const save = useSettingsSave();
  const change = (values: Partial<Project>) => setProject({ ...project, ...values });
  const deviceId = props.data.devices.currentDeviceId;
  const folderName = (path: string) => path.replace(/\/+$/, '').split('/').at(-1) ?? '';
  // A new project's name follows its folder until the user types a name of their own.
  const [nameFollowsFolder, setNameFollowsFolder] = useState(!row);
  const choosePath = (path: string) =>
    setProject((current) => ({
      ...current,
      paths: { ...current.paths, [deviceId]: path },
      name: nameFollowsFolder || !current.name.trim() ? folderName(path) : current.name,
    }));
  // Opening a folder selects it, so Save works without a separate "Use this folder" click.
  const browse = (path?: string) =>
    task.run(async () => {
      const result = await api(
        `/api/project-folders${path ? `?path=${encodeURIComponent(path)}` : ''}`,
        ProjectFoldersSchema,
      );
      setFolders(result);
      if (path) choosePath(result.path);
    });
  return (
    <Modal title={row ? `Edit ${row.project.name}` : 'Add project'} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async (signal) => {
            const paths = Object.fromEntries(Object.entries(project.paths).filter(([, path]) => path.trim()));
            await save(
              '/hub/projects',
              ProjectViewSchema,
              'PUT',
              {
                schema: 'project-write-v1',
                revision: row?.revision ?? 0,
                createContext: !row && createContext,
                project: {
                  ...project,
                  name: project.name.trim() || folderName(paths[deviceId] ?? ''),
                  paths,
                  remoteUrl: project.remoteUrl || undefined,
                  testCommand: project.testCommand || undefined,
                },
              },
              signal,
            );
            await saved(signal);
          });
        }}
      >
        <label>
          Name
          <input
            value={project.name}
            placeholder="The folder name"
            onChange={(event) => {
              setNameFollowsFolder(!event.target.value.trim());
              change({ name: event.target.value });
            }}
          />
        </label>
        <label>
          Remote URL
          <input
            value={project.remoteUrl ?? ''}
            placeholder="Optional"
            onChange={(event) => change({ remoteUrl: event.target.value })}
          />
        </label>
        {props.data.devices.devices.map((device) => (
          <label key={device.id}>
            Path on {device.name}
            <input
              required={device.id === props.data.devices.currentDeviceId}
              placeholder="/absolute/path/to/project"
              value={project.paths[device.id] ?? ''}
              onChange={(event) =>
                device.id === deviceId
                  ? choosePath(event.target.value)
                  : change({ paths: { ...project.paths, [device.id]: event.target.value } })
              }
            />
          </label>
        ))}
        <button type="button" className="secondary" disabled={task.busy} onClick={() => void browse()}>
          Browse folders on{' '}
          {
            props.data.devices.devices.find((device) => device.id === props.data.devices.currentDeviceId)
              ?.name
          }
        </button>
        {folders && (
          <section className="folder-picker" aria-label="Project folders">
            <p className="project-path">{folders.path}</p>
            <div className="actions">
              {folders.parent && (
                <button
                  type="button"
                  className="text-button"
                  disabled={task.busy}
                  onClick={() => void browse(folders.parent!)}
                >
                  ↑ Parent folder
                </button>
              )}
              <button
                type="button"
                disabled={task.busy}
                onClick={() => {
                  choosePath(folders.path);
                  setFolders(undefined);
                }}
              >
                Use this folder
              </button>
            </div>
            <div className="folder-list">
              {folders.folders.length === 0 && <p className="muted small-text">No folders inside this one.</p>}
              {folders.folders.map((folder) => (
                <button
                  type="button"
                  key={folder.path}
                  disabled={task.busy}
                  className="text-button"
                  onClick={() => void browse(folder.path)}
                >
                  ▸ {folder.name}
                </button>
              ))}
            </div>
            <p className="muted small-text">Choose an existing Git project on this device.</p>
          </section>
        )}
        <label>
          Git policy
          <select
            value={project.branchPolicy}
            onChange={(event) => {
              const branchPolicy = event.target.value as Project['branchPolicy'];
              change({
                branchPolicy,
                memory: { ...project.memory, mode: branchPolicy === 'main' ? 'repo' : 'device' },
              });
            }}
          >
            <option value="main">Work on main</option>
            <option value="external">Leave git to me</option>
          </select>
        </label>
        {project.branchPolicy === 'main' && <p className="notice small-text">Jevellan automatically switches clean checkouts to main and announces the change. If main does not exist, it creates it from published branch history. The original branch is preserved.</p>}
        <label>
          Test command
          <input
            value={project.testCommand ?? ''}
            placeholder="npm test"
            onChange={(event) => change({ testCommand: event.target.value })}
          />
        </label>
        <fieldset>
          <legend>Allowed devices</legend>
          {props.data.devices.devices.map((device) => (
            <label className="toggle" key={device.id}>
              <input
                type="checkbox"
                checked={!project.allowedDevices || project.allowedDevices.includes(device.id)}
                onChange={(event) =>
                  change({
                    allowedDevices: event.target.checked
                      ? [...(project.allowedDevices ?? []), device.id]
                      : (
                          project.allowedDevices ?? props.data.devices.devices.map((entry) => entry.id)
                        ).filter((id) => id !== device.id),
                  })
                }
              />
              {device.name}
            </label>
          ))}
        </fieldset>
        {!row && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={createContext}
              onChange={(event) => setCreateContext(event.target.checked)}
            />
            Create AGENTS.md if no instruction file exists
          </label>
        )}
        <h3>Memory</h3>
        {knownPublic &&
          row &&
          project.paths[props.data.devices.currentDeviceId] ===
            row.project.paths[props.data.devices.currentDeviceId] &&
          project.remoteUrl === row.project.remoteUrl && <PublicMemoryNotice />}
        <label>
          Keep project memory
          <select
            value={project.memory.mode}
            onChange={(event) =>
              change({ memory: { ...project.memory, mode: event.target.value as Project['memory']['mode'] } })
            }
          >
            <option value="repo">In the repository, synced through git</option>
            <option value="device">On each device only</option>
          </select>
        </label>
        <label>
          Memory folder
          <input
            required
            value={project.memory.dir}
            onChange={(event) => change({ memory: { ...project.memory, dir: event.target.value } })}
          />
        </label>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={task.busy}>{task.busy ? 'Saving…' : 'Save project'}</button>
        </div>
      </form>
    </Modal>
  );
}
function ContextPanel({ project, close, ...props }: PageProps & { project: Project; close(): void }) {
  const [review, setReview] = useState<z.infer<typeof ContextReviewSchema>>();
  const [panel, setPanel] = useState<z.infer<typeof ContextPanelSchema>>();
  const [modelId, setModelId] = useState('');
  const task = useTask(props.onError);
  const pending = useRef<{ signature: string; id: string } | undefined>(undefined);
  const route = `/api/projects/${project.id}/context`;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api(`${route}/operations`, ContextPanelSchema);
        if (active) setPanel(value);
      } catch (error) {
        if (active) props.onError(error);
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 1000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [route, props.onError]);
  const send = async (endpoint: string, value: Record<string, unknown>, signal: AbortSignal) => {
    const signature = JSON.stringify(value);
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: `context_${clientId()}` };
    setPanel(
      await api(
        `${route}/${endpoint}`,
        ContextPanelSchema,
        'POST',
        { ...value, clientRequestId: pending.current.id },
        { signal, waitForHub: true },
      ),
    );
    pending.current = undefined;
  };
  const operation =
    panel?.operations.find((entry) => !['completed', 'cancelled'].includes(entry.status)) ??
    panel?.operations.at(-1);
  const active = operation && !['completed', 'cancelled'].includes(operation.status);
  const busy = task.busy || panel?.busy;
  const choose = (choice: string) =>
    void task.run((signal) =>
      send(
        'operations',
        {
          schema: 'context-request-v1',
          revision: panel!.revision,
          fingerprint: panel!.context.fingerprint,
          choice,
          ...(choice === 'merge' && modelId ? { modelId } : {}),
        },
        signal,
      ),
    );
  const proceed = (action: string) =>
    void task.run((signal) =>
      send(
        'continue',
        {
          schema: 'context-continue-v1',
          operationId: operation!.id,
          generation: action === 'accept-changes' ? review!.generation : operation!.generation,
          action,
          ...(action === 'accept-changes' ? { fingerprint: review!.fingerprint } : {}),
        },
        signal,
      ),
    );
  const separate = panel?.context.files.every((file) => file.kind === 'file');
  return (
    <Modal title={`Context · ${project.name}`} close={close}>
      {!panel ? (
        <p>Loading context…</p>
      ) : (
        <>
          <p>
            {panel.context.state === 'linked'
              ? `Linked: ${panel.context.files.find((file) => file.kind === 'link')?.name ?? 'Claude Code'} → ${panel.context.primary}`
              : separate
                ? `${project.name} has both AGENTS.md and CLAUDE.md. Agents should read one file.`
                : 'Choose the instructions your agents read in this project.'}
          </p>
          {panel.context.state === 'left-as-is' && (
            <p className="muted">Both files are being kept as they are.</p>
          )}
          {operation?.branchChange && <BranchChangeNotice change={operation.branchChange} />}
          {operation && (
            <section className="context-operation" aria-label="Context operation">
              <p role="status">
                {panel.busy
                  ? operation.status === 'drafting'
                    ? 'Drafting a merge…'
                    : 'Applying and verifying the context change…'
                  : operation.status === 'completed'
                    ? 'Context change completed.'
                    : operation.status === 'cancelled'
                      ? 'Context change cancelled.'
                      : operation.status === 'draft-ready'
                        ? 'Review the proposed changes before applying.'
                        : (operation.reason ?? operation.status)}
              </p>
              {operation.status === 'draft-ready' && operation.draft && (
                <>
                  <p className="muted small-text">
                    The draft ran read-only. Apply replaces AGENTS.md with this text and links CLAUDE.md to
                    it.
                  </p>
                  <div className="context-diff" aria-label="Context merge diff">
                    {operation.before.files.map((file) => (
                      <div key={file.name}>
                        <h3>{file.name}</h3>
                        <pre className="git-diff">
                          <span className="removal">
                            {file.content
                              .split('\n')
                              .map((line) => `− ${line}`)
                              .join('\n')}
                          </span>
                          {'\n'}
                          <span className="addition">
                            {(file.name === 'AGENTS.md' ? operation.draft! : 'Symlink → AGENTS.md')
                              .split('\n')
                              .map((line) => `+ ${line}`)
                              .join('\n')}
                          </span>
                        </pre>
                      </div>
                    ))}
                  </div>
                  <div className="form-actions">
                    <button className="secondary" disabled={busy} onClick={() => proceed('cancel')}>
                      Cancel
                    </button>
                    <button disabled={busy} onClick={() => proceed('apply')}>
                      Apply
                    </button>
                  </div>
                </>
              )}
              {operation.status === 'blocked' && operation.activityReason && (
                <section aria-label="Review context changes">
                  {operation.reason !== operation.activityReason && <p>{operation.activityReason}</p>}
                  {review?.operationId === operation.id && (
                    <>
                      <pre className="git-diff" aria-label="Current context checkout changes">
                        {review.diff}
                      </pre>
                      <p>
                        Continue accepts all the files shown above as this work’s checkpoint, then verifies
                        them before publication.
                      </p>
                    </>
                  )}
                  <div className="actions">
                    {review?.operationId === operation.id && (
                      <button disabled={busy} onClick={() => proceed('accept-changes')}>
                        Continue
                      </button>
                    )}
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void task.run(async () =>
                          setReview(
                            await api(
                              `${route}/review?operation=${encodeURIComponent(operation.id)}`,
                              ContextReviewSchema,
                            ),
                          ),
                        )
                      }
                    >
                      {review?.operationId === operation.id ? 'Refresh changes' : 'Review changes'}
                    </button>
                  </div>
                </section>
              )}
              {operation.status === 'blocked' && !operation.activityReason && (
                <div className="actions">
                  <button disabled={busy} onClick={() => proceed('retry')}>
                    Retry
                  </button>
                  {!operation.applied && (
                    <button className="secondary" disabled={busy} onClick={() => proceed('cancel')}>
                      Cancel
                    </button>
                  )}
                </div>
              )}
              <button
                className="text-button"
                onClick={() => {
                  close();
                  props.navigate(`/conversations/${operation.conversationId}`);
                }}
              >
                Open work
              </button>
            </section>
          )}
          {!active && (
            <>
              {separate ? (
                <div className="context-choices">
                  {project.branchPolicy === 'external' && (
                    <p className="notice">
                      This project follows its own git rules. Only untracked files can become local links.
                    </p>
                  )}
                  <button
                    className="secondary"
                    disabled={busy || (project.branchPolicy === 'external' && panel.context.files[1].tracked)}
                    onClick={() => choose('keep-agents')}
                  >
                    Keep AGENTS.md and link CLAUDE.md to it
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || (project.branchPolicy === 'external' && panel.context.files[0].tracked)}
                    onClick={() => choose('keep-claude')}
                  >
                    Keep CLAUDE.md and link AGENTS.md to it
                  </button>
                  <label>
                    Draft model
                    <select
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                      disabled={busy || project.branchPolicy === 'external'}
                    >
                      <option value="">First eligible model</option>
                      {props.data.config.configuration['x-jevellan'].menu
                        .filter((model) => model.enabled)
                        .map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    className="secondary"
                    disabled={busy || project.branchPolicy === 'external'}
                    onClick={() => choose('merge')}
                  >
                    Merge them into AGENTS.md
                  </button>
                  <button className="secondary" disabled={busy} onClick={() => choose('leave')}>
                    Leave both as they are
                  </button>
                </div>
              ) : (
                panel.context.state === 'none' && (
                  <button disabled={busy} onClick={() => choose(panel.context.primary ? 'link' : 'create')}>
                    {panel.context.primary ? 'Link the instruction files' : 'Create AGENTS.md'}
                  </button>
                )
              )}
            </>
          )}
          <details className="context-files">
            <summary>Current instruction files</summary>
            {panel.context.files.map((file) => (
              <div key={file.name}>
                <h3>{file.name}</h3>
                <p className="muted small-text">
                  {file.kind}
                  {file.target ? ` → ${file.target}` : ''}
                  {file.tracked ? ' · tracked' : ''}
                </p>
                {file.content && <Markdown>{file.content}</Markdown>}
              </div>
            ))}
          </details>
        </>
      )}
    </Modal>
  );
}
function MemoryViewer({
  project,
  isPublic,
  onError,
  close,
}: {
  project: Project;
  isPublic: boolean;
  onError(error: unknown): void;
  close(): void;
}) {
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<z.infer<typeof MemoryNoteSchema>[]>();
  const [selected, setSelected] = useState<z.infer<typeof MemoryNoteSchema>>();
  const task = useTask(onError);
  return (
    <Modal title={`Memory · ${project.name}`} close={close}>
      {isPublic && <PublicMemoryNotice />}
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            const result = await api(
              `/api/projects/${project.id}/memory?query=${encodeURIComponent(query)}`,
              MemorySearchSchema,
            );
            setNotes(result.notes);
            setSelected(undefined);
          });
        }}
      >
        <label>
          Search memory
          <input required value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button disabled={task.busy}>Search</button>
      </form>
      {notes?.length === 0 && <p className="muted">No matching notes.</p>}
      {notes?.map((note) => (
        <button
          className="memory-result secondary"
          key={note.permalink}
          onClick={() =>
            void task.run(async () =>
              setSelected(
                await api(
                  `/api/projects/${project.id}/memory?permalink=${encodeURIComponent(note.permalink)}`,
                  MemoryNoteSchema,
                ),
              ),
            )
          }
        >
          <span>
            {note.title}
            {note.unresolved ? ' (conflicting versions, unresolved)' : ''}
          </span>
          {note.updatedAt && (
            <time
              className="memory-updated"
              dateTime={note.updatedAt}
              title="File modification time on this device"
            >
              Updated {dateTime(note.updatedAt)}
            </time>
          )}
        </button>
      ))}
      {selected && (
        <section>
          <h3>{selected.title}</h3>
          {selected.updatedAt && (
            <p className="muted small-text">
              Updated{' '}
              <time dateTime={selected.updatedAt} title="File modification time on this device">
                {dateTime(selected.updatedAt)}
              </time>
            </p>
          )}
          <Markdown>{selected.content}</Markdown>
        </section>
      )}
    </Modal>
  );
}
