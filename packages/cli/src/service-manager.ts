import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { resolvedPath } from '@jevellan/core';
import { z } from 'zod';

const line = z.string().min(1).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Expected a single line.');
const absolute = line.refine(isAbsolute, 'Expected an absolute path.');
export const ServiceSpecSchema = z.strictObject({
  schema: z.literal('service-spec-v1'),
  node: absolute,
  entry: absolute,
  home: absolute,
  path: line,
  port: z.number().int().min(1).max(65535),
});
export type ServiceSpec = z.infer<typeof ServiceSpecSchema>;
export const ServiceDefinitionSchema = z.strictObject({
  schema: z.literal('service-definition-v1'),
  platform: z.enum(['darwin', 'linux']),
  path: absolute,
  spec: ServiceSpecSchema,
});
export type ServiceDefinition = z.infer<typeof ServiceDefinitionSchema>;
export interface ServiceManager {
  definition(spec: ServiceSpec): ServiceDefinition;
  start(definition: ServiceDefinition): Promise<void>;
  stop(definition: ServiceDefinition): Promise<void>;
  removed(): Promise<void>;
}

function xml(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}
function unitValue(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/%/gu, '%%')}"`;
}

export function serviceContents(input: ServiceDefinition): string {
  const { platform, spec } = ServiceDefinitionSchema.parse(input);
  const args = [spec.node, spec.entry, 'start', '--port', String(spec.port)];
  const cwd = dirname(dirname(spec.entry));
  if (platform === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.jevellan.daemon</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(cwd)}</string>
<key>EnvironmentVariables</key><dict><key>JEVELLAN_HOME</key><string>${xml(spec.home)}</string><key>PATH</key><string>${xml(spec.path)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(spec.home, 'logs', 'daemon.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(spec.home, 'logs', 'daemon.log'))}</string>
</dict></plist>
`;
  // ':' disables environment expansion in ExecStart; %% preserves literal percent signs.
  return `[Unit]
Description=Jevellan
After=network.target

[Service]
Type=exec
WorkingDirectory=${unitValue(cwd)}
ExecStart=:${args.map(unitValue).join(' ')}
Environment=${unitValue(`JEVELLAN_HOME=${spec.home}`)} ${unitValue(`PATH=${spec.path}`)}
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
`;
}

export type ServiceCommand = (command: string, args: readonly string[]) => Promise<number>;
export const runServiceCommand: ServiceCommand = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  // Native manager output can contain environment details. Only the exit status is used.
  child.stdout.resume(); child.stderr.resume();
  child.once('error', reject);
  child.once('exit', code => resolve(code ?? 1));
});

/** File creation/removal and the manifest belong to the installer. This adapter only manages its exact service. */
export class UserServiceManager implements ServiceManager {
  private readonly path: string;
  private readonly domain: string;
  constructor(private readonly options: { platform: 'darwin' | 'linux'; userHome: string; uid: number; run: ServiceCommand }) {
    absolute.parse(options.userHome); z.number().int().nonnegative().parse(options.uid);
    this.path = options.platform === 'darwin'
      ? join(options.userHome, 'Library', 'LaunchAgents', 'dev.jevellan.daemon.plist')
      : join(options.userHome, '.config', 'systemd', 'user', 'jevellan.service');
    this.domain = `gui/${options.uid}`;
  }
  definition(spec: ServiceSpec): ServiceDefinition {
    return ServiceDefinitionSchema.parse({ schema: 'service-definition-v1', platform: this.options.platform, path: this.path, spec });
  }
  private verify(input: ServiceDefinition): ServiceDefinition {
    const definition = ServiceDefinitionSchema.parse(input);
    if (definition.platform !== this.options.platform || definition.path !== this.path || resolvedPath(this.path) !== this.path) throw new Error('The service path does not belong to this installation.');
    if (readFileSync(this.path, 'utf8') !== serviceContents(definition)) throw new Error('The service definition has changed outside Jevellan.');
    return definition;
  }
  private async command(args: readonly string[]): Promise<void> {
    const command = this.options.platform === 'darwin' ? '/bin/launchctl' : 'systemctl';
    const code = await this.options.run(command, args);
    if (code !== 0) throw new Error(`Jevellan's service manager failed (${command}, exit ${code}).`);
  }
  async start(input: ServiceDefinition): Promise<void> {
    const definition = this.verify(input);
    if (this.options.platform === 'darwin') {
      const target = `${this.domain}/dev.jevellan.daemon`;
      if (await this.options.run('/bin/launchctl', ['print', target]) !== 0) await this.command(['bootstrap', this.domain, definition.path]);
      await this.command(['kickstart', target]);
    } else {
      await this.command(['--user', 'daemon-reload']);
      await this.command(['--user', 'enable', '--now', 'jevellan.service']);
    }
  }
  async stop(input: ServiceDefinition): Promise<void> {
    this.verify(input);
    if (this.options.platform === 'darwin') {
      const target = `${this.domain}/dev.jevellan.daemon`;
      const code = await this.options.run('/bin/launchctl', ['bootout', target]);
      if (code !== 0) {
        // Confirm an accessible GUI domain and an absent service, rather than ignoring every failure.
        await this.command(['print', this.domain]);
        if (await this.options.run('/bin/launchctl', ['print', target]) !== 113) throw new Error(`Could not stop Jevellan's service (exit ${code}).`);
      }
    } else await this.command(['--user', 'disable', '--now', 'jevellan.service']);
  }
  async removed(): Promise<void> {
    if (this.options.platform === 'linux') await this.command(['--user', 'daemon-reload']);
  }
}

export function nativeServiceManager(): ServiceManager {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Jevellan services require macOS or Linux.');
  if (!process.getuid) throw new Error('A user service identity is unavailable.');
  return new UserServiceManager({ platform: process.platform, userHome: resolvedPath(homedir()), uid: process.getuid(), run: runServiceCommand });
}
