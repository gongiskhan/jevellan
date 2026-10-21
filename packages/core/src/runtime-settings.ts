import type { z } from 'zod';
import { ConfigurationSchema, RuntimeConfigurationSchema, type ConfigRevision } from './schemas.js';
import type { NativeSetupInventorySchema } from './native-setup-schemas.js';
import { RuntimeSettingsEditorSchema, RuntimeSettingsSaveSchema, defaultRuntimeCacheWindow } from './runtime-settings-schemas.js';

export function runtimeSettingsEditor(revision: ConfigRevision, runtimes: { id: string; displayName: string; nativeSetup?: z.infer<typeof NativeSetupInventorySchema> }[]) {
  const range = RuntimeConfigurationSchema.shape.cacheWindowMinutes.unwrap();
  return RuntimeSettingsEditorSchema.parse({ schema: 'runtime-settings-editor-v1', revision: revision.revision, rows: runtimes.map(runtime => {
    const settings = revision.configuration['x-jevellan'].runtimes[runtime.id];
    return { schema: 'runtime-settings-row-v1', id: runtime.id, enabled: { label: 'Enabled', ariaLabel: `Enable ${runtime.displayName}`, checked: settings?.enabled === true },
      cache: { label: 'Cache window (minutes)', ariaLabel: `${runtime.displayName} cache window (minutes)`, value: settings?.cacheWindowMinutes ?? defaultRuntimeCacheWindow(runtime.id), min: range.minValue, max: range.maxValue, step: 1 },
      ownSetup: runtime.nativeSetup ? { label: `Use my own ${runtime.displayName} setup`, checked: settings?.useOwnSetup !== false,
        help: `Sessions use the skills, agents, commands, plugins, MCP servers and instructions from your own ${runtime.displayName} setup on each device. Jevellan only reads them. Permissions, logins and model choices stay with Jevellan.`, inventoryTitle: 'Applied from this device',
        lines: runtime.nativeSetup.items.map(item => `${item.applied ? 'Applied from' : 'Not applied'} ${item.path} · ${item.item}${item.reason ? ` · ${item.reason}` : ''}`) } : null,
      savedNotice: 'Settings saved.', write: { schema: 'runtime-settings-write-plan-v1', path: '/api/config/runtimes', method: 'PUT', body: { schema: 'runtime-settings-save-v1', revision: revision.revision, runtime: runtime.id } } };
  }) });
}
export function normalizeRuntimeSettings(revision: ConfigRevision, raw: unknown) {
  const input = RuntimeSettingsSaveSchema.parse(raw), configuration = structuredClone(revision.configuration), settings = configuration['x-jevellan'].runtimes[input.runtime] ?? { enabled: false };
  const cache = input.patch.cacheWindowMinutes;
  const cacheWindowMinutes = cache === undefined ? undefined : RuntimeConfigurationSchema.shape.cacheWindowMinutes.unwrap().parse(typeof cache === 'string' ? Number(cache.trim()) : cache);
  configuration['x-jevellan'].runtimes[input.runtime] = RuntimeConfigurationSchema.parse({ ...settings, ...input.patch, ...(cacheWindowMinutes === undefined ? {} : { cacheWindowMinutes }) });
  return ConfigurationSchema.parse(configuration);
}
