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
// PLACEHOLDER must be the ESCAPE SEQUENCE '\u0000', never a literal NUL
// byte typed into this file: a real 0x00 makes git's binary-detection heuristic
// treat the whole file as binary, which breaks `git diff`/`git grep`/3-way
// merge on it (this exact defect shipped once before, in detect-stack.mjs,
// pre-extraction — see scripts/lib/glob.test.mjs's binary-file guard).
const PLACEHOLDER = '\u0000';

/**
 * A regex source that can never match anything, not even the empty string.
 * `(?!)` is a negative lookahead for the empty pattern, which always
 * succeeds, so the lookahead always fails.
 */
const NEVER_MATCHES = '(?!)';

const ESCAPE_RE = /[.+?^${}()|[\]\\]/g;

/**
 * True for a pattern this module REFUSES to transform.
 *
 * `PLACEHOLDER` is a NUL, and step 4 above replaces EVERY occurrence of it,
 * not only the ones step 2 put there — so a pattern that already contains a
 * literal NUL has that NUL turned into `.*`. Measured, with the NUL built at
 * runtime so this file stays text:
 * `globToRegExpSource('a' + String.fromCharCode(0) + 'b')` was `"a.*b"`.
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
  return typeof pattern !== 'string' || pattern.includes(PLACEHOLDER);
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

