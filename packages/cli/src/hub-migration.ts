import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { c, t, x } from 'tar';
import { z } from 'zod';
import { AccountSchema, AccountStatusSchema, ConfigRevisionSchema, DaemonOwnership, DeviceConfigSchema, DeviceSchema,
  Homes, HubArchiveHeaderSchema, HubExportManifestSchema, HubImportActivationSchema, HubImportReceiptSchema, HubMovedSchema,
  ProjectSchema, VERSION, daemonRunning, deviceAllowsWork, inside, newId, readDocument, resolvedPath, writeDocument,
  type DeviceConfig, type HubExportManifest, type HubImportReceipt } from '@jevellan/core';

const MAGIC = Buffer.from('JEVELLAN-HUB-1\n');
const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3;
const MAX_DATA_BYTES = 8 * 1024 ** 3;
const dataNames = new Set(['hub', 'homes', 'checkouts', 'apm', 'apm.yml', 'git-settings.json', 'device.json', 'projects', 'project-saves',
  'conversations', 'context-operations', 'rigging', 'basic-memory', 'improver', 'settings-sync.json', 'ui', 'cursor', 'worktrees', 'logs']);
const pathMappingsSchema = z.record(z.string().min(1), z.string().refine(isAbsolute));
const plainDocumentSchema = z.record(z.string(), z.json());
type Options = { homes: Homes; passphrase: string };
type ExportOptions = Options & { out: string; destinationName: string };
type ImportOptions = Options & { archive: string; projectPaths?: Record<string, string>; beforeActivate?: () => void };

function key(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (passphrase.length < 12 || passphrase.length > 1024) throw new Error('The migration passphrase must have 12 to 1024 characters.');
  return new Promise((accept, reject) => scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 },
    (error, result) => error ? reject(error) : accept(result)));
}
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function archivePath(root: string, ref: string): string {
  if (isAbsolute(ref) || ref.includes('\\') || ref.split('/').some(part => part === '..' || !part)) throw new Error('Invalid migration archive path.');
  const path = resolve(root, ref); if (!inside(root, path)) throw new Error('Migration path escapes its staging directory.'); return path;
}
function exclusion(ref: string): string | undefined {
  if (!dataNames.has(ref.split('/')[0]!)) return 'Installation or transient device state.';
  if (/^homes\/codex\/[^/]+\/(?:auth(?:\.json(?:\..*)?|\/|$)|\.credentials(?:\.json)?$)/u.test(ref)) return 'Codex authentication is device-local; sign in after import.';
  if (/^homes\/[^/]+\/[^/]+\/(?:Library\/Caches|\.cache|\.npm|tmp)(?:\/|$)/u.test(ref)) return 'Regenerable runtime cache.';
  if (ref.endsWith('/.append-lock') || ref.endsWith('/ledger.lock')) return 'Transient writer lock.';
  return undefined;
}
async function snapshot(homes: Homes, root: string, destinationName: string): Promise<HubExportManifest> {
  const sourceDevice = readDocument(homes.at('device.json'), DeviceConfigSchema);
  if (sourceDevice.role !== 'hub') throw new Error('Only the hub can export its data.');
  const entries: HubExportManifest['entries'] = [], excluded: HubExportManifest['excluded'] = [];
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const source = join(directory, name), ref = relative(homes.root, source).split('\\').join('/');
      const reason = exclusion(ref); if (reason) { excluded.push({ path: ref, reason }); continue; }
      const info = await lstat(source);
      if (info.isSymbolicLink()) { excluded.push({ path: ref, reason: 'Runtime links are recreated locally, never followed during export.' }); continue; }
      if (info.isDirectory()) { await walk(source); continue; }
      if (!info.isFile()) throw new Error('The hub contains an unsupported filesystem entry.');
      total += info.size; if (total > MAX_DATA_BYTES || entries.length >= 100_000) throw new Error('Hub data exceeds the supported migration size.');
      const target = archivePath(join(root, 'data'), ref);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(source, target);
      const mode = 0o600 | (info.mode & 0o111); await chmod(target, mode);
      entries.push({ path: ref, bytes: info.size, mode, sha256: await digest(target) });
    }
  };
  await walk(homes.root);
  if (!entries.some(entry => entry.path === 'hub/jevellan.db') || !entries.some(entry => entry.path === 'hub/secret.key')) throw new Error('The hub database and vault key are required for export.');
  return HubExportManifestSchema.parse({ schema: 'hub-export-manifest-v1', id: newId('export'), createdAt: new Date().toISOString(),
    sourceHome: homes.root, sourceDevice, destinationName, entries, excluded });
}
function ownStopped(homes: Homes): DaemonOwnership {
  if (daemonRunning(homes)) throw new Error('Stop the Jevellan daemon before hub migration.');
  return new DaemonOwnership(homes);
}

