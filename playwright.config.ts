import { defineConfig } from '@playwright/test';

// A separate port base lets two browser runs share one machine (for example JEVELLAN_E2E_PORT_BASE=19871).
const base = Number(process.env.JEVELLAN_E2E_PORT_BASE ?? 19771);

const layouts = ['light', 'dark'].flatMap((colorScheme) => [
  { name: `desktop-${colorScheme}`, use: { viewport: { width: 1440, height: 900 }, colorScheme: colorScheme as 'light' | 'dark' } },
  { name: `phone-${colorScheme}`, use: { viewport: { width: 390, height: 844 }, colorScheme: colorScheme as 'light' | 'dark' } },
]);
// Journeys that save a Jev key (the improver, which also runs hub-wide jobs, and answer options) get their own
// fixture servers instead of sharing hub state with journeys that start from missing configuration.
const keyed = ['improver.spec.ts', 'answer-options.spec.ts'];
// Projects journeys get servers started with --projects: their GitHub-shaped project, fake GitHub, accounts and scripted
// turns are hub-wide state the other journeys must not see.
const projectsSpec = 'projects.spec.ts';
const decisionsSpec = 'decisions-settings.spec.ts';
const projects = [
  ...layouts.map((layout, index) => ({ name: layout.name, metadata: { layout: layout.name }, testIgnore: ['installation.spec.ts', ...keyed, projectsSpec, decisionsSpec], use: { ...layout.use, baseURL: `http://127.0.0.1:${base + index}` } })),
  ...layouts.map((layout, index) => ({ name: `${layout.name}-improver`, metadata: { layout: layout.name }, testMatch: keyed, use: { ...layout.use, baseURL: `http://127.0.0.1:${base + layouts.length + index}` } })),
  ...layouts.map((layout, index) => ({ name: `${layout.name}-projects`, metadata: { layout: layout.name }, testMatch: projectsSpec, use: { ...layout.use, baseURL: `http://127.0.0.1:${base + 2 * layouts.length + index}` } })),
  ...layouts.map((layout, index) => ({ name: `${layout.name}-decisions`, metadata: { layout: layout.name }, testMatch: decisionsSpec, use: { ...layout.use, baseURL: `http://127.0.0.1:${base + 3 * layouts.length + index}` } })),
];
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, timeout: 120_000, workers: 4,
  // Assertions wait as long as actions: with four workers, diffs, checkpoints and step launches can take over five seconds.
  expect: { timeout: 15_000 },
  use: { trace: 'retain-on-failure', actionTimeout: 15_000, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  projects: [...projects, { name: 'installation', workers: 1, testMatch: 'installation.spec.ts' }],
  // Every server is ready only after its control listener binds, after member, account and project seeding.
  // SIGTERM lets each fixture server close its daemons and remove its temporary root (a SIGKILL leaves about 25 MB behind).
  webServer: projects.flatMap((project, index) => {
    // Packed installation journeys start their own installed daemons and need no ordinary fixture servers.
    if (process.env.JEVELLAN_E2E_FIXTURE_GROUP === 'installation') return [];
    if (process.env.JEVELLAN_E2E_FIXTURE_GROUP === 'projects' && !project.name.endsWith('-projects')) return [];
    const seeded = project.name.endsWith('-projects');
    return [{ command: `node scripts/test-server.mjs --port ${base + index}${seeded ? ' --projects' : ''}`, url: `http://127.0.0.1:${base + index + 200}/ready`,
      reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 15_000 } }];
  }),
});
