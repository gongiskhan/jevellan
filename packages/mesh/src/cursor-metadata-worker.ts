import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

// Query only metadata. The native database is never opened for writing, and
// a busy IDE cannot hold the daemon's event loop while this query runs.
let database: DatabaseSync | undefined;
try {
  if (typeof workerData !== 'string') throw new Error('Invalid metadata source.');
  database = new DatabaseSync(workerData, { readOnly: true });
  database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200;');
  const rows = database.prepare(`SELECT substr(key, 14) AS id,
    json_extract(value, '$.cwd') AS cwd,
    json_extract(value, '$.lastUpdatedAt', '$.updatedAt', '$.createdAt') AS activity
    FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND json_valid(value) LIMIT 20001`).all();
  if (rows.length > 20000) throw new Error('Metadata limit reached.');
  parentPort?.postMessage({ schema: 'cursor-metadata-v1', rows });
} catch { parentPort?.postMessage({ schema: 'cursor-metadata-error-v1' }); }
finally { database?.close(); }
