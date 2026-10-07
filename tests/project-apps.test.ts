import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, SecretRedactor } from '../packages/core/dist/index.js';
import { ProjectApps, tailnetAppPublisher, type AppPublisher } from '../packages/projects/dist/index.js';
let root = ''; let apps: ProjectApps | undefined;
afterEach(async () => { await apps?.close(); apps = undefined; if (root) await rm(root, { recursive: true, force: true }); root = ''; });
const local: AppPublisher = { publish: async port => ({ access: 'local', url: `http://127.0.0.1:${port}/` }), remove: async () => undefined };
async function setup(publisher = local) {
  root = await mkdtemp(join(tmpdir(), 'jevellan-app-test-')); const directory = join(root, 'project'); await mkdir(directory);
  await writeFile(join(directory, 'index.html'), '<script src="/app.js"></script>Todo'); await writeFile(join(directory, 'app.js'), 'console.log("todo")');
  apps = new ProjectApps(new Homes(join(root, 'home'), join(root, 'user')), publisher, new SecretRedactor());
  return { directory, scope: { projectId: 'project_fixture', threadId: 'thread_fixture', cwd: directory, projectDirectory: directory } };
}
test('a static app keeps serving absolute assets after the caller ends and repeated starts reuse its link', async () => {
  const { scope, directory } = await setup();
  const app = await apps!.start(scope, { kind: 'static' });
  expect(await (await fetch(app.url)).text()).toContain('Todo'); expect(await (await fetch(app.url + 'app.js')).text()).toContain('console.log');
  expect(await apps!.start(scope, { kind: 'static' })).toEqual(app);
  await writeFile(join(directory, '.secret.json'), 'hidden'); await writeFile(join(root, 'outside.json'), 'outside'); await symlink(join(root, 'outside.json'), join(directory, 'escape.json'));
  for (const asset of ['.secret.json', 'escape.json']) expect((await fetch(app.url + asset)).status).toBe(404);
  await expect(apps!.stop('other_project', app.id)).rejects.toThrow('does not belong');
  expect((await apps!.stop(scope.projectId, app.id)).state).toBe('stopped'); await expect(fetch(app.url)).rejects.toThrow();
});
test('a command app has an isolated home, no inherited credentials, and stops its process separately from a model turn', async () => {
  const { scope, directory } = await setup();
  await writeFile(join(directory, 'server.mjs'), `import {createServer} from 'node:http'; createServer((req,res)=>res.end(JSON.stringify({home:process.env.HOME, token:!!process.env.JEVELLAN_TEST_CODEX_KEY, authorization:req.headers.authorization,cookie:req.headers.cookie}))).listen(Number(process.env.PORT),process.env.HOST);`);
  const app = await apps!.start(scope, { kind: 'command', command: process.execPath, args: ['server.mjs'] });
  const body = await (await fetch(app.url, { headers: { authorization: 'Bearer fake', cookie: 'jevellan_session=fixture; app_theme=dark' } })).json();
  expect(body).toEqual({ home: await realpath(join(root, 'home', 'apps', app.id, 'home')), token: false, cookie: 'app_theme=dark' });
  expect(JSON.parse(await readFile(join(root, 'home', 'apps', app.id, 'app.json'), 'utf8')).native).toHaveProperty('startIdentity');
  await apps!.stop(scope.projectId, app.id); await expect(fetch(app.url)).rejects.toThrow();
});
test('an unavailable published link cleans up its owned route and server', async () => {
  let removed = 0; const { scope } = await setup({ publish: async port => ({ access: 'tailnet', url: `http://127.0.0.1:${port}/missing`, httpsPort: 9600 }), remove: async app => { expect(app.loopbackPort).not.toBe(9600); removed++; } });
  await expect(apps!.start(scope, { kind: 'static' })).rejects.toThrow('did not answer'); expect(removed).toBe(1); expect(apps!.list(scope.projectId)).toEqual([]);
});
test('tailnet publication skips occupied ports, preserves existing routes and removes only its own route', async () => {
  const original = { TCP: { '9444': { HTTPS: true }, '9600': { HTTPS: true } }, Web: { 'device.tail.ts.net:9444': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9773' } } } } };
  const state = structuredClone(original) as { TCP: Record<string, unknown>; Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> };
  const calls: string[][] = [];
  const publisher = tailnetAppPublisher(async () => 'https://device.tail.ts.net:9444', async args => {
    calls.push(args); if (args[1] === 'status') return JSON.stringify(state);
    const port = args.find(arg => arg.startsWith('--https='))!.split('=')[1]!;
    if (args.at(-1) === 'off') { delete state.Web[`device.tail.ts.net:${port}`]; delete state.TCP[port]; }
    else { state.TCP[port] = { HTTPS: true }; state.Web[`device.tail.ts.net:${port}`] = { Handlers: { '/': { Proxy: args.at(-1)! } } }; }
    return '';
  });
  const { scope } = await setup(); const link = await publisher.publish(23456);
  expect(link.url).toBe('https://device.tail.ts.net:9601/'); expect(state.Web['device.tail.ts.net:9444']).toEqual(original.Web['device.tail.ts.net:9444']);
  const app = await apps!.start(scope, { kind: 'static' }); const published = { ...app, ...link, loopbackPort: 23456 };
  state.Web['device.tail.ts.net:9601']!.Handlers['/']!.Proxy = 'http://127.0.0.1:9999'; await publisher.remove(published);
  expect(calls.some(args => args.at(-1) === 'off')).toBe(false);
  state.Web['device.tail.ts.net:9601']!.Handlers['/']!.Proxy = 'http://127.0.0.1:23456'; await publisher.remove(published); expect(state).toEqual(original);
});

test('command apps forward WebSocket upgrades and close upgraded connections when stopped', async () => {
  const { scope, directory } = await setup();
  await writeFile(join(directory, 'socket.mjs'), `import {createServer} from 'node:http'; import {createHash} from 'node:crypto';
const server=createServer((req,res)=>res.end('ready')); server.on('upgrade',(req,socket)=>{const key=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');socket.write(Buffer.from([129,5,104,101,108,108,111]));});server.listen(Number(process.env.PORT),process.env.HOST);`);
  const app = await apps!.start(scope, { kind: 'command', command: process.execPath, args: ['socket.mjs'] });
  const socket = new WebSocket(app.url.replace('http:', 'ws:'));
  const message = new Promise<string>((resolve, reject) => { socket.onmessage = event => resolve(String(event.data)); socket.onerror = () => reject(new Error('WebSocket failed')); });
  expect(await message).toBe('hello'); const closed = new Promise<void>(resolve => { socket.onclose = () => resolve(); });
  await apps!.stop(scope.projectId, app.id); await closed;
});

test('a delayed old-process exit cannot stop the replacement app with the same id', async () => {
  const { scope, directory } = await setup();
  await writeFile(join(directory, 'restart.mjs'), `import {createServer} from 'node:http';let ready=true;createServer((req,res)=>{if(req.url==='/unhealthy')ready=false;res.statusCode=ready?200:503;res.end(ready?'ready':'unhealthy');}).listen(Number(process.env.PORT),process.env.HOST);`);
  const input = { kind: 'command', command: process.execPath, args: ['restart.mjs'] };
  const old = await apps!.start(scope, input); await (await fetch(old.url + 'unhealthy')).body?.cancel();
  const replacement = await apps!.start(scope, input); expect(replacement.id).toBe(old.id); expect(replacement.url).not.toBe(old.url);
  // Drain queued exit handling through the same serialized service without changing this project's app.
  await expect(apps!.stop('other_project', old.id)).rejects.toThrow('does not belong');
  expect(apps!.list(scope.projectId)).toMatchObject([{ id: old.id, state: 'running', url: replacement.url }]);
  expect(await (await fetch(replacement.url)).text()).toBe('ready');
});
