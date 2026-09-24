import { spawn } from 'node:child_process';
import { serveWorker } from '../../packages/runtime-contract/dist/index.js';

serveWorker((input) => {
  let finish;
  return {
    async interrupt() { finish?.(); },
    async run(message, _timeout, emit, session) {
      session('fixture-session');
      if (message.includes('wait-for-interrupt')) {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        emit({ type: 'tool-start', id: 'waiting', name: 'Fixture child', input: { pid: child.pid } });
        await new Promise((resolve) => { finish = resolve; });
        return { status: 'interrupted' };
      }
      emit({ type: 'text', delta: JSON.stringify({ keys: Object.keys(process.env), inputEnv: input.account.env, launchEnv: input.launch.env, mcp: input.launch.mcpServers, argv: process.argv.slice(2), token: process.env.JEVELLAN_STRETCH_TOKEN ?? '' }) });
      emit({ type: 'usage', inputTokens: 1, outputTokens: 1 });
      return { status: 'completed' };
    },
  };
});
