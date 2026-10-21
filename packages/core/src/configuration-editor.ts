import type { z } from 'zod';
import { ImportSchema, ConfigPreviewSchema } from './client-schemas.js';
import { ConfigurationEditorViewSchema, ConfigurationImportViewSchema, CONFIGURATION_EXPORT_FILENAME } from './configuration-editor-schemas.js';
import { exportConfiguration } from './configuration.js';
import { stableJson } from './files.js';
import type { ConfigRevision, Configuration } from './schemas.js';
import type { DeviceRosterSchema } from './mesh-schemas.js';

export function configurationEditorView(history: readonly ConfigRevision[], roster: z.infer<typeof DeviceRosterSchema>) {
  if (!history.length) throw Object.assign(new Error('Configuration history is unavailable. Reload and try again.'), { status: 409 });
  const sources: Record<ConfigRevision['changedBy']['source'], string> = { ui: 'Settings', improver: 'Jev', install: 'Installation' };
  const rows = [...history].sort((a, b) => b.revision - a.revision).map(row => ({ schema: 'configuration-revision-row-v1', revision: row.revision, label: `Revision ${row.revision}`, at: row.at,
    deviceLabel: roster.devices.find(device => device.device.id === row.changedBy.deviceId)?.device.name ?? row.changedBy.deviceId, sourceLabel: sources[row.changedBy.source], source: row.changedBy.source }));
  return ConfigurationEditorViewSchema.parse({ schema: 'configuration-editor-v1', revision: rows[0]!.revision, rows, title: 'Configuration', intro: 'One configuration for every device. Each saved change creates a revision.', historyTitle: 'Revisions',
    yaml: { readPath: '/api/config/yaml', downloadPath: '/hub/config/export', downloadName: CONFIGURATION_EXPORT_FILENAME, showLabel: 'View YAML', hideLabel: 'Hide YAML', title: 'Current YAML' },
    import: { previewPath: '/api/config/import-preview', openLabel: 'Import', title: 'Import configuration', sourceLabel: 'YAML', validateLabel: 'Validate and show diff', cancelLabel: 'Cancel', applyLabel: 'Apply import', maxLength: ImportSchema.shape.yaml.maxLength } });
}
function changedConfigurationPaths(before: unknown, after: unknown, path = ''): string[] {
  if (stableJson(before) === stableJson(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => changedConfigurationPaths(a[key], b[key], `${path}/${key}`));
  }
  return [path || '/'];
}
export function configurationImportView(current: ConfigRevision, proposed: Configuration) {
  const changedPaths = changedConfigurationPaths(current.configuration, proposed);
  const preview = ConfigPreviewSchema.parse({ schema: 'config-preview-v1', revision: current.revision, configuration: proposed, before: exportConfiguration(current.configuration), after: exportConfiguration(proposed), changedPaths });
  return ConfigurationImportViewSchema.parse({ schema: 'configuration-import-view-v1', preview, heading: changedPaths.length ? 'Changes to apply' : 'No changes', canApply: changedPaths.length > 0, savedNotice: 'Configuration imported.',
    write: changedPaths.length ? { schema: 'configuration-write-plan-v1', path: '/hub/config', method: 'PUT', body: { schema: 'config-write-v1', revision: current.revision, configuration: proposed } } : null });
}
