import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DoctorControlSchema, Homes, LifecycleGate, SecretRedactor, doctorControlPath, readDocument, writeDocument } from '../packages/core/dist/index.js';
import { startDaemon } from '../apps/daemon/dist/index.js';
import { createRuntime as createClaude } from '../runtimes/claude/dist/index.js';
import { doctor, doctorLines, runningDiagnostics } from '../packages/cli/dist/doctor.js';
import { main } from '../packages/cli/dist/index.js';
import { InstallationManifestSchema } from '../packages/cli/dist/installation-files.js';
import { ToolchainSchema, toolchainDirectoryName, type ToolCommand } from '../packages/cli/dist/toolchain.js';
import { availablePort } from '../packages/cli/dist/installation.js';
import { joinMember } from '../packages/mesh/dist/index.js';

const roots: string[] = [], daemons: Awaited<ReturnType<typeof startDaemon>>[] = [];
afterEach(async () => { await Promise.all(daemons.splice(0).map(daemon => daemon.close())); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync('/private/tmp/jevellan-doctor-test-'); roots.push(root); const user = join(root, 'user'); mkdirSync(user);
  const homes = new Homes(join(user, '.jevellan'), user);
  const canaries = ['.claude', '.codex', '.basic-memory'];
  for (const name of canaries) { mkdirSync(join(user, name)); writeFileSync(join(user, name, 'native'), 'Do not read or change this fixture.'); }
  const unchanged = () => { for (const name of canaries) { expect(readdirSync(join(user, name))).toEqual(['native']); expect(readFileSync(join(user, name, 'native'), 'utf8')).toBe('Do not read or change this fixture.'); } };
  return { homes, unchanged };
}
const versions: Record<string, string> = { apm: '0.10.0', 'basic-memory': '0.22.1', claude: '2.1.0', codex: '0.100.0' };
const run = vi.fn<ToolCommand>(async (command, args, options) => {
  expect(options.env.HOME).toContain('jevellan-doctor-'); expect(options.env.OPENAI_API_KEY).toBeUndefined(); expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
  if (command === 'git') return { code: args[0] === '--version' ? 0 : 129, stdout: args[0] === '--version' ? 'git version 2.50.1' : '', stderr: '--write-tree --[no-]merge-base', timedOut: false };
  expect(args).toEqual(['--version']); expect(options.env.CODEX_HOME).toContain('jevellan-doctor-'); expect(options.env.CLAUDE_CONFIG_DIR).toContain('jevellan-doctor-');
  return { code: 0, stdout: `${basename(command)} ${versions[basename(command)]}`, stderr: '', timedOut: false };
});
const find = (name: string) => `/fixture/bin/${name}`;
function installed(homes: Homes) {
  const root = homes.ensure('tools', toolchainDirectoryName());
  const tool = (name: string) => ({ schema: 'installed-tool-v1', executable: join(root, 'bin', name), version: versions[name], owned: true });
  const tools = ToolchainSchema.parse({ schema: 'toolchain-v1', root, installedAt: new Date().toISOString(), uv: { schema: 'installed-tool-v1', executable: '/fixture/bin/uv', version: '0.11.23', owned: false }, apm: tool('apm'), basicMemory: tool('basic-memory'), python: '3.12', path: '/fixture/bin' });
  writeDocument(homes.at('install.json'), InstallationManifestSchema, { schema: 'installation-v1', id: randomUUID(), home: homes.root, createdAt: new Date().toISOString(), dataRoot: { schema: 'installed-data-root-v1', path: homes.root, retainedOnUninstall: true }, applications: [{ schema: 'installed-application-v1', version: '0.1.0', path: homes.at('app/0.1.0'), digest: '0'.repeat(64), installedAt: new Date().toISOString(), toolchain: root }], serviceDirectories: [], activeVersion: '0.1.0', toolchains: [tools] });
}
async function live(homes: Homes, decisionFetch: typeof fetch = async () => Response.json({ models: [{ name: 'jev-1.13.0', description: 'Simulated model.', release_date: '2026-09-25' }] })) {
  const daemon = await startDaemon(0, { homes, timers: false, tailscaleAddress: async () => null, runtimes: context => new Map([['claude', { ...createClaude(context), probe: async () => ({ auth: 'ready' as const }) }]]), decisionFetch }); daemons.push(daemon);
  await daemon.application.conversations.ready; return daemon;
}

test('doctor reads the live daemon through a private token and reports every required check', async () => {
  const f = fixture(); installed(f.homes); const daemon = await live(f.homes), app = daemon.application;
  const account = await app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Simulated account', kind: 'subscription', secret: `fixture-${randomUUID()}` }); await app.accounts.check(account.account.id);
  const secret = `fixture-${randomUUID()}`; await app.state.jev.put(secret);
  const control = readDocument(doctorControlPath(f.homes), DoctorControlSchema);
  expect(statSync(doctorControlPath(f.homes)).mode & 0o777).toBe(0o600);
  const report = await doctor({ homes: f.homes, run, find });
  expect(report.checks.map(check => check.id)).toEqual(['node', 'git', 'apm', 'basic-memory', 'claude', 'codex', 'daemon', 'hub', 'accounts', 'jev']);
  expect(report.checks.every(check => check.status === 'ok'), JSON.stringify(report)).toBe(true); expect(doctorLines(report)).toHaveLength(10);
  expect(JSON.stringify(report)).not.toContain(secret); expect(JSON.stringify(report)).not.toContain(control.token); expect(JSON.stringify(report)).not.toContain(account.account.id); f.unchanged();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {}), previous = process.exitCode; process.exitCode = undefined;
  try { await main(['doctor'], { doctor: async () => report }); expect(output).toHaveBeenCalledTimes(10); expect(process.exitCode).toBeUndefined(); }
  finally { process.exitCode = previous; }
});

