import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EkoaToolDataSchema, EkoaUrlSchema, VERSION } from '@jevellan/core';
import { z } from 'zod';
export interface EkoaClient {
  tools: Set<string>;
  call(name: string, args: Record<string, unknown>): Promise<z.infer<typeof EkoaToolDataSchema>>;
  close(): Promise<void>;
}
export type EkoaConnector = (url: string, token: string) => Promise<EkoaClient>;
const requirements: Record<string, string[]> = { task_create: ['title', 'notes', 'labels'], task_update: ['id', 'title', 'notes', 'labels'], task_complete: ['id'], labels_list: [], label_create: ['name'], tasks_list: ['search', 'status', 'limit'], task_get: ['id'] };
export async function connectEkoa(rawUrl: string, token: string, fetcher: typeof fetch = fetch): Promise<EkoaClient> {
  const url = new URL(EkoaUrlSchema.parse(rawUrl)); const client = new Client({ name: 'jevellan', version: VERSION });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: async (target, init) => {
      if (new URL(target).origin !== url.origin) throw new Error('Ekoa redirected outside its MCP origin.');
      return fetcher(target, { ...init, redirect: 'error', signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10_000)]) });
    } });
  try {
    // SDK transport's optional sessionId getter conflicts with exactOptionalPropertyTypes.
    await client.connect(transport as Transport, { timeout: 10_000 });
    const tools = new Map<string, Record<string, unknown>>(); const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10_000 });
      if (tools.size + page.tools.length > 300) throw new Error('Ekoa offers too many tools.');
      for (const tool of page.tools) tools.set(tool.name, tool.inputSchema);
      if (page.nextCursor && (cursors.has(page.nextCursor) || cursors.size >= 10)) throw new Error('Ekoa repeated its tool cursor.');
      if (page.nextCursor) cursors.add(page.nextCursor); cursor = page.nextCursor;
    } while (cursor);
    for (const [name, fields] of Object.entries(requirements)) {
      const schema = tools.get(name); if (!schema) throw new Error(`Ekoa is missing ${name}; the mirror cannot safely create and recover its tasks.`);
      const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
      for (const field of fields) if (!(field in properties)) throw new Error(`Ekoa ${name} does not support ${field}.`);
    }
    return { tools: new Set(tools.keys()), close: () => client.close(), call: async (name, args) => {
      if (!tools.has(name)) throw new Error(`Ekoa is missing ${name}.`);
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
      const content = z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).parse(result.content);
      if (result.isError) throw new Error(content.find(block => block.type === 'text')?.text?.slice(0, 1200) ?? 'Ekoa refused this operation.');
      const first = content.find(block => block.type === 'text')?.text;
      const data: unknown = result.structuredContent ?? (first ? JSON.parse(first) : undefined);
      return EkoaToolDataSchema.parse({ schema: 'ekoa-tool-data-v1', data, externalText: content.slice(1).flatMap(block => block.text ?? []).join('\n') });
    } };
  } catch (error) { await client.close().catch(() => undefined); throw error; }
}
