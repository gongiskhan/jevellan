import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnGroup, terminateGroup, type NativeProcess } from '@jevellan/core';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** An MCP child owned by the daemon, including its descendant process groups. */
export class OwnedMemoryTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #child: ChildProcessWithoutNullStreams | undefined;
  #native: NativeProcess | undefined;
  #launch: ReturnType<typeof spawnGroup> | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;
  readonly #buffer = new ReadBuffer({ maxBufferSize: 4 * 1024 * 1024 });
  constructor(readonly command: string, readonly args: string[], readonly options: { cwd: string; env: Record<string, string> }) {}
  get native(): NativeProcess | undefined { return this.#native; }
  async start(): Promise<void> {
    if (this.#launch || this.#closing) throw new Error('Memory transport has already started or closed.');
    this.#launch = spawnGroup(this.command, this.args, this.options);
    const { child, native } = await this.#launch; this.#child = child; this.#native = native;
    child.stderr.on('data', () => {});
    child.on('error', () => this.onerror?.(new Error('Basic Memory process failed.')));
    child.stdin.on('error', () => this.onerror?.(new Error('Basic Memory input channel closed.')));
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.#buffer.append(chunk);
        for (;;) { const message = this.#buffer.readMessage(); if (!message) break; this.onmessage?.(message); }
      } catch {
        this.onerror?.(new Error('Basic Memory returned an invalid protocol message.'));
        void this.close().catch(() => this.onerror?.(new Error('Basic Memory process cleanup failed.')));
      }
    });
    child.once('close', () => this.#notifyClosed());
  }
  send(message: JSONRPCMessage): Promise<void> {
    if (!this.#child || this.#closing || this.#closed) return Promise.reject(new Error('Basic Memory is not connected.'));
    return new Promise((resolve, reject) => { this.#child!.stdin.write(serializeMessage(message), (error) => error ? reject(new Error('Basic Memory request could not be sent.')) : resolve()); });
  }
  #notifyClosed(): void { if (!this.#closed) { this.#closed = true; this.#buffer.clear(); this.onclose?.(); } }
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      if (this.#launch) {
        const { child, native } = await this.#launch;
        child.stdin.end(); await terminateGroup(native);
      }
      this.#notifyClosed();
    })();
  }
}
