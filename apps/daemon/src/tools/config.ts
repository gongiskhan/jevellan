import {projectHealthEditor} from '../project-health-editor.js';
import { ekoaEditor, prepareEkoaEditorSave } from '@jevellan/core';
import { settingsNavigation, nativeConversationPolicy } from '@jevellan/core';
import { ProjectRoutineSettingsSaveSchema, ProjectWorkSettingsSchema, ProjectWorkSettingsRequestSchema, NotificationBrowserFactsSchema } from '@jevellan/core';
import { capLines, projectRoutineJobChoices, projectRoutineSettings, settingsEditorRigging, environmentSecretSummary, notificationEditor, projectNotificationInfo } from '@jevellan/projects';
import { OwnerRefusal, type OwnerContext, type OwnerHandler } from '../owner-tools.js';
import { ownerCoordinatorEditorSave } from '../project-work-api.js';
import { ProjectSettingsUndoRequestSchema } from '@jevellan/core';
import { ProjectSettingsEditorSchema } from '@jevellan/core';
import { deviceAboutView } from '@jevellan/mesh';
import { nativeConnectionsDeviceOperation } from '../native-connection-device.js';

const yesNo = (value: boolean) => value ? 'yes' : 'no';
async function routineView({ app, tools, project }: OwnerContext) {
  const [jobs, missed] = await Promise.all([app.projectWork.daily.jobs(project.id), tools.missedNights(project.id, 7)]), state = tools.routineSettingsState(project.id);
  return projectRoutineSettings(project.id, jobs, state.owner, state.revision, missed);
}
type Setter = (context: OwnerContext, key: string, value: string | number | boolean) => Promise<{ old: string; new: string; consequence?: string }>;