/** A stopped-home snapshot, encrypted before publication. The source is fenced only after a complete archive exists. */
export async function exportHub(options: ExportOptions): Promise<HubExportManifest> {
  const { homes } = options;
  const out = resolvedPath(options.out);
  if (inside(homes.root, out)) throw new Error('Save the export archive outside the data home.');
  if (existsSync(out)) throw new Error('The export file already exists. Choose a new path.');
  const ownership = ownStopped(homes); const staging = await mkdtemp(homes.ensure('tmp') + '/hub-export-');
  let published = false;
  try {
    const manifest = await snapshot(homes, staging, options.destinationName);
    writeDocument(join(staging, 'manifest.json'), HubExportManifestSchema, manifest);
    const tar = join(staging, 'payload.tar.gz'); await c({ cwd: staging, file: tar, gzip: true, portable: true }, ['manifest.json', 'data']);
    const salt = randomBytes(16), nonce = randomBytes(12);
    const header = Buffer.from(JSON.stringify(HubArchiveHeaderSchema.parse({ schema: 'hub-archive-v1', cipher: 'aes-256-gcm', kdf: 'scrypt-32768-8-1',
      salt: salt.toString('base64'), nonce: nonce.toString('base64') })) + '\n');
    const derived = await key(options.passphrase, salt);
    try {
      const encrypted = join(staging, 'archive'); await writeFile(encrypted, Buffer.concat([MAGIC, header]), { mode: 0o600, flag: 'wx' });
      const cipher = createCipheriv('aes-256-gcm', derived, nonce); cipher.setAAD(Buffer.concat([MAGIC, header]));
      await pipeline(createReadStream(tar), cipher, createWriteStream(encrypted, { flags: 'a', mode: 0o600 }));
      await writeFile(encrypted, cipher.getAuthTag(), { flag: 'a' });
      if ((await stat(encrypted)).size > MAX_ARCHIVE_BYTES) throw new Error('The encrypted export exceeds the supported archive size.');
      const handle = await open(encrypted, 'r'); try { await handle.sync(); } finally { await handle.close(); }
      ownership.assert(); await mkdir(dirname(out), { recursive: true, mode: 0o700 });
      // Hard-link publication refuses replacement and keeps the completed archive on the same filesystem when possible.
      try { await link(encrypted, out); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        const temporary = `${out}.${manifest.id}.tmp`;
        try { await copyFile(encrypted, temporary, 1); await link(temporary, out); } finally { await rm(temporary, { force: true }); }
      }
      published = true;
      const folder = await open(dirname(out), 'r'); try { await folder.sync(); } finally { await folder.close(); }
      writeDocument(homes.at('hub-moved.json'), HubMovedSchema, { schema: 'hub-moved-v1', exportId: manifest.id,
        destinationName: manifest.destinationName, exportedAt: manifest.createdAt, archiveSha256: await digest(out) });
      return manifest;
    } finally { derived.fill(0); }
  } catch (error) { if (published && !existsSync(homes.at('hub-moved.json'))) await rm(out, { force: true }); throw error; }
  finally { await rm(staging, { recursive: true, force: true }); ownership.close(); }
}

