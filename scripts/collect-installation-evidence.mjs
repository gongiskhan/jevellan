import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { InstallationNotices } from './spikes/installation-notices.mjs';

const FirstRun = z.strictObject({
  layout: z.enum(['desktop', 'phone']), theme: z.enum(['light', 'dark']),
  browserSetup: z.literal(true), guidedSetup: z.literal(true), skippedJev: z.boolean(),
  configuredDoctor: z.literal(true), verifiedPublication: z.literal(true), retainedConversation: z.literal(true), providers: z.literal('simulated'),
});
const Checks = z.strictObject({
  independentCopy: z.literal(true), installedCommand: z.literal(true), commandUpdate: z.literal(true), commandRollback: z.literal(true), commandRemoved: z.literal(true),
  occupiedPortSkipped: z.literal(true), uiAndAsset: z.literal(true), doctorExecutableChecks: z.literal(true), doctorMissingCredentials: z.literal(true),
  memberJoined: z.literal(true), memberUiLogin: z.literal(true), memberRepeatPreserved: z.literal(true), memberRemoval: z.literal(true), busyUninstallRefused: z.literal(true),
  updateWaited: z.literal(true), updateVersion: z.literal('0.2.0'), rollbackVersion: z.literal('0.1.0'), removedServiceAndApplications: z.literal(true), dataRetained: z.literal(true),
  purgeRemovedHome: z.literal(true), purgePreservedExternalFiles: z.literal(true), canariesPreserved: z.literal(true), nativeServicesInvoked: z.literal(false),
});
const Receipt = z.object({ schema: z.literal('installation-command-check-v8'), at: z.iso.datetime(), passed: z.literal(true), firstRun: FirstRun,
  package: z.literal('real-packed-application'), work: z.literal('real-conversation-simulated-providers'), dependencies: z.literal('live'),
  serviceManager: z.literal('fake-owned-processes'), updateRelease: z.literal('simulated-version-0.2.0'), devices: z.literal('local-simulated-devices'), checks: Checks });
const Evidence = z.strictObject({ schema: z.literal('j9-guided-v1'), runs: z.array(Receipt.extend({ screenshots: z.array(z.string().regex(/^screenshots\/phase5-guide-[a-z-]+\.png$/)) })).length(4) });
const NoticesEvidence = z.strictObject({ schema: z.literal('j9-installed-notices-v1'), files: InstallationNotices.shape.files,
  runs: z.array(InstallationNotices.omit({ files: true }).extend({ layout: FirstRun.shape.layout, theme: FirstRun.shape.theme })).length(4) });

const roots = process.argv.slice(2).map(root => resolve(root));
if (roots.length !== 4) throw new Error('Provide the four completed guided installation fixture directories.');
const sources = roots.map(root => ({ root, receipt: Receipt.parse(JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))),
  notices: InstallationNotices.parse(JSON.parse(readFileSync(join(root, 'installation-notices.json'), 'utf8'))) }));
if (new Set(sources.map(({ receipt }) => `${receipt.firstRun.layout}-${receipt.firstRun.theme}`)).size !== 4) throw new Error('Provide one result for each desktop/phone and light/dark layout.');
if (new Set(sources.map(({ notices }) => JSON.stringify(notices.files))).size !== 1) throw new Error('The four installations contain different notice inventories.');
const noticeEvidence = NoticesEvidence.parse({ schema: 'j9-installed-notices-v1', files: sources[0].notices.files,
  runs: sources.map(({ receipt, notices }) => ({ schema: notices.schema, at: notices.at, scope: notices.scope, passed: notices.passed,
    layout: receipt.firstRun.layout, theme: receipt.firstRun.theme })) });
const copies = [];
const runs = sources.map(({ root, receipt }) => {
  const { layout, theme, skippedJev } = receipt.firstRun;
  if (skippedJev !== (layout === 'phone')) throw new Error('The phone journey must exercise skipped Jev setup.');
  const screenshots = ['welcome', 'jev', 'connected', 'account', 'project', 'conversation', 'running', 'verified', 'why', ...(skippedJev ? ['manual'] : [])].map(name => {
    const destination = `screenshots/phase5-guide-${name}-${layout}-${theme}.png`;
    const source = join(root, `first-run-${name}-${layout}-${theme}.png`);
    const bytes = readFileSync(source);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('An installation capture is not a PNG.');
    copies.push({ source, destination }); return destination;
  });
  return { ...receipt, screenshots };
});
const evidence = Evidence.parse({ schema: 'j9-guided-v1', runs });
for (const { source, destination } of copies) copyFileSync(source, resolve('docs/acceptance', destination));
writeFileSync(resolve('docs/acceptance/J9-guided.json'), `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(resolve('docs/acceptance/J9-installed-notices.json'), `${JSON.stringify(noticeEvidence, null, 2)}\n`);
console.log(`Recorded ${evidence.runs.length} guided installation results and ${copies.length} captures.`);
