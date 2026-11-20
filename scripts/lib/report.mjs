import { splitExposures, partitionProminent, collapsedExposureNote } from './detect-exposure.mjs';
import { basename } from 'node:path';
import { countProposals } from './gap-model.mjs';

const MARK = { absent: '[ ]', declared: '[~]', verified: '[x]', failing: '[!]', 'n/a': '[-]' };
const PHASE_NAMES = { 0: 'Reconnaissance', 1: 'Legible', 2: 'Senses', 3: 'Intent', 4: 'Continuity', 5: 'Learning' };
const UNWRITTEN_NOTE = {
  skill: ' (the skill drafts this; apply does not write it)',
  human: ' (a human does this; apply does not write it)',
};

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What is left when nothing more can be written: a count of what was found,
 * and "nothing is outstanding" only when nothing is absent, nothing is
 * failing and no question is open. The failing count is named whenever it is
 * not zero, so the line never reads as a clean bill over a failing check.
 * Shared with `apply`, so the two commands cannot word it differently. */
export function stillOpen(checks, questions) {
  const absent = checks.filter(c => c.state === 'absent').length;
  const failing = checks.filter(c => c.state === 'failing').length;
  if (absent === 0 && failing === 0 && questions.length === 0) return 'nothing is outstanding';
  return `${plural(absent, 'check')} still absent, ${failing ? `${failing} failing, ` : ''}${plural(questions.length, 'question')} open`;
}

/** The uv workspace members (detect-stack.mjs, `uvWorkspace`) when the
 * selected profile is a TypeScript one (the mixed shape), else null. */
function mixedUvWorkspace(stack, profileId) {
  const members = stack?.uvWorkspace?.members ?? [];
  return members.length && String(profileId).startsWith('typescript') ? members : null;
}

/** True when the mixed shape leaves a question: the bootstrap install step
 * is derived from one lockfile, and that lockfile is not uv's. */
function uvInstallUnasked(stack) {
  return Boolean(stack?.packageManager) && stack.packageManager !== 'uv';
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
  // A uv workspace beside a TypeScript profile (Vyugate trial): the profile
  // is right about the root manifest and silent about the Python members.
  // Only the install step is asked about: the per-edit sensor falls back to
  // a package.json beside a member's pyproject.toml (lint-touched.mjs), so
  // Python edits in such a workspace are linted with no decision needed.
  const uv = mixedUvWorkspace(stack, profile.id);
  if (uv && uvInstallUnasked(stack)) {
    out.push(`This repository is also a uv workspace with ${uv.length} Python member${uv.length === 1 ? '' : 's'} (${uv.join(', ')}), ` +
      `but its profile is ${profile.id}, from the root package.json, and the bootstrap install step is derived for ${stack.packageManager} only, ` +
      'so uv.lock is not installed by it. Should the bootstrap install the Python members too?');
  }
  // A workspace pattern this tool refused to interpret is reported, not
  // absorbed. `glob.mjs` fails closed on it, compiling it to a source that
  // never matches, and a pattern that silently matches nothing cannot be
  // told from a workspace with no members. The pattern's own text is never
  // echoed: it is repository-controlled and holds a control character by
  // definition, so the index is what is named.
  const rejected = stack.rejectedWorkspacePatterns ?? [];
  if (rejected.length) {
    const s = rejected.length === 1 ? '' : 's';
    const is = rejected.length === 1 ? 'is' : 'are';
    out.push(`${rejected.length} workspace pattern${s} (at index ${rejected.join(', ')} of this repository's own \`workspaces\` list) ${is} not a usable glob — ${rejected.length === 1 ? 'it contains' : 'they contain'} a NUL character, so ${rejected.length === 1 ? 'it was' : 'they were'} refused rather than interpreted, and any package ${rejected.length === 1 ? 'it' : 'they'} would have matched is NOT in this report. The value is not printed here because it is repository-controlled and holds a control character. What should ${rejected.length === 1 ? 'that entry' : 'those entries'} be?`);
  }
  // Asked only while no rules registry exists. Once docs/harness/RULES.md is
  // there, that is where the answer lives — each rule names what holds it —
  // and P3.rules' advice lists the rule-shaped lines still outside it.
  const registryExists = checks.some(c => c.id === 'P3.rules' && c.state !== 'absent');
  if (!registryExists && checks.some(c => c.id === 'P1.instructions' && c.state === 'declared')) {
    out.push('An instruction file already exists. Which of its rules are decisions that cannot be re-derived from source? Those must survive any regeneration — docs/harness/RULES.md (Phase 3) is where each can name what enforces it.');
  }
  // Questions routed by buildGaps from checks that could not decide. These are
  // the `absent` results that may not propose: asking is what they do instead.
  // Checks that are held by one cause ask one question, listed once.
  for (const c of checks) if (c.question && !out.includes(c.question)) out.push(c.question);
  return out;
}

