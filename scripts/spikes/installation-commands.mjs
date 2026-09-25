import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { c, x } from 'tar';
import { z } from 'zod';
import { chromium } from '@playwright/test';
import { installationBrowser } from './installation-browser.mjs';
import { checkInstalledNotices } from './installation-notices.mjs';

const Result = z.strictObject({
  schema: z.literal('installation-command-check-v8'), at: z.iso.datetime(), passed: z.literal(true), root: z.string(),
  firstRun: z.strictObject({ layout: z.enum(['desktop', 'phone']), theme: z.enum(['light', 'dark']), browserSetup: z.literal(true), guidedSetup: z.literal(true), skippedJev: z.boolean(), configuredDoctor: z.literal(true), verifiedPublication: z.literal(true), retainedConversation: z.literal(true), providers: z.literal('simulated') }).nullable(),
  https: z.enum(['live-tailscale', 'not-enabled']), httpsBrowserChecks: z.number().int().min(0), tailscaleRoutesPreserved: z.boolean().nullable(),
  package: z.literal('real-packed-application'), dependencies: z.literal('live'), serviceManager: z.literal('fake-owned-processes'), work: z.enum(['simulated-admission', 'real-conversation-simulated-providers']), updateRelease: z.literal('simulated-version-0.2.0'), devices: z.literal('local-simulated-devices'),
  checks: z.strictObject({ independentCopy: z.literal(true), installedCommand: z.literal(true), commandUpdate: z.literal(true), commandRollback: z.literal(true), commandRemoved: z.literal(true), occupiedPortSkipped: z.literal(true), uiAndAsset: z.literal(true), doctorExecutableChecks: z.literal(true), doctorMissingCredentials: z.literal(true), memberJoined: z.literal(true), memberUiLogin: z.literal(true), memberRepeatPreserved: z.literal(true), memberRemoval: z.literal(true), busyUninstallRefused: z.literal(true), updateWaited: z.literal(true), updateVersion: z.literal('0.2.0'), rollbackVersion: z.literal('0.1.0'), removedServiceAndApplications: z.literal(true), dataRetained: z.literal(true), purgeRemovedHome: z.literal(true), purgePreservedExternalFiles: z.literal(true), canariesPreserved: z.literal(true), nativeServicesInvoked: z.literal(false) }),
});
const flags = process.argv.slice(2);
if (flags.some(arg => !['--https', '--conversation', '--phone', '--dark'].includes(arg)) || new Set(flags).size !== flags.length || !flags.includes('--conversation') && flags.some(arg => ['--phone', '--dark'].includes(arg))) throw new Error('Usage: installation-commands.mjs [--https] [--conversation [--phone] [--dark]]');
const liveHttps = flags.includes('--https'), conversationCheck = flags.includes('--conversation'), layout = flags.includes('--phone') ? 'phone' : 'desktop', theme = flags.includes('--dark') ? 'dark' : 'light';
const DriverEvent = z.strictObject({ schema: z.literal('installation-fixture-event-v1'), state: z.enum(['ready', 'holding']) });
const DriverControl = z.strictObject({ schema: z.literal('installation-fixture-control-v1'), operation: z.literal('release') });
const root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-install-commands-'))), user = join(root, 'user'), distribution = join(root, 'distribution'); mkdirSync(user); mkdirSync(distribution);
const driver = join(root, 'installation-runtime.mjs');
if (conversationCheck) cpSync(resolve('scripts/spikes/installation-runtime.mjs'), driver);
console.log(`Installation command check: ${root}`);
const packed = z.array(z.object({ filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/) })).length(1).parse(JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: resolve('.'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: user, npm_config_cache: join(root, 'npm-cache') } })))[0];
const archive = join(root, packed.filename); await x({ file: archive, cwd: distribution, strict: true });
const source = join(distribution, 'package'), load = path => import(pathToFileURL(join(source, path)).href);
const { DeviceConfigSchema, DeviceRosterSchema, Homes, JoinInvitationSchema, LifecycleGate, stableJson } = await load('packages/core/dist/index.js');
const { Installer } = await load('packages/cli/dist/installation.js');
const { ServeStatusSchema } = await load('packages/cli/dist/https-service.js');
const { UserServiceManager, serviceContents } = await load('packages/cli/dist/service-manager.js');
const { main } = await load('packages/cli/dist/index.js');
const memberUser = join(root, 'member-user'); mkdirSync(memberUser);
const homes = new Homes(join(user, '.jevellan'), user), memberHomes = new Homes(join(memberUser, '.jevellan'), memberUser), canaries = ['.claude/settings.json', '.codex/config.toml', '.basic-memory/config.json', 'dev/garrison/reference', 'Library/LaunchAgents/dev.garrison.fixture.plist', '.local/bin/unrelated-command', '.zshrc'];
for (const owner of [user, memberUser]) for (const path of canaries) { mkdirSync(dirname(join(owner, path)), { recursive: true }); writeFileSync(join(owner, path), `Untouched fixture: ${path}\n`); }
const protectedPaths = ['.claude', '.codex', '.basic-memory', 'dev/garrison', 'Library/LaunchAgents/dev.garrison.fixture.plist', '.local/bin/unrelated-command', '.zshrc'];
const digest = () => {
  const hash = createHash('sha256');
  const visit = (owner, path) => {
    const full = join(owner, path), stat = lstatSync(full);
    hash.update(JSON.stringify({ path, mode: stat.mode, type: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file' }));
    if (stat.isSymbolicLink()) hash.update(readlinkSync(full));
    else if (stat.isDirectory()) for (const name of readdirSync(full).sort()) visit(owner, join(path, name));
    else hash.update(readFileSync(full));
  };
  for (const owner of [user, memberUser]) for (const path of protectedPaths) visit(owner, path);
  return hash.digest('hex');
};
const before = digest(), neighbour = createServer((_request, response) => response.end('Fake Garrison'));
const serveStatus = () => ServeStatusSchema.parse({ schema: 'tailscale-serve-status-v1', config: JSON.parse(execFileSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) });
const serveBefore = liveHttps ? serveStatus() : undefined;
if (serveBefore) writeFileSync(join(root, 'tailscale-before.json'), JSON.stringify(serveBefore, null, 2) + '\n', { mode: 0o600 });
await new Promise((resolve, reject) => { neighbour.once('error', reject); neighbour.listen(9771, '127.0.0.1', resolve); });
function ownedService(owner, data) {
  const definitions = new UserServiceManager({ platform: 'darwin', userHome: owner, uid: process.getuid(), run: async () => { throw new Error('Native services must not run in this check.'); } });
  let child, output, starts = 0, holding = false;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'close'); child.kill('SIGTERM'); let timer;
      try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fixture daemon did not stop.')), 30_000); timer.unref(); })]); }
      finally { clearTimeout(timer); }
    }
    child = undefined; if (output) { output.end(); output = undefined; }
  };
  const manager = {
    definition: spec => definitions.definition(spec),
    start: async definition => {
      if (readFileSync(definition.path, 'utf8') !== serviceContents(definition)) throw new Error('Service definition mismatch.');
      if (child && child.exitCode === null && child.signalCode === null) throw new Error('The disposable service is already running.');
      output = createWriteStream(join(data.root, 'logs', 'command-check.log'), { flags: 'a', mode: 0o600 });
      const appRoot = dirname(dirname(definition.spec.entry)); holding = false;
      child = spawn(definition.spec.node, conversationCheck ? [driver, appRoot, String(definition.spec.port)] : [definition.spec.entry, 'start', '--port', String(definition.spec.port)], { cwd: appRoot, env: { HOME: owner, JEVELLAN_HOME: data.root, PATH: definition.spec.path, LANG: 'en_US.UTF-8' }, stdio: conversationCheck ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
      if (conversationCheck) child.on('message', value => { if (DriverEvent.parse(value).state === 'holding') holding = true; });
      child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false }); await once(child, 'spawn'); starts++;
    },
    stop: async definition => { if (readFileSync(definition.path, 'utf8') !== serviceContents(definition)) throw new Error('Service definition mismatch.'); await stop(); },
    removed: async () => {},
  };
  return { manager, stop, starts: () => starts, holding: () => holding, release: () => { if (!child?.connected || !holding) throw new Error('No held conversation belongs to this service.'); child.send(DriverControl.parse({ schema: 'installation-fixture-control-v1', operation: 'release' })); } };
}
const service = ownedService(user, homes), memberService = ownedService(memberUser, memberHomes), manager = service.manager;
let gate, releaseWork, firstRun;
const conversationDigest = () => {
  const folder = join(homes.root, 'conversations', basename(firstRun.conversationPath), 'ledger');
  const segments = readdirSync(folder).filter(name => name.endsWith('.jsonl')).sort();
  if (!segments.length) throw new Error('The installed conversation has no durable ledger.');
  return createHash('sha256').update(Buffer.concat(segments.map(name => readFileSync(join(folder, name))))).digest('hex');
};
const messages = [];
const installer = () => new Installer({ homes, manager, commandSearchPath: `${join(user, '.local/bin')}:${process.env.PATH}`, progress: message => { messages.push(message); console.log(message); } });
const memberInstaller = () => new Installer({ homes: memberHomes, manager: memberService.manager, commandSearchPath: `${join(memberUser, '.local/bin')}:${process.env.PATH}`, progress: message => console.log(message) });
const interrupted = () => {
  void (async () => { releaseWork?.(); gate?.close(); await firstRun?.close(); await Promise.all([service.stop(), memberService.stop()]); })()
    .finally(() => process.exit(1));
};
process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
function commandVersion(owner, expected) {
  const version = execFileSync('jevellan', ['--version'], { cwd: owner, encoding: 'utf8', env: { HOME: owner, PATH: join(owner, '.local/bin') } }).trim();
  if (version !== expected) throw new Error('The installed command did not run its active version.');
}
const health = async (port, expected) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`); const value = z.object({ schema: z.literal('health-v1'), version: z.literal(expected) }).parse(await response.json());
  if (!response.ok) throw new Error('Installed health check failed.'); return value.version;
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: user, PATH: process.env.PATH, LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const project = join(root, 'project'), projectOrigin = join(root, 'project-origin.git');
function prepareProject() {
  git(root, 'init', '--bare', '-b', 'main', projectOrigin); git(root, 'clone', projectOrigin, project);
  git(project, 'config', 'user.name', 'Installation fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(project, 'AGENTS.md'), '# Installation fixture\nChange only value.txt. Preserve the independent test.\n'); writeFileSync(join(project, 'value.txt'), '1\n');
  writeFileSync(join(project, 'value.test.mjs'), "import { readFileSync } from 'node:fs';\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the requested value is two', () => assert.equal(readFileSync(new URL('./value.txt', import.meta.url), 'utf8'), '2\\n'));\n");
  git(project, 'add', '-A'); git(project, 'commit', '-m', 'Seed installation acceptance'); git(project, 'push', '-u', 'origin', 'main');
  let failed = false; try { execFileSync(process.execPath, ['--test', 'value.test.mjs'], { cwd: project, stdio: 'pipe' }); } catch (error) { failed = error.status === 1; }
  if (!failed) throw new Error('The independent project test must fail before the requested change.');
}
let httpsBrowserChecks = 0;
async function checkHttpsBrowser(origin, passphrase, label) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage(); await page.goto(origin);
    await page.getByLabel('Passphrase').fill(passphrase); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Runtimes', exact: true }).waitFor();
    const cookies = await context.cookies(origin);
    if (!cookies.some(cookie => cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict')) throw new Error('The HTTPS browser did not receive a protected session cookie.');
    await page.goto(`${origin}/settings/devices`); await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
    await page.screenshot({ path: join(root, `https-${label}-desktop.png`), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Open navigation', exact: true }).waitFor();
    await page.waitForFunction(() => globalThis.document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
    if (!await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)) throw new Error('The HTTPS phone layout overflowed.');
    await page.screenshot({ path: join(root, `https-${label}-phone.png`), fullPage: true, animations: 'disabled' });
    httpsBrowserChecks++;
  } finally { await browser.close(); }
}
try {
  await main(['install', '--from', archive, ...(liveHttps ? ['--https'] : [])], { installer });
  let current = installer(), manifest = current.files.load(); current.close();
  const port = manifest.service.definition.spec.port; if (port === 9771) throw new Error('The occupied port was not skipped.'); await health(port, '0.1.0');
  commandVersion(user, '0.1.0');
  if (manifest.service.definition.spec.entry !== join(homes.root, 'app/0.1.0/bin/jevellan.mjs')) throw new Error('The daemon is not using its installed copy.');
  const notices = checkInstalledNotices(source, join(homes.root, 'app/0.1.0'));
  writeFileSync(join(root, 'installation-notices.json'), JSON.stringify(notices, null, 2) + '\n', { mode: 0o600 });
  const page = await fetch(`http://127.0.0.1:${port}/`), html = await page.text(), asset = /src="([^"]+\.js)"/.exec(html)?.[1];
  if (!page.ok || !asset || !(await fetch(new URL(asset, `http://127.0.0.1:${port}`))).ok) throw new Error('The installed UI or its script could not load.');
  let diagnosticOutput = '', diagnosticStatus = 0;
  try { diagnosticOutput = execFileSync('jevellan', ['doctor'], { cwd: homes.root, env: { HOME: user, PATH: `${join(user, '.local/bin')}:${manifest.service.definition.spec.path}`, LANG: 'en_US.UTF-8' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }); }
  catch (error) { diagnosticOutput = String(error.stdout ?? ''); diagnosticStatus = error.status; }
  const diagnosticLines = diagnosticOutput.trim().split('\n');
  if (diagnosticStatus !== 1 || diagnosticLines.length !== 10 || !['Node', 'Git', 'APM', 'Basic Memory', 'Claude', 'Codex', 'Daemon', 'Hub'].every(label => diagnosticLines.some(line => line.startsWith(`OK ${label}:`))) || !['Accounts', 'Jev'].every(label => diagnosticLines.some(line => line.startsWith(`MISSING ${label}:`)))) throw new Error('The actual installed doctor did not distinguish healthy executables from absent test credentials.');
  console.log('Installed doctor passed eight checks and correctly reported missing Accounts and Jev credentials.');
  const hubOrigin = DeviceConfigSchema.parse(JSON.parse(readFileSync(join(homes.root, 'device.json'), 'utf8'))).url;
  if (conversationCheck) {
    prepareProject(); firstRun = await installationBrowser({ origin: hubOrigin, project, remote: projectOrigin, root, layout, theme });
    if (!service.holding()) throw new Error('Browser setup did not start a real held conversation.');
    const configuredDoctor = execFileSync('jevellan', ['doctor'], { cwd: homes.root, env: { HOME: user, PATH: `${join(user, '.local/bin')}:${manifest.service.definition.spec.path}`, LANG: 'en_US.UTF-8' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim().split('\n');
    if (configuredDoctor.length !== 10 || configuredDoctor.some(line => !line.startsWith('OK '))) throw new Error('The installed doctor was not all green after browser setup.');
    console.log('First-run browser setup and all ten installed doctor checks passed; provider readiness and judge responses are simulated.');
  }
  const passphrase = firstRun?.passphrase ?? `fixture-${randomUUID()}`;
  const post = (origin, path, value, cookie) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(value) });
  const setup = await post(hubOrigin, firstRun ? '/api/auth/login' : '/api/auth/setup', { schema: 'passphrase-input-v1', passphrase });
  if (!setup.ok) throw new Error('The disposable hub passphrase was not configured.');
  const hubCookie = setup.headers.get('set-cookie').split(';')[0]; await setup.body.cancel();
  const invited = await post(hubOrigin, '/hub/devices/invitations', { schema: 'empty-request-v1' }, hubCookie);
  if (!invited.ok) throw new Error('The disposable hub did not issue an invitation.');
  const invitation = JoinInvitationSchema.parse(await invited.json());
  await main(['join', hubOrigin, invitation.code, '--from', archive, ...(liveHttps ? ['--https'] : [])], { installer: memberInstaller });
  commandVersion(memberUser, '0.1.0');
  const memberDevice = DeviceConfigSchema.parse(JSON.parse(readFileSync(join(memberHomes.root, 'device.json'), 'utf8')));
  if (memberDevice.role !== 'member' || existsSync(join(memberHomes.root, 'hub'))) throw new Error('Joining incorrectly created a hub.');
  const login = await post(memberDevice.url, '/api/auth/login', { schema: 'passphrase-input-v1', passphrase });
  if (!login.ok) throw new Error('The joined member did not accept the hub UI passphrase.');
  const memberCookie = login.headers.get('set-cookie').split(';')[0]; await login.body.cancel();
  const roster = await fetch(`${memberDevice.url}/hub/devices/roster`, { headers: { Cookie: memberCookie } });
  if (!roster.ok || DeviceRosterSchema.parse(await roster.json()).devices.length !== 2) throw new Error('The joined member did not show the shared roster.');
  if (liveHttps) { await checkHttpsBrowser(hubOrigin, passphrase, 'hub'); await checkHttpsBrowser(memberDevice.url, passphrase, 'member'); }
  await main(['join', hubOrigin, '00000000'], { installer: memberInstaller });
  if (memberService.starts() !== 1 || DeviceConfigSchema.parse(JSON.parse(readFileSync(join(memberHomes.root, 'device.json'), 'utf8'))).deviceId !== memberDevice.deviceId) throw new Error('Repeating join changed the member or restarted it.');
  writeFileSync(join(memberHomes.root, 'retained-member.txt'), 'Keep the member data.');
  await main(['uninstall'], { installer: memberInstaller });
  if (readFileSync(join(memberHomes.root, 'retained-member.txt'), 'utf8') !== 'Keep the member data.') throw new Error('Member uninstall lost retained data.');
  await main(['uninstall', '--purge'], { installer: memberInstaller, confirmPurge: async path => { if (path !== memberHomes.root) throw new Error('Unexpected member purge path.'); return path; } });
  if (existsSync(memberHomes.root) || existsSync(join(memberUser, '.local/bin/jevellan')) || readdirSync(memberUser).some(name => name.startsWith('.jevellan.purge-')) || digest() !== before) throw new Error('Member removal changed external files or left its home or command.');
  await health(port, '0.1.0');
  console.log('The second local daemon joined, accepted the hub UI login, preserved its identity on repeat and removed only its own installation. Devices are simulated locally.');
  writeFileSync(join(homes.root, 'retained-work.txt'), 'Keep this application data.\n');
  if (!conversationCheck) { gate = new LifecycleGate(homes); releaseWork = gate.enter({ kind: 'conversation', id: 'fixture_work', title: 'Disposable admitted work' }); }
  let refused = false; try { await main(['uninstall'], { installer }); } catch (error) { refused = error instanceof Error && error.message.includes(conversationCheck ? 'Installation acceptance: change the value to two.' : 'Disposable admitted work'); }
  if (!refused) throw new Error('Busy uninstall was not refused.');
  const next = join(root, 'next-release'); cpSync(source, next, { recursive: true, verbatimSymlinks: true });
  const packagePath = join(next, 'package.json'), identity = JSON.parse(readFileSync(packagePath, 'utf8')); identity.version = '0.2.0'; writeFileSync(packagePath, JSON.stringify(identity, null, 2) + '\n');
  for (const file of new Set(['packages/core/dist/index.js', 'node_modules/@jevellan/core/dist/index.js'].map(path => realpathSync(join(next, path))))) {
    const text = readFileSync(file, 'utf8'); if (!text.includes("export const VERSION = '0.1.0';")) throw new Error('Unexpected packed version marker.'); writeFileSync(file, text.replace("export const VERSION = '0.1.0';", "export const VERSION = '0.2.0';"));
  }
  const updateArchive = join(root, 'jevellan-fixture-0.2.0.tgz'); await c({ file: updateArchive, cwd: next, prefix: 'package', gzip: true }, readdirSync(next));
  const updating = main(['update', '--from', updateArchive], { installer }); let updateError; void updating.catch(error => { updateError = error; });
  const deadline = Date.now() + 120_000;
  while (!messages.some(message => message.startsWith('Waiting for'))) { if (updateError) throw updateError; if (Date.now() > deadline) throw new Error('Update did not reach the running-work wait.'); await delay(100); }
  if (!messages.includes('Waiting for 1 running conversations to finish') || service.starts() !== 1) throw new Error('Update did not preserve the running service with the specified wait message.');
  await health(port, '0.1.0'); commandVersion(user, '0.1.0');
  if (conversationCheck) { if (readFileSync(join(project, 'value.txt'), 'utf8') !== '1\n') throw new Error('The held conversation already changed the project.'); service.release(); }
  else { releaseWork(); releaseWork = undefined; }
  await updating; const updateVersion = await health(port, '0.2.0'); commandVersion(user, '0.2.0');
  if (firstRun) {
    await firstRun.verifyCompleted();
    if (git(project, 'status', '--porcelain') || git(project, 'rev-parse', 'HEAD') !== git(projectOrigin, 'rev-parse', 'main') || readFileSync(join(project, 'value.txt'), 'utf8') !== '2\n') throw new Error('The real conversation did not publish a clean verified change.');
    execFileSync(process.execPath, ['--test', 'value.test.mjs'], { cwd: project, stdio: 'pipe' });
    console.log('Update waited for the actual conversation, verification and Git publication, then switched to the simulated next release.');
  }
  await main(['rollback'], { installer }); const rollbackVersion = await health(port, '0.1.0'); commandVersion(user, '0.1.0');
  if (firstRun) { await firstRun.verifyCompleted(); await firstRun.close(); }
  const retainedLedger = firstRun ? conversationDigest() : undefined;
  await main(['uninstall'], { installer });
  current = installer(); manifest = current.files.load(); current.close();
  if (manifest.applications.length || manifest.service || manifest.command || existsSync(join(user, '.local/bin/jevellan')) || existsSync(join(user, 'Library/LaunchAgents/dev.jevellan.daemon.plist'))) throw new Error('Uninstall left its service, command or recorded application.');
  if (readFileSync(join(homes.root, 'retained-work.txt'), 'utf8') !== 'Keep this application data.\n' || digest() !== before) throw new Error('Retained data or native fixture files changed.');
  if (firstRun && conversationDigest() !== retainedLedger) throw new Error('Uninstall changed the completed conversation ledger.');
  gate?.close(); gate = undefined;
  symlinkSync(join(user, '.claude'), join(homes.root, 'external-fixture'));
  await main(['uninstall', '--purge'], { installer, confirmPurge: async path => { if (path !== homes.root) throw new Error('Purge offered an unexpected path.'); return path; } });
  if (existsSync(homes.root) || readdirSync(user).some(name => name.startsWith('.jevellan.purge-')) || digest() !== before) throw new Error('Purge left owned files or changed external fixtures.');
  if ((await (await fetch('http://127.0.0.1:9771')).text()) !== 'Fake Garrison') throw new Error('Removal disturbed the neighbouring service.');
  if (firstRun && (git(project, 'status', '--porcelain') || git(project, 'rev-parse', 'HEAD') !== git(projectOrigin, 'rev-parse', 'main'))) throw new Error('Removal changed the external project or its memory.');
  const serveAfter = liveHttps ? serveStatus() : undefined;
  if (serveAfter) writeFileSync(join(root, 'tailscale-after.json'), JSON.stringify(serveAfter, null, 2) + '\n', { mode: 0o600 });
  if (serveBefore && stableJson(serveAfter) !== stableJson(serveBefore)) throw new Error('The Tailscale routes did not return to their original configuration.');
  const result = Result.parse({ schema: 'installation-command-check-v8', at: new Date().toISOString(), passed: true, root, firstRun: conversationCheck ? { layout, theme, browserSetup: true, guidedSetup: true, skippedJev: firstRun.skippedJev, configuredDoctor: true, verifiedPublication: true, retainedConversation: true, providers: 'simulated' } : null, https: liveHttps ? 'live-tailscale' : 'not-enabled', httpsBrowserChecks, tailscaleRoutesPreserved: liveHttps ? true : null, package: 'real-packed-application', dependencies: 'live', serviceManager: 'fake-owned-processes', work: conversationCheck ? 'real-conversation-simulated-providers' : 'simulated-admission', updateRelease: 'simulated-version-0.2.0', devices: 'local-simulated-devices', checks: { independentCopy: true, installedCommand: true, commandUpdate: true, commandRollback: true, commandRemoved: true, occupiedPortSkipped: true, uiAndAsset: true, doctorExecutableChecks: true, doctorMissingCredentials: true, memberJoined: true, memberUiLogin: true, memberRepeatPreserved: true, memberRemoval: true, busyUninstallRefused: true, updateWaited: true, updateVersion, rollbackVersion, removedServiceAndApplications: true, dataRetained: true, purgeRemovedHome: true, purgePreservedExternalFiles: true, canariesPreserved: true, nativeServicesInvoked: false } });
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  rmSync(distribution, { recursive: true }); rmSync(next, { recursive: true });
  console.log(`Verified installation commands: ${join(root, 'result.json')}`);
} finally {
  releaseWork?.(); gate?.close(); await firstRun?.close(); await Promise.all([service.stop(), memberService.stop()]);
  if (liveHttps) for (const [data, create] of [[memberHomes, memberInstaller], [homes, installer]]) {
    if (!existsSync(data.root)) continue;
    const cleanup = create();
    try { await cleanup.purge(data.root); }
    catch { console.error(`Disposable HTTPS cleanup needs attention in ${data.root}. Existing routes were preserved.`); }
    finally { cleanup.close(); }
  }
  await new Promise(resolve => { neighbour.close(() => resolve()); neighbour.closeAllConnections(); });
  console.log(`Evidence retained in ${basename(root)}.`);
  process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted);
}
