import type { DocumentSchema } from './schemas.js';

export type Stored<T> = { revision: number; document: T };
/** The hub implements this locally; member devices use an authenticated API. */
export interface DocumentStore {
  get<T>(namespace: string, id: string, schema: DocumentSchema<T>): Stored<T> | null;
  list<T>(namespace: string, schema: DocumentSchema<T>): Stored<T>[];
  put<T>(namespace: string, id: string, schema: DocumentSchema<T>, document: unknown, expectedRevision: number): Stored<T>;
}
