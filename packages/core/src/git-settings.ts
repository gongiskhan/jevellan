import type { Homes } from './homes.js';
import { resolveProjectPath } from './homes.js';
import { readDocument, writeDocument } from './files.js';
import { GitCheckSchema, GitSettingsSchema } from './git-settings-schemas.js';
import { gitEnvironment, runOwnedCommand } from './command.js';
import { SecretRedactor } from './environment.js';
import type { Project } from './schemas.js';

/** Per-device preferences. Native Git configuration and credentials are never written. */
export class GitSettings {
  constructor(readonly homes: Homes) {}
  get() {
    try { return readDocument(this.homes.at('git-settings.json'), GitSettingsSchema); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return GitSettingsSchema.parse({ schema: 'git-settings-v1', revision: 0, githubTransport: 'machine' });
    }
  }
  save(raw: unknown) {
    const input = GitSettingsSchema.parse(raw); const current = this.get();
    if (input.revision !== current.revision) throw Object.assign(new Error('Git settings changed. Reload and try again.'), { status: 409 });
    return writeDocument(this.homes.at('git-settings.json'), GitSettingsSchema, { ...input, revision: current.revision + 1 });
  }
  environment() {
    const env = gitEnvironment();
    if (this.get().githubTransport === 'ssh') {
      // Command-scoped rewrites keep project remotes and native configuration intact.
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'url.git@github.com:.insteadOf';
      env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
      env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oUpdateHostKeys=no';
    }
    return env;
  }
  async check(project: Project, deviceId: string, redactor = new SecretRedactor()) {
    const cwd = resolveProjectPath(project, deviceId); const env = this.environment();
    const base = { schema: 'git-check-v1', projectId: project.id, checkedAt: new Date().toISOString() };
    const names = await runOwnedCommand('git', ['remote'], { cwd, env, redactor });
    if (names.code !== 0) throw new Error('Could not inspect the project Git repository.');
    if (!names.stdout.trim().split('\n').includes('origin')) return GitCheckSchema.parse({ ...base, status: 'local', remote: null, transport: 'none', message: 'No origin remote is configured for this checkout.' });
    const configured = await runOwnedCommand('git', ['remote', 'get-url', 'origin'], { cwd, env, redactor, redactOutput: false });
    if (configured.code !== 0) throw new Error('Could not read the origin remote.');
    const remote = configured.stdout.trim();
    if (redactor.text(remote) !== remote || /^https?:\/\//i.test(remote) && (new URL(remote).username || new URL(remote).password)) throw new Error('Remove credentials from the origin URL. Use a Git credential helper or SSH.');
    const transport = /^(?:ssh:\/\/|[^/:\s]+@[^:\s]+:)/.test(remote) ? 'ssh' : remote.startsWith('https://') ? 'https' : 'other';
    const result = await runOwnedCommand('git', ['ls-remote', 'origin'], { cwd, env, redactor, timeoutMs: 15_000 });
    return GitCheckSchema.parse({ ...base, remote, transport, status: result.code === 0 ? 'ready' : 'failed',
      message: result.code === 0 ? 'Connected. Jevellan can read this remote. Push permission is checked when publishing.'
        : gitFailureMessage(result.timedOut ? 'The remote connection timed out.' : result.stderr.trim(), redactor) });
  }
}

export function gitFailureMessage(stderr: string, redactor = new SecretRedactor()): string {
  const message = redactor.text(stderr);
  if (/could not read Username|terminal prompts disabled|-25308|Authentication failed|Permission denied \(publickey\)/i.test(message)) {
    return 'Git authentication is unavailable to Jevellan on this device. Open Settings → Git, choose the connection method and check this project, then retry. ' + message;
  }
  return message;
}
