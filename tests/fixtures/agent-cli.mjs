// A simulated interactive `claude` or `codex` CLI for terminal takeover (brief phase 7, PJ7). It never contacts a provider and never
// records an environment value: its log (one JSON line per event) holds the `--help` probe, a resumed run (argv, the names of its
// environment variables, a digest of the authentication variable, the working directory, whether stdin is a terminal and the new
// session id), every signal and its exit. A resumed run writes a new native session in the account home it was given (as a CLI that
// forks the session on resume does), echoes its argv and every stdin line, and exits on a line `exit <code>`. A signal is logged and
// then ends the process by that signal 300 ms later, so a signal sent twice shows twice in the log.
//
// The test writes `claude` and `codex` executables on a temporary PATH that import this module and call `run({ name, log, effort })`:
// the attach command passes only a minimal environment, so the log path cannot travel through it.
import { appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { writeFakeNativeSession } from '../../packages/runtime-contract/dist/fake-native.js';

const help = (name, effort) => name === 'claude'
  ? ['Usage: claude [options] [command] [prompt]', '', 'Options:', ...(effort ? ['  --effort <level>        Effort level for the current session (low, medium, high, xhigh, max)'] : []),
    '  --model <model>         Model for the current session.', '  -r, --resume [value]    Resume a session by its id.', '']
  : ['Usage: codex [OPTIONS] [PROMPT]', '', 'Commands:', '  resume  Resume a previous interactive session', ''];

export function run({ name, log, effort = true }) {
  const args = process.argv.slice(2);
  const record = (entry) => appendFileSync(log, `${JSON.stringify({ name, pid: process.pid, ...entry })}\n`);
  if (args.length === 1 && args[0] === '--help') { record({ kind: 'help' }); process.stdout.write(help(name, effort).join('\n')); return; }
  // Signal handlers come first: a test signals as soon as it sees the run record or the echo below.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      record({ kind: 'signal', signal });
      setTimeout(() => { process.removeAllListeners(signal); process.kill(process.pid, signal); }, 300);
    });
  }
  const home = name === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  if (!home) { record({ kind: 'no-home' }); process.exit(70); }
  const sessionId = randomUUID(), auth = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  writeFakeNativeSession({ format: name, home, sessionId, cwd: process.cwd(), append: false,
    rows: [{ role: 'user', text: 'Worked on the thread in a terminal.' }, { role: 'assistant', text: 'Done in the terminal.' }] });
  record({ kind: 'run', argv: args, envKeys: Object.keys(process.env).sort(), cwd: process.cwd(), tty: process.stdin.isTTY === true, sessionId,
    ...(auth ? { authDigest: createHash('sha256').update(auth).digest('hex') } : {}) });
  console.log(`agent-cli ${name} started: ${args.join(' ')}`);
  createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
    const exit = /^exit (\d+)$/u.exec(line.trim());
    if (exit) { record({ kind: 'exit', code: Number(exit[1]) }); process.exit(Number(exit[1])); }
    console.log(`agent-cli ${name} heard: ${line.trim()}`);
  });
}
