import { landingCheckEnvironment } from './landing-resources.js';
import { createHash } from 'node:crypto';
import { chmodSync, constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { IdSchema, ProjectCheckEnvironmentSchema, TimestampSchema, newId, stableJson, writeDocument,
  type Homes, type LandingCheckPort, type ProjectCheckEnvironment, type ProjectEnvSecretSummary, type ProjectWorkSettings, type SecretRedactor } from '@jevellan/core';
import type { ThreadGit } from './git.js';
import { runThreadCommand, type ProjectCheckCommandOptions } from './verification.js';

export class CheckEnvironmentBlocked extends Error {
  readonly code = 'check_environment_required';
  constructor(message = 'Configure a separate check environment in Project settings → Environment.') { super(message); this.name = 'CheckEnvironmentBlocked'; }
}
const emptyProfile: ProjectCheckEnvironment = { schema: 'project-check-environment-v1', variables: [], secrets: [], copyFiles: [] };
const normalized = (path: string) => path.split('/').filter(part => part && part !== '.').join('/');
export function checkEnvironmentProfile(settings: Pick<ProjectWorkSettings, 'environment' | 'checkEnvironment'>): ProjectCheckEnvironment {
  const profile = ProjectCheckEnvironmentSchema.parse(settings.checkEnvironment ?? emptyProfile);
  const workFiles = new Set(settings.environment.copyFiles.map(normalized));
  if (profile.copyFiles.some(file => workFiles.has(normalized(file.source)))) throw new CheckEnvironmentBlocked('The check environment needs source files separate from work inputs.');
  return profile;
}
function confined(root: string, input: string): string {
  const path = resolve(root, input), rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || rel.split('/').some(part => part.toLowerCase() === '.git')) throw new CheckEnvironmentBlocked('The check environment file must stay inside the project and outside Git metadata.');
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new CheckEnvironmentBlocked('The check environment cannot use file links.');
  }
  return path;
}
function generation(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new CheckEnvironmentBlocked('The check environment input must be a regular file.');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fileHash(path: string): Promise<string> { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
export type CheckInputSnapshot = { profile: ProjectCheckEnvironment; identity: string; root: string;
  files: Array<{ source: string; target: string; generation: string; mode: number }> };
/** Metadata identity contains sealed-envelope revisions, never a hash of plaintext secrets. */
export async function checkInputSnapshot(options: { settings: ProjectWorkSettings; projectRoot: string; summary?(name: string): Promise<ProjectEnvSecretSummary> }): Promise<CheckInputSnapshot> {
  const profile = checkEnvironmentProfile(options.settings), root = realpathSync(options.projectRoot), versions: Array<{ name: string; revision: string }> = [];
  for (const name of profile.secrets) {
    const summary = await options.summary?.(name);
    if (!summary?.saved || summary.purpose !== 'check' || !summary.revision) throw new CheckEnvironmentBlocked('The check environment has a missing check-only secret.');
    versions.push({ name, revision: summary.revision });
  }
  const files: CheckInputSnapshot['files'] = [];
  for (const file of profile.copyFiles) {
    const source = confined(root, file.source), target = normalized(file.target);
    try { files.push({ source, target, generation: generation(source), mode: lstatSync(source).mode & 0o777 }); }
    catch (error) { if (error instanceof CheckEnvironmentBlocked) throw error; throw new CheckEnvironmentBlocked('The check environment source file is unavailable.'); }
  }
  return { profile, root, files, identity: sha(stableJson({ schema: 'project-check-input-identity-v1', profile, versions, files })) };
}
export function projectCheckEnvironment(profile: ProjectCheckEnvironment, secrets: Record<string, string>, redactor?: SecretRedactor): Record<string, string> {
  const values = Object.fromEntries(profile.variables.map(row => [row.name, row.value]));
  for (const name of profile.secrets) {
    const value = secrets[name]; if (!value) throw new CheckEnvironmentBlocked('The check environment has a missing check-only secret.');
    redactor?.add(value); values[name] = value;
  }
  return values;
}
export type CheckCopiedFile = { path: string; sha256: string };
/** The caller owns a freshly created detached checkout; no work files are inherited. */
export async function stageProjectCheckFiles(snapshot: CheckInputSnapshot, cwd: string, git: ThreadGit, commit: string): Promise<CheckCopiedFile[]> {
  if (await git.resolve(cwd, 'HEAD') !== commit || (await git.run(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
    || (await git.run(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout) throw new CheckEnvironmentBlocked('The check environment needs a fresh candidate checkout.');
  const copied: CheckCopiedFile[] = [];
  for (const file of snapshot.files) {
    const target = confined(cwd, file.target);
    if ((await git.run(cwd, ['ls-files', '-z', '--', file.target])).stdout || existsSync(target)) throw new CheckEnvironmentBlocked('The check environment cannot replace a tracked or existing candidate file.');
    if (generation(file.source) !== file.generation) throw new CheckEnvironmentBlocked('The check environment input changed before verification.');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); copyFileSync(file.source, target, constants.COPYFILE_EXCL); chmodSync(target, file.mode);
    if (generation(file.source) !== file.generation) throw new CheckEnvironmentBlocked('The check environment input changed while it was copied.');
    copied.push({ path: file.target, sha256: await fileHash(target) });
  }
  return copied;
}
/** Remove only unchanged files this check copied; other work remains available. */
export async function releaseProjectCheckFiles(cwd: string, copied: readonly CheckCopiedFile[]): Promise<boolean> {
  for (const file of copied) {
    const path = confined(cwd, file.path);
    if (!existsSync(path)) continue;
    if (!lstatSync(path).isFile() || await fileHash(path) !== file.sha256) return false;
  }
  for (const file of copied) { const path = confined(cwd, file.path); if (existsSync(path)) rmSync(path); }
  return true;
}
export async function checkCheckoutClean(git: ThreadGit, cwd: string, commit: string, copied: readonly CheckCopiedFile[]): Promise<boolean> {
  if (await git.resolve(cwd, 'HEAD') !== commit || (await git.run(cwd, ['diff', '--quiet', 'HEAD', '--'], { permitted: [1] })).code !== 0) return false;
  const own = new Set(copied.map(file => file.path));
  return !(await git.run(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(path => path && !own.has(path)).length;
}
const WorkspaceReceipt = z.strictObject({ schema: z.literal('project-check-workspace-v1'), id: IdSchema, projectId: IdSchema, workId: IdSchema,
  commit: z.string().regex(/^[a-f0-9]{40,64}$/u), identity: z.string().regex(/^[a-f0-9]{64}$/u), createdAt: TimestampSchema,
  state: z.enum(['creating', 'ready', 'retained', 'cleaned']), files: z.array(z.strictObject({ path: z.string().max(300), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })).max(20) });
type WorkspaceOptions = { homes: Homes; git: ThreadGit; redactor: SecretRedactor; projectId: string; workId: string; cwd: string; commit: string;
  snapshot: CheckInputSnapshot; secrets: Record<string, string>; ports?: readonly LandingCheckPort[]; signal?: AbortSignal };
/** A detached candidate with explicit check files and an empty home. The author's checkout is never changed. */
export class ProjectCheckWorkspace {
  readonly cwd: string; readonly home: string; readonly root: string; readonly environment: Record<string, string>;
  #ports: number[] = [];
  get ports(): readonly number[] { return this.#ports; }
  readonly #id: string; readonly #createdAt = new Date().toISOString(); readonly #files: Array<{ path: string; sha256: string }> = [];
  private constructor(readonly options: WorkspaceOptions) {
    this.environment = projectCheckEnvironment(options.snapshot.profile, options.secrets, options.redactor);
    this.#id = newId('check'); this.root = options.homes.ensure('tmp', 'checks', this.#id); this.cwd = join(this.root, 'checkout');
    this.home = join(this.root, 'home'); mkdirSync(this.home, { mode: 0o700 });
  }
  #receipt(state: z.infer<typeof WorkspaceReceipt>['state']) {
    writeDocument(join(this.root, 'workspace.json'), WorkspaceReceipt, { schema: 'project-check-workspace-v1', id: this.#id, projectId: this.options.projectId,
      workId: this.options.workId, commit: this.options.commit, identity: this.options.snapshot.identity, createdAt: this.#createdAt, state, files: this.#files });
  }
  static async create(options: WorkspaceOptions): Promise<ProjectCheckWorkspace> {
    const result = new ProjectCheckWorkspace(options); result.#receipt('creating');
    try {
      await options.git.run(options.cwd, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'worktree', 'add', '--detach', result.cwd, options.commit], { ...(options.signal ? { signal: options.signal } : {}) });
      result.#files.push(...await stageProjectCheckFiles(options.snapshot, result.cwd, options.git, options.commit));
      result.#receipt('ready'); return result;
    } catch (error) { await result.close(); throw error; }
  }
  clean(): Promise<boolean> { return checkCheckoutClean(this.options.git, this.cwd, this.options.commit, this.#files); }
  async run(command: string, options: ProjectCheckCommandOptions) {
    const allowed = new Set(['JEVELLAN_GATE_INPUT', 'JEVELLAN_GATE_CANDIDATE', 'JEVELLAN_GATE_CANDIDATE_COMMIT', 'JEVELLAN_GATE_BASE_COMMIT', 'JEVELLAN_GATE_RESULT']);
    if (Object.keys(options.gitEnv ?? {}).some(name => !allowed.has(name)) || options.jobContext?.deployment) throw new CheckEnvironmentBlocked('The check environment received an unsupported command context.');
    const resources = await landingCheckEnvironment(this.environment, this.options.ports); this.#ports = resources.ports;
    return runThreadCommand(this.cwd, command, { ...options, homes: this.options.homes, workId: this.options.workId, redactor: this.options.redactor,
      commandHome: this.home, projectEnv: resources.environment, minimal: true, environmentScope: 'command',
      ...(options.jobContext ? { jobContext: { ...options.jobContext, purpose: 'check', workspace: this.root, commandCheckout: this.cwd } } : {}) });
  }
  async close(): Promise<boolean> {
    try {
      for (const file of this.#files) {
        const path = confined(this.cwd, file.path);
        if (!existsSync(path) || !lstatSync(path).isFile() || await fileHash(path) !== file.sha256) { this.#receipt('retained'); return false; }
      }
      if (!await this.clean()) { this.#receipt('retained'); return false; }
      for (const file of this.#files) rmSync(confined(this.cwd, file.path));
      const removed = await this.options.git.run(this.options.cwd, ['worktree', 'remove', this.cwd], { permitted: [1, 128] });
      if (removed.code !== 0) { this.#receipt('retained'); return false; }
      if (realpathSync(this.home) !== this.home || !lstatSync(this.home).isDirectory()) { this.#receipt('retained'); return false; }
      rmSync(this.home, { recursive: true }); this.#receipt('cleaned'); return true;
    } catch { this.#receipt('retained'); return false; }
  }
}
