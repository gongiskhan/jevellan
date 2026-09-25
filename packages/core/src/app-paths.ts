import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const PackageIdentity = z.object({ name: z.literal('jevellan'), version: z.string().min(1) });

/** Workspace packages can live in packages/ or in npm's bundled node_modules/. */
export function applicationRoot(moduleUrl = import.meta.url): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (PackageIdentity.safeParse(value).success && existsSync(join(directory, 'bin', 'jevellan.mjs'))) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('The installed Jevellan application could not be located.');
    directory = parent;
  }
}
