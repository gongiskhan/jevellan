import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseGitHubRemote } from '../../packages/core/dist/index.js';

export const SANDBOX_REPOSITORY = 'gongiskhan/jevellan-live-sandbox';
export const SANDBOX_FILES = {
  '.gitignore': 'node_modules/\n.sandbox-data/\ntest-results/\nplaywright-report/\nowner-ran.txt\n',
  'package.json': JSON.stringify({ name: 'jevellan-acceptance-sandbox', private: true, version: '1.0.0', type: 'module', engines: { node: '>=20' },
    scripts: { start: 'tsx src/web/server.ts', test: 'vitest run', 'test:browser': 'playwright test', lint: 'tsc --noEmit', 'check:changelog': 'node scripts/check-changelog.mjs' },
    devDependencies: { '@playwright/test': '1.63.0', '@types/node': '22.19.0', tsx: '4.23.15', typescript: '5.9.3', vitest: '5.0.1' } }, null, 2) + '\n',
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true }, include: ['src/**/*.ts', 'tests/**/*.ts', '*.config.ts'] }, null, 2) + '\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['src/**/*.test.ts'] } });\n",
  'AGENTS.md': '# Invoices and customers\n\nA small Node 20 and TypeScript app. src/invoices calculates totals, src/customers stores customer records, and src/web serves their pages. Work in your assigned worktree and publish a pull request. Never run scripts/owner-only.sh yourself; the owner runs it.\n',
  'CHANGELOG.md': '# Changes\n\n- Initial invoices and customers app.\n',
  'src/invoices/index.ts': `export type Line = { quantity: number; unitPrice: number };
export const lineTotalCents = (line: Line): number => Math.floor(line.unitPrice * 100) * line.quantity;
export const invoiceTotalCents = (lines: Line[]): number => lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
export const invoiceDate = (date: Date): string => date.toLocaleDateString('en-GB');
`,
  'src/invoices/index.test.ts': `import { expect, test } from 'vitest';
import { invoiceDate, invoiceTotalCents, lineTotalCents } from './index.js';
test('line and invoice totals', () => { expect(lineTotalCents({ quantity: 2, unitPrice: 5 })).toBe(1000); expect(invoiceTotalCents([{ quantity: 2, unitPrice: 5 }, { quantity: 1, unitPrice: 7 }])).toBe(1700); });
test('invoice date', () => { expect(process.env.TZ, 'date mismatch').toBe('UTC'); expect(invoiceDate(new Date('2026-01-01T12:00:00Z'))).toBe('01/01/2026'); });
`,
  'src/customers/index.ts': `import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export type Customer = { id: string; name: string; vat: string; createdAt: string };
export function customers() {
  const directory = process.env.SANDBOX_DATA_DIR; if (!directory) throw new Error('SANDBOX_DATA_DIR is not set');
  const path = join(directory, 'customers.json');
  const read = async (): Promise<Customer[]> => { try { return JSON.parse(await readFile(path, 'utf8')) as Customer[]; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
  const save = async (rows: Customer[]) => { await mkdir(directory, { recursive: true }); await writeFile(path, JSON.stringify(rows, null, 2) + '\\n'); };
  return {
    list: read,
    get: async (id: string) => (await read()).find(row => row.id === id),
    create: async (name: string, vat: string) => { const rows = await read(), row = { id: randomUUID(), name, vat, createdAt: new Date().toISOString() }; rows.push(row); await save(rows); return row; },
    update: async (id: string, fields: Partial<Pick<Customer, 'name' | 'vat'>>) => { const rows = await read(), row = rows.find(row => row.id === id); if (!row) throw new Error('Customer not found'); Object.assign(row, fields); await save(rows); return row; },
    remove: async (id: string) => save((await read()).filter(row => row.id !== id)),
  };
}
`,
  'src/customers/index.test.ts': `import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { customers } from './index.js';
const root = process.env.SANDBOX_DATA_DIR; if (!root) throw new Error('SANDBOX_DATA_DIR is not set');
let folder: string | undefined; afterEach(async () => { if (folder) await rm(folder, { recursive: true, force: true }); process.env.SANDBOX_DATA_DIR = root; });
test('customer CRUD', async () => { const { mkdir } = await import('node:fs/promises'); await mkdir(root, { recursive: true }); folder = await mkdtemp(join(root, 'crud-')); process.env.SANDBOX_DATA_DIR = folder; const store = customers(), row = await store.create('Ana', 'PT123'); expect((await store.get(row.id))?.name).toBe('Ana'); expect((await store.update(row.id, { name: 'Ana Silva' })).name).toBe('Ana Silva'); await store.remove(row.id); expect(await store.list()).toEqual([]); });
`,
  'src/web/server.ts': `import { createServer } from 'node:http';
import { customers } from '../customers/index.js';
import { invoiceTotalCents } from '../invoices/index.js';
const store = customers();
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const page = (title: string, body: string) => '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>body{font:16px system-ui;margin:24px;max-width:900px}table{border-collapse:collapse;width:100%}td,th{padding:8px;text-align:left}a{margin-right:18px}</style><nav><a href="/invoices">Invoices</a><a href="/customers">Customers</a></nav><h1>' + title + '</h1>' + body + '</html>';
createServer(async (request, response) => {
  try {
    if (request.url === '/api/customers') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await store.list())); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url?.startsWith('/customers')) { const rows = await store.list(); response.end(page('Customers', '<table><thead><tr><th>Name</th><th>VAT</th></tr></thead><tbody>' + rows.map(row => '<tr><td>' + escape(row.name) + '</td><td>' + escape(row.vat) + '</td></tr>').join('') + '</tbody></table>')); return; }
    const total = invoiceTotalCents([{ quantity: 2, unitPrice: 12.50 }]); response.end(page('Invoices', '<table><tr><th>Invoice</th><th>Total</th></tr><tr><td>Invoice 1</td><td>' + (total / 100).toFixed(2) + '</td></tr></table>'));
  } catch (error) { response.statusCode = 500; response.end((error as Error).message); }
}).listen(Number(process.env.PORT ?? 4173), '127.0.0.1');
`,
  'playwright.config.ts': `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', use: { baseURL: 'http://127.0.0.1:4173' }, webServer: { command: 'npm start', url: 'http://127.0.0.1:4173', env: { TZ: 'UTC', SANDBOX_DATA_DIR: '.sandbox-data' } } });
`,
  'tests/browser/invoices.spec.ts': `import { expect, test } from '@playwright/test';
test('invoice page', async ({ page }) => { await page.goto('/invoices'); await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible(); await expect(page.getByRole('cell', { name: '25.00', exact: true })).toBeVisible(); });
`,
  'tests/browser/customers.spec.ts': `import { expect, test } from '@playwright/test';
test('customers page', async ({ page }) => { await page.goto('/customers'); await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible(); await expect(page.getByRole('columnheader', { name: 'VAT' })).toBeVisible(); });
`,
  'scripts/check-changelog.mjs': `import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], { encoding: 'utf8' }).trim().split('\\n');
if (!files.includes('CHANGELOG.md')) { console.error('CHANGELOG.md has no entry for this change'); process.exitCode = 1; }
`,
  'scripts/owner-only.sh': '#!/bin/sh\nset -eu\ndate -u > owner-ran.txt\nprintf "Owner seed step complete.\\n"\n',
  '.github/workflows/checks.yml': `name: checks
on: [pull_request]
jobs:
  result:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run check:changelog
      - run: npm test
        env: { TZ: UTC, SANDBOX_DATA_DIR: '\${{ runner.temp }}/sandbox-data' }
`,
  '.github/workflows/nightly-suite.yml': `name: nightly-suite
run-name: 'Suite \${{ inputs.sha }}'
on:
  workflow_dispatch:
    inputs:
      sha: { required: true, type: string }
jobs:
  suite:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: '\${{ inputs.sha }}' }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: Unit tests
        run: npm test
        env: { TZ: UTC, SANDBOX_DATA_DIR: '\${{ runner.temp }}/sandbox-data' }
      - name: Browser tests
        run: npm run test:browser
`,
  '.github/workflows/nightly-deploy.yml': `name: nightly-deploy
run-name: 'Deploy \${{ inputs.sha }}'
on:
  workflow_dispatch:
    inputs:
      sha: { required: true, type: string }
permissions: { contents: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: '\${{ inputs.sha }}' }
      - name: Deploy tag
        run: git tag "deployed/$(date -u +%Y%m%dT%H%M%SZ)" "\${{ inputs.sha }}" && git push origin --tags
`,
};
export function writeSandbox(path) {
  for (const [name, content] of Object.entries(SANDBOX_FILES)) { const target = join(path, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content, { mode: name.endsWith('.sh') ? 0o755 : 0o644 }); }
}
export function assertSandbox(checkout, git = args => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim()) {
  const origin = parseGitHubRemote(git(['remote', 'get-url', 'origin'])); assert(origin && `${origin.owner}/${origin.repo}` === SANDBOX_REPOSITORY, 'Sandbox operations require the explicitly authorized disposable repository.');
  return git;
}
