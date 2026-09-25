import { spawnGroup, terminateGroup } from './process-group.js';
import { SecretRedactor } from './environment.js';

export type CommandResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export async function runOwnedCommand(command: string, args: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs?: number; redactor?: SecretRedactor; redactOutput?: boolean; input?: string; signal?: AbortSignal }): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const { child, native } = await spawnGroup(command, args, { cwd: options.cwd, env: options.env ?? {} });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk)); child.stdin.on('error', () => {}); child.stdin.end(options.input);
  let timedOut = false; let cleanup: Promise<void> | undefined; let cleanupError: unknown;
  let fail!: (error: Error) => void;
  const completion = new Promise<number>((resolve, reject) => {
    fail = reject; child.once('close', (value) => resolve(value ?? 1)); child.once('error', reject);
  });
  const stop = () => { cleanup ??= terminateGroup(native).catch((error: unknown) => { cleanupError = error; fail(new Error('Command process cleanup could not be confirmed.')); }); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 30_000);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  let code: number;
  try { code = await completion; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); await cleanup; await terminateGroup(native); }
  if (cleanupError) throw new Error('Command process cleanup could not be confirmed.');
  options.signal?.throwIfAborted();
  const redactor = options.redactor ?? new SecretRedactor();
  const output = (chunks: Buffer[]) => options.redactOutput === false ? Buffer.concat(chunks).toString('utf8') : redactor.text(Buffer.concat(chunks).toString('utf8'));
  return { code: timedOut && code === 0 ? 124 : code, stdout: output(stdout), stderr: output(stderr), timedOut };
}
export function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const name of ['PATH', 'HOME', 'USER', 'LANG', 'SSH_AUTH_SOCK']) if (process.env[name]) env[name] = process.env[name]!;
  return env;
}
