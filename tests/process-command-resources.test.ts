import { expect, test } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { runOwnedCommand, rememberProcessTree, spawnGroup, terminateGroup, groupAlive } from '../packages/core/dist/index.js';

test.runIf(process.platform === 'linux')('completed empty command groups need no additional helper processes', async () => {
  const options = { cwd: process.cwd(), env: {} };
  await runOwnedCommand('/bin/echo', ['warm'], options);
  // Node22's documented child_process channel observes actual launches; no arguments or environments are retained.
  let launches = 0; const created = () => { launches++; }, processes = channel('child_process'); processes.subscribe(created);
  try {
    for (let n = 0; n < 8; n++) expect(await runOwnedCommand('/bin/echo', [String(n)], options)).toEqual({ code: 0, stdout: `${n}\n`, stderr: '', timedOut: false });
  } finally { processes.unsubscribe(created); }
  expect(launches, 'The observer must see every requested command.').toBeGreaterThanOrEqual(8);
  expect(launches, 'Confirming an already absent root and group must not fork another process.').toBeLessThanOrEqual(8);
});

test('a remembered detached descendant is still stopped after its original group exits', async () => {
  const program = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(child.pid);process.stdin.once('data',()=>process.exit(0));process.stdin.resume();`;
  const { child, native } = await spawnGroup(process.execPath, ['-e', program], { cwd: process.cwd(), env: {} });
  try {
    const [data] = await once(child.stdout, 'data'), descendant = Number(String(data).trim()); expect(Number.isSafeInteger(descendant)).toBe(true);
    await rememberProcessTree(native);
    const closed = once(child, 'close'); child.stdin.end('exit'); await closed;
    expect(groupAlive(native.pgid)).toBe(false); expect(groupAlive(descendant)).toBe(true);
    await terminateGroup(native, 100);
    expect(groupAlive(descendant)).toBe(false);
  } finally { await terminateGroup(native, 100); }
});
