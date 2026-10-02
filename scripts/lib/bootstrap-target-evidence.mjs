// scripts/lib/bootstrap-target-evidence.mjs
//
// Shared by gap-model.mjs's P1.bootstrap CHECK for its Makefile/justfile
// branch. Task 8b (coordinator ruling): the mere EXISTENCE of a Makefile or
// justfile was being credited as "a bootstrap mechanism exists", even when
// the file's only targets had nothing to do with installing dependencies —
// confirmed live: a Makefile containing only a `build:` target reported
// `declared` with evidence `["Makefile"]`. A repository with a build-only
// Makefile was told bootstrap was handled.
//
// Parsing or running the file to learn what a target DOES would be a guess
// this project does not make (the same doctrine gap-model.mjs's own
// P2.scripts comment states for advice: a command this tool cannot verify
// is never invented). But reading a TARGET NAME off a line is evidence,
// exactly the same kind of fact a lockfile's presence or a declared script
// NAME already is elsewhere in this codebase — never a body, never an
// inference about behaviour.
//
// `setup`, `bootstrap`, `init` and `install` are the well-known convention
// names for "take a clean checkout to a working state" across Makefiles and
// justfiles alike; this looks for exactly those four, in that order, and no
// others — widening the list would be the same shape of guess this module
// exists to avoid.
import { readIfPresent } from './scan.mjs';

const SETUP_TARGET_NAMES = ['setup', 'bootstrap', 'init', 'install'];

/** Makefile/justfile comments both start with `#` and run to end of line.
 * Stripped before matching so a name mentioned only in a comment (or in a
 * trailing comment after a real, unrelated line) is never credited. */
/**
 * True if `line` declares a Makefile RULE for `name` — `name:` or the
 * double-colon form `name::`, at the start of the line (target lines are
 * never indented; a recipe's own command lines are, conventionally with a
 * tab, but this does not need to rely on that — a target name can only
 * ever be followed by `:` here, never by `=`).
 *
 * No separate comment-stripping step: every pattern here is anchored at
 * the start of the line (`^\s*name`), so a whole-line comment (`# ...`)
 * can never match it — the line does not start with `name` — and a
 * TRAILING comment sits after the point the regex already stopped caring
 * about (it is not anchored at the end). An earlier version stripped `#…`
 * before matching; a mutation replacing that step with a no-op left every
 * test in this module still passing, proving the anchor alone already
 * carries the "ignore comments" guarantee. Removed, rather than kept as
 * inert insurance — this project does not keep code a mutation cannot
 * detect (see the project's own retrospective on this exact shape).
 *
 * The `(?!=)` guard is load-bearing: `setup := value` and `setup = value`
 * are Makefile VARIABLE assignments, not a `setup` target, and both put an
 * `=` immediately after the point this regex's own `:` would need to
 * match (immediately for `=`, or after the `:` for `:=`). Without the
 * guard, a variable that merely happens to share one of these four names
 * would be mistaken for a real bootstrap target.
 */
function makeTargetLine(name, line) {
  return new RegExp(`^\\s*${name}\\s*::?(?!=)`).test(line);
}

/**
 * True if `line` declares a just RECIPE for `name` — `name:`, or
 * `name param1 param2:` (just recipes may take bare parameters between the
 * name and the colon). Deliberately does not attempt a parameter's own
 * DEFAULT value (`param='default'`): a default can itself contain `:` or
 * `=` inside quotes, and distinguishing that from the recipe's own
 * terminating colon without a real parser is exactly the kind of guess
 * this module exists to avoid — a recipe with a defaulted parameter is
 * read as "not found" here, the safe direction (never a false `declared`),
 * not a false `absent` either way: it only means this one recipe-naming
 * form is not recognised, not that a real one is misread as satisfied.
 * The same `(?!=)` guard excludes just's own `name := value` variable
 * assignment form. No comment-stripping, for the same reason as
 * `makeTargetLine` above: the start-of-line anchor already makes it moot.
 */
function justRecipeLine(name, line) {
  return new RegExp(`^\\s*${name}(?:\\s+[A-Za-z_][\\w-]*)*\\s*:(?!=)`).test(line);
}

/**
 * Looks for a setup-shaped target/recipe in a Makefile or justfile.
 *
 * Never throws, and never reports `found: true` from a bad read. Two
 * different mechanisms get that result, and the distinction matters because
 * only one of them is this function's own guard:
 *
 *   - `readIfPresent` returns `null` — and it does that for exactly two
 *     inputs: a MISSING file, and a path that is actually a DIRECTORY
 *     (`readFileSync` throws `EISDIR`). The `content == null` exit below is
 *     what handles those, the same discipline bootstrap-install.mjs's
 *     `yarnFrozenCommand` uses for a yarn.lock it cannot read: fall through
 *     to the honest "not found" answer, never guess, never throw.
 *   - everything else falls through because the BYTES match no target name.
 *     An empty file returns `''`, not `null`; a binary file returns
 *     mojibake, not `null`. Both end at `{ found: false }`, but by the
 *     regexes below, not by the guard.
 *
 * Whole-branch review, F14: this comment used to claim `readIfPresent`
 * "already treats every one of those as nothing to read", listing an empty
 * file and a binary file among them. It does not — it is four lines, with no
 * binary detection and no empty-file handling:
 *
 *     export function readIfPresent(root, rel) {
 *       const p = join(root, rel);
 *       if (!existsSync(p)) return null;
 *       try { return readFileSync(p, 'utf8'); } catch { return null; }
 *     }
 *
 * The RESULT was right, so this was a wrong explanation rather than a wrong
 * answer — but it is exactly the kind of comment the next person to change
 * `readIfPresent` would have trusted, and the two tests named after the
 * claim ("an empty Makefile is not found", "a binary Makefile is not found")
 * passed for the other reason entirely. Measured: neutering the
 * `content == null` guard is killed by the MISSING and DIRECTORY tests, and
 * those two did not fire. They are renamed after what they actually pin.
 *
 * `kind` is `'make'` or `'just'` — the two grammars differ only in whether
 * parameters may sit between the name and the colon.
 */
export function setupTargetEvidence(root, relPath, kind) {
  const content = readIfPresent(root, relPath);
  if (content == null) return { found: false, target: null };
  const lineMatches = kind === 'just' ? justRecipeLine : makeTargetLine;
  const lines = content.split(/\r?\n/);
  for (const name of SETUP_TARGET_NAMES) {
    if (lines.some(line => lineMatches(name, line))) return { found: true, target: name };
  }
  return { found: false, target: null };
}

export { SETUP_TARGET_NAMES };
