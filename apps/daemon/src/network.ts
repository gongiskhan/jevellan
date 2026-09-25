import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

export function tailscaleIpv4(value: string): string | null {
  const address = value.trim(); const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts[0] === '100' && Number(parts[1]) >= 64 && Number(parts[1]) <= 127 ? address : null;
}
export async function detectTailscaleIpv4(): Promise<string | null> {
  try { const result = await promisify(execFile)('tailscale', ['ip', '-4'], { timeout: 3000, maxBuffer: 16_384, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } }); return tailscaleIpv4(result.stdout); }
  catch { return null; }
}
export async function closeListeners(servers: readonly Server[]): Promise<void> {
  await Promise.all(servers.map(server => new Promise<void>(resolve => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve()); server.closeAllConnections();
  })));
}
/** Every listener uses the same port; a partial bind never leaves a half-started daemon. */
export async function listenOnInterfaces(create: () => Server, port: number, tailscale: string | null) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be between 0 and 65535.');
  if (tailscale !== null && tailscaleIpv4(tailscale) !== tailscale) throw new Error('Expected a Tailscale IPv4 address.');
  const hosts = ['127.0.0.1', ...(tailscale ? [tailscale] : [])]; const servers: Server[] = []; let selectedPort = port;
  try {
    for (const host of hosts) {
      const server = create();
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(selectedPort, host, () => { server.off('error', reject); resolve(); }); });
      servers.push(server); selectedPort = (server.address() as AddressInfo).port;
    }
    return { servers, port: selectedPort, addresses: hosts.map(host => `http://${host}:${selectedPort}`) };
  } catch (error) { await closeListeners(servers); throw error; }
}
