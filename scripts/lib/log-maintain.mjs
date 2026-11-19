// scripts/lib/log-maintain.mjs
//
// `log maintain`: the sealing and retention the hook runs at session start
// within 150 ms, run here for minutes, for a log that has outgrown that.
// It reports counts and reasons only, never a logged event's content.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { BLOBS_DIR, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { applyRetention, SEAL_IDLE_MS, sealClosedSessions } from '../../assets/scripts/harness-seal.mjs';
import { idWithSuffix, sessionNames, sessionsDir } from './log-lib.mjs';

// The index lock is breakable once it is 10 minutes old, so each of the two
// locked steps stops well inside that; what is left is done by a later run.
const MAINTAIN_BUDGET_MS = 5 * 60_000;

function blobNames(root) {
  try {
    return readdirSync(join(repoDataDir(root), BLOBS_DIR));
  } catch {
    return [];
  }
}

/** Sessions still holding unsealed events after a run: those appended to
 * within the idle threshold, which sealing leaves by design, and the rest. */
function unsealedAfter(root, now) {
  let recent = 0;
  let other = 0;
  for (const name of sessionNames(root)) {
    if (idWithSuffix(name, '.jsonl') === null) continue;
    try {
      if (now - statSync(join(sessionsDir(root), name)).mtimeMs < SEAL_IDLE_MS) recent++;
      else other++;
    } catch {
      // sealed since it was listed
    }
  }
  return { recent, other };
}

/**
 * Seals closed sessions and applies retention, as the hook does at session
 * start, with a budget of minutes rather than milliseconds, and says what was
 * done, what was left, and why sealing did not run when it did not.
 */
export function maintainLog(root) {
  const started = performance.now();
  const blobsBefore = blobNames(root);
  const seal = sealClosedSessions(root, { budgetMs: MAINTAIN_BUDGET_MS });
  const retention = applyRetention(root, { budgetMs: MAINTAIN_BUDGET_MS - (performance.now() - started) });
  const blobsAfter = new Set(blobNames(root));
  return {
    sealed: seal.sealed.length,
    sealingNotRun: seal.notRun,
    contentRemoved: retention.contentRemoved,
    contentUnverifiable: retention.contentUnverifiable,
    blobsRemoved: blobsBefore.filter(name => !blobsAfter.has(name)).length,
    blobSweep: retention.blobSweep,
    lockLost: seal.lockLost || retention.lockLost,
    timeLimitReached: performance.now() - started >= MAINTAIN_BUDGET_MS,
    unsealed: unsealedAfter(root, Date.now()),
  };
}

export function renderMaintain(r) {
  const out = [];
  if (r.sealingNotRun !== null) out.push(`sealing did not run: ${r.sealingNotRun}`);
  out.push(
    `sessions sealed: ${r.sealed}`,
    `content expired: ${r.contentRemoved} sessions`,
    `blobs removed: ${r.blobsRemoved}`,
  );
  if (r.blobSweep.skipped) out.push(`blob sweep skipped: ${r.blobSweep.reason}`);
  if (r.contentUnverifiable > 0) out.push(`content past the period left in place, because it could not be verified: ${r.contentUnverifiable} sessions`);
  if (r.unsealed.recent > 0) out.push(`not sealed: ${r.unsealed.recent} sessions appended to in the last ${SEAL_IDLE_MS / 60_000} minutes, which may still be running`);
  if (r.unsealed.other > 0) out.push(`not sealed: ${r.unsealed.other} other sessions; \`status\` says whether the index explains why`);
  if (r.timeLimitReached) out.push(`the ${MAINTAIN_BUDGET_MS / 60_000}-minute limit was reached; run maintain again to continue`);
  if (r.lockLost) out.push('the index lock was broken by another process during the run, which then stopped');
  return out.join('\n');
}
