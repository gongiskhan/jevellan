import { createServer, type Server } from 'node:net';
import type { LandingCheckPort } from '@jevellan/core';

/** Bind first so one allocation cannot choose the same port twice. Only these owned handles are closed. */
export async function landingCheckEnvironment(project: Record<string, string>, bindings: readonly LandingCheckPort[] = []) {
  const servers: Server[] = [], environment = { ...project }, ports: number[] = [];
  try {
    for (const binding of bindings) {
      const server = createServer(); servers.push(server);
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') reject(new Error('No localhost port was allocated.')); else resolve(address.port); });
      });
      ports.push(port); environment[binding.variable] = String(port);
      if (binding.urlVariable) environment[binding.urlVariable] = `http://127.0.0.1:${port}`;
    }
    return { environment, ports };
  } finally {
    await Promise.all(servers.map(server => server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve()));
  }
}
