import type { z } from 'zod';
import { ProjectSchema, globalThreadLimit, type ConfigRevision } from './schemas.js';
import { ProjectWriteSchema, type ProjectViewSchema } from './conversation-schemas.js';
import { vaultFolder, type VaultView } from './vault-schemas.js';
import { GlobalThreadLimitEditorSchema, GlobalThreadLimitSaveSchema, ProjectDefinitionEditorSchema, ProjectDefinitionFieldsSchema, ProjectDefinitionCommandSchema, ProjectDefinitionsViewSchema, ProjectVaultPresentationSchema, type ProjectDefinitionCommand, type ProjectDefinitionFields, type ProjectDefinitionPreviewSchema } from './project-definition-schemas.js';
const folderName = (path: string) => path.replace(/\/+$/, '').split('/').at(-1) ?? '';
/** Shared deterministic draft commands; raw input handling stays with the client. The save prepares again on the engine. */
export function projectDefinitionCommand(raw: ProjectDefinitionFields, command: ProjectDefinitionCommand, deviceIds: string[], currentDeviceId: string) {
  const fields = ProjectDefinitionFieldsSchema.parse(structuredClone(raw)), input = ProjectDefinitionCommandSchema.parse(command);
  if (input.type === 'name') { fields.name = input.value; fields.nameFollowsFolder = !input.value.trim(); }
  else if (input.type === 'path') { fields.paths[input.deviceId] = input.value; if (input.deviceId === currentDeviceId && (fields.nameFollowsFolder || !fields.name.trim())) fields.name = folderName(input.value); }
  else if (input.type === 'branch-policy') { fields.branchPolicy = input.value; if (fields.memory.mode !== 'hub') fields.memory.mode = input.value === 'main' ? 'repo' : 'device'; }
  else if (input.type === 'github-token') fields.requireProjectToken = input.checked;
  else { const allowed = fields.allowedDevices ?? deviceIds; fields.allowedDevices = input.checked ? [...new Set([...allowed, input.deviceId])] : allowed.filter(id => id !== input.deviceId); }
  return fields;
}
export function projectDefinitionDeviceRows(fields: ProjectDefinitionFields, devices: { id: string; name: string }[], currentDeviceId: string) {
  return devices.map(device => ({ id: device.id, name: device.name, required: device.id === currentDeviceId, checked: fields.allowedDevices === null || fields.allowedDevices.includes(device.id) }));
}
export function projectDefinitionFields(project: z.infer<typeof ProjectSchema> | null, deviceId: string) {
  return ProjectDefinitionFieldsSchema.parse({ name: project?.name ?? '', nameFollowsFolder: !project, remoteUrl: project?.remoteUrl ?? '', testCommand: project?.testCommand ?? '', paths: project?.paths ?? { [deviceId]: '' }, branchPolicy: project?.branchPolicy ?? 'main', memory: project?.memory ?? { mode: 'hub', dir: '.jevellan/memory' }, requireProjectToken: project?.githubTokenScope === 'project', allowedDevices: project?.allowedDevices ?? null, createContext: true, restore: true });
}
export function projectDefinitionEditor(input: z.infer<typeof ProjectDefinitionPreviewSchema>, options: { current: z.infer<typeof ProjectViewSchema> | null; deviceId: string; devices: { id: string; name: string }[]; vault: VaultView | null; receiptRetry?: boolean }) {
  const context = input.context, fields = input.command ? projectDefinitionCommand(input.fields, input.command, options.devices.map(row => row.id), options.deviceId) : ProjectDefinitionFieldsSchema.parse(input.fields), validation: string[] = [];
  if (!options.receiptRetry && (context.mode === 'create' ? !!options.current : options.current?.revision !== context.revision)) validation.push('Project settings changed elsewhere. Your draft is preserved. Reload before saving.');
  const paths = Object.fromEntries(Object.entries(fields.paths).filter(([, path]) => path.trim()));
  if (!paths[options.deviceId]) validation.push('Choose a project folder on this device.');
  const value = ProjectWriteSchema.safeParse({ schema: 'project-write-v1', revision: context.revision, createContext: context.mode === 'create' && fields.createContext, project: { schema: 'project-v1', id: context.projectId, name: fields.name.trim() || folderName(paths[options.deviceId] ?? ''), paths, branchPolicy: fields.branchPolicy, memory: fields.memory, context: context.projectContext, githubTokenScope: fields.requireProjectToken ? 'project' : 'shared', ...(fields.remoteUrl ? { remoteUrl: fields.remoteUrl } : {}), ...(fields.testCommand ? { testCommand: fields.testCommand } : {}), ...(fields.allowedDevices === null ? {} : { allowedDevices: fields.allowedDevices }) } });
  if (!value.success) validation.push(...value.error.issues.map(issue => issue.message));
  const folder = vaultFolder(fields.remoteUrl), restorable = context.mode === 'create' && !!folder && options.vault?.folders.includes(folder) === true;
  return ProjectDefinitionEditorSchema.parse({ schema: 'project-definition-editor-v1', currentDeviceId: options.deviceId, context, fields, devices: projectDefinitionDeviceRows(fields, options.devices, options.deviceId), canSave: validation.length === 0, validation,
    title: context.mode === 'create' ? 'Add project' : `Edit ${options.current?.project.name ?? fields.name}`, showCreateContext: context.mode === 'create', showMainNotice: fields.branchPolicy === 'main', showMemoryDirectory: fields.memory.mode !== 'hub', publicMemoryNotice: fields.memory.mode !== 'hub' && context.reference.public && fields.paths[options.deviceId] === context.reference.localPath && fields.remoteUrl === context.reference.remoteUrl,
    restorable, restoreText: `Settings, goals, jobs, the notebook and project memory come back from ${folder ?? ''}. This device becomes its only device.`,
    branchChoices: [{ value: 'main', label: 'Work on main' }, { value: 'external', label: 'Leave git to me' }], memoryChoices: [{ value: 'hub', label: 'Shared on the hub' }, { value: 'repo', label: 'In the repository, synced through git' }, { value: 'device', label: 'On each device only' }],
    plan: validation.length === 0 && value.success ? { path: '/hub/projects', method: 'PUT', body: value.data, restorePath: restorable && fields.restore ? `/api/projects/${context.projectId}/vault-restore` : null } : null,
  });
}
export function globalThreadLimitEditor(revision: ConfigRevision) {
  const range = globalThreadLimit.removeDefault();
  return GlobalThreadLimitEditorSchema.parse({ schema: 'global-thread-limit-editor-v1', revision: revision.revision, title: 'Running threads across all projects', help: 'One limit shared by every project and device. Threads wait for a free slot.', savedNotice: 'Settings saved.', input: { label: 'Maximum running threads', value: revision.configuration['x-jevellan'].maxRunningThreadsAll, min: range.minValue, max: range.maxValue, step: 1 }, write: { path: '/api/config/limits', method: 'PUT', body: { schema: 'global-thread-limit-save-v1', revision: revision.revision } } });
}
export function normalizeGlobalThreadLimit(revision: ConfigRevision, raw: unknown) {
  const input = GlobalThreadLimitSaveSchema.parse(raw), value = typeof input.value === 'string' && input.value.trim() ? Number(input.value) : input.value;
  const configuration = structuredClone(revision.configuration); configuration['x-jevellan'].maxRunningThreadsAll = globalThreadLimit.parse(value); return configuration;
}
export function projectVaultPresentation(vault: VaultView) { return ProjectVaultPresentationSchema.parse({ schema: 'project-vault-presentation-v1', label: vault.lastError ? 'Not synced' : vault.pending ? 'Changes waiting' : vault.remote ? 'Synced' : 'Local only', blocked: !!vault.lastError, remoteLine: vault.remote ?? 'None yet: save a GitHub token in Settings → Git.', lastSyncAt: vault.lastSyncAt, lastError: vault.lastError }); }
export function projectDefinitionsView(rows: { view: z.infer<typeof ProjectViewSchema>; public: boolean }[], deviceId: string, vault: VaultView | null) {
  return ProjectDefinitionsViewSchema.parse({ schema: 'project-definitions-view-v1', currentDeviceId: deviceId, projects: rows.map(({ view, public: isPublic }) => {
    const project = view.project, path = project.paths[deviceId];
    return { schema: 'project-definition-row-v1', view, checkedOutHere: !!path, path: path ?? 'Not checked out on this device', canContext: !!path, publicMemoryNotice: isPublic, chips: [{ label: project.branchPolicy === 'main' ? 'Work on main' : 'Leave git to me', tone: 'normal' }, { label: project.memory.mode === 'hub' ? 'Shared hub memory' : project.memory.mode === 'repo' ? 'Memory in repository' : 'Memory on each device', tone: 'normal' }, ...(project.testCommand ? [{ label: project.testCommand, tone: 'dim' }] : []), ...(project.context.state === 'needs-decision' ? [{ label: 'Context needs a decision', tone: 'blocked' }] : [])] };
  }), vault: vault ? projectVaultPresentation(vault) : null });
}