test('a fresh machine reports missing private memory and daemon checks without creating a home or borrowing logins', async () => {
  const f = fixture(), report = await doctor({ homes: f.homes, run, find });
  for (const id of ['basic-memory', 'daemon', 'hub', 'accounts', 'jev']) expect(report.checks.find(check => check.id === id)?.status).toBe('missing');
  expect(existsSync(f.homes.root)).toBe(false); f.unchanged();
  const previous = process.exitCode; vi.spyOn(console, 'log').mockImplementation(() => {});
  try { await main(['doctor'], { doctor: async () => report }); expect(process.exitCode).toBe(1); }
  finally { process.exitCode = previous; }
});

test('missing keys, failed Jev authentication and stale account status never appear green', async () => {
  const f = fixture(), transport = vi.fn<typeof fetch>(async () => new Response('Invalid fixture credential', { status: 401 })); const daemon = await live(f.homes, transport), app = daemon.application;
  let report = await runningDiagnostics(f.homes); expect(report.checks[1].status).toBe('missing'); expect(report.checks[2].status).toBe('missing'); expect(transport).not.toHaveBeenCalled();
  const account = await app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Simulated account', kind: 'subscription', secret: `fixture-${randomUUID()}` }); await app.accounts.check(account.account.id);
  const views = await app.accounts.list(); for (const status of views[0]!.statuses) status.observedAt = '2020-01-01T00:00:00.000Z';
  vi.spyOn(app.accounts, 'list').mockResolvedValue(views); await app.state.jev.put(`fixture-${randomUUID()}`);
  report = await runningDiagnostics(f.homes); expect(report.checks[1]).toMatchObject({ status: 'warning', note: expect.stringContaining('refreshing') }); expect(report.checks[2].status).toBe('error'); expect(transport).toHaveBeenCalledOnce(); f.unchanged();
});

test('doctor reports hub and account outages while still returning the other checks', async () => {
  const f = fixture(), daemon = await live(f.homes); vi.spyOn(daemon.application, 'roster').mockRejectedValue(new Error('Fixture outage'));
  vi.spyOn(daemon.application.accounts, 'list').mockRejectedValue(new Error('Fixture outage'));
  const report = await doctor({ homes: f.homes, run, find });
  expect(report.checks.find(check => check.id === 'node')?.status).toBe('ok'); expect(report.checks.find(check => check.id === 'daemon')?.status).toBe('ok');
  expect(report.checks.find(check => check.id === 'hub')?.status).toBe('error'); expect(report.checks.find(check => check.id === 'accounts')?.status).toBe('error');
});

