import { splitExposures, partitionProminent, collapsedExposureNote } from './detect-exposure.mjs';
import { countProposals } from './gap-model.mjs';

const MARK = { absent: '[ ]', declared: '[~]', verified: '[x]', failing: '[!]', 'n/a': '[-]' };
const PHASE_NAMES = { 0: 'Reconnaissance', 1: 'Legible', 2: 'Senses', 4: 'Continuity' };

export function deriveCouldNotDerive({ stack, checks, nested = [], profile = {} }) {
  const out = [];
  if (nested.length) {
    const paths = nested.map(n => n.path).join(', ');
    // "detected", not "contains": a repository whose .git is a file
    // (separate-git-dir layout) is a known blind spot, so this list is what was
    // found, not a guarantee of completeness.
    out.push(`${nested.length} nested repositor${nested.length === 1 ? 'y was' : 'ies were'} detected (${paths}). Stack detection and credential scanning covered this repository only; each nested repository must be assessed separately.`);
  }
  if (profile.id === 'generic') {
    out.push('Stack detection did not reach a decision (confidence below 0.5). What is this project\'s primary stack? Stack-specific steps were skipped as a result.');
  }
  if (stack.packages.length > 3) {
    out.push(`Which packages should the per-edit sensor cover? Detected ${stack.packages.length}; linting all of them on every edit may be too slow.`);
  }
  if (!stack.packageManager) {
    out.push('No lockfile found, so the package manager is unknown. Confirm which one this project uses.');
  }
  if (checks.some(c => c.id === 'P1.instructions' && c.state === 'declared')) {
    out.push('An instruction file already exists. Which of its rules are decisions that cannot be re-derived from source? Those must survive any regeneration.');
  }
  // Questions routed by buildGaps from checks that could not decide. These are
  // the `absent` results that may not propose: asking is what they do instead.
  for (const c of checks) if (c.question) out.push(c.question);
  return out;
}

export function buildReport({ root, kitVersion, git, stack, harness, exposures, profile, checks, nested = [] }) {
  return {
    schema: 1,
    kitVersion,
    generatedAt: new Date().toISOString(),
    repo: { root, vcs: git.isRepo ? 'git' : null, branch: git.branch ?? null },
    profile: profile.id,
    stack,
    harness,
    exposures,
    checks,
    nested,
    couldNotDerive: deriveCouldNotDerive({ stack, checks, nested, profile }),
  };
}

export function renderSummary(report) {
  const lines = [];
  lines.push(`harness-kit ${report.kitVersion} — ${report.repo.root}`);
  lines.push(`profile: ${report.profile}   branch: ${report.repo.branch ?? '(none)'}`);
  lines.push('');

  const phases = [...new Set(report.checks.map(c => c.phase))].sort((a, b) => a - b);
  for (const phase of phases) {
    lines.push(`Phase ${phase} — ${PHASE_NAMES[phase] ?? ''}`.trimEnd());
    for (const c of report.checks.filter(x => x.phase === phase)) {
      lines.push(`  ${MARK[c.state]} ${c.id.padEnd(18)} ${c.state}`);
      for (const e of c.evidence) lines.push(`        ${e}`);
      if (c.proposal) lines.push(`      → ${c.proposal}`);
    }
    lines.push('');
  }

  if (report.nested && report.nested.length) {
    lines.push(`Nested repositories detected (${report.nested.length}) — not scanned:`);
    for (const n of report.nested) lines.push(`  • ${n.path} (${n.kind})`);
    lines.push('');
  }

  if (report.exposures.length) {
    // Task 9b, finding 1: the prominent/collapsed split is the SAME one
    // P0.security's own check applies (gap-model.mjs, via the shared
    // detect-exposure.mjs helpers) — the heading count, the listed findings
    // and P0.security's evidence can never disagree about what counts as
    // noise, because all three read it from one place.
    const { prominent, collapsedCount } = splitExposures(report.exposures);
    // Whole-branch review, F1: a file the sweep could not READ is on the same
    // list as a credential finding — it is a finding of the same sweep — but
    // it is not a credential, and the Exposures heading's "values are never
    // printed; rotate by hand" is not true of it. Partitioned through the
    // SHARED `partitionProminent` (detect-exposure.mjs), the same function
    // `P0.security` reads, so the two can never disagree about which section
    // a finding belongs in or how many are in each.
    const { credentials, unreadable } = partitionProminent(prominent);

    if (credentials.length || collapsedCount) {
      let heading = `Exposures (${credentials.length})`;
      if (report.nested && report.nested.length) {
        heading += ` — this repository only; ${report.nested.length} nested repositor${report.nested.length === 1 ? 'y' : 'ies'} not scanned`;
      }
      heading += ' — values are never printed; rotate by hand:';
      lines.push(heading);
      for (const e of credentials) lines.push(`  ! ${e.severity.padEnd(6)} ${e.kind} at ${e.location}`);
      if (collapsedCount) lines.push(`  ~ ${collapsedExposureNote(collapsedCount)}`);
      lines.push('');
    }

    if (unreadable.length) {
      lines.push(`Not examined (${unreadable.length}) — the credential sweep could NOT read these, so they were never scanned:`);
      for (const e of unreadable) lines.push(`  ! ${e.location} — ${e.reason ?? 'unknown reason'}`);
      lines.push('');
    }
  }

  const n = countProposals(report.checks);
  lines.push(n === 0 ? 'No proposals — this repository already satisfies every applicable step.' : `${n} proposal${n === 1 ? '' : 's'}. Nothing has been written except docs/harness/detect.json.`);

  // Distinct from proposals, deliberately: a proposal is "the tool will do
  // this"; advice is "you should do this, but harness-kit will not" (e.g.
  // P2.scripts — see gap-model.mjs's own comment on why package.json is
  // never written). Folding these into the `→` proposal lines above would
  // blur a line a reader must be able to trust without re-deriving it.
  const advice = report.checks.flatMap(c => c.advice ?? []);
  if (advice.length) {
    lines.push('');
    lines.push('Advice — reported only; harness-kit will not write these:');
    for (const a of advice) lines.push(`  * ${a}`);
  }

  if (report.couldNotDerive.length) {
    lines.push('');
    lines.push('Could not derive — answer these before applying:');
    for (const q of report.couldNotDerive) lines.push(`  ? ${q}`);
  }

  return lines.join('\n');
}
