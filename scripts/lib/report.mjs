import { splitExposures, partitionProminent, collapsedExposureNote } from './detect-exposure.mjs';
import { basename } from 'node:path';
import { countProposals } from './gap-model.mjs';

const MARK = { absent: '[ ]', declared: '[~]', verified: '[x]', failing: '[!]', 'n/a': '[-]' };
const PHASE_NAMES = { 0: 'Reconnaissance', 1: 'Legible', 2: 'Senses', 3: 'Intent', 4: 'Continuity' };

/** The uv workspace members (detect-stack.mjs, `uvWorkspace`) when the
 * selected profile is not the Python one — the mixed shape — else null. */
function mixedUvWorkspace(stack, profileId) {
  const members = stack?.uvWorkspace?.members ?? [];
  return members.length && String(profileId).startsWith('typescript') ? members : null;
}

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
  // A uv workspace beside a non-Python profile (Vyugate trial): the profile
  // is right about the root manifest and silent about the Python members.
  // Asked, not acted on — what to derive for them is a decision.
  const uv = mixedUvWorkspace(stack, profile.id);
  // Only the install step is left to ask about: the per-edit sensor falls back
  // to a package.json beside a member's pyproject.toml, so Python edits in such
  // a workspace are linted with no decision needed.
  if (uv && stack.packageManager && stack.packageManager !== 'uv') {
    out.push(`This repository is also a uv workspace with ${uv.length} Python member${uv.length === 1 ? '' : 's'} (${uv.join(', ')}), ` +
      `but its profile is ${profile.id}, from the root package.json, and the bootstrap install step is derived for ${stack.packageManager} only, ` +
      'so uv.lock is not installed by it. Should the bootstrap install the Python members too?');
  }
  // Coordinator ruling (post-review, concern 1): a workspace pattern this
  // tool REFUSED to interpret must be reported, not absorbed. `glob.mjs`
  // already fails closed on it — a refused pattern compiles to a
  // never-matching source — but a pattern that silently matches nothing is
  // indistinguishable from a workspace with no members, which is exactly the
  // confident-and-wrong shape this report exists to avoid. The pattern's own
  // text is never echoed: it is repository-controlled and holds a control
  // character by definition, so the index is what is named.
  const rejected = stack.rejectedWorkspacePatterns ?? [];
  if (rejected.length) {
    const s = rejected.length === 1 ? '' : 's';
    const is = rejected.length === 1 ? 'is' : 'are';
    out.push(`${rejected.length} workspace pattern${s} (at index ${rejected.join(', ')} of this repository's own \`workspaces\` list) ${is} not a usable glob — ${rejected.length === 1 ? 'it contains' : 'they contain'} a NUL character, so ${rejected.length === 1 ? 'it was' : 'they were'} refused rather than interpreted, and any package ${rejected.length === 1 ? 'it' : 'they'} would have matched is NOT in this report. The value is not printed here because it is repository-controlled and holds a control character. What should ${rejected.length === 1 ? 'that entry' : 'those entries'} be?`);
  }
  // Asked only while no rules registry exists (audit Tier 4, finding 20: it
  // used to be asked on every run, forever). Once docs/harness/RULES.md is
  // there, that is where the answer lives — each rule names what holds it —
  // and P3.rules' advice already lists the rule-shaped lines still outside it.
  const registryExists = checks.some(c => c.id === 'P3.rules' && c.state !== 'absent');
  if (!registryExists && checks.some(c => c.id === 'P1.instructions' && c.state === 'declared')) {
    out.push('An instruction file already exists. Which of its rules are decisions that cannot be re-derived from source? Those must survive any regeneration — docs/harness/RULES.md (Phase 3) is where each can name what enforces it.');
  }
  // Questions routed by buildGaps from checks that could not decide. These are
  // the `absent` results that may not propose: asking is what they do instead.
  for (const c of checks) if (c.question) out.push(c.question);
  return out;
}

/** The one file `detect` writes — named here so `apply`'s dirty-tree gate
 * can excuse it as the kit's own write (audit Tier 4, finding 21: a tracked
 * report, re-generated with a new `generatedAt`, refused the next apply). */
export const DETECT_REPORT_PATH = 'docs/harness/detect.json';

/**
 * The one line `detect` and a plain `apply` print when `apply --upgrade`
 * would update something — said with what was looked for, and only when
 * the list is non-empty (callers check). `paths` comes from propose.mjs's
 * `pendingUpgrades`, the same plan `--upgrade` acts on.
 */
/** One quiet line for linked worktrees of this repository — shared by
 * detect and apply, so the two say it the same way. */
export function worktreeLine(worktrees) {
  const n = worktrees.length;
  return `Linked worktrees of this repository (${n}) — checkouts of the same repository, not scanned: ${worktrees.map(w => w.path).join(', ')}`;
}

export function upgradeHint(paths) {
  const n = paths.length;
  return `${n} file${n === 1 ? '' : 's'} kh-harness wrote ${n === 1 ? 'is' : 'are'} older than this kit — unmodified since, stamped, ` +
    `and this kit generates different content (${paths.join(', ')}). \`apply --upgrade\` would update ${n === 1 ? 'it' : 'them'}.`;
}

