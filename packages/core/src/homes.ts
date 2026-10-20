import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { IdSchema, type Project } from './schemas.js';

/** Accounts that run in a folder the owner already logged in, used where it is: no copy, no rigging, no login through Jevellan. */
export const InPlaceHomesSchema = z.strictObject({ schema: z.literal('in-place-homes-v1'), homes: z.record(z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u), z.string().min(1)) });
export type InPlaceHomes = z.infer<typeof InPlaceHomesSchema>;

export function resolvedPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(resolvedPath(parent), basename(absolute));
  }
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

export class Homes {
  readonly root: string;
  readonly userHome: string;
  constructor(root = process.env.JEVELLAN_HOME || join(homedir(), '.jevellan'), userHome = homedir()) {
    this.userHome = resolvedPath(userHome);
    this.root = resolvedPath(root);
    if (this.root === '/' || inside(this.root, this.userHome)) throw new Error('Jevellan requires its own data directory.');
    for (const name of ['.claude', '.codex', '.cursor', '.gemini', '.basic-memory']) {
      const native = resolvedPath(join(this.userHome, name));
      if (inside(native, this.root) || inside(this.root, native)) throw new Error('Jevellan cannot use a native agent or memory home.');
    }
  }
  at(...parts: string[]): string {
    const candidate = resolvedPath(resolve(this.root, ...parts));
    if (!inside(this.root, candidate)) throw new Error('Path escapes the Jevellan home.');
    return candidate;
  }
  ensure(...parts: string[]): string {
    const path = this.at(...parts);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory()) throw new Error('Expected a Jevellan directory.');
    chmodSync(path, 0o700);
    return path;
  }
  /** The owner's own folder registered for this account, or undefined when Jevellan owns the account's home. */
  inPlace(runtime: string, accountId: string): string | undefined {
    const file = join(this.root, 'homes', 'in-place.json');
    if (!existsSync(file)) return undefined;
    const path = InPlaceHomesSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).homes[`${IdSchema.parse(runtime)}/${IdSchema.parse(accountId)}`];
    return path === undefined ? undefined : resolvedPath(path);
  }
  /** Whether a folder is registered as some account's in-place folder. */
  isInPlaceFolder(folder: string): boolean {
    const file = join(this.root, 'homes', 'in-place.json');
    if (!existsSync(file)) return false;
    const path = resolvedPath(folder);
    return Object.values(InPlaceHomesSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).homes).some(entry => resolvedPath(entry) === path);
  }
  registerInPlace(runtime: string, accountId: string, folder: string): string {
    IdSchema.parse(runtime); IdSchema.parse(accountId);
    if (!isAbsolute(folder)) throw new Error('An in-place account folder must be an absolute path.');
    const path = resolvedPath(folder);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error(`${path} is not a folder.`);
    if (inside(this.root, path) || inside(path, this.root) || path === this.userHome) throw new Error('An in-place account folder must be outside the Jevellan home.');
    const file = join(this.ensure('homes'), 'in-place.json');
    const current = existsSync(file) ? InPlaceHomesSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : { schema: 'in-place-homes-v1' as const, homes: {} };
    const next = InPlaceHomesSchema.parse({ ...current, homes: { ...current.homes, [`${runtime}/${accountId}`]: path } });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); renameSync(`${file}.tmp`, file);
    return path;
  }
  account(runtime: string, accountId: string): string {
    IdSchema.parse(runtime); IdSchema.parse(accountId);
    const own = this.inPlace(runtime, accountId);
    if (own !== undefined) return own;
    const expected = join(this.root, 'homes', runtime, accountId);
    if (resolvedPath(expected) !== expected) throw new Error('Account homes cannot alias another directory.');
    this.ensure();
    return this.ensure('homes', IdSchema.parse(runtime), IdSchema.parse(accountId));
  }
}

const notCheckedOut = (project: Project, deviceName: string, path: string | undefined) => `Project ${project.name} isn't checked out on ${deviceName} at ${path ?? '(no path)'}.`;
/**
 * Why the project has no usable path on a device, from the settings alone (no path, a relative one, or a device the project does not
 * allow), with `resolveProjectPath`'s own sentence; undefined when only the checkout itself is left to check.
 */
export function projectPathProblem(project: Project, deviceId: string, deviceName = deviceId): string | undefined {
  const path = project.paths[deviceId];
  if (!path || !isAbsolute(path)) return notCheckedOut(project, deviceName, path);
  if (project.allowedDevices && !project.allowedDevices.includes(deviceId)) return `${project.name} isn't set up on ${deviceName}. Add its path in Settings → Projects, or switch device.`;
  return undefined;
}
export function resolveProjectPath(project: Project, deviceId: string, deviceName = deviceId): string {
  const path = project.paths[deviceId];
  const failure = () => new Error(notCheckedOut(project, deviceName, path));
  const problem = projectPathProblem(project, deviceId, deviceName);
  if (problem !== undefined || path === undefined) throw new Error(problem ?? notCheckedOut(project, deviceName, path));
  try {
    const cwd = realpathSync(path);
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } }).trim();
    if (realpathSync(root) !== cwd) throw failure();
    return cwd;
  } catch { throw failure(); }
}

/** The same checkout boundary for background discovery, without holding HTTP behind Git. */
export async function resolveProjectPathAsync(project: Project, deviceId: string, deviceName = deviceId): Promise<string> {
  const path = project.paths[deviceId];
  const failure = () => new Error(notCheckedOut(project, deviceName, path));
  const problem = projectPathProblem(project, deviceId, deviceName);
  if (problem !== undefined || path === undefined) throw new Error(problem ?? notCheckedOut(project, deviceName, path));
  try {
    const cwd = await realpath(path);
    const { stdout } = await promisify(execFile)('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } });
    if (await realpath(stdout.trim()) !== cwd) throw failure();
    return cwd;
  } catch { throw failure(); }
}
