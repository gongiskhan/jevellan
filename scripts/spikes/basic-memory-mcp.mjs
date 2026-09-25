import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = await mkdtemp(join(tmpdir(), 'jevellan-memory-mcp-'));
const env = { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), BASIC_MEMORY_CONFIG_DIR: join(root, 'config'),
  BASIC_MEMORY_AUTO_UPDATE: 'false', BASIC_MEMORY_FORCE_LOCAL: 'true', BASIC_MEMORY_EXPLICIT_ROUTING: 'true', BASIC_MEMORY_SYNC_CHANGES: 'false', BASIC_MEMORY_LOGFIRE_ENABLED: 'false',
  BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED: 'false', BASIC_MEMORY_DISABLE_PERMALINKS: 'true', BASIC_MEMORY_ENSURE_FRONTMATTER_ON_SYNC: 'false', PYTHONDONTWRITEBYTECODE: '1' };
const clients = [];
async function open(project) {
  const client = new Client({ name: 'jevellan-memory-probe', version: '1.0.0' }); clients.push(client);
  await client.connect(new StdioClientTransport({ command: 'basic-memory', args: ['mcp', ...(project ? ['--project', project] : [])], env: { ...env, ...(project ? { BASIC_MEMORY_MCP_PROJECT: project } : {}) }, stderr: 'pipe' }));
  return client;
}
async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: { ...args, output_format: 'json' } }, undefined, { timeout: 30_000 });
  assert(!response.isError, `${name} failed.`);
  return response.structuredContent ?? JSON.parse(response.content.find((item) => item.type === 'text').text);
}
try {
  await mkdir(env.HOME); await mkdir(env.BASIC_MEMORY_CONFIG_DIR);
  const manager = await open();
  const created = await call(manager, 'create_memory_project', { project_name: 'jv-fixture', project_path: join(root, 'notes') });
  await manager.close();
  const project = await open('jv-fixture');
  const written = await call(project, 'write_note', { title: 'Vitest convention', directory: '', content: 'This fixture uses Vitest globals.', overwrite: false });
  const reference = written.result.permalink ?? written.result.file_path;
  const read = await call(project, 'read_note', { identifier: reference });
  const search = await call(project, 'search_notes', { query: 'Vitest', search_type: 'text', page_size: 12 });
  const edited = await call(project, 'edit_note', { identifier: reference, operation: 'append', content: '\nKeep the public signature.' });
  assert(created.result.created && read.result.content.includes('Vitest globals') && search.result.results.length === 1 && !edited.result.fileCreated, 'The isolated memory operations did not preserve one note.');
  console.log(JSON.stringify({ schema: 'basic-memory-mcp-spike-v1', evidence: 'installed-basic-memory-isolated', projectCreated: true, noteWritten: true, exactReferenceRead: true, noteFound: true, existingNoteEdited: true, passed: true }, null, 2));
} finally { await Promise.all(clients.map((client) => client.close())); await rm(root, { recursive: true, force: true }); }
