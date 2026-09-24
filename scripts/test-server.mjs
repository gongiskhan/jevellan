import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Homes } from '../packages/core/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

// Browser tests never start the application in the developer's real data home.
const root = mkdtempSync(join(tmpdir(), 'jevellan-browser-'));
mkdirSync(join(root, 'user'));
const application = new Application({ homes: new Homes(join(root, 'user', '.jevellan'), join(root, 'user')), port: 19771 });
const server = createDaemon({ application });
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => server.close(resolve));
  await application.close();
  await rm(root, { recursive: true, force: true });
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
server.listen(19771, '127.0.0.1');
