import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

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
const hash = createHash('sha256');
// Include the worker and HTML so code-only changes also trigger a new installation.
for (const name of [...files, '/index.html', '/sw.js']) hash.update(name).update(await readFile(new URL(name.slice(1), root)));
const worker = await readFile(new URL('sw.js', root), 'utf8');
await writeFile(new URL('sw.js', root), worker.replace('__BUILD_VERSION__', hash.digest('hex').slice(0, 20)).replace('/* __PUBLIC_FILES__ */', files.map((file) => JSON.stringify(file)).join(', ')));
