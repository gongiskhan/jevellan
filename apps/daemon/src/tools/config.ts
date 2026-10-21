import { ProjectRoutineSettingsSaveSchema, ProjectWorkSettingsSchema, ProjectWorkSettingsRequestSchema } from '@jevellan/core';
import { capLines, projectRoutineJobChoices, projectRoutineSettings, settingsEditorRigging } from '@jevellan/projects';
import { OwnerRefusal, type OwnerContext, type OwnerHandler } from '../owner-tools.js';
import { ownerCoordinatorEditorSave } from '../project-work-api.js';
import { ProjectSettingsUndoRequestSchema } from '@jevellan/core';
import { ProjectSettingsEditorSchema } from '@jevellan/core';

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
    case 'settings_editor': {
      const { app, project } = context, base = await app.projectWork.settingsEditor(project.id);
      const [routines, secretStates, rigging] = await Promise.all([routineView(context), Promise.all(base.settingsView.settings.environment.secrets.map(name => app.state.environment.summary(project.id, name))), app.rigging.list()]);
      return { text: 'Project settings.', data: ProjectSettingsEditorSchema.parse({ ...base, schema: 'project-settings-editor-v1', routines, secretStates, rigging: settingsEditorRigging(project.id, rigging) }) };
    }
    case 'settings_save': {
      const data = await context.app.projectWork.saveSettingsEditor(context.project.id, args.request);
      return { text: data.secretSteps.length ? `Project settings saved; ${data.secretSteps.length} secret changes remain.` : data.savedNotice, data };
    }
    case 'remove_secret': {
      const name = String(args.name); await context.app.state.environment.remove(context.project.id, name); return { text: `Removed ${name}.` };
    }
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
