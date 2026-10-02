// scripts/lib/glob.mjs
//
// One glob-to-regex transformation, shared by every consumer that needs to
// test a glob against a repository's file list. It was originally inline in
// detect-stack.mjs's `membersFor` (workspace-pattern matching); propose.mjs's
// evidence-based protected-path filter needed the same thing, so it lives
// here now rather than as a second, independently-maintained globber.
//
// The order of the four steps below is load-bearing:
//   1. Escape regex metacharacters FIRST, while the pattern is still plain
//      text — a literal `.` in `*.lock` must become `\.` before anything
//      else touches the string.
//   2. Replace `**` with a placeholder BEFORE single `*` is expanded, or
//      `**` is consumed two characters at a time by the single-star rule
//      and loses its "any depth, including zero directories crossed" shape
//      (it would become `[^/]*[^/]*`, which is just `[^/]*` with extra
//      steps — no longer able to cross a `/`).
//   3. Expand the remaining single `*` to `[^/]*` (any run of
//      non-separator characters).
//   4. Replace the placeholder with `.*` (any run of characters, including
//      separators) — now that no real `*` is left to confuse it with.
// Reordering any of these silently breaks single- or double-star patterns.
//
/**
 * EVERY character this module uses as an internal sentinel, in one list,
 * from which both the transformation and the refusal are derived. Adding a
 * sentinel here automatically extends `isRejectableGlob`; introducing one
 * anywhere else is the mistake this list exists to make impossible.
 *
 * Coordinator ruling (post-review, concern 1, round 2): the refusal used to
 * be tied to `PLACEHOLDER` by a COMMENT — "if you change this, remember to
 * change that". A comment telling the next person to remember something is
 * a coupling that fails silently the first time someone is in a hurry, and
 * this plan has already ruled three times that the SHAPE gets removed
 * rather than the hazard documented. So: one list, one derivation, and a
 * property test (glob.test.mjs's INVARIANT) that fails if a sentinel is
 * ever introduced without being added here.
 *
 * Each entry must be written as an ESCAPE SEQUENCE ('\u0000'), never as the
 * literal byte: a real 0x00 makes git treat the whole file as binary, which
 * breaks `git diff`/`git grep`/3-way merge on it. That defect has shipped
 * twice in this project (detect-stack.mjs pre-extraction, then glob.mjs
 * itself) and was caught twice more by the guard below while this module
 * was being fixed.
 *
 * Why a sentinel needs a refusal at all: step 4 above replaces EVERY
 * occurrence of the placeholder, not only the ones step 2 put there, so a
 * pattern that ALREADY contains one has it turned into `.*`. Measured, with
 * the NUL built at runtime so this file stays text:
 * `globToRegExpSource('a' + String.fromCharCode(0) + 'b')` was `"a.*b"` —
 * repository-controlled data (a `package.json` `workspaces` entry, via
 * JSON's own escape) producing a glob that matches everything.
 */
export const RESERVED_SENTINELS = Object.freeze(['\u0000']);

const [PLACEHOLDER] = RESERVED_SENTINELS;

/**
 * A regex source that can never match anything, not even the empty string.
 * `(?!)` is a negative lookahead for the empty pattern, which always
 * succeeds, so the lookahead always fails.
 */
const NEVER_MATCHES = '(?!)';

const ESCAPE_RE = /[.+?^${}()|[\]\\]/g;

/**
 * True for a pattern this module REFUSES to transform: a non-string, or a
 * string containing any `RESERVED_SENTINELS` entry.
 *
 * DERIVED from that list, never a hand-maintained copy of it — see the
 * list's own comment for why a comment was not enough. A sentinel added
 * there is refused here with no further edit.
 *
 * It is reachable from REPOSITORY DATA, which is what makes it a defect
 * rather than a curiosity: workspace patterns come from a `package.json`'s
 * own `workspaces` array (detect-stack.mjs's `membersFor`), and JSON permits
 * the escape `\u0000`, which parses to a real NUL. A hostile or merely broken
 * manifest could therefore supply one pattern that matches EVERY
 * `package.json` in the tree, and every one of them would be detected as a
 * workspace member — repository-controlled data producing a glob that
 * matches everything.
 *
 * The fix is AT THE BOUNDARY, not in the machinery. Changing `PLACEHOLDER`,
 * or re-ordering the four steps to dodge the collision, would be adjusting
 * the transformation to tolerate bad input — and that order is load-bearing
 * for every legitimate pattern (69 tests depend on it indirectly). A NUL is
 * not a legitimate character in any path a glob could usefully match, so a
 * glob containing one is not a glob: it is refused before transformation,
 * and the refusal is reported rather than silently absorbed.
 *
 * Deliberately narrow — a NUL and nothing else, because the placeholder
 * collision is the only reason this exists. It is not a general "sanitize
 * the glob" step; widening it would start rejecting patterns that work.
 */
export function isRejectableGlob(pattern) {
  if (typeof pattern !== 'string') return true;
  return RESERVED_SENTINELS.some(sentinel => pattern.includes(sentinel));
}

/**
 * The regex SOURCE for `pattern`, unanchored. Callers add their own `^...$`
 * (and any suffix — see detect-stack.mjs's `membersFor`, which appends
 * `/package\.json$` rather than anchoring directly after this).
 *
 * A refused pattern yields `NEVER_MATCHES`, so a caller that does not check
 * gets the SAFE answer (nothing matches) rather than the dangerous one
 * (everything matches). A caller that can disclose the refusal should ask
 * `isRejectableGlob` first and say so — see `membersFor`.
 */
export function globToRegExpSource(pattern) {
  if (isRejectableGlob(pattern)) return NEVER_MATCHES;
  return pattern
    .replace(ESCAPE_RE, '\\$&')
    .replace(/\*\*/g, PLACEHOLDER)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(PLACEHOLDER, 'g'), '.*');
}

/** `pattern` compiled to a RegExp that matches a full relative path. */
export function globToRegExp(pattern) {
  return new RegExp('^' + globToRegExpSource(pattern) + '$');
}

