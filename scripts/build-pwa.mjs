import { build } from 'vite';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const push = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: true, lib: { entry: new URL('../apps/web/src/notifications-worker.ts', import.meta.url).pathname, formats: ['iife'], name: 'JevellanPush' } } });
const bundled = (Array.isArray(push) ? push : [push]).flatMap(result => result.output).filter(item => item.type === 'chunk').map(item => item.code).join('\n');
const root = new URL('../apps/web/dist/', import.meta.url);
const manifest = z.object({
  schema: z.literal('web-app-manifest-v1'), id: z.literal('/'), name: z.string(), short_name: z.string(),
  start_url: z.literal('/'), scope: z.literal('/'), display: z.literal('standalone'),
  icons: z.array(z.object({ src: z.string().regex(/^\/[\w.-]+$/), sizes: z.string(), type: z.string(), purpose: z.enum(['any', 'maskable']) })),
}).parse(JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8')));
const files = [...new Set([
  '/offline.html', '/offline.css', '/offline.js', '/manifest.webmanifest', '/apple-touch-icon.png', '/favicon-32.png',
  ...manifest.icons.map((icon) => icon.src),
  ...(await readdir(new URL('assets/', root))).map((name) => `/assets/${name}`),
])].sort();
const hash = createHash('sha256'); hash.update(bundled);
// Include the worker and HTML so code-only changes also trigger a new installation.
for (const name of [...files, '/index.html', '/sw.js']) hash.update(name).update(await readFile(new URL(name.slice(1), root)));
const worker = await readFile(new URL('sw.js', root), 'utf8') + '\n' + bundled;
await writeFile(new URL('sw.js', root), worker.replace('__BUILD_VERSION__', hash.digest('hex').slice(0, 20)).replace('/* __PUBLIC_FILES__ */', files.map((file) => JSON.stringify(file)).join(', ')));
