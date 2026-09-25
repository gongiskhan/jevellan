import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inside } from '@jevellan/core';

/** Preserve the project path as one TOML key, including dots and symlinks. */
export function projectTrustOverride(cwd: string): string {
  return `projects={${JSON.stringify(realpathSync(cwd))}={trust_level="untrusted"}}`;
}

/** Supply project instructions without enabling project configuration or hooks. */
export function projectInstructions(cwd: string): string {
  const root = realpathSync(cwd); const path = join(root, 'AGENTS.md');
  if (!existsSync(path)) return '';
  if (!inside(root, realpathSync(path))) throw new Error('Project AGENTS.md must resolve inside the project.');
  if (!statSync(path).isFile() || statSync(path).size > 32_768) throw new Error('Project AGENTS.md must be a file of at most 32768 bytes.');
  return readFileSync(path, 'utf8');
}