async function decrypt(archive: string, tar: string, passphrase: string): Promise<void> {
  const info = await stat(archive); if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES) throw new Error('Invalid hub archive size.');
  const head: Buffer[] = []; let headerSize = 0, headerText = Buffer.alloc(0);
  for await (const chunk of createReadStream(archive, { start: 0, end: Math.min(info.size - 1, 4095) })) head.push(chunk as Buffer);
  const prefix = Buffer.concat(head);
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not a supported Jevellan hub archive.');
  const end = prefix.indexOf(10, MAGIC.length); if (end < 0) throw new Error('Invalid hub archive header.');
  headerSize = end + 1; headerText = prefix.subarray(0, headerSize);
  const header = HubArchiveHeaderSchema.parse(JSON.parse(prefix.subarray(MAGIC.length, end).toString('utf8')));
  if (info.size <= headerSize + 16) throw new Error('The hub archive is truncated.');
  const tags: Buffer[] = []; for await (const part of createReadStream(archive, { start: info.size - 16 })) tags.push(part as Buffer);
  const derived = await key(passphrase, Buffer.from(header.salt, 'base64'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(header.nonce, 'base64'));
    decipher.setAAD(headerText); decipher.setAuthTag(Buffer.concat(tags));
    await pipeline(createReadStream(archive, { start: headerSize, end: info.size - 17 }), decipher, createWriteStream(tar, { flags: 'wx', mode: 0o600 }));
  } catch { throw new Error('The hub archive could not be authenticated. Check the passphrase and archive.'); }
  finally { derived.fill(0); }
}
async function unpack(tar: string, root: string): Promise<HubExportManifest> {
  const paths = new Set<string>(); let bytes = 0;
  await t({ file: tar, strict: true, onReadEntry: entry => {
    const ref = entry.path.replace(/\/$/u, ''); archivePath(root, ref);
    if (paths.has(ref) || !['File', 'Directory'].includes(entry.type)) throw new Error('The migration archive contains duplicate or unsupported entries.');
    paths.add(ref); bytes += entry.size;
    if (bytes > MAX_DATA_BYTES || paths.size > 200_001) throw new Error('The migration archive expands beyond its supported size.');
    if (ref !== 'manifest.json' && ref !== 'data' && !ref.startsWith('data/')) throw new Error('Unexpected hub archive entry.');
  } });
  await x({ file: tar, cwd: root, strict: true, noChmod: true, preservePaths: false });
  const manifest = readDocument(join(root, 'manifest.json'), HubExportManifestSchema);
  const expected = new Set(manifest.entries.map(entry => `data/${entry.path}`));
  for (const path of paths) if (path !== 'manifest.json' && path !== 'data' && !(await lstat(archivePath(root, path))).isDirectory() && !expected.has(path)) throw new Error('The hub archive contains an unlisted file.');
  for (const entry of manifest.entries) {
    const path = archivePath(join(root, 'data'), entry.path); const info = await lstat(path);
    if (!info.isFile() || info.size !== entry.bytes || await digest(path) !== entry.sha256 || exclusion(entry.path)) throw new Error('The hub archive manifest does not match its data.');
    await chmod(path, entry.mode);
  }
  if (expected.size !== manifest.entries.length || !expected.has('data/hub/jevellan.db') || !expected.has('data/hub/secret.key')) throw new Error('The hub archive manifest is incomplete.');
  return manifest;
}

