import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stableJson } from '@jevellan/core';
import { z } from 'zod';

const Port = z.number().int().min(1).max(65535);
const Hostname = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/);
export const InstalledHttpsSchema = z.strictObject({
  schema: z.literal('installed-https-v1'), hostname: Hostname, port: Port, localPort: Port, state: z.enum(['pending', 'active', 'removed']),
});
export type InstalledHttps = z.infer<typeof InstalledHttpsSchema>;
export const httpsOrigin = (route: InstalledHttps) => `https://${route.hostname}${route.port === 443 ? '' : `:${route.port}`}`;
const target = (route: InstalledHttps) => `http://127.0.0.1:${route.localPort}`;
const authority = (route: InstalledHttps) => `${route.hostname}:${route.port}`;
const ConfigSchema = z.looseObject({
  TCP: z.record(z.string(), z.json()).nullish(), Web: z.record(z.string(), z.json()).nullish(),
  AllowFunnel: z.record(z.string(), z.boolean()).nullish(), Foreground: z.record(z.string(), z.json()).nullish(),
});
export const ServeStatusSchema = z.strictObject({ schema: z.literal('tailscale-serve-status-v1'), config: ConfigSchema });
const NodeSchema = z.strictObject({
  schema: z.literal('tailscale-node-status-v1'), status: z.object({ BackendState: z.literal('Running'), Self: z.object({ DNSName: z.string() }) }),
});
type Config = z.infer<typeof ConfigSchema>;
export type TailscaleCommand = (args: readonly string[]) => Promise<string>;
const runCommand: TailscaleCommand = async args => {
  try {
    return (await promisify(execFile)('tailscale', [...args], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } })).stdout;
  } catch { throw new Error('Tailscale HTTPS setup is unavailable. Check Tailscale and its HTTPS setting, then retry installation.'); }
};
const onPort = (host: string, port: number) => host.endsWith(`:${port}`);
function occupied(config: Config, port: number): boolean {
  return Object.hasOwn(config.TCP ?? {}, String(port)) || Object.keys(config.Web ?? {}).some(host => onPort(host, port)) || Object.entries(config.AllowFunnel ?? {}).some(([host, enabled]) => enabled && onPort(host, port)) || Object.values(config.Foreground ?? {}).some(value => occupied(ConfigSchema.parse(value), port));
}
function routeState(config: Config, route: InstalledHttps): 'absent' | 'owned' | 'conflict' {
  if (!occupied(config, route.port)) return 'absent';
  if (Object.values(config.Foreground ?? {}).some(value => occupied(ConfigSchema.parse(value), route.port))) return 'conflict';
  const web = Object.fromEntries(Object.entries(config.Web ?? {}).filter(([host]) => onPort(host, route.port)));
  if (Object.entries(config.AllowFunnel ?? {}).some(([host, enabled]) => enabled && onPort(host, route.port))) return 'conflict';
  return stableJson(config.TCP?.[String(route.port)]) === stableJson({ HTTPS: true }) && stableJson(web) === stableJson({ [authority(route)]: { Handlers: { '/': { Proxy: target(route) } } } }) ? 'owned' : 'conflict';
}

/** Each mutation names one recorded HTTPS port and root handler. Never resets Serve or enables Funnel. */
export class HttpsService {
  constructor(private readonly run: TailscaleCommand = runCommand) {}
  async #config(): Promise<Config> { return ServeStatusSchema.parse({ schema: 'tailscale-serve-status-v1', config: JSON.parse(await this.run(['serve', 'status', '--json'])) }).config; }
  async plan(localPort: number, previous?: InstalledHttps): Promise<InstalledHttps> {
    Port.parse(localPort);
    const node = NodeSchema.parse({ schema: 'tailscale-node-status-v1', status: JSON.parse(await this.run(['status', '--json'])) });
    const hostname = Hostname.parse(node.status.Self.DNSName.replace(/\.$/u, '').toLowerCase());
    const config = await this.#config();
    if (previous) {
      const route = InstalledHttpsSchema.parse(previous);
      if (route.hostname !== hostname || route.localPort !== localPort) throw new Error('Keep this installation’s recorded HTTPS hostname and local port.');
      if (routeState(config, route) === 'conflict' || route.state === 'removed' && routeState(config, route) !== 'absent') throw new Error('The recorded HTTPS port is now used by another service. Existing routes were preserved.');
      return route;
    }
    const candidates = [443, 8443, 9443];
    for (let port = 10443; port <= 65535; port++) candidates.push(port);
    const port = candidates.find(port => port !== localPort && !occupied(config, port));
    if (!port) throw new Error('No unused HTTPS port is available. Existing Tailscale routes were preserved.');
    return InstalledHttpsSchema.parse({ schema: 'installed-https-v1', hostname, port, localPort, state: 'pending' });
  }
  async check(input: InstalledHttps): Promise<void> {
    const route = InstalledHttpsSchema.parse(input), state = routeState(await this.#config(), route);
    if (state === 'conflict' || route.state === 'removed' && state !== 'absent') throw new Error('The HTTPS route changed outside Jevellan. Existing routes were preserved.');
  }
  async enable(input: InstalledHttps): Promise<InstalledHttps> {
    const route = InstalledHttpsSchema.parse(input); let state = routeState(await this.#config(), route);
    if (state === 'conflict' || route.state === 'removed' && state !== 'absent') throw new Error('The HTTPS route changed outside Jevellan. Existing routes were preserved.');
    if (state === 'absent') {
      await this.run(['serve', '--bg', '--yes', `--https=${route.port}`, '--set-path=/', target(route)]);
      state = routeState(await this.#config(), route);
      if (state !== 'owned') throw new Error('Tailscale did not confirm the recorded HTTPS route. Retry installation.');
    }
    return { ...route, state: 'active' };
  }
  async remove(input: InstalledHttps): Promise<InstalledHttps> {
    const route = InstalledHttpsSchema.parse(input), state = routeState(await this.#config(), route);
    if (state === 'conflict' || route.state === 'removed' && state !== 'absent') throw new Error('The HTTPS route changed outside Jevellan. Existing routes were preserved.');
    if (state === 'owned') {
      await this.run(['serve', '--bg', '--yes', `--https=${route.port}`, '--set-path=/', 'off']);
      if (routeState(await this.#config(), route) !== 'absent') throw new Error('Tailscale did not confirm removal of the recorded HTTPS route. Retry uninstall.');
    }
    return { ...route, state: 'removed' };
  }
}
