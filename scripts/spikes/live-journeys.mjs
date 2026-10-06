// Live acceptance journeys: node scripts/spikes/live-journeys.mjs --journey <name> [options]
// J1, J2, J4, J5, J6, J7-off, J7-on and J13 are the conversation journeys (live-conversation-journeys.mjs: the real Claude
// runtime, real Jev and real Git against a local bare origin). PJ-live is the Projects journey (live-projects-journey.mjs: a
// real Codex account, Claude when its token is present, real Jev and a disposable GitHub repository); it checks its
// credentials before anything else and writes a blocked receipt, without starting a daemon, when a required one is missing.
// Credentials come only from JEVELLAN_TEST_* variables; each journey removes them from its own environment before it starts.
const index = process.argv.indexOf('--journey');
const journey = index < 0 ? undefined : process.argv[index + 1];
await import(journey === 'PJ-live' ? './live-projects-journey.mjs' : './live-conversation-journeys.mjs');
