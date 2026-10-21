import { ConfigurationSchema, type ConfigRevision } from './schemas.js';
import { CleanupSettingsSchema } from './cleanup-settings-schemas.js';
import { CleanupSettingsEditorSchema, CleanupSettingsSaveSchema } from './cleanup-editor-schemas.js';
const categories = [
  { id: 'logs', label: 'Job logs and daemon logs' }, { id: 'evidence', label: 'Thread evidence and screenshots' },
  { id: 'worktrees', label: 'Worktrees of landed or resolved threads' }, { id: 'workspaces', label: 'Job workspaces' },
] as const;
export function cleanupSettingsEditor(revision: ConfigRevision) {
  const settings = revision.configuration['x-jevellan'].cleanup, retention = CleanupSettingsSchema.shape.logs.unwrap().shape, floor = CleanupSettingsSchema.shape.freeDiskFloorGb.unwrap();
  return CleanupSettingsEditorSchema.parse({ schema: 'cleanup-settings-editor-v1', revision: revision.revision,
    fields: { ...Object.fromEntries(categories.map(({ id }) => [id, { days: String(settings[id].days), maxGb: String(settings[id].maxGb) }])), freeDiskFloorGb: String(settings.freeDiskFloorGb) },
    title: 'Cleanup', intro: 'Each device checks hourly when it is idle. Oldest eligible items go first. Active work, unlanded worktrees, backups, memory, the vault, ledgers and the journal stay.', categories,
    days: { min: retention.days.minValue, max: retention.days.maxValue, step: 1 }, maxGb: { min: retention.maxGb.minValue, max: retention.maxGb.maxValue, step: 'any' }, floor: { min: floor.minValue, max: floor.maxValue, step: 'any' },
    floorTitle: 'Free disk space', floorLabel: 'Keep at least (GB) free', floorHelp: 'Below this floor, the oldest eligible items can go before their retention age.', saveLabel: 'Save cleanup settings', savedNotice: 'Settings saved.',
    write: { path: '/api/config/cleanup', method: 'PUT', body: { schema: 'cleanup-settings-save-v1', revision: revision.revision } },
  });
}
export function normalizeCleanupSettings(revision: ConfigRevision, raw: unknown) {
  const input = CleanupSettingsSaveSchema.parse(raw), configuration = structuredClone(revision.configuration);
  const numeric = (value: string | number) => {
    if (typeof value === 'string' && !value.trim()) throw Object.assign(new Error('Enter a cleanup retention value.'), { status: 400 });
    return typeof value === 'number' ? value : Number(value.trim());
  };
  const cleanup = CleanupSettingsSchema.parse({ schema: 'cleanup-settings-v1', ...Object.fromEntries(categories.map(({ id }) => [id, { days: numeric(input.fields[id].days), maxGb: numeric(input.fields[id].maxGb) }])), freeDiskFloorGb: numeric(input.fields.freeDiskFloorGb) });
  configuration['x-jevellan'].cleanup = cleanup; return ConfigurationSchema.parse(configuration);
}
