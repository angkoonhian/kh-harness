// scripts/lib/protected-evidence.mjs
//
// Shared by gap-model.mjs's P2.protected CHECK and propose.mjs's
// protected-path GENERATOR (protectedPathProposal) — same pattern as
// sensor-evidence.mjs/stopgate-evidence.mjs, and the one Task 5 established
// for P1.bootstrap. The check used to decide `absent` + a proposal purely
// from `harness.claudeDir.denyRules > 0`, never consulting `files` at
// all — while the generator (correctly) refuses to propose anything unless
// real protected-path evidence exists in the repository (a lockfile,
// tracked build output, migrations, generated files). A repository with
// none of that was told a deny-rule proposal was available; `apply`
// silently wrote nothing.
//
// Moved here verbatim from propose.mjs — see git history for the
// evidence-filter rationale predating this split.
import { selectProfile } from './profiles/index.mjs';
import { globToRegExp } from './glob.mjs';

/**
 * Evidence-based protected-path candidates for conventions that are NOT
 * universal to a language — migrations are an ORM/framework convention
 * (Prisma, Drizzle, Django, Alembic, ...), not a fact about every project
 * written in a given language. Plan 1 hardcoded `**\/migrations/**` into the
 * stack profiles and the review struck it for exactly that reason: a profile
 * asserting this is an opinion about layout it has no basis for (see
 * docs/plan-1-execution-log.md).
 *
 * Listing the known conventions HERE, instead, is not an opinion, because
 * every candidate below is filtered against the repository's actual file
 * list in `protectedPathCandidates` — a candidate that matches nothing is
 * simply never proposed. Applied uniformly (not split per detected stack):
 * uniformity is safe precisely because the existence filter prunes whatever
 * is absent, and it avoids maintaining a second set of per-language guesses.
 *
 * Root-anchored and `**\/`-anchored forms are both listed deliberately, for
 * the same reason as typescript.mjs's dist/build globs (see its comment):
 * this is about OUR OWN matcher (glob.mjs's `globToRegExp`), not Claude
 * Code's. `globToRegExp` compiles `**` to `.*` with a required literal `/`
 * before the final segment, so `hasEvidence('**\/migrations/**', [...])` is
 * false for a root-level `migrations/` and the rule is never PROPOSED at
 * all — even though Claude Code's own `Edit(...)` matcher is wider (per its
 * docs, `**\/` also matches zero directory segments) and would have
 * honoured `Edit(**\/migrations/**)` against a root-level path just fine
 * once proposed. The duplication exists to satisfy OUR evidence filter, not
 * Claude Code's matcher.
 *
 * As with every candidate here, a rule is only ever PROPOSED when the path
 * is visible to `listFiles` (scan.mjs) — tracked by git, or not excluded on
 * the dependency-free fallback walk. Migration directories are typically
 * committed, so this rarely bites the way it does for build output (see
 * typescript.mjs/python.mjs), but the mechanism is the same: no evidence,
 * no proposal, by design.
 */
const PROTECTED_PATH_CANDIDATES = [
  'prisma/migrations/**',
  'src/migrations/**',
  'migrations/**',
  '**/migrations/**',
  'drizzle/**',
  'alembic/versions/**',
  // Root-anchored AND **-anchored, deliberately — same reason as this
  // file's migrations comment above and typescript.mjs's dist/build
  // comment: it is OUR `globToRegExp` that requires the literal `/`, not
  // Claude Code's matcher. `hasEvidence('**/__generated__/**', [...])` is
  // false for a root-level `__generated__/`, and likewise for
  // `**/*.generated.*` against a root-level `foo.generated.ts` (both
  // verified) — so without the root-anchored form, our evidence filter
  // never proposes a rule for either, regardless of what Claude Code
  // itself would have matched. Do not collapse this back to one form.
  '__generated__/**',
  '**/__generated__/**',
  '*.generated.*',
  '**/*.generated.*',
];

