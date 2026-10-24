import {afterEach, beforeEach, expect, test} from 'vitest';
import {mkdtempSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {claudePermissionHook, safetyDenial} from '../packages/runtime-contract/dist/index.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-literal-input-'));
  for (const name of ['worktree', 'protected', 'private-inputs']) mkdirSync(join(root, name));
  mkdirSync(join(root, 'worktree', 'nested'));
});
afterEach(() => rmSync(root, {recursive: true, force: true}));
const context = () => ({cwd: join(root, 'worktree'), daemonPid: 41999, profile: 'thread' as const,
  protectedPaths: [join(root, 'protected')], privatePaths: [join(root, 'private-inputs')]});

test('quoted cat document input remains literal data in both runtime guards', async () => {
  const commands = [
    "cat > note.md <<'DOC'\nExample: > $OUTPUT\nDon't execute git push.\nDOC\n",
    'cat <<"DOC" > "note with spaces.md"\ngit push\nDOC\n',
    'cat <<\\DOC > note.md\nrm -rf /example\nDOC\n',
    "cat <<-'DOC' > note.md\n\tExample: > $OUTPUT\n\tDOC\n",
    "cat <<'FIRST' <<'SECOND' > note.md\nExample: > $ONE\nFIRST\nExample: > $TWO\nSECOND\n",
    "cd nested\ncat > note.md <<'DOC'\ngit push\nDOC\n",
    "cat > note.md <<'DOC'\n`git push` and $(git push) are documentation.\nDOC\n",
  ];
  const ctx = context();
  const hook = claudePermissionHook({...ctx, permissions: 'write'});
  for (const command of commands) {
    expect(safetyDenial(command, ctx), command).toBeNull();
    expect(await hook({tool_name: 'Bash', tool_input: {command}})).toEqual({});
    const output = execFileSync(process.execPath,
      [fileURLToPath(new URL('../runtimes/codex/dist/safety-hook.js', import.meta.url)), JSON.stringify(ctx)],
      {input: JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command}}), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore']});
    expect(JSON.parse(output)).toEqual({});
  }
  execFileSync('/bin/bash', ['-c', commands[0]!], {cwd: ctx.cwd, stdio: 'ignore'});
  expect(readFileSync(join(ctx.cwd, 'note.md'), 'utf8')).toBe("Example: > $OUTPUT\nDon't execute git push.\n");
});

test.each([
  "cat > ../protected/note.md <<'DOC'\nLiteral text.\nDOC\n",
  "cat >> ../protected/note.md <<'DOC'\nLiteral text.\nDOC\n",
  "cat ../private-inputs/input <<'DOC'\nLiteral text.\nDOC\n",
  "cat > note.md <<'DOC'\nLiteral text.\nDOC\ngit push\n",
  "cat <<'DOC' | bash\ngit push\nDOC\n",
  "bash <<'DOC'\ngit push\nDOC\n",
  "cat > note.md # <<'DOC'\ngit push\nDOC\n",
  "printf '%s' \"cat <<'DOC'\"\ngit push\nDOC\n",
  "cat > note.md <<DOC\ngit push\nDOC\n",
])('executable commands and protected operands remain guarded around literal input (%#)', command => {
  expect(safetyDenial(command, context())).not.toBeNull();
});

test('enclosing shell syntax retains input that can reach an interpreter', () => {
  const commands = [
    "{\ncat <<'DOC'\ngit push\nDOC\n} | bash\n",
    "bash -c $(\ncat <<'DOC'\ngit push\nDOC\n)\n",
    "bash -c `\ncat <<'DOC'\ngit push\nDOC\n`\n",
    "if true; then\ncat <<'DOC'\ngit push\nDOC\nfi | bash\n",
  ];
  for (const command of commands) expect(safetyDenial(command, context()), command).not.toBeNull();
});