/** The one file `detect` writes — named here so `apply`'s dirty-tree gate
 * can excuse it as the kit's own write (a tracked report, regenerated with a
 * new `generatedAt`, would otherwise refuse the next apply), and so
 * `uninstall` can say it leaves it. */
export const DETECT_REPORT_PATH = 'docs/harness/detect.json';

/** One quiet line for linked worktrees of this repository, shared by
 * detect and apply so the two say it the same way. */
export function worktreeLine(worktrees) {
  const n = worktrees.length;
  return `Linked worktrees of this repository (${n}) — checkouts of the same repository, not scanned: ${worktrees.map(w => w.path).join(', ')}`;
}

export function buildReport({ root, kitVersion, git, stack, harness, exposures, profile, checks, nested = [], worktrees = [] }) {
  return {
    schema: 1,
    kitVersion,
    generatedAt: new Date().toISOString(),
    // The repository's name, never its absolute path: detect.json is
    // committed, and the path carries the machine's user name.
    repo: { name: basename(root), vcs: git.isRepo ? 'git' : null, branch: git.branch ?? null },
    profile: profile.id,
    stack,
    harness,
    exposures,
    checks,
    nested,
    // Linked worktrees of THIS repository (scan.mjs, isOwnWorktree): not
    // scanned, and not a question: they are checkouts of the same repository.
    worktrees,
    couldNotDerive: deriveCouldNotDerive({ stack, checks, nested, profile }),
  };
}

/**
 * The Exposures and "Not examined" sections, as lines, with their trailing
 * blank separator — or `[]` when there is nothing to report.
 *
 * Shared with `apply.mjs`, which performs the same Phase-0 credential
 * sweep: the two print the same bytes for the same exposures because they
 * call this one function.
 *
 * The prominent/collapsed split is the one `P0.security`'s check applies
 * (gap-model.mjs, through detect-exposure.mjs's helpers), so the heading
 * count, the listed findings and that check's evidence cannot disagree
 * about what counts as noise.
 *
 * A file the sweep could not read is on the same list as a credential
 * finding, but it is not a credential, and the Exposures heading's "values
 * are never printed; rotate by hand" is not true of it. It is partitioned
 * out by `partitionProminent`, which `P0.security` reads too, so the two
 * agree about which section a finding belongs in and how many are in each.
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
  if (uv) {
    const s = uv.length === 1 ? '' : 's';
    const see = uvInstallUnasked(report.stack) ? ' — see "Could not derive"' : '';
    lines.push(`mixed stack: also a uv workspace (pyproject.toml [tool.uv.workspace] and uv.lock) with ${uv.length} Python member${s}${see}`);
  }
  lines.push('');

  const phases = [...new Set(report.checks.map(c => c.phase))].sort((a, b) => a - b);
  for (const phase of phases) {
    lines.push(`Phase ${phase} — ${PHASE_NAMES[phase] ?? ''}`.trimEnd());
    for (const c of report.checks.filter(x => x.phase === phase)) {
      lines.push(`  ${MARK[c.state]} ${c.id.padEnd(18)} ${c.state}`);
      for (const e of c.evidence) lines.push(`        ${e}`);
      if (c.proposal) lines.push(`      → ${c.proposal}${UNWRITTEN_NOTE[c.via] ?? ''}`);
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

  const { apply, skill, human } = countProposals(report.checks);
  const n = apply + skill + human;
  lines.push(n === 0
    ? `No proposals — ${stillOpen(report.checks, report.couldNotDerive)}.`
    : `${plural(n, 'proposal')}: ${apply} apply can write, ${skill} for the skill to draft, ${human} for a human. Nothing has been written except docs/harness/detect.json.`);

  // Distinct from proposals, deliberately: a proposal is "this closes the
  // gap", with who closes it (`via`); advice is "you should do this, but
  // kh-harness will not" (e.g. P2.scripts — see gap-model.mjs's own comment
  // on why package.json is never written). Folding these into the `→` proposal lines above would
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
