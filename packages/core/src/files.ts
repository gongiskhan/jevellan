import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DocumentSchema } from './schemas.js';

export function atomicWrite(path: string, content: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', mode);
  try { writeFileSync(fd, content); fsyncSync(fd); }
  catch (error) { closeSync(fd); unlinkSync(temporary); throw error; }
  closeSync(fd);
  try { renameSync(temporary, path); }
  catch (error) { unlinkSync(temporary); throw error; }
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function readDocument<T>(path: string, schema: DocumentSchema<T>): T {
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function writeDocument<T>(path: string, schema: DocumentSchema<T>, value: unknown): T {
  const parsed = schema.parse(value);
  atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}
export function stableJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
    return entry;
  };
  return JSON.stringify(sort(value));
}