function rebind(value: unknown, source: HubExportManifest, destination: DeviceConfig, destinationHome: string): unknown {
  if (typeof value === 'string') {
    if (value === source.sourceDevice.deviceId) return destination.deviceId;
    if (value === source.sourceHome || value.startsWith(source.sourceHome + '/')) return destinationHome + value.slice(source.sourceHome.length);
    return value;
  }
  if (Array.isArray(value)) return value.map(entry => rebind(entry, source, destination, destinationHome));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) =>
    [name === source.sourceDevice.deviceId ? destination.deviceId : name, rebind(entry, source, destination, destinationHome)]));
  return value;
}
function rebindHub(root: string, manifest: HubExportManifest, device: DeviceConfig, destinationHome: string, mappings: Record<string, string>): Pick<HubImportReceipt, 'unboundProjectIds' | 'needsLoginAccountIds'> {
  const db = new DatabaseSync(join(root, 'hub', 'jevellan.db'));
  const unboundProjectIds: string[] = [], needsLoginAccountIds: string[] = [];
  try {
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('The exported hub database failed its integrity check.');
    db.exec('BEGIN IMMEDIATE;');
    const rows = db.prepare('SELECT namespace,id,revision,document FROM documents').all();
    const accounts = rows.filter(row => row.namespace === 'accounts').map(row => AccountSchema.parse(JSON.parse(String(row.document))));
    for (const row of rows) {
      const original = plainDocumentSchema.parse(JSON.parse(String(row.document)));
      let document: Record<string, unknown> = plainDocumentSchema.parse(rebind(original, manifest, device, destinationHome));
      let id = String(row.id) === manifest.sourceDevice.deviceId ? device.deviceId : String(row.id);
      if (row.namespace === 'devices' && row.id === manifest.sourceDevice.deviceId) document = DeviceSchema.parse({ ...document,
        id: device.deviceId, name: device.name, role: 'hub', url: device.url, os: process.platform, version: VERSION });
      if (row.namespace === 'projects') {
        const project = ProjectSchema.parse(original); const oldPath = project.paths[manifest.sourceDevice.deviceId];
        const mapped = mappings[project.id] ?? (oldPath && inside(manifest.sourceHome, oldPath) ? destinationHome + oldPath.slice(manifest.sourceHome.length) : undefined);
        document = { ...project, paths: { ...project.paths, ...(mapped ? { [device.deviceId]: mapped } : {}) },
          ...(project.allowedDevices ? { allowedDevices: [...project.allowedDevices.filter(id => id !== manifest.sourceDevice.deviceId), ...(mapped && project.allowedDevices.includes(manifest.sourceDevice.deviceId) ? [device.deviceId] : [])] } : {}) };
        if (oldPath && !mapped) unboundProjectIds.push(project.id);
      }
      if (row.namespace === 'account-statuses' && original.deviceId === manifest.sourceDevice.deviceId) {
        const status = AccountStatusSchema.parse(document), account = accounts.find(account => account.id === status.accountId);
        if (account?.runtime === 'codex' && account.kind === 'subscription') {
          document = AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: account.id, deviceId: device.deviceId,
            auth: 'needs-login', observedAt: new Date().toISOString() }); needsLoginAccountIds.push(account.id);
        }
        id = createHash('sha256').update(`${status.accountId}\0${device.deviceId}`).digest('hex');
      }
      if (row.namespace === 'account-use' && typeof document.accountId === 'string' && original.deviceId === manifest.sourceDevice.deviceId)
        id = createHash('sha256').update(`${document.accountId}\0${device.deviceId}`).digest('hex');
      if (id !== row.id) db.prepare('DELETE FROM documents WHERE namespace=? AND id=?').run(String(row.namespace), String(row.id));
      db.prepare('INSERT INTO documents(namespace,id,revision,document) VALUES(?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET revision=excluded.revision,document=excluded.document')
        .run(String(row.namespace), id, Number(row.revision), JSON.stringify(document));
    }
    for (const account of accounts.filter(account => account.runtime === 'codex' && account.kind === 'subscription')) {
      const id = createHash('sha256').update(`${account.id}\0${device.deviceId}`).digest('hex');
      const document = AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: account.id, deviceId: device.deviceId, auth: 'needs-login', observedAt: new Date().toISOString() });
      db.prepare('INSERT INTO documents(namespace,id,revision,document) VALUES(?,?,1,?) ON CONFLICT(namespace,id) DO UPDATE SET document=excluded.document')
        .run('account-statuses', id, JSON.stringify(document));
      if (!needsLoginAccountIds.includes(account.id)) needsLoginAccountIds.push(account.id);
    }
    for (const row of db.prepare('SELECT revision,document FROM configuration_revisions').all())
      db.prepare('UPDATE configuration_revisions SET document=? WHERE revision=?').run(JSON.stringify(ConfigRevisionSchema.parse(rebind(JSON.parse(String(row.document)), manifest, device, destinationHome))), Number(row.revision));
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
    return { unboundProjectIds, needsLoginAccountIds };
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Integrity may fail before the transaction. */ } throw error; }
  finally { db.close(); }
}

function assertFresh(homes: Homes): void {
  for (const name of ['projects', 'conversations', 'homes']) if (existsSync(homes.at(name)) && readdirSync(homes.at(name)).length) throw new Error('Import requires a fresh installation. Existing local work was preserved.');
  if (!deviceAllowsWork(homes)) throw new Error('An apps-only device cannot become the working hub.');
  const path = homes.at('hub', 'jevellan.db');
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const occupied = db.prepare("SELECT count(*) AS n FROM documents WHERE namespace NOT IN ('devices','heartbeats','device-work-policy')").get();
    const secrets = db.prepare("SELECT name FROM sqlite_schema WHERE name='secrets'").get() ? db.prepare('SELECT count(*) AS n FROM secrets').get()?.n : 0;
    if (Number(occupied?.n) || Number(secrets)) throw new Error('Import requires a fresh installation. Existing hub data was preserved.');
  } finally { db.close(); }
}

