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

/**
 * The first-run answers an interactive Claude Code session Jevellan starts (the bridge, a takeover) needs in its account's `.claude.json`, so
 * it reaches its prompt without a person: onboarding (theme picker, security notes) done, and the fullscreen-renderer offer already seen
 * (Claude Code 2.1.305 stops offering it once `fullscreenUpsellSeenCount` reaches its limit).
 */
export const CLAUDE_FIRST_RUN_SETTLED = { hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 100 } as const;
/** Whether an account's preferences already carry the first-run answers. */
export const claudeFirstRunSettled = (value: Record<string, unknown>): boolean =>
  value.hasCompletedOnboarding === true && typeof value.fullscreenUpsellSeenCount === 'number' && value.fullscreenUpsellSeenCount >= CLAUDE_FIRST_RUN_SETTLED.fullscreenUpsellSeenCount;