export function buildReport({ root, kitVersion, git, stack, harness, exposures, profile, checks, nested = [], worktrees = [], upgradable = [] }) {
  return {
    schema: 1,
    kitVersion,
    generatedAt: new Date().toISOString(),
    // The repository's NAME, never its absolute path: detect.json is committed,
    // and the path carried the machine's user name (audit Tier 4, finding 23).
    repo: { name: basename(root), vcs: git.isRepo ? 'git' : null, branch: git.branch ?? null },
    profile: profile.id,
    stack,
    harness,
    exposures,
    checks,
    nested,
    // Linked worktrees of THIS repository (scan.mjs, isOwnWorktree): not
    // scanned, and not a question — they are checkouts of the same repository.
    worktrees,
    // Paths `apply --upgrade` would update (propose.mjs, `pendingUpgrades`).
    upgradable,
    couldNotDerive: deriveCouldNotDerive({ stack, checks, nested, profile }),
  };
}

/**
 * The Exposures and "Not examined" sections, as lines, with their trailing
 * blank separator — or `[]` when there is nothing to report.
 *
 * Exported and shared because `apply.mjs` performs the identical Phase-0
 * credential sweep and used to print NONE of it (whole-branch review, F9).
 * The fix had to not be a second renderer: two places formatting the same
 * findings is precisely the duplicated-predicate shape this branch's review
 * found five times over. `detect` and `apply` now print the same bytes for
 * the same exposures because they call the same function.
 *
 * Task 9b, finding 1: the prominent/collapsed split is the SAME one
 * `P0.security`'s own check applies (gap-model.mjs, via the shared
 * detect-exposure.mjs helpers) — the heading count, the listed findings and
 * `P0.security`'s evidence can never disagree about what counts as noise,
 * because all of them read it from one place.
 *
 * Whole-branch review, F1: a file the sweep could not READ is on the same
 * list as a credential finding — it is a finding of the same sweep — but it
 * is not a credential, and the Exposures heading's "values are never
 * printed; rotate by hand" is not true of it. Partitioned through the SHARED
 * `partitionProminent`, the same function `P0.security` reads, so the two
 * can never disagree about which section a finding belongs in, or how many
 * are in each.
 */
export function exposureSectionLines(exposures, nested = []) {
  if (!exposures || exposures.length === 0) return [];
  const lines = [];
  const { prominent, collapsedCount } = splitExposures(exposures);
  const { credentials, unreadable } = partitionProminent(prominent);

  if (credentials.length || collapsedCount) {
    let heading = `Exposures (${credentials.length})`;
    if (nested.length) {
      heading += ` — this repository only; ${nested.length} nested repositor${nested.length === 1 ? 'y' : 'ies'} not scanned`;
    }
    heading += ' — values are never printed; rotate by hand:';
    lines.push(heading);
    for (const e of credentials) lines.push(`  ! ${e.severity.padEnd(6)} ${e.kind} at ${e.location}${e.line ? ':' + e.line : ''}`);
    if (collapsedCount) lines.push(`  ~ ${collapsedExposureNote(collapsedCount)}`);
    lines.push('');
  }

  if (unreadable.length) {
    lines.push(`Not examined (${unreadable.length}) — the credential sweep could NOT read these, so they were never scanned:`);
    for (const e of unreadable) lines.push(`  ! ${e.location} — ${e.reason ?? 'unknown reason'}`);
    lines.push('');
  }

  return lines;
}

export function renderSummary(report) {
  const lines = [];
  lines.push(`kh-harness ${report.kitVersion} — ${report.repo.name}`);
  lines.push(`profile: ${report.profile}   branch: ${report.repo.branch ?? '(none)'}`);
  const uv = mixedUvWorkspace(report.stack, report.profile);
  if (uv) lines.push(`mixed stack: also a uv workspace (pyproject.toml [tool.uv.workspace] and uv.lock) with ${uv.length} Python member${uv.length === 1 ? '' : 's'} — see "Could not derive"`);
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

  if (report.worktrees?.length) {
    lines.push(worktreeLine(report.worktrees));
    lines.push('');
  }

  lines.push(...exposureSectionLines(report.exposures, report.nested ?? []));

  const n = countProposals(report.checks);
  lines.push(n === 0 ? 'No proposals — this repository already satisfies every applicable step.' : `${n} proposal${n === 1 ? '' : 's'}. Nothing has been written except docs/harness/detect.json.`);
  if (report.upgradable?.length) lines.push(upgradeHint(report.upgradable));

  // Distinct from proposals, deliberately: a proposal is "the tool will do
  // this"; advice is "you should do this, but kh-harness will not" (e.g.
  // P2.scripts — see gap-model.mjs's own comment on why package.json is
  // never written). Folding these into the `→` proposal lines above would
  // blur a line a reader must be able to trust without re-deriving it.
  const advice = report.checks.flatMap(c => c.advice ?? []);
  if (advice.length) {
    lines.push('');
    lines.push('Advice — reported only; kh-harness will not write these:');
    for (const a of advice) lines.push(`  * ${a}`);
  }

  if (report.couldNotDerive.length) {
    lines.push('');
    lines.push('Could not derive — answer these before applying:');
    for (const q of report.couldNotDerive) lines.push(`  ? ${q}`);
  }

  return lines.join('\n');
}