/** Reconcile a crash between the two directory renames. Completed imports remain active; incomplete ones restore the fresh home. */
export async function recoverHubImport(homes: Homes): Promise<void> {
  const marker = `${homes.root}.import-operation.json`; if (!existsSync(marker)) return;
  const plan = readDocument(marker, HubImportActivationSchema);
  const confined = (path: string, prefix: string) => dirname(path) === dirname(homes.root) && path.startsWith(homes.root + prefix) && resolvedPath(path) === path;
  if (plan.home !== homes.root || !confined(plan.stage, '.import-stage_') || !confined(plan.backup, '.before-import-backup_')) throw new Error('The pending import paths are invalid. All copies were preserved.');
  if (daemonRunning(homes)) throw new Error('Stop the daemon before recovering the hub import.');
  const receipt = join(homes.root, 'hub-import.json');
  if (existsSync(receipt) && readDocument(receipt, HubImportReceiptSchema).exportId === plan.exportId) {
    await rm(plan.stage, { recursive: true, force: true }); await unlink(marker); return;
  }
  if (!existsSync(homes.root) && existsSync(plan.backup)) await rename(plan.backup, homes.root);
  else if (existsSync(plan.backup)) throw new Error('Hub import recovery found conflicting copies. All copies were preserved.');
  if (!existsSync(homes.root)) throw new Error('The hub import backup is missing. Its staging copy was preserved.');
  await rm(plan.stage, { recursive: true, force: true }); await unlink(marker);
}
export async function importHub(options: ImportOptions): Promise<HubImportReceipt> {
  const { homes } = options;
  await recoverHubImport(homes);
  const ownership = ownStopped(homes);
  const temporary = await mkdtemp(homes.ensure('tmp') + '/hub-import-');
  const stage = `${homes.root}.import-${newId('stage')}`, backup = `${homes.root}.before-import-${newId('backup')}`;
  const marker = `${homes.root}.import-operation.json`;
  let activated = false, movedOriginal = false;
  try {
    assertFresh(homes);
    if (existsSync(marker)) throw new Error('A hub import is pending. Recover its staging and backup before starting another.');
    const archive = resolvedPath(options.archive); if (inside(homes.root, archive)) throw new Error('The import archive must be outside the destination home.');
    const tar = join(temporary, 'payload.tar.gz'); await decrypt(archive, tar, options.passphrase);
    const unpacked = join(temporary, 'unpacked'); await mkdir(unpacked, { mode: 0o700 });
    const manifest = await unpack(tar, unpacked);
    const prior = existsSync(homes.at('device.json')) ? readDocument(homes.at('device.json'), DeviceConfigSchema) : null;
    if (prior?.role === 'member' || prior?.deviceId === manifest.sourceDevice.deviceId) throw new Error('Import requires a distinct fresh hub identity.');
    const device = DeviceConfigSchema.parse(prior ?? { schema: 'device-config-v1', deviceId: newId('dev'), name: manifest.destinationName,
      role: 'hub', hubUrl: 'http://127.0.0.1:9771', url: 'http://127.0.0.1:9771', version: VERSION });
    const mappings = pathMappingsSchema.parse(options.projectPaths ?? {});
    await rename(join(unpacked, 'data'), stage);
    // Retain the fresh installation's release, dependency runtime and service receipts at their existing final paths.
    for (const name of ['install.json', 'app', 'distributions', 'tools']) if (existsSync(homes.at(name))) await cp(homes.at(name), join(stage, name), { recursive: true, dereference: false });
    const status = rebindHub(stage, manifest, device, homes.root, mappings);
    // Local current state is rebound; append-only ledger segments and content-addressed blobs remain byte-identical.
    for (const entry of manifest.entries.filter(entry => /^(?:projects|conversations|rigging)\/.+\.json$/u.test(entry.path) && !entry.path.includes('/blobs/'))) {
      const path = archivePath(stage, entry.path); const original: unknown = JSON.parse(await readFile(path, 'utf8'));
      const document = rebind(original, manifest, device, homes.root);
      if (document && typeof document === 'object' && 'schema' in document && ['thread-local-v1', 'coordinator-local-v1'].includes(String(document.schema))) delete (document as Record<string, unknown>).process;
      await writeFile(path, JSON.stringify(document, null, 2) + '\n', { mode: entry.mode });
    }
    writeDocument(join(stage, 'device.json'), DeviceConfigSchema, device);
    const receipt = HubImportReceiptSchema.parse({ schema: 'hub-import-receipt-v1', exportId: manifest.id, importedAt: new Date().toISOString(),
      sourceDeviceId: manifest.sourceDevice.deviceId, destinationDeviceId: device.deviceId, archiveSha256: await digest(archive), ...status });
    writeDocument(join(stage, 'hub-import.json'), HubImportReceiptSchema, receipt);
    ownership.assert(); options.beforeActivate?.();
    writeDocument(marker, HubImportActivationSchema, { schema: 'hub-import-activation-v1', exportId: manifest.id, home: homes.root, stage, backup });
    // The persisted activation fence closes the startup gap while the ownership DB's path changes.
    ownership.close();
    await rename(homes.root, backup); movedOriginal = true;
    try { await rename(stage, homes.root); activated = true; }
    catch (error) { await rename(backup, homes.root); movedOriginal = false; throw error; }
    await unlink(marker);
    return receipt;
  } finally {
    ownership.close();
    if (!activated) { await rm(stage, { recursive: true, force: true }); if (!movedOriginal) await rm(marker, { force: true }); }
    await rm(activated ? join(backup, 'tmp', basename(temporary)) : temporary, { recursive: true, force: true });
  }
}
