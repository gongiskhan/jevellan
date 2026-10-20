import { ProjectDeploySummarySchema, type ProjectDeploy, type ProjectDeployBaseline } from '@jevellan/core';

/** Shared by deployment guards and all clients; a baseline records state, not an attested deployment event. */
export function currentProjectDeploy(rows: readonly ProjectDeploy[], baseline: ProjectDeployBaseline | null) {
  const events = rows.flatMap(row => [
    ...(row.deployedAt ? [{ source: 'deploy' as const, at: row.deployedAt, commit: row.releaseUncertain ? null : row.commit, rollbackAvailable: !row.releaseUncertain, record: row }] : []),
    ...(row.rollback ? [{ source: 'rollback' as const, at: row.rollback.at, commit: row.rollback.result === 'done' ? row.rollback.toCommit : null, rollbackAvailable: row.rollback.result === 'done', record: row }] : []),
  ]).sort((a, b) => b.at.localeCompare(a.at));
  if (baseline && (!events[0] || Date.parse(baseline.updatedAt) > Date.parse(events[0].at))) return { source: 'baseline' as const, at: baseline.updatedAt, commit: baseline.commit, rollbackAvailable: baseline.rollbackAvailable, record: null };
  return events[0] ?? null;
}

export function deployBusy(rows: readonly ProjectDeploy[], row: ProjectDeploy, allowOwnMonitor = false): boolean {
  return !!(!allowOwnMonitor && row.monitor || row.rollbackPending && !row.rollback || rows.some(item => item.id !== row.id && (['approved', 'running'].includes(item.state) || item.monitor || item.rollbackPending && !item.rollback)));
}
export const DEPLOY_BUSY = 'A deploy is already running. Wait for it to finish before approving this message.';
export function projectRollbackRefusal(rows: readonly ProjectDeploy[], baseline: ProjectDeployBaseline | null, row: ProjectDeploy | undefined, revision: number): string | null {
  if (!row || row.revision !== revision || !row.deployedAt || row.rollback || currentProjectDeploy(rows, baseline)?.commit !== row.commit) return 'Only the current latest deploy can be rolled back.';
  if (deployBusy(rows, row, true)) return DEPLOY_BUSY;
  if (!row.previousCommit || !row.rollbackAvailable) return 'A rollback image is not available.';
  return null;
}
const short = (commit: string | null) => commit?.slice(0, 7) ?? 'unknown';
const clock = (at: string, timezone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

export function projectDeploySummary(projectId: string, rows: readonly ProjectDeploy[], baseline: ProjectDeployBaseline | null, timezone: string) {
  const current = currentProjectDeploy(rows, baseline), record = current?.record;
  const candidate = current?.commit ? rows.findLast(row => row.commit === current.commit && row.deployedAt && !row.rollback) : undefined;
  const refusal = candidate ? projectRollbackRefusal(rows, baseline, candidate, candidate.revision) : null;
  const label = current ? `${current.source === 'baseline' ? 'Recorded deploy baseline' : 'Last deploy'}: ${short(current.commit)}, ${clock(current.at, record?.timezone ?? timezone)}` : null;
  const healthAfter = record?.health.after.map(run => `${record.checks.find(check => check.id === run.checkId)?.name ?? run.checkId} ${run.passed ? 'passed' : 'failed'}`).join(', ') || 'not run';
  const unavailable = candidate ? candidate.rollbackPending ? 'a rollback is running' : !candidate.previousCommit || !candidate.rollbackAvailable ? `no image for ${candidate.previousCommit?.slice(0, 7) ?? 'the previous commit'}` : refusal?.replace(/\.$/u, '')
    : current?.commit === null ? 'the current production commit is unknown' : record?.rollback ? 'it was already rolled back' : 'no current deployment record';
  const availability = candidate && refusal === null ? 'available' : `not available (${unavailable})`;
  return ProjectDeploySummarySchema.parse({ schema: 'project-deploy-summary-v1', projectId,
    current: current ? { source: current.source, commit: current.commit, at: current.at,
      label } : null,
    toolLine: current && record ? `${label} · health after: ${healthAfter} · rollback to ${short(candidate?.previousCommit ?? record.previousCommit)}: ${availability}` : label,
    healthLines: record?.checks.map(check => {
      const run = record.messageHealth.find(item => item.checkId === check.id), failed = run?.steps.find(step => !step.passed);
      return `${check.name}: ${run ? `${run.passed ? 'passed' : 'failed'} at ${clock(run.at, record.timezone)}${failed ? `: ${failed.name}: ${failed.reason ?? 'failed'}` : ''}` : 'not run yet'}`;
    }) ?? [],
    desktopLine: record?.desktop?.state === 'skipped' ? `Desktop build skipped: ${record.desktop.reason ?? 'not available'}` : null,
    rollback: candidate ? { deployId: candidate.id, enabled: refusal === null, pending: candidate.rollbackPending?.reason === 'owner', refusal,
      label: `Roll back to ${short(candidate.previousCommit)}`, confirmation: `Roll back production to ${short(candidate.previousCommit)}?`,
      detail: `Rolling production back to ${short(candidate.previousCommit)} replaces ${short(candidate.commit)} (deployed ${clock(candidate.deployedAt!, candidate.timezone)}, ${candidate.threads.length} threads). Call again with confirm to do it.`,
      path: `/api/projects/${projectId}/deploys/${candidate.id}/rollback`, body: { schema: 'project-deploy-rollback-request-v1', clientRequestId: `rollback_${candidate.id}_${candidate.revision}`, expectedRevision: candidate.revision },
    } : null,
  });
}
