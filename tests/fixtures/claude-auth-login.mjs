#!/usr/bin/env node
// A stand-in for `claude auth login`: prints the sign-in link and its prompt, then accepts the code "good" by writing the
// interactive credentials file into CLAUDE_CONFIG_DIR, the way the real command does.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
if (process.argv[2] !== 'auth' || process.argv[3] !== 'login') process.exit(2);
process.stdout.write('Opening browser to sign in...\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=fixture\n\nPaste code here if prompted > ');
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim() === 'good') { writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{"fixture":true}'); process.stdout.write('\nLogin successful.\n'); process.exit(0); }
  process.stdout.write('\nOAuth error: Invalid code.\n'); process.exit(1);
});
