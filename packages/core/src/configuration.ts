import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseDocument, stringify } from 'yaml';
import { ConfigRevisionSchema, ConfigurationSchema, IdSchema, LegacyConfigurationSchema, defaultImproverSettings, type Configuration, type ConfigRevision } from './schemas.js';
import { atomicWrite, stableJson } from './files.js';
import type { Homes } from './homes.js';
import { existsSync, readFileSync } from 'node:fs';

export class RevisionConflict extends Error {
  readonly status = 409;
  constructor() { super('Settings changed elsewhere. Reloaded the latest version.'); }
}
const ConfigurationRequestSchema = z.strictObject({
  schema: z.literal('configuration-request-v1'), id: IdSchema, deviceId: IdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(),
});
const LegacyConfigRevisionSchema = ConfigRevisionSchema.extend({ configuration: LegacyConfigurationSchema });
function requestFingerprint(configuration: unknown, expectedRevision: number, changedBy: ConfigRevision['changedBy']): string {
  return createHash('sha256').update(stableJson({ configuration, expectedRevision, changedBy })).digest('hex');
}
export function configurationDigest(configuration: Configuration): string {
  return createHash('sha256').update(stableJson(ConfigurationSchema.parse(configuration))).digest('hex');
}
export function parseConfiguration(yaml: string): Configuration {
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid configuration YAML.');
  return ConfigurationSchema.parse(document.toJS({ maxAliasCount: 20 }));
}
export function exportConfiguration(configuration: Configuration): string { return stringify(ConfigurationSchema.parse(configuration)); }
export function materialiseConfiguration(homes: Homes, raw: ConfigRevision): ConfigRevision {
  const revision = ConfigRevisionSchema.parse(raw); const file = homes.at('apm.yml'); const yaml = exportConfiguration(revision.configuration);
  if (!existsSync(file) || readFileSync(file, 'utf8') !== yaml) atomicWrite(file, yaml);
  return revision;
}

export class ConfigurationStore {
  readonly #transact: (operation: () => ConfigRevision) => ConfigRevision;
  constructor(private readonly db: DatabaseSync, transact?: (operation: () => ConfigRevision) => ConfigRevision) {
    this.#transact = transact ?? (operation => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = operation(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    db.exec('CREATE TABLE IF NOT EXISTS configuration_revisions (revision INTEGER PRIMARY KEY, document TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS configuration_requests (device_id TEXT NOT NULL, request_id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(device_id, request_id))');
  }
  current(): ConfigRevision | null {
    const row = this.db.prepare('SELECT document FROM configuration_revisions ORDER BY revision DESC LIMIT 1').get();
    return row ? ConfigRevisionSchema.parse(JSON.parse(String(row.document))) : null;
  }
  revision(number: number): ConfigRevision | null {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('A positive configuration revision is required.');
    const row = this.db.prepare('SELECT document FROM configuration_revisions WHERE revision=?').get(number);
    return row ? ConfigRevisionSchema.parse(JSON.parse(String(row.document))) : null;
  }
  history(): ConfigRevision[] {
    return this.db.prepare('SELECT document FROM configuration_revisions ORDER BY revision').all().map((row) => ConfigRevisionSchema.parse(JSON.parse(String(row.document))));
  }
  put(configuration: unknown, expectedRevision: number, changedBy: ConfigRevision['changedBy'], at = new Date().toISOString(), clientRequestId?: string): ConfigRevision {
    const validated = ConfigurationSchema.parse(configuration);
    const author = ConfigRevisionSchema.shape.changedBy.parse(changedBy);
    const requestId = clientRequestId === undefined ? undefined : IdSchema.parse(clientRequestId);
    const fingerprint = requestFingerprint(validated, expectedRevision, author);
    return this.#transact(() => {
      if (requestId !== undefined) {
        const row = this.db.prepare('SELECT document FROM configuration_requests WHERE device_id=? AND request_id=?').get(author.deviceId, requestId);
        if (row) {
          const receipt = ConfigurationRequestSchema.parse(JSON.parse(String(row.document)));
          if (receipt.deviceId !== author.deviceId || receipt.id !== requestId) throw new RevisionConflict();
          const saved = this.db.prepare('SELECT document FROM configuration_revisions WHERE revision=?').get(receipt.revision);
          if (!saved) throw new Error('The saved configuration result is missing.');
          const raw: unknown = JSON.parse(String(saved.document));
          const revision = ConfigRevisionSchema.parse(raw);
          if (receipt.fingerprint !== fingerprint) {
            // A schema upgrade must not break recovery of an acknowledged older save.
            const legacy = LegacyConfigRevisionSchema.safeParse(raw);
            if (!legacy.success || receipt.revision !== legacy.data.revision
              || receipt.fingerprint !== requestFingerprint(legacy.data.configuration, legacy.data.revision - 1, legacy.data.changedBy)
              || fingerprint !== requestFingerprint(revision.configuration, legacy.data.revision - 1, legacy.data.changedBy)) throw new RevisionConflict();
          }
          return revision;
        }
      }
      const current = this.current();
      if ((current?.revision ?? 0) !== expectedRevision) throw new RevisionConflict();
      const revision = ConfigRevisionSchema.parse({ schema: 'config-revision-v1', revision: expectedRevision + 1, configuration: validated, changedBy, at });
      this.db.prepare('INSERT INTO configuration_revisions(revision,document) VALUES(?,?)').run(revision.revision, JSON.stringify(revision));
      if (requestId !== undefined) {
        const receipt = ConfigurationRequestSchema.parse({ schema: 'configuration-request-v1', id: requestId, deviceId: author.deviceId, fingerprint, revision: revision.revision });
        this.db.prepare('INSERT INTO configuration_requests(device_id,request_id,document) VALUES(?,?,?)').run(author.deviceId, requestId, JSON.stringify(receipt));
      }
      return revision;
    });
  }
  materialise(homes: Homes): ConfigRevision {
    const revision = this.current();
    if (!revision) throw new Error('Configuration has not been initialized.');
    return materialiseConfiguration(homes, revision);
  }
}

