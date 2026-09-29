import { readFileSync } from 'node:fs';
import { DecisionEvaluationOutputSchema, DecisionEvaluationSummarySchema, parseConfiguration, seedConfiguration } from '../packages/core/dist/index.js';
import { JevClient, JevError, compareDecisionCases, evaluateDecisionCase, savedDecisionCases } from '../packages/decisions/dist/index.js';

const args = process.argv.slice(2); const paths = {};
if (args.includes('--help')) {
  console.log('Usage: npm run eval:decisions -- [--configuration apm.yml] [--proposed proposed-apm.yml]\nUses only JEVELLAN_TEST_JEV_KEY. Evaluates 27 saved engineering cases with real Jev; no generative runtime is launched.');
} else {
  try {
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i]; const value = args[i + 1];
      if (!['--configuration', '--proposed'].includes(name) || !value || value.startsWith('--') || paths[name]) throw new Error('Invalid arguments. Use --help.');
      paths[name] = value;
    }
    if (!process.env.JEVELLAN_TEST_JEV_KEY?.trim()) {
      console.error('BLOCKED: JEVELLAN_TEST_JEV_KEY is missing. No live decision cases ran.'); process.exitCode = 2;
    } else {
      const configuration = paths['--configuration'] ? parseConfiguration(readFileSync(paths['--configuration'], 'utf8')) : seedConfiguration();
      const proposed = paths['--proposed'] ? parseConfiguration(readFileSync(paths['--proposed'], 'utf8')) : undefined;
      const client = new JevClient({ key: () => process.env.JEVELLAN_TEST_JEV_KEY, timeoutMs: configuration['x-jevellan'].decisions.timeoutMs });
      const controller = new AbortController(); const cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const cases = savedDecisionCases();
        if (proposed) {
          const comparison = await compareDecisionCases(client, cases, configuration, proposed, 'live', controller.signal);
          console.log(JSON.stringify(comparison, null, 2));
          if (comparison.worse) process.exitCode = 1;
        } else {
          let failed = 0;
          for (const example of cases) {
            const result = await evaluateDecisionCase(client, example, configuration, controller.signal);
            console.log(JSON.stringify(DecisionEvaluationOutputSchema.parse({ schema: 'decision-case-output-v1', evidence: 'live', result })));
            if (!result.acceptable) failed++;
          }
          console.log(JSON.stringify(DecisionEvaluationSummarySchema.parse({ schema: 'decision-evaluation-summary-v1', evidence: 'live', total: cases.length, passed: cases.length - failed, failed })));
          if (failed) process.exitCode = 1;
        }
      } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
  } catch (error) {
    console.error(error instanceof JevError ? `Live decision evaluation did not complete: ${error.message}.` : 'Decision evaluation did not complete. Check the arguments, configuration and saved cases.');
    process.exitCode = 1;
  }
}
