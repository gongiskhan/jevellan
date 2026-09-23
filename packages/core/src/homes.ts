import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { IdSchema, type Project } from './schemas.js';

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
  account(runtime: string, accountId: string): string {
    IdSchema.parse(runtime); IdSchema.parse(accountId);
    this.ensure();
    return this.ensure('homes', IdSchema.parse(runtime), IdSchema.parse(accountId));
  }
}

export function resolveProjectPath(project: Project, deviceId: string, deviceName = deviceId): string {
  const path = project.paths[deviceId];
  const failure = () => new Error(`Project ${project.name} isn't checked out on ${deviceName} at ${path ?? '(no path)'}.`);
  if (!path || !isAbsolute(path)) throw failure();
  if (project.allowedDevices && !project.allowedDevices.includes(deviceId)) throw new Error(`${project.name} isn't set up on ${deviceName}. Add its path in Settings → Projects, or switch device.`);
  try {
    const cwd = realpathSync(path);
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } }).trim();
    if (realpathSync(root) !== cwd) throw failure();
    return cwd;
  } catch { throw failure(); }
}
