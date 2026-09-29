import type { Action } from '@jevellan/core';
export { ACTION_DESCRIPTIONS } from '@jevellan/core';

const common = 'Work only in the specified project. Preserve the request and constraints. Do not stop, restart, update or redeploy Jevellan. Do not commit or push: Jevellan owns checkpoints and publication. Finish by calling jevellan_handoff exactly once with an honest status, summary, evidence pointers, findings, blockers and failed approaches. Keep full results in the result field; do not replace them with a short summary. Tests you report are evidence, not Jevellan verification.';
const contracts: Partial<Record<Action, string>> = {
  reply: 'Answer the message using the project as needed. Do not edit code or run writing commands. Return an answer result when useful, status done and proposedNext null unless further work is clearly requested. If execution was requested, return status partial and proposedNext implement; lacking shell tools in this step is not a user blocker. Never propose integrate for an ordinary command: it is reserved for publication conflicts.',
  plan: 'Inspect the project read-only. Return the complete plan as a result of type plan: goal, ordered steps, affected files, reproducible checks and risks. Include all remaining work. Do not create or edit a plan file. Propose implement next.',
  implement: 'Carry out the requested change or command, including operational work needing no code edits. Keep scope to the request. Before the first writing step under main policy, Jevellan fetches and fast-forwards clean main to origin/main; inspect that result for an update request rather than changing Git history yourself. Do not repeat completed work. Run fast relevant checks where appropriate. List changes and exact checks. Preserve partial results and state unfinished work; never claim unrun commands or checks passed.',
  test: 'Run the project tests and add durable missing tests for this change. Do not edit application code. Report exact commands, exit outcomes and evidence pointers in testsRun. Exercise the real user path when appropriate. A passed test does not authorize publication.',
  review: 'Read the diff from the work base commit to HEAD. Do not edit. Report concrete correctness findings with file:line and severity serious or minor. Propose implement for serious findings, otherwise done. Preserve any outstanding verification obligation.',
  'adversarial-review': 'Read the change and try to break its requirements, edge cases, concurrency and boundaries without editing. Report concrete findings with file:line and severity serious or minor. Propose implement for serious findings, otherwise done.',
  integrate: 'Resolve the publication conflict by rebasing the work onto origin/main, preserving both sides of the intent. Use jevellan_integrate with command start, edit the reported conflicting files, then call it with continue until clean. The tool stages those paths and records the exact rewritten checkpoints for undo. Use skip only when the current commit should contribute no change. Do not run a separate rebase or change Git history outside this tool. Return done only once no rebase is in progress and no conflict markers remain. Never push; Jevellan verifies and publishes.',
};
export function actionContract(action: Action): string {
  if (!contracts[action]) throw new Error('This action has no runtime stretch.');
  return `${contracts[action]}\n\n${common}`;
}
export function actionPermissions(action: Action): 'read-only' | 'write' {
  if (!contracts[action]) throw new Error('This action has no runtime stretch.');
  return ['implement', 'test', 'integrate'].includes(action) ? 'write' : 'read-only';
}
