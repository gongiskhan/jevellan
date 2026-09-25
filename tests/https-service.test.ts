import { expect, test, vi } from 'vitest';
import { HttpsService, httpsOrigin, type InstalledHttps } from '../packages/cli/dist/https-service.js';

function fixture(initial: Record<string, unknown> = {}) {
  const state = { config: structuredClone(initial), hostname: 'fixture.tailtest.ts.net.', backend: 'Running', lost: false };
  const changes: string[][] = [];
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'status') return JSON.stringify({ BackendState: state.backend, Self: { DNSName: state.hostname } });
    if (args[1] === 'status') return JSON.stringify(state.config);
    changes.push([...args]); const port = args.find(arg => arg.startsWith('--https='))!.slice(8), host = `${state.hostname.replace(/\.$/u, '')}:${port}`;
    const tcp = (state.config.TCP ??= {}) as Record<string, unknown>, web = (state.config.Web ??= {}) as Record<string, unknown>;
    if (args.at(-1) === 'off') { delete tcp[port]; delete web[host]; }
    else { tcp[port] = { HTTPS: true }; web[host] = { Handlers: { '/': { Proxy: args.at(-1) } } }; }
    if (state.lost) { state.lost = false; throw new Error('Simulated lost Tailscale response'); }
    return '';
  });
  return { state, changes, run, service: new HttpsService(run) };
}

test('HTTPS uses a free port and preserves background and foreground services across enable, retry and removal', async () => {
  const initial = { TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true }, '9443': { HTTPS: true } }, Web: { 'fixture.tailtest.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8777' } } } }, Foreground: { live: { TCP: { '10443': { HTTPS: true } } } } };
  const f = fixture(initial), planned = await f.service.plan(9771);
  expect(planned.port).toBe(10444); expect(httpsOrigin(planned)).toBe('https://fixture.tailtest.ts.net:10444'); expect(f.changes).toEqual([]);
  const active = await f.service.enable(planned); expect(active.state).toBe('active'); await f.service.enable(active); expect(f.changes).toHaveLength(1);
  expect(f.state.config.Foreground).toEqual(initial.Foreground); expect((f.state.config.Web as Record<string, unknown>)['fixture.tailtest.ts.net:443']).toEqual(initial.Web['fixture.tailtest.ts.net:443']);
  expect((await f.service.remove(active)).state).toBe('removed'); expect(f.state.config).toEqual(initial);
  expect(f.changes).toEqual([
    ['serve', '--bg', '--yes', '--https=10444', '--set-path=/', 'http://127.0.0.1:9771'],
    ['serve', '--bg', '--yes', '--https=10444', '--set-path=/', 'off'],
  ]);
});

test('lost enable and removal responses recover from the recorded intent without repeating a mutation', async () => {
  const f = fixture(), plan = await f.service.plan(9771); f.state.lost = true;
  await expect(f.service.enable(plan)).rejects.toThrow('lost Tailscale response'); const active = await f.service.enable(plan); expect(f.changes).toHaveLength(1);
  f.state.lost = true; await expect(f.service.remove(active)).rejects.toThrow('lost Tailscale response');
  expect((await f.service.remove(active)).state).toBe('removed'); expect(f.changes).toHaveLength(2);
});

test.each(['other-target', 'another-handler', 'funnel', 'tcp', 'foreground'])('a %s change preserves the route and refuses all installer mutations', async change => {
  const f = fixture(), active = await f.service.enable(await f.service.plan(9771));
  const host = `${active.hostname}:${active.port}`;
  if (change === 'other-target') f.state.config.Web = { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } };
  if (change === 'another-handler') f.state.config.Web = { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9771' }, '/another': { Text: 'Keep this' } } } };
  if (change === 'funnel') f.state.config.AllowFunnel = { [host]: true };
  if (change === 'tcp') f.state.config.TCP = { [active.port]: { TCPForward: '127.0.0.1:9999' } };
  if (change === 'foreground') f.state.config.Foreground = { live: { TCP: { [active.port]: { HTTPS: true } } } };
  const before = structuredClone(f.state.config);
  await expect(f.service.check(active)).rejects.toThrow('changed outside'); await expect(f.service.enable(active)).rejects.toThrow('changed outside'); await expect(f.service.remove(active)).rejects.toThrow('changed outside');
  expect(f.state.config).toEqual(before); expect(f.changes).toHaveLength(1);
});

test('a removed route cannot adopt a later matching service and a changed node identity cannot retarget membership', async () => {
  const f = fixture(), active = await f.service.enable(await f.service.plan(9771)), removed: InstalledHttps = { ...active, state: 'removed' };
  await expect(f.service.plan(9771, removed)).rejects.toThrow('another service'); await expect(f.service.enable(removed)).rejects.toThrow('changed outside');
  f.state.hostname = 'another.tailtest.ts.net.'; await expect(f.service.plan(9771, active)).rejects.toThrow('recorded HTTPS hostname');
  expect(f.changes).toHaveLength(1);
});

test('stopped Tailscale and invalid status cannot create a route', async () => {
  const f = fixture(); f.state.backend = 'Stopped'; await expect(f.service.plan(9771)).rejects.toThrow();
  f.state.backend = 'Running'; f.state.hostname = 'not-a-tailscale-host.example'; await expect(f.service.plan(9771)).rejects.toThrow();
  f.state.hostname = 'fixture.tailtest.ts.net'; f.state.config.TCP = []; await expect(f.service.plan(9771)).rejects.toThrow();
  expect(f.changes).toEqual([]);
});
