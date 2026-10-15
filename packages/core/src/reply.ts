import { ZodError, type core } from 'zod';
import type { DocumentSchema } from './schemas.js';

const MAX_PASSES = 10;
const keyAt = (path: readonly PropertyKey[], key: string) => JSON.stringify([...path.map(String), key]);

/**
 * Parses a reply from another Jevellan process (the hub, or a peer device) that may run a newer version.
 * A strict schema refuses keys it does not know; when those are the only problems, exactly the reported keys
 * are removed and the reply is parsed again, while each pass still removes keys it has not removed before.
 * Every other issue, and every stored document, stays strict.
 */
export function parseReply<T>(schema: DocumentSchema<T>, value: unknown): T {
  let current = value; let copied = false; const removed = new Set<string>();
  for (let pass = 0; ; pass++) {
    try { return schema.parse(current); }
    catch (error) {
      if (!(error instanceof ZodError) || pass >= MAX_PASSES) throw error;
      const issues = error.issues as core.$ZodIssue[];
      if (!issues.length || issues.some(issue => issue.code !== 'unrecognized_keys')) throw error;
      const fresh = issues.flatMap(issue => (issue as core.$ZodIssueUnrecognizedKeys).keys.map(key => ({ path: issue.path, key }))).filter(entry => !removed.has(keyAt(entry.path, entry.key)));
      if (!fresh.length) throw error;
      if (!copied) { current = structuredClone(current); copied = true; }
      for (const entry of fresh) {
        let target: unknown = current;
        for (const part of entry.path) target = target && typeof target === 'object' ? (target as Record<PropertyKey, unknown>)[part as PropertyKey] : undefined;
        if (!target || typeof target !== 'object' || Array.isArray(target)) throw error;
        delete (target as Record<string, unknown>)[entry.key]; removed.add(keyAt(entry.path, entry.key));
      }
    }
  }
}
