import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonDiagnosticsSchema, DoctorControlSchema, DoctorReportSchema, Homes, doctorControlPath, readDocument, runOwnedCommand, type DiagnosticCheck, type DoctorReport } from '@jevellan/core';
import { InstallationManifestSchema, type InstallationManifest } from './installation-files.js';
import { APM_VERSION, findExecutable, toolEnvironment, validateToolchain, type ToolCommand, type Toolchain } from './toolchain.js';
import { checkGit, checkNodeVersion } from './prerequisites.js';

export async function runningDiagnostics(homes: Homes, fetcher: typeof fetch = fetch) {
  const control = readDocument(doctorControlPath(homes), DoctorControlSchema);
  const response = await fetcher(`${control.origin}/api/local/doctor`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(45_000),
    headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'empty-request-v1' }),
  });
  if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json' || !response.body) { await response.body?.cancel(); throw new Error('The local daemon did not answer its diagnostics check.'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length; if (length > 64 * 1024) { await reader.cancel(); throw new Error('The diagnostics response was too large.'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return DaemonDiagnosticsSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

type Options = { homes?: Homes; run?: ToolCommand; find?: typeof findExecutable; diagnostics?: typeof runningDiagnostics };
const version = (text: string) => /\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/.exec(text)?.[0];

export async function doctor(options: Options = {}): Promise<DoctorReport> {
  const homes = options.homes ?? new Homes(), run = options.run ?? runOwnedCommand, find = options.find ?? findExecutable;
  let manifest: InstallationManifest | undefined, tools: Toolchain | undefined, invalid = false;
  try {
    if (existsSync(homes.at('install.json'))) {
      manifest = readDocument(homes.at('install.json'), InstallationManifestSchema);
      if (manifest.home !== homes.root || manifest.dataRoot.path !== homes.root) throw new Error('Installation mismatch.');
      const active = manifest.applications.find(app => app.version === manifest!.activeVersion);
      const selected = manifest.toolchains.find(tool => tool.root === active?.toolchain);
      if (selected) tools = validateToolchain(homes, selected);
    }
  } catch { invalid = true; manifest = undefined; }
  const path = manifest?.service?.definition.spec.path ?? process.env.PATH ?? '/usr/bin:/bin';
  // Version probes get a disposable HOME even when the application has never been installed.
  const scratch = mkdtempSync(join(tmpdir(), 'jevellan-doctor-')); mkdirSync(join(scratch, 'user'));
  const probeHome = new Homes(join(scratch, 'probe'), join(scratch, 'user'));
  try {
    const env = toolEnvironment(probeHome, path);
    env.CODEX_HOME = probeHome.ensure('codex'); env.CLAUDE_CONFIG_DIR = probeHome.ensure('claude');
    const checks: DiagnosticCheck[] = [];
    try { checks.push({ id: 'node', status: 'ok', note: `Node ${checkNodeVersion()}.` }); }
    catch { checks.push({ id: 'node', status: 'error', note: 'Node 22.13+ or 23.4+ is required for SQLite.' }); }
    try { const output = await checkGit(probeHome, run, path); checks.push({ id: 'git', status: 'ok', note: `Git ${version(output) ?? 'available'}; required merge-tree capabilities are present.` }); }
    catch { checks.push({ id: 'git', status: 'missing', note: 'Git or required merge-tree capabilities are unavailable. Install a compatible Git.' }); }
    const probe = async (id: DiagnosticCheck['id'], executable: string | null | undefined, expected?: string): Promise<DiagnosticCheck> => {
      if (invalid && ['apm', 'basic-memory'].includes(id)) return { id, status: 'error', note: 'The recorded installation is invalid. Its files were preserved.' };
      if (!executable) return { id, status: 'missing', note: id === 'basic-memory' ? 'Jevellan’s private Basic Memory installation is unavailable.' : 'The executable is unavailable on the configured PATH.' };
      try {
        const result = await run(executable, ['--version'], { cwd: probeHome.root, env, timeoutMs: 30_000 });
        const found = version(result.stdout);
        if (result.code !== 0 || !found) return { id, status: 'error', note: 'The executable did not complete its version check.' };
        return expected && found !== expected ? { id, status: 'error', note: `Version ${found} is available; this installation requires ${expected}.` } : { id, status: 'ok', note: `Version ${found}.${id === 'claude' || id === 'codex' ? ' Account login is checked separately.' : ''}` };
      } catch { return { id, status: 'error', note: 'The executable could not complete its version check.' }; }
    };
    checks.push(...await Promise.all([
      probe('apm', tools?.apm.executable ?? find('apm', path), tools?.apm.version ?? APM_VERSION),
      probe('basic-memory', tools?.basicMemory.executable, tools?.basicMemory.version),
      probe('claude', find('claude', path)), probe('codex', find('codex', path)),
    ]));
    try {
      const live = await (options.diagnostics ?? runningDiagnostics)(homes);
      checks.push({ id: 'daemon', status: 'ok', note: `Jevellan ${live.version} answered on its local diagnostics endpoint.` }, ...live.checks);
    } catch {
      checks.push({ id: 'daemon', status: 'missing', note: 'The running daemon could not be reached through its private control file.' });
      for (const id of ['hub', 'accounts', 'jev'] as const) checks.push({ id, status: 'missing', note: 'Not checked: a running local Jevellan daemon is required.' });
    }
    return DoctorReportSchema.parse({ schema: 'doctor-report-v1', at: new Date().toISOString(), checks });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const labels = { node: 'Node', git: 'Git', apm: 'APM', 'basic-memory': 'Basic Memory', claude: 'Claude', codex: 'Codex', daemon: 'Daemon', hub: 'Hub', accounts: 'Accounts', jev: 'Jev' };
export function doctorLines(input: DoctorReport): string[] {
  return DoctorReportSchema.parse(input).checks.map(check => `${check.status.toUpperCase()} ${labels[check.id]}: ${Array.from(check.note, character => { const code = character.codePointAt(0)!; return code < 32 || code >= 127 && code <= 159 ? ' ' : character; }).join('')}`);
}