/** True if `glob` matches at least one path in `files`. */
function hasEvidence(glob, files) {
  const re = globToRegExp(glob);
  return files.some(f => re.test(f));
}

/**
 * A path whose basename is pip's requirements*.txt convention
 * (`requirements.txt`, `requirements-dev.txt`, any directory) OR that
 * sits inside a directory literally named `requirements/`
 * (`requirements/base.txt`) — pip-tools' other common layout. Matching on
 * PATH SHAPE, not on a stack-profile check, because the file-naming
 * convention is the evidence; a repository that happens to have one of
 * these without being detected as "python" is not a reason to skip the
 * pairing rule below.
 */
const REQUIREMENTS_TXT_RE = /(^|\/)requirements[^/]*\.txt$|(^|\/)requirements\/[^/]*\.txt$/;

/**
 * Coordinator correction, round 2: `requirements*.txt` used to survive as
 * a single GLOB, gated on whether ANY `requirements*.in` existed anywhere
 * in the repository. That reintroduced the original defect on a narrower
 * path: a `requirements.in` that backs `requirements.txt` also protected
 * a sibling `requirements-dev.txt` with no `requirements-dev.in` of its
 * own — a hand-edited file swept in by an unrelated pair, the exact false
 * friction this whole fix exists to remove.
 *
 * The rule is now PER FILE. `requirements.txt` is normally a HAND-EDITED
 * manifest — Python's analogue of `package.json`, which this project
 * deliberately does not protect (a deny rule there blocks "add this
 * dependency", a legitimate and frequent action — the false friction that
 * gets a harness uninstalled, worse than no rule because it arrives
 * looking authoritative). Under pip-tools it IS compiled output, but only
 * for the specific `requirements*.txt` whose OWN sibling `requirements*.in`
 * (same directory, same basename, extension swapped) exists — a hand edit
 * to that one file is silently lost on the next `pip-compile`. Implemented
 * as a general rule (swap the extension, test for existence), not a
 * special case for `-dev`, so a `requirements/base.in` +
 * `requirements/base.txt` directory layout is covered without further
 * thought, and a newly added hand-edited `requirements-*.txt` later does
 * not silently inherit protection from an unrelated pair.
 *
 * Returns LITERAL filenames, never a glob — unlike every other candidate
 * in this module, each result here was already matched against a
 * specific file, so re-widening it into a wildcard would throw that
 * precision away. A literal entry also means the deny list in the user's
 * `settings.json` names exactly the generated files: a reader can verify
 * each entry against the repository directly, and it cannot silently
 * widen to cover a file that did not exist when it was written.
 */
function pairedRequirementsFiles(files) {
  const survivors = [];
  for (const f of files) {
    if (!REQUIREMENTS_TXT_RE.test(f)) continue;
    const sibling = f.slice(0, -'.txt'.length) + '.in';
    if (files.includes(sibling)) survivors.push(f);
  }
  return survivors;
}

/**
 * Intersects `profile.protectedGlobs()` (the universal-per-stack candidates:
 * lockfiles, build output) with `PROTECTED_PATH_CANDIDATES` (the ORM/
 * framework conventions above), keeps only the globs with evidence in
 * `files`, and appends any `requirements*.txt` files that pair with their
 * own `requirements*.in` sibling (see `pairedRequirementsFiles`, above) —
 * the complete answer to "is there anything in this repository worth
 * protecting", consulted by both the check (to decide `n/a` vs `absent`)
 * and the generator (to build the actual deny rules).
 */
export function protectedPathCandidates({ stack, files }) {
  const profile = selectProfile(stack);
  const candidates = [...profile.protectedGlobs(), ...PROTECTED_PATH_CANDIDATES];
  const seen = new Set();
  const surviving = [];
  for (const glob of candidates) {
    if (seen.has(glob)) continue;
    seen.add(glob);
    if (hasEvidence(glob, files)) surviving.push(glob);
  }
  surviving.push(...pairedRequirementsFiles(files));
  return surviving;
}
