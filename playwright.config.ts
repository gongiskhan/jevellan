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
const projects = [
  ...layouts.map((layout, index) => ({ name: layout.name, metadata: { layout: layout.name }, testIgnore: ['installation.spec.ts', ...keyed, projectsSpec], use: { ...layout.use, baseURL: `http://127.0.0.1:${base + index}` } })),
  ...layouts.map((layout, index) => ({ name: `${layout.name}-improver`, metadata: { layout: layout.name }, testMatch: keyed, use: { ...layout.use, baseURL: `http://127.0.0.1:${base + layouts.length + index}` } })),
  ...layouts.map((layout, index) => ({ name: `${layout.name}-projects`, metadata: { layout: layout.name }, testMatch: projectsSpec, use: { ...layout.use, baseURL: `http://127.0.0.1:${base + 2 * layouts.length + index}` } })),
];
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, timeout: 120_000, workers: 4,
  // Assertions wait as long as actions: with four workers, diffs, checkpoints and step launches can take over five seconds.
  expect: { timeout: 15_000 },
  use: { trace: 'retain-on-failure', actionTimeout: 15_000, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  projects: [...projects, { name: 'installation', workers: 1, testMatch: 'installation.spec.ts' }],
  // A --projects server is ready once its control listener answers, which binds after the accounts and projects are seeded.
  // SIGTERM lets each fixture server close its daemons and remove its temporary root (a SIGKILL leaves about 25 MB behind).
  webServer: projects.map((project, index) => {
    const seeded = project.name.endsWith('-projects');
    return { command: `node scripts/test-server.mjs --port ${base + index}${seeded ? ' --projects' : ''}`, url: seeded ? `http://127.0.0.1:${base + index + 200}/projects/ready` : `${project.use.baseURL}/api/health`,
      reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 15_000 } };
  }),
});