/** Every section `config get` prints, one line each (bridge specification, `config`). */
async function sections(context: OwnerContext): Promise<Record<string, string>> {
  const { app, tools, project } = context; const view = await app.projectWork.view(project.id); const settings = view.settings;
  const owner = tools.projectSettings(project.id); const installation = tools.installationSettings();
  const configuration = (await app.configuration()).configuration['x-jevellan'];
  const accounts = await app.accounts.list();
  const cleanup = configuration.cleanup as Record<string, unknown>;
  const pushKinds = Object.entries(owner.push.kinds).filter(([, on]) => on === false).map(([kind]) => kind);
  return {
    accounts: accounts.length ? accounts.map(row => `${row.account.label} budget ${row.account.ceilingPct ?? 90}%${row.account.enabled === false ? ' (disabled)' : ''}`).join(' · ') : 'none',
    limits: `maxRunningThreadsAll ${configuration.maxRunningThreadsAll} · maxRunningThreads ${settings.maxRunningThreads}`,
    deploy: `mode ${settings.deploy.mode} · paused ${yesNo(owner.deploy.paused)} · debounce ${owner.deploy.debounceMinutes} min`,
    routines: `nightlyWindow ${settings.nightlyWindow.enabled ? `${settings.nightlyWindow.time} ${settings.nightlyWindow.timezone}` : 'off'} · refill ${settings.refill.enabled ? `every ${settings.refill.minIntervalMinutes} min` : 'off'}`,
    landing: `delivery ${settings.delivery} · autoLand ${yesNo(settings.autoLand)} · landingChecks ${settings.landingChecks.length} · smokeCheck ${settings.smokeCheck ? 'set' : 'none'} · mergeCommitPaths ${settings.mergeCommitPaths.length ? settings.mergeCommitPaths.join(', ') : 'none'}`,
    health: settings.healthChecks.length ? settings.healthChecks.map(check => `${check.name}${check.enabled === false ? ' (disabled)' : ''}`).join(' · ') : 'no checks',
    coordinator: `model ${settings.coordinator.modelId ?? 'automatic'} · effort ${settings.coordinator.effort} · coordinatorHandoffAtPercent ${settings.coordinatorHandoffAtPercent}`,
    notifications: `level ${settings.notifications.level} · quietHours ${settings.notifications.quietHours.enabled ? `on, ${settings.notifications.quietHours.start} to ${settings.notifications.quietHours.end}` : 'off'}`,
    push: `transport ${owner.push.transport} · batchSeconds ${owner.push.batchSeconds} · ${pushKinds.length ? `off: ${pushKinds.join(', ')}` : 'every kind on'}`,
    bridge: `account ${owner.bridge.account} · ${owner.bridge.wanted ? 'wanted' : 'not started'}`,
    cleanup: Object.entries(cleanup).filter(([key]) => key !== 'schema').map(([key, value]) => `${key} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · '),
    remote: `enabled ${yesNo(installation.remote.enabled)} · writeEnabled ${yesNo(installation.remote.writeEnabled)} · hostname ${installation.remote.hostname ?? 'none'}`,
    heartbeat: `url ${installation.heartbeat.url ? 'set' : 'none'} · intervalMinutes ${installation.heartbeat.intervalMinutes}`,
  };
}

/** Setters for keys whose engine change exists in this version; each returns old and new values and the consequence. */
const SETTERS: Record<string, Setter> = {
  'push.transport': async ({ tools, project }, _key, value) => {
    if (!['channel', 'inject', 'none'].includes(String(value))) throw new OwnerRefusal('push.transport must be channel, inject or none.', 'invalid_value');
    const old = tools.projectSettings(project.id).push.transport; tools.updateProjectSettings(project.id, settings => ({ ...settings, push: { ...settings.push, transport: String(value) as 'channel' | 'inject' | 'none' } }));
    return { old, new: String(value), consequence: 'The bridge uses it from its next start (jevellan bridge --restart).' };
  },
  'push.batchSeconds': async ({ tools, project }, _key, value) => {
    const seconds = Number(value); if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) throw new OwnerRefusal('push.batchSeconds must be a whole number from 10 to 3600.', 'invalid_value');
    const old = tools.projectSettings(project.id).push.batchSeconds; tools.updateProjectSettings(project.id, settings => ({ ...settings, push: { ...settings.push, batchSeconds: seconds } }));
    return { old: String(old), new: String(seconds) };
  },
  'bridge.account': async ({ app, tools, project }, _key, value) => {
    const label = String(value); const accounts = await app.accounts.list();
    if (!accounts.some(row => row.account.label === label && row.account.runtime === 'claude')) throw new OwnerRefusal(`bridge.account must be a Claude account: ${accounts.filter(row => row.account.runtime === 'claude').map(row => row.account.label).join(', ') || 'none'}.`, 'invalid_value');
    const old = tools.projectSettings(project.id).bridge.account; tools.updateProjectSettings(project.id, settings => ({ ...settings, bridge: { ...settings.bridge, account: label } }));
    return { old, new: label, consequence: 'Restart the bridge to use it: jevellan bridge --restart.' };
  },
  'deploy.mode': async ({ app, project }, _key, value) => {
    const mode = String(value); if (!['approve', 'nightly', 'automatic'].includes(mode)) throw new OwnerRefusal('deploy.mode must be approve, nightly or automatic.', 'invalid_value');
    const view = await app.projectWork.settingsView(project.id); const old = view.settings.deploy.mode;
    await app.projectWork.putSettings(project.id, { schema: 'project-work-settings-request-v1', revision: view.settings.revision, settings: { ...withoutIdentity(view.settings), deploy: { ...view.settings.deploy, mode: mode as 'approve' } } } as never);
    const consequence = mode === 'nightly' ? 'From tonight, production deploys run after the night\'s full suite passes.' : mode === 'automatic' ? 'Production deploys now run after the night\'s full suite passes and after each landing settles.' : 'Production deploys wait for your approval again.';
    return { old, new: mode, consequence: `${consequence} Deploys that change the database still wait for your approval.` };
  },
  'deploy.debounceMinutes': async ({ tools, project }, _key, value) => {
    const minutes = Number(value); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw new OwnerRefusal('deploy.debounceMinutes must be a whole number from 1 to 30.', 'invalid_value');
    const old = tools.projectSettings(project.id).deploy.debounceMinutes; tools.patchRoutineSettings(project.id, { debounceMinutes: minutes });
    return { old: String(old), new: String(minutes) };
  },
  'night.catchUpHours': async ({ tools, project }, _key, value) => {
    const hours = Number(value); if (!Number.isInteger(hours) || hours < 0 || hours > 12) throw new OwnerRefusal('night.catchUpHours must be a whole number from 0 to 12.', 'invalid_value');
    const old = tools.projectSettings(project.id).night.catchUpHours; tools.patchRoutineSettings(project.id, { catchUpHours: hours });
    return { old: String(old), new: String(hours) };
  },
  'heartbeat.url': async ({ tools }, _key, value) => {
    const url = String(value); if (url && url !== 'none' && !/^https:\/\/\S+$/u.test(url)) throw new OwnerRefusal('heartbeat.url must be an https address, or none.', 'invalid_value');
    const old = tools.installationSettings().heartbeat.url; tools.updateInstallationSettings(settings => ({ ...settings, heartbeat: { ...settings.heartbeat, url: url && url !== 'none' ? url : null } }));
    return { old: old ? 'set' : 'none', new: url && url !== 'none' ? 'set' : 'none', consequence: url && url !== 'none' ? `The state point calls it every ${tools.installationSettings().heartbeat.intervalMinutes} minutes.` : 'No heartbeat is sent.' };
  },
  'remote.enabled': async ({ tools }, _key, value) => {
    const on = value === true || value === 'true'; const old = tools.installationSettings().remote.enabled;
    tools.updateInstallationSettings(settings => ({ ...settings, remote: { ...settings.remote, enabled: on } }));
    return { old: String(old), new: String(on), consequence: on ? 'The remote endpoint answers through its tunnel.' : 'Every remote call is refused from now on.' };
  },
  'remote.writeEnabled': async ({ tools }, _key, value) => {
    const on = value === true || value === 'true'; const old = tools.installationSettings().remote.writeEnabled;
    tools.updateInstallationSettings(settings => ({ ...settings, remote: { ...settings.remote, writeEnabled: on } }));
    return { old: String(old), new: String(on), consequence: on ? 'Remote callers can change things; deploys and rollbacks stay refused remotely.' : 'Remote callers can read and answer waiting items only.' };
  },
  'remote.hostname': async ({ tools }, _key, value) => {
    const hostname = String(value).toLowerCase(); if (!/^[a-z0-9.-]{3,253}$/u.test(hostname) || !hostname.includes('.')) throw new OwnerRefusal('remote.hostname must be a host name like mcp.example.com.', 'invalid_value');
    const old = tools.installationSettings().remote.hostname; tools.updateInstallationSettings(settings => ({ ...settings, remote: { ...settings.remote, hostname } }));
    return { old: old ?? 'none', new: hostname, consequence: 'Run jevellan remote setup for the tunnel configuration.' };
  },
  'remote.allowedIdentity': async ({ tools }, _key, value) => {
    const identity = String(value); if (!/^[A-Za-z0-9-]{1,39}$/u.test(identity)) throw new OwnerRefusal('remote.allowedIdentity must be a GitHub login.', 'invalid_value');
    const old = tools.installationSettings().remote.allowedIdentity; tools.updateInstallationSettings(settings => ({ ...settings, remote: { ...settings.remote, allowedIdentity: identity } }));
    return { old: old ?? 'none', new: identity };
  },
  'deploy.paused': async ({ tools, project }, _key, value) => {
    const paused = value === true || value === 'true' || value === 'yes'; if (!paused && !(value === false || value === 'false' || value === 'no')) throw new OwnerRefusal('deploy.paused must be true or false.', 'invalid_value');
    const old = tools.projectSettings(project.id).deploy.paused; tools.patchRoutineSettings(project.id, { deployPaused: paused });
    return { old: String(old), new: String(paused), consequence: paused ? 'No deploy runs until you turn this off; the deploy message keeps updating.' : 'Deploys can run again.' };
  },
};

const nightly = ProjectWorkSettingsSchema.shape.nightlyWindow.removeDefault().shape, refill = ProjectWorkSettingsSchema.shape.refill.removeDefault().shape;
const routineFields = [
  ['nightlyWindow.enabled', 'nightlyWindow', 'enabled', nightly.enabled, 'boolean'], ['nightlyWindow.time', 'nightlyWindow', 'time', nightly.time, 'string'],
  ['nightlyWindow.timezone', 'nightlyWindow', 'timezone', nightly.timezone, 'string'], ['refill.enabled', 'refill', 'enabled', refill.enabled, 'boolean'],
  ['refill.minIntervalMinutes', 'refill', 'minIntervalMinutes', refill.minIntervalMinutes, 'number'],
] as const;
for (const [key, group, field, schema, kind] of routineFields) SETTERS[`routines.${key}`] = async ({ app, project }, _key, value) => {
  let raw: unknown = value;
  if (kind === 'boolean') {
    if (value === true || value === 'true' || value === 'yes') raw = true;
    else if (value === false || value === 'false' || value === 'no') raw = false;
    else throw new OwnerRefusal(`routines.${key} must be true or false.`, 'invalid_value');
  } else if (kind === 'number') raw = Number(value);
  const parsed = schema.safeParse(raw); if (!parsed.success) throw new OwnerRefusal(parsed.error.issues[0]?.message ?? 'Choose a valid routine setting.', 'invalid_value');
  const view = await app.projectWork.settingsView(project.id), settings = view.settings, previous = settings[group];
  const old = (previous as Record<string, unknown>)[field];
  await app.projectWork.putSettings(project.id, ProjectWorkSettingsRequestSchema.parse({ schema: 'project-work-settings-request-v1', revision: settings.revision,
    settings: { ...withoutIdentity(settings), [group]: { ...previous, [field]: parsed.data } } }));
  return { old: String(old), new: String(parsed.data) };
};
for (const key of ['jobId', 'desktopJobId', 'suiteJobId'] as const) SETTERS[`deploy.${key}`] = async ({ app, project }, _key, value) => {
  if (typeof value !== 'string') throw new OwnerRefusal(`deploy.${key} must be a command job id or none.`, 'invalid_value');
  const selected = value === 'none' ? '' : value, jobs = await app.projectWork.daily.jobs(project.id);
  const choice = projectRoutineJobChoices(project.id, jobs, key).find(row => row.value === selected);
  if (!choice) throw new OwnerRefusal(`deploy.${key} must be a command job of this project, or none.`, 'invalid_value');
  const view = await app.projectWork.settingsView(project.id), settings = view.settings;
  await app.projectWork.putSettings(project.id, ProjectWorkSettingsRequestSchema.parse({ schema: 'project-work-settings-request-v1', revision: settings.revision,
    settings: { ...withoutIdentity(settings), deploy: { ...settings.deploy, ...choice.patch } } }));
  return { old: settings.deploy[key] ?? 'none', new: selected || 'none' };
};

/** `accounts.<label>.budgetPercent` and `accounts.<label>.enabled`. */
const accountSetter: Setter = async (context, key, value) => {
  const [label, field] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)];
  if (!['budgetPercent', 'enabled'].includes(field)) throw new OwnerRefusal('accounts keys are <label>.budgetPercent or <label>.enabled.', 'invalid_key');
  const account = await context.app.ownerLogins.account(label);
  const budget = field === 'budgetPercent' ? Number(value) : account.account.ceilingPct ?? 90;
  if (!Number.isInteger(budget) || budget < 1 || budget > 100) throw new OwnerRefusal(`accounts.${label}.budgetPercent must be a whole number from 1 to 100.`, 'invalid_value');
  const enabled = field === 'enabled' ? value === true || value === 'true' : account.account.enabled !== false;
  await context.app.accounts.update(account.account.id, { schema: 'update-account-v1', revision: account.revision, label: account.account.label, enabled, ceilingPct: budget });
  return field === 'budgetPercent' ? { old: String(account.account.ceilingPct ?? 90), new: String(budget), consequence: `New work stops using ${account.account.label} at ${budget}% of its limits.` }
    : { old: String(account.account.enabled !== false), new: String(enabled) };
};

/** `config` (bridge specification). */
export const config: OwnerHandler = async (context) => {
  const { args } = context;
  switch (context.action) {
    case 'native_policy': return { text: 'Native conversation policy.', data: nativeConversationPolicy() };
    case 'native_connections_editor': case 'native_connections_command': {
      const deviceId = context.request.deviceId ?? context.app.device.deviceId;
      return { text: context.action === 'native_connections_editor' ? 'Native session connections.' : 'Connection settings saved.',
        data: await nativeConnectionsDeviceOperation(context.app, deviceId, { schema: 'native-connections-operation-v1', deviceId,
          ...(context.action === 'native_connections_editor' ? { operation: 'read' } : { operation: 'command', request: args.request }) }) };
    }
    case 'setup_view': return { text: 'Suggested setup.', data: await context.app.projectWork.setupView(context.project.id, String(args.proposal)) };
    case 'mirror_editor': return { text: 'Task mirror settings.', data: ekoaEditor(context.app.ekoa!.state()) };
    case 'mirror_preview': return { text: 'Task mirror settings.', data: ekoaEditor(context.app.ekoa!.state(), args.request) };
    case 'mirror_save': return { text: 'Ekoa settings saved.', data: ekoaEditor(context.app.ekoa!.save(prepareEkoaEditorSave(args.request), context.request.deviceId ?? context.app.device.deviceId)) };
    case 'navigation': return { text: 'Settings pages.', data: settingsNavigation() };
    case 'cleanup_editor': return { text: 'Cleanup settings.', data: await context.app.cleanupSettingsEditor() };
    case 'cleanup_save': return { text: 'Settings saved.', data: await context.app.saveCleanupSettings(args.request, context.request.deviceId ?? context.app.device.deviceId) };
    case 'limits_editor': return { text: 'Shared thread limit.', data: await context.app.globalThreadLimitEditor() };
    case 'limits_save': return { text: 'Settings saved.', data: await context.app.saveGlobalThreadLimit(args.request, context.request.deviceId ?? context.app.device.deviceId) };
    case 'projects_view': return { text: 'Project definitions.', data: await context.app.projectDefinitions(context.request.deviceId ?? context.app.device.deviceId) };
    case 'project_editor': return { text: 'Project editor.', data: await context.app.projectDefinitionRead({ schema: 'project-definition-read-v1', ...(args.projectId ? { projectId: args.projectId } : {}) }, context.request.deviceId ?? context.app.device.deviceId) };
    case 'project_preview': return { text: 'Project preparation.', data: await context.app.projectDefinitionPreview(args.request, false, context.request.deviceId ?? context.app.device.deviceId) };
    case 'project_save': return { text: 'Project saved.', data: await context.app.saveProjectDefinition(args.request, context.request.deviceId ?? context.app.device.deviceId) };
    case 'account_editor': return { text: 'Account editor.', data: await context.app.accountEditorRead({ schema: 'account-editor-read-v1', runtime: args.runtime, ...(args.accountId ? { accountId: args.accountId } : {}), ...(args.mode ? { mode: args.mode } : {}) }) };
    case 'account_preview': return { text: 'Account preparation.', data: await context.app.accountEditorPreview(args.request) };
    case 'account_save': return { text: 'Account saved.', data: await context.app.accountEditorSave(args.request) };
    case 'runtimes_editor': return { text: 'Runtime settings.', data: await context.app.runtimeSettings() };
    case 'runtimes_save': return { text: 'Settings saved.', data: await context.app.saveRuntimeSettings(args.request, context.request.deviceId ?? context.app.device.deviceId) };
    case 'accounts_view': return { text: 'Runtime account views.', data: await context.app.accountsSettings(context.request.deviceId ?? context.app.device.deviceId) };
    case 'configuration_editor': return { text: 'Configuration history.', data: await context.app.configurationEditor() };
    case 'configuration_yaml': return { text: 'Configuration YAML.', data: await context.app.configurationYaml() };
    case 'configuration_preview': return { text: 'Configuration import preview.', data: await context.app.configurationImportPreview({ schema: 'config-import-v1', yaml: args.yaml }) };
    case 'configuration_apply': return { text: 'Configuration imported.', data: await context.app.writeConfiguration(args.request) };
    case 'about': {
      const data = deviceAboutView(await context.app.roster(), context.request.deviceId ?? context.app.device.deviceId);
      return { text: `Jevellan ${data.currentVersion ?? 'version unavailable'}.`, data };
    }
    case 'usage': return { text: 'Project usage.', data: await context.app.projectWork.usage.view(context.project.id, args.range) };
    case 'notification_editor': case 'notification_remove': case 'notification_test': {
      const notifications = context.app.notifications;
      if (!notifications) throw new OwnerRefusal('Notification settings are unavailable here.');
      const view = context.action === 'notification_remove' ? notifications.remove(String(args.id)) : context.action === 'notification_test' ? notifications.test() : notifications.view();
      const data = notificationEditor(view, args.browser ? NotificationBrowserFactsSchema.parse(args.browser) : null);
      return { text: context.action === 'notification_test' ? data.labels.testSent : data.statusText, data };
    }
    case 'settings_editor': {
      const { app, project } = context, base = await app.projectWork.settingsEditor(project.id);
      const [routines, secretStates, rigging] = await Promise.all([routineView(context), Promise.all(base.settingsView.settings.environment.secrets.map(async name => environmentSecretSummary(await app.state.environment.summary(project.id, name)))), app.rigging.list()]);
      return { text: 'Project settings.', data: ProjectSettingsEditorSchema.parse({ ...base, schema: 'project-settings-editor-v1', routines, secretStates, rigging: settingsEditorRigging(project.id, rigging), notificationInfo: projectNotificationInfo() }) };
    }
    case 'project_setup': return { text: 'Project setup applied.', data: await context.app.projectWork.setupEkoaCode(context.project.id, args.request) };
    case 'settings_save': {
      const data = await context.app.projectWork.saveSettingsEditor(context.project.id, args.request);
      return { text: data.secretSteps.length ? `Project settings saved; ${data.secretSteps.length} secret changes remain.` : data.savedNotice, data };
    }
    case 'remove_secret': {
      const name = String(args.name); await context.app.state.environment.remove(context.project.id, name); return { text: `Removed ${name}.` };
    }
    case 'environment_editor': case 'environment_preview': return { text: 'Project environment.', data: await context.app.projectWork.environmentEditor(context.project.id, context.action === 'environment_preview' ? args.request : undefined) };
    case 'environment_save': return { text: 'Project environment settings saved.', data: await context.app.projectWork.saveEnvironmentEditor(context.project.id, args.request) };
    case 'placement_editor': case 'placement_preview': return { text: 'Project placement choices.', data: await context.app.projectWork.placementEditor(context.project.id, context.action === 'placement_preview' ? args.request : undefined) };
    case 'placement_save': return { text: 'Project placement settings saved.', data: await context.app.projectWork.savePlacementEditor(context.project.id, args.request) };
    case 'health_editor': case 'health_preview': return { text: 'Health check settings.', data: await projectHealthEditor(context.app, context.project.id, context.action === 'health_preview' ? args.request : undefined) };
    case 'landing_editor': case 'landing_preview': return { text: 'Landing settings.', data: await context.app.projectWork.landingEditor(context.project.id, context.action === 'landing_preview' ? args.request : undefined) };
    case 'landing_save': return { text: 'Landing settings saved.', data: await context.app.projectWork.saveLandingEditor(context.project.id, args.request) };
    case 'settings_change': return { text: 'Recorded settings changes.', data: await context.app.projectWork.settingsChangeView(context.project.id, args.request) };
    case 'settings_undo': return { text: 'Setting restored.', data: await context.app.projectWork.undoSetting(context.project.id, ProjectSettingsUndoRequestSchema.parse(args.request)) };
    case 'coordinator_editor': case 'coordinator_preview': {
      const data = await context.app.projectWork.coordinatorEditor(context.project.id, context.action === 'coordinator_preview' ? args.request : undefined);
      return { text: 'Coordinator choices.', data };
    }
    case 'coordinator_save': return { text: 'Coordinator choices saved. They apply from the next turn.', data: await ownerCoordinatorEditorSave(context.app, context.project.id, args.request) };
    case 'routines': case 'routines_save': {
      const { project, tools } = context;
      if (context.action === 'routines_save') {
        const input = ProjectRoutineSettingsSaveSchema.parse(args.request), fields = input.fields;
        tools.patchRoutineSettings(project.id, { deployPaused: fields.deployPaused, debounceMinutes: Number(fields.debounceMinutes), catchUpHours: Number(fields.catchUpHours) }, input.expectedRevision);
      }
      return { text: context.action === 'routines_save' ? 'Saved automation preferences.' : 'Deploy and routine settings.', data: await routineView(context) };
    }
    case 'get': {
      if (args.section === 'project') return { text: 'Project configuration.', data: await context.app.projectWork.settingsView(context.project.id) };
      const all = await sections(context); const wanted = typeof args.section === 'string' ? args.section : undefined;
      if (wanted && !(wanted in all)) throw new OwnerRefusal(`section must be one of ${[...Object.keys(all), 'project'].join(', ')}.`, 'invalid_section');
      return { text: capLines(Object.entries(all).filter(([name]) => !wanted || name === wanted).map(([name, line]) => `${name}: ${line}`)), data: all };
    }
    case 'set': {
      const section = String(args.section); const key = String(args.key); const setter = SETTERS[`${section}.${key === 'write_enabled' ? 'writeEnabled' : key}`] ?? (section === 'accounts' ? accountSetter : undefined);
      if (!setter) {
        const known = Object.keys(await sections(context));
        if (!known.includes(section)) throw new OwnerRefusal(`section must be one of ${known.join(', ')}.`, 'invalid_section');
        throw new OwnerRefusal(`${section}.${key} can't be changed through config in this version. Keys that can: ${Object.keys(SETTERS).join(', ')}.`, 'not_settable');
      }
      const result = await setter(context, key, args.value as string | number | boolean);
      return { text: `Changed ${section}.${key} from ${result.old} to ${result.new}.${result.consequence ? ` ${result.consequence}` : ''}` };
    }
    case 'secrets': {
      const names = (await context.app.projectWork.view(context.project.id)).settings.environment.secrets;
      const states = await Promise.all(names.map(async name => ({ name, saved: (await context.app.state.environment.summary(context.project.id, name)).saved })));
      const missing = states.filter(row => !row.saved).map(row => row.name);
      return { text: `Environment: ${states.length - missing.length} set, ${missing.length} not set${missing.length ? `: ${missing.join(', ')}` : ''}.` };
    }
    case 'set_secret': {
      const name = String(args.name); const view = await context.app.projectWork.settingsView(context.project.id);
      if (!view.settings.environment.secrets.includes(name)) {
        if (view.settings.environment.variables.some(variable => variable.name === name)) throw new OwnerRefusal(`${name} is a plain variable in this project. Use a new name for a secret.`, 'invalid_name');
        await context.app.projectWork.putSettings(context.project.id, { schema: 'project-work-settings-request-v1', revision: view.settings.revision,
          settings: { ...withoutIdentity(view.settings), environment: { ...view.settings.environment, secrets: [...view.settings.environment.secrets, name] } } } as never);
      }
      await context.app.state.environment.put(context.project.id, name, String(args.value));
      return { text: context.request.caller === 'cli' ? `Saved ${name}.` : `Saved ${name}. Its value is now in this conversation's transcript; the terminal prompt (jevellan secret set ${name}) keeps it out.` };
    }
    case 'add_account': {
      const label = String(args.label); const runtime = String(args.runtime);
      if ((await context.app.accounts.list()).some(row => row.account.label.toLowerCase() === label.toLowerCase())) throw new OwnerRefusal(`There is already an account ${label}.`, 'exists', 409);
      await context.app.accounts.add({ schema: 'add-account-v1', runtime, label, kind: 'subscription', ceilingPct: typeof args.budgetPercent === 'number' ? args.budgetPercent : 90 });
      return { text: `Added account ${label} (${runtime}). Log it in with login start ${label}${runtime === 'claude' ? ', and with interactive for remote control' : ''}.` };
    }
    case 'remove_account': {
      const account = await context.app.ownerLogins.account(String(args.label));
      await context.app.accounts.update(account.account.id, { schema: 'update-account-v1', revision: account.revision, label: account.account.label, enabled: false, ceilingPct: account.account.ceilingPct ?? 90 });
      return { text: `Disabled account ${account.account.label}. Accounts are never deleted, so its history stays; turn it back on with config set accounts ${account.account.label}.enabled true.` };
    }
    case 'add_health_check': case 'edit_health_check': {
      const view = await context.app.projectWork.settingsView(context.project.id); const check = args.check as { id?: string; name?: string };
      const checks = view.settings.healthChecks; const index = checks.findIndex(row => row.id === check.id || row.name === check.name);
      if (context.action === 'edit_health_check' && index < 0) throw new OwnerRefusal(`There is no health check ${check.name ?? check.id}. Checks: ${checks.map(row => row.name).join(', ') || 'none'}.`, 'not_found', 404);
      const next = context.action === 'add_health_check' ? [...checks, { id: check.id ?? `check_${Date.now().toString(36)}`, ...check }] : checks.map((row, position) => position === index ? { ...row, ...check } : row);
      await context.app.projectWork.putSettings(context.project.id, { schema: 'project-work-settings-request-v1', revision: view.settings.revision, settings: { ...withoutIdentity(view.settings), healthChecks: next } } as never);
      return { text: `${context.action === 'add_health_check' ? 'Added' : 'Changed'} the health check ${check.name ?? checks[index]?.name}. Run it with jobs health_run.` };
    }
  }
  throw new OwnerRefusal(`config ${context.action} is not available in this version yet.`, 'not_available', 501);
};
export { SETTERS as CONFIG_SETTERS };

const withoutIdentity = <T extends { schema?: unknown; projectId?: unknown; revision?: unknown }>(value: T) => { const { schema: _s, projectId: _p, revision: _r, ...rest } = value; void _s; void _p; void _r; return rest; };
