import { capLines } from '@jevellan/projects';
import { OwnerRefusal, type OwnerContext, type OwnerHandler } from '../owner-tools.js';

const yesNo = (value: boolean) => value ? 'yes' : 'no';
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
    const old = tools.projectSettings(project.id).deploy.debounceMinutes; tools.updateProjectSettings(project.id, settings => ({ ...settings, deploy: { ...settings.deploy, debounceMinutes: minutes } }));
    return { old: String(old), new: String(minutes) };
  },
  'night.catchUpHours': async ({ tools, project }, _key, value) => {
    const hours = Number(value); if (!Number.isInteger(hours) || hours < 0 || hours > 12) throw new OwnerRefusal('night.catchUpHours must be a whole number from 0 to 12.', 'invalid_value');
    const old = tools.projectSettings(project.id).night.catchUpHours; tools.updateProjectSettings(project.id, settings => ({ ...settings, night: { ...settings.night, catchUpHours: hours } }));
    return { old: String(old), new: String(hours) };
  },
  'heartbeat.url': async ({ tools }, _key, value) => {
    const url = String(value); if (url && url !== 'none' && !/^https:\/\/\S+$/u.test(url)) throw new OwnerRefusal('heartbeat.url must be an https address, or none.', 'invalid_value');
    const old = tools.installationSettings().heartbeat.url; tools.updateInstallationSettings(settings => ({ ...settings, heartbeat: { ...settings.heartbeat, url: url && url !== 'none' ? url : null } }));
    return { old: old ? 'set' : 'none', new: url && url !== 'none' ? 'set' : 'none', consequence: url && url !== 'none' ? `The state point calls it every ${tools.installationSettings().heartbeat.intervalMinutes} minutes.` : 'No heartbeat is sent.' };
  },
  'deploy.paused': async ({ tools, project }, _key, value) => {
    const paused = value === true || value === 'true' || value === 'yes'; if (!paused && !(value === false || value === 'false' || value === 'no')) throw new OwnerRefusal('deploy.paused must be true or false.', 'invalid_value');
    const old = tools.projectSettings(project.id).deploy.paused; tools.updateProjectSettings(project.id, settings => ({ ...settings, deploy: { ...settings.deploy, paused } }));
    return { old: String(old), new: String(paused), consequence: paused ? 'No deploy runs until you turn this off; the deploy message keeps updating.' : 'Deploys can run again.' };
  },
};

/** `config` (bridge specification). */
export const config: OwnerHandler = async (context) => {
  const { args } = context;
  switch (context.action) {
    case 'get': {
      const all = await sections(context); const wanted = typeof args.section === 'string' ? args.section : undefined;
      if (wanted && !(wanted in all)) throw new OwnerRefusal(`section must be one of ${Object.keys(all).join(', ')}.`, 'invalid_section');
      return { text: capLines(Object.entries(all).filter(([name]) => !wanted || name === wanted).map(([name, line]) => `${name}: ${line}`)), data: all };
    }
    case 'set': {
      const section = String(args.section); const key = String(args.key); const setter = SETTERS[`${section}.${key}`];
      if (!setter) {
        const known = Object.keys(await sections(context));
        if (!known.includes(section)) throw new OwnerRefusal(`section must be one of ${known.join(', ')}.`, 'invalid_section');
        throw new OwnerRefusal(`${section}.${key} can't be changed through config in this version. Keys that can: ${Object.keys(SETTERS).join(', ')}.`, 'not_settable');
      }
      const result = await setter(context, key, args.value as string | number | boolean);
      return { text: `Changed ${section}.${key} from ${result.old} to ${result.new}.${result.consequence ? ` ${result.consequence}` : ''}` };
    }
  }
  throw new OwnerRefusal(`config ${context.action} is not available in this version yet.`, 'not_available', 501);
};
export { SETTERS as CONFIG_SETTERS };

const withoutIdentity = <T extends { schema?: unknown; projectId?: unknown; revision?: unknown }>(value: T) => { const { schema: _s, projectId: _p, revision: _r, ...rest } = value; void _s; void _p; void _r; return rest; };
