#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const session = '11111111-1111-4111-8111-111111111111';
const end = () => send({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'fixture', modelUsage: { fixture: { inputTokens: 11, outputTokens: 3, cacheReadInputTokens: 2, cacheCreationInputTokens: 0, costUSD: 0, costBasis: 'unknown' } } });
let timer;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { commands: [], models: [{ value: 'fixture', resolvedModel: 'fixture-model', displayName: 'Fixture', supportedEffortLevels: ['low', 'high'] }], account: {} } : {} } });
    if (message.request.subtype === 'interrupt') { clearTimeout(timer); end(); }
  }
  if (message.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: session });
    send({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'fixture' } }] } });
    const finish = () => {
      send({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'fixture', is_error: false }] } });
      send({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: process.argv.some((arg) => arg.startsWith('--resume=')) ? 'remembered-fixture' : 'fixture-answer' } } });
      end();
    };
    if (JSON.stringify(message).includes('WAIT_FOR_INTERRUPT')) timer = setTimeout(finish, 30_000); else finish();
  }
});
