import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether a Claude config folder holds an interactive claude.ai login, which remote control needs. Linux keeps it in the folder's
 * `.credentials.json`; macOS keeps it in the login keychain under "Claude Code-credentials-" and the first eight hex digits of the
 * folder path's SHA-256 (the default folder `~/.claude` uses the bare name). Only the entry's presence is read, never its value.
 */
export function hasInteractiveClaudeLogin(dir: string, platform: NodeJS.Platform = process.platform, keychain = keychainEntryExists): boolean {
  if (existsSync(join(dir, '.credentials.json'))) return true;
  if (platform !== 'darwin') return false;
  return keychain(`Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`);
}

export function keychainEntryExists(service: string): boolean {
  return spawnSync('/usr/bin/security', ['find-generic-password', '-s', service], { stdio: 'ignore', timeout: 5000 }).status === 0;
}