export function seedConfiguration(): Configuration {
  return ConfigurationSchema.parse({
    name: 'jevellan-config', version: '1.0.0', dependencies: { apm: [] },
    'x-jevellan': {
      schema: 2, improver: defaultImproverSettings(), runtimes: { claude: { enabled: true }, codex: { enabled: true } },
      decisions: { provider: 'jev', model: 'jev-1.13.0', timeoutMs: 4000, keepCurrentThreshold: 0.6 },
      menu: [
        { id: 'claude-fable', runtime: 'claude', model: 'claude-fable-5-1', efforts: ['low', 'medium', 'high', 'max'], label: 'Fable', description: 'The strongest Claude model. UI and visual work, anything judged by looking, deep architecture, stubborn bugs. Uses subscription quota fastest.', enabled: false, unavailableReason: 'Model discovery has not run.' },
        { id: 'claude-opus', runtime: 'claude', model: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'max'], label: 'Opus', description: 'Strong default for planning, implementation and reviews.', enabled: false, unavailableReason: 'Model discovery has not run.' },
        { id: 'codex-gpt', runtime: 'codex', model: 'discover-latest-gpt', efforts: ['low', 'medium', 'high', 'xhigh'], label: 'GPT', description: 'Long, well-specified implementation runs; nearly as strong as Fable, and its quota lasts about five times longer. An independent reviewer for work written by Claude.', enabled: false, unavailableReason: 'Model discovery has not run.' },
        { id: 'claude-sonnet', runtime: 'claude', model: 'claude-sonnet-5', efforts: ['low', 'medium', 'high'], label: 'Sonnet', description: 'Only trivial, mechanical work.', enabled: false },
      ],
      effortGuide: { low: 'Quick, obvious work: short answers, one-line fixes, renames.', medium: 'Routine work with a clear path.', high: 'Non-trivial work: most implementation, planning and reviews.', xhigh: 'Hard problems: tricky bugs, changes that cut across the system.', max: 'The hardest work: deep debugging, architecture, UI judged by eye, or a step that already failed at a lower effort.' },
      routingProfile: [
        'The user builds TypeScript and JavaScript web apps and agent platforms.',
        'Prefer staying on the current model when it fits the next step. Every step starts a fresh session either way, but consecutive steps on the same model reuse its prompt cache, so switching has a cost.',
        'Effort follows difficulty, not importance: most implementation, planning and reviews are high; routine work is medium; quick answers are low; max is for the hardest design, debugging and UI work, or after a step failed at a lower effort.',
        'UI, visual work and anything judged by looking goes to Fable.',
        'Long, well-specified implementation prefers GPT through Codex, especially when Claude quota is tight.',
        'Small, clear changes need no plan. Plan when the work spans several parts of the system, changes stored data, or the request is ambiguous.',
        'Tests catch problems better than reviews. Review only when the change is large or risky (stored data, auth, money, deletion, concurrency, migrations). Prefer a reviewer from a different model family than the one that wrote the code.',
        'Adversarial review is rare: only for risky changes where a wrong result is expensive.', 'Sonnet almost never.',
      ].join('\n'), guards: {},
    },
  });
}