test('a real local member diagnoses its hub connection and reports an outage without opening a local hub', async () => {
  const hubFixture = fixture(), memberFixture = fixture(), hub = await live(hubFixture.homes);
  await hub.application.auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
  const port = await availablePort(12000, null);
  await joinMember(memberFixture.homes, { schema: 'member-join-input-v1', hubUrl: hub.addresses[0], code: hub.application.mesh.invite().code, device: { name: 'Doctor fixture member', url: `http://127.0.0.1:${port}`, os: process.platform, version: '0.1.0' } }, { redactor: new SecretRedactor() });
  const member = await startDaemon(port, { homes: memberFixture.homes, timers: false, runtimes: () => new Map(), tailscaleAddress: async () => null }); daemons.push(member);
  await member.application.conversations.ready;
  expect((await runningDiagnostics(memberFixture.homes)).checks[0]).toMatchObject({ status: 'ok', note: expect.stringContaining('authenticated device request') });
  await hub.close();
  const disconnected = await runningDiagnostics(memberFixture.homes); expect(disconnected.checks.map(check => check.status)).toEqual(['error', 'error', 'error']);
  expect(existsSync(memberFixture.homes.at('hub'))).toBe(false); memberFixture.unchanged();
});

test('local diagnostics reject browser requests and wrong tokens, respect maintenance, and rotate on restart', async () => {
  const f = fixture(), daemon = await live(f.homes), control = readDocument(doctorControlPath(f.homes), DoctorControlSchema);
  const request = (token: string, origin?: string) => fetch(`${control.origin}/api/local/doctor`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ schema: 'empty-request-v1' }) });
  expect((await request('wrong')).status).toBe(401); expect((await request(control.token, control.origin)).status).toBe(401);
  const gate = new LifecycleGate(f.homes), release = gate.tryMaintenance()!;
  try { expect((await request(control.token)).status).toBe(503); } finally { release(); gate.close(); }
  await daemon.close(); expect(existsSync(doctorControlPath(f.homes))).toBe(false);
  const next = await live(f.homes), changed = readDocument(doctorControlPath(f.homes), DoctorControlSchema); expect(changed.token).not.toBe(control.token);
  expect((await fetch(`${next.addresses[0]}/api/local/doctor`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'empty-request-v1' }) })).status).toBe(401);
});

test('a failed executable and an incompatible recorded version are reported without command output', async () => {
  const f = fixture(); installed(f.homes); const privateOutput = `fixture-${randomUUID()}`;
  const report = await doctor({ homes: f.homes, find, run: async (command, args, options) => basename(command) === 'codex' ? { code: 1, stdout: '', stderr: privateOutput, timedOut: false } : basename(command) === 'apm' ? { code: 0, stdout: 'APM 0.1.0', stderr: '', timedOut: false } : run(command, args, options) });
  expect(report.checks.find(check => check.id === 'codex')?.status).toBe('error'); expect(report.checks.find(check => check.id === 'apm')?.status).toBe('error'); expect(JSON.stringify(report)).not.toContain(privateOutput);
});

test('a changed manifest is preserved and a control URL outside loopback is never contacted', async () => {
  const f = fixture(); f.homes.ensure(); writeFileSync(f.homes.at('install.json'), 'Malformed installation fixture');
  const report = await doctor({ homes: f.homes, run, find }); expect(report.checks.find(check => check.id === 'apm')?.status).toBe('error'); expect(readFileSync(f.homes.at('install.json'), 'utf8')).toBe('Malformed installation fixture');
  writeFileSync(doctorControlPath(f.homes), JSON.stringify({ schema: 'doctor-control-v1', origin: 'https://example.invalid', token: 'x'.repeat(43) }));
  const fetcher = vi.fn<typeof fetch>(); await expect(runningDiagnostics(f.homes, fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); f.unchanged();
});
