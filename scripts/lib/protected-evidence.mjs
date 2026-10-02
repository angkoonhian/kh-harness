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
 * Coordinator correction: `requirements*.txt` (python.mjs's own
 * `protectedGlobs()` entry) used to survive on presence alone, the same as
 * a real lockfile. It is not one. `requirements.txt` is normally a
 * HAND-EDITED manifest — Python's analogue of `package.json`, which this
 * project deliberately does not protect (a deny rule there blocks "add
 * this dependency", a legitimate and frequent action — exactly the false
 * friction that gets a harness uninstalled, and worse than no rule because
 * it arrives looking authoritative).
 *
 * But under pip-tools, `requirements*.txt` IS compiled output, generated
 * FROM a `requirements*.in` source — and protecting it there is correct,
 * because a hand edit to the compiled file is silently lost on the next
 * `pip-compile`. The presence of any `requirements*.in` file is exactly
 * the kind of real, already-in-hand evidence this module otherwise
 * requires for every other candidate, so `requirements*.txt` is gated on
 * it rather than matched unconditionally.
 *
 * This is a GLOB-level gate, not a per-file one: it asks "does ANY
 * requirements*.in exist anywhere in the repository", never "does THIS
 * specific *.txt have its own *.in" — so a `requirements.in` that backs
 * `requirements.txt` also protects a sibling `requirements-dev.txt` with
 * no `requirements-dev.in` of its own, which may genuinely be
 * hand-edited. That is the same granularity every other candidate in this
 * module already has (`migrations/**` protects the whole directory, not
 * file-by-file) — a known, visible trade-off, not an oversight; see
 * propose.test.mjs's own pinning test for the exact shape.
 */
const CONDITIONAL_CANDIDATES = {
  'requirements*.txt': files => hasEvidence('requirements*.in', files),
};

/**
 * Intersects `profile.protectedGlobs()` (the universal-per-stack candidates:
 * lockfiles, build output) with `PROTECTED_PATH_CANDIDATES` (the ORM/
 * framework conventions above), and returns only the RAW globs with
 * evidence in `files` — the complete answer to "is there anything in this
 * repository worth protecting", consulted by both the check (to decide
 * `n/a` vs `absent`) and the generator (to build the actual deny rules). A
 * candidate listed in `CONDITIONAL_CANDIDATES` must additionally pass its
 * own extra gate, on top of (not instead of) the ordinary evidence check.
 */
export function protectedPathCandidates({ stack, files }) {
  const profile = selectProfile(stack);
  const candidates = [...profile.protectedGlobs(), ...PROTECTED_PATH_CANDIDATES];
  const seen = new Set();
  const surviving = [];
  for (const glob of candidates) {
    if (seen.has(glob)) continue;
    seen.add(glob);
    if (!hasEvidence(glob, files)) continue;
    const extraGate = CONDITIONAL_CANDIDATES[glob];
    if (extraGate && !extraGate(files)) continue;
    surviving.push(glob);
  }
  return surviving;
}
