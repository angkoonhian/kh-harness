import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globToRegExp, globToRegExpSource, isRejectableGlob, RESERVED_SENTINELS } from './glob.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// `-z`, for the same reason scan.mjs's `gitPaths` uses it (whole-branch
// review, F1): without it git C-quotes any non-ASCII path name, `readFileSync`
// on that literal throws, and the `catch { return false }` in the filter below
// turns the throw into "not an offender" — so the one guard that exists to
// stop a NUL byte reaching a tracked source file would silently stop checking
// the moment a source file got an accented name. This is a test, not
// production code, and it is listed here deliberately: it answers the same
// question `gitPaths` answers, so it gets the same answer.
function gitTrackedFiles(prefix) {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', prefix], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * This exact defect has shipped twice in this project: a literal NUL byte
 * typed into source in place of the backslash-u-0000 ESCAPE SEQUENCE —
 * first in detect-stack.mjs (Plan 1), then again here in glob.mjs when
 * that constant was extracted into its own module. A raw NUL is invisible
 * to the author: the string behaves identically at runtime (JS strings
 * may contain NUL freely), so nothing in the test suite catches it. What
 * breaks is everything OTHER than running the code — git's binary-
 * detection heuristic treats the file as binary the moment it sees one,
 * so `git diff` prints "Binary files differ" instead of the change,
 * `git grep` silently skips it, and a textual 3-way merge becomes
 * impossible. The second time this shipped, it made the task's only new
 * file unreadable in the code review diff — a real cost, not a
 * hypothetical one.
 *
 * Twice is a pattern: this closes the CLASS (every tracked source file
 * under scripts/ and assets/), not just the one instance in glob.mjs.
 */
test('no tracked file under scripts/ or assets/ contains a raw NUL byte', () => {
  const files = [...gitTrackedFiles('scripts'), ...gitTrackedFiles('assets')];
  // A guard that finds nothing to check is indistinguishable from a guard
  // that is silently never run — pin that the scan itself is live.
  assert.ok(files.length > 10, 'expected many tracked files under scripts/ and assets/ to check — the scan itself may be broken');

  const offenders = files.filter(relPath => {
    let bytes;
    try {
      bytes = readFileSync(join(ROOT, relPath));
    } catch {
      return false; // listed by git but not present on disk — not this guard's concern
    }
    return bytes.includes(0);
  });

  assert.deepEqual(
    offenders,
    [],
    'a tracked file holds a literal NUL byte — git will treat it as binary, hiding it from diff/grep/merge; ' +
    'use the backslash-u-0000 escape sequence in source instead of typing the raw byte',
  );
});

// --- Whole-branch review, F15 ---------------------------------------------
//
// This file was 60 lines and contained exactly one test — the NUL-byte guard
// above, which is a valuable repository-wide check and is not a test of
// `glob.mjs` at all. The review measured the coverage before filing it as a
// hole, and the measurement says it is not one: reordering the four steps
// breaks 69 tests, indirectly, through every end-to-end fixture whose
// repository has a lockfile and therefore exercises `**/*-lock.json` against
// a real file list.
//
// So this is about legibility, not coverage, and it is worth closing anyway:
// a file named `glob.test.mjs` with no test of `glob.mjs` tells the next
// reader this module is covered where it is not, and that the coverage it
// does have lives somewhere they will not think to look. It also pins the
// one thing the indirect tests do not — the documented asymmetry that
// `**/dist/**` deliberately does NOT match a root-level `dist/a.js`, which
// three separate profile comments depend on being true.

test('globToRegExp: a literal dot is a literal dot, not "any character"', () => {
  // Step 1 of the four: escape regex metacharacters FIRST, while the
  // pattern is still plain text.
  assert.equal(globToRegExp('*.lock').test('yarn.lock'), true);
  assert.equal(globToRegExp('*.lock').test('yarnXlock'), false, 'the `.` must have been escaped');
  assert.equal(globToRegExp('a+b.txt').test('a+b.txt'), true, '`+` is a metacharacter too');
  assert.equal(globToRegExp('a+b.txt').test('aab.txt'), false);
});

test('globToRegExp: a single * does not cross a path separator', () => {
  // Step 3: a lone `*` expands to `[^/]*`.
  assert.equal(globToRegExp('src/*.ts').test('src/index.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/deep/index.ts'), false);
  assert.equal(globToRegExp('*-lock.json').test('package-lock.json'), true);
  assert.equal(globToRegExp('*-lock.json').test('a/package-lock.json'), false);
});

test('globToRegExp: ** crosses separators, and crossing ZERO of them still matches', () => {
  // Step 2 is what makes this work: `**` is parked on a placeholder BEFORE
  // the single-star rule can eat it two characters at a time. If the order
  // were reversed, `**` would become `[^/]*[^/]*` — unable to cross a `/`
  // at all — and every assertion below would fail.
  assert.equal(globToRegExp('**/*-lock.json').test('a/b/package-lock.json'), true);
  assert.equal(globToRegExp('**/*-lock.json').test('a/package-lock.json'), true);
  assert.equal(globToRegExp('prisma/migrations/**').test('prisma/migrations/0001_init/migration.sql'), true);
  assert.equal(globToRegExp('packages/**/*').test('packages/api/src/index.ts'), true);
});

test('globToRegExp: THE DOCUMENTED ASYMMETRY — `**/dist/**` does not match a root-level dist/a.js', () => {
  // `**/dist/**` becomes `.*/dist/.*`, which REQUIRES a separator before
  // `dist` — so a root-level `dist/` is deliberately not matched by this
  // pattern, and a profile that wants it must say `dist/**` as well. Three
  // separate profile comments depend on this being true, and no indirect
  // test pins it.
  const nested = globToRegExp('**/dist/**');
  assert.equal(nested.test('packages/api/dist/a.js'), true);
  assert.equal(nested.test('dist/a.js'), false, 'the leading `**/` requires at least one separator');
  assert.equal(globToRegExp('dist/**').test('dist/a.js'), true, 'the root-level form is the one that matches it');
});

test('globToRegExp: the match is anchored — a glob never matches a substring of a path', () => {
  assert.equal(globToRegExp('*.lock').test('yarn.lock.bak'), false);
  assert.equal(globToRegExp('src/*.ts').test('vendor/src/a.ts'), false);
  assert.equal(globToRegExpSource('*.lock'), '[^/]*\\.lock', 'the SOURCE is deliberately unanchored; callers anchor');
});

// --- Coordinator ruling (post-review, concern 1): a glob is REFUSED at the
// --- boundary, not tolerated by the machinery -----------------------------
//
// `PLACEHOLDER` is a NUL and step 4 replaces EVERY occurrence of it, so a
// pattern that already contains one had that NUL turned into `.*`. Measured
// before the fix: `globToRegExpSource('a' + NUL + 'b')` was `"a.*b"` — a
// glob that matches everything, derived from repository-controlled data
// (a `package.json` `workspaces` entry, via JSON's own `\u0000` escape).
//
// The NUL is built with `String.fromCharCode(0)` in every test below, never
// typed: a literal 0x00 in this file would make git treat it as binary,
// which is precisely what the guard at the top of this file exists to catch
// — and it caught exactly that mistake once while this test was being
// written.
const NUL = String.fromCharCode(0);

test('CONCERN 1: a glob that is nothing but a NUL matches nothing — it used to match everything', () => {
  assert.equal(isRejectableGlob(NUL), true);
  assert.equal(globToRegExpSource(NUL), '(?!)', 'a refused pattern compiles to a never-matching source');
  const re = globToRegExp(NUL);
  for (const candidate of ['', 'a', 'packages/api/package.json', 'src/index.ts', NUL]) {
    assert.equal(re.test(candidate), false, `must match nothing, matched ${JSON.stringify(candidate)}`);
  }
});

test('CONCERN 1: a NUL embedded MID-GLOB is refused too, not just a bare one', () => {
  const pattern = 'packages/' + NUL + '/src';
  assert.equal(isRejectableGlob(pattern), true);
  const re = globToRegExp(pattern);
  // Before the fix this was `packages/.*/src`, which is a perfectly usable
  // glob the repository never asked for.
  assert.equal(re.test('packages/api/src'), false);
  assert.equal(re.test('packages/anything/at/all/src'), false);
});

test('CONCERN 1: the refusal is the ONLY thing that changed — every legitimate pattern is untouched', () => {
  // The transformation itself is not adjusted, so the four ordered steps and
  // the 69 tests that depend on them indirectly are unaffected.
  for (const [pattern, hit] of [
    ['packages/*', 'packages/api'],
    ['**/*-lock.json', 'a/b/package-lock.json'],
    ['prisma/migrations/**', 'prisma/migrations/0001/x.sql'],
    ['*.lock', 'yarn.lock'],
  ]) {
    assert.equal(isRejectableGlob(pattern), false, `${pattern} must not be refused`);
    assert.equal(globToRegExp(pattern).test(hit), true, `${pattern} must still match ${hit}`);
  }
});

test('CONCERN 1: a non-string pattern is refused rather than throwing', () => {
  for (const bad of [undefined, null, 42, {}, ['packages/*']]) {
    assert.equal(isRejectableGlob(bad), true);
    assert.doesNotThrow(() => globToRegExpSource(bad));
    assert.equal(globToRegExpSource(bad), '(?!)');
  }
});

// --- Coordinator ruling (post-review, concern 1, round 2): the refusal is
// --- DERIVED from the sentinel list, and a new sentinel cannot be forgotten
//
// The refusal used to be tied to `PLACEHOLDER` by a comment. Both tests
// below exist because a comment is not a coupling:
//
//   - the first ITERATES `RESERVED_SENTINELS`, so adding an entry is covered
//     with no test edit at all;
//   - the second is the one that catches the mistake the first cannot — a
//     sentinel introduced in the transformation WITHOUT being added to the
//     list. It does not read the list; it tests the transformation itself
//     against the property that makes a sentinel dangerous.

test('CONCERN 1: every RESERVED_SENTINELS entry is refused — iterated, so a new one needs no test edit', () => {
  assert.ok(RESERVED_SENTINELS.length > 0, "fixture sanity: the list must not be empty");
  for (const sentinel of RESERVED_SENTINELS) {
    const where = { bare: sentinel, leading: sentinel + "packages/*", mid: "packages/" + sentinel + "/src", trailing: "packages/*" + sentinel };
    for (const [position, pattern] of Object.entries(where)) {
      assert.equal(isRejectableGlob(pattern), true, `sentinel ${JSON.stringify(sentinel)} must be refused ${position}`);
      assert.equal(globToRegExpSource(pattern), '(?!)', `and must compile to a never-matching source ${position}`);
      const re = globToRegExp(pattern);
      for (const candidate of ['', 'packages/api', 'packages/api/src', 'anything/at/all']) {
        assert.equal(re.test(candidate), false, `must match nothing, matched ${JSON.stringify(candidate)}`);
      }
    }
  }
});

test('CONCERN 1 INVARIANT: no single character may expand to a wildcard unless it is `*` — a sentinel added without a refusal fails HERE', () => {
  // What makes a sentinel dangerous is precisely this: the transformation
  // turns that one character into something that matches text it is not.
  // So the property to pin is not "the list is complete" (unknowable from
  // the list) but "no character behaves like a wildcard". A new sentinel
  // introduced in the four steps without being added to RESERVED_SENTINELS
  // breaks this, whatever character it is, with nobody extending this test.
  //
  // The scan covers every C0 control character and DEL — the only plausible
  // sentinel choices, since a sentinel must be a character a real glob
  // cannot contain — plus a few printable characters as a control group.
  const suspects = [];
  for (let code = 0; code <= 0x1f; code++) suspects.push(String.fromCharCode(code));
  suspects.push(String.fromCharCode(0x7f));
  suspects.push(...['a', '-', '_', '.', '/', '{', '}', '[', ']', '(', ')', '+', '?', '^', '$', '|', String.fromCharCode(92)]);

  for (const ch of suspects) {
    const pattern = "a" + ch + "b";
    if (isRejectableGlob(pattern)) continue; // refused: safe by construction
    const re = globToRegExp(pattern);
    // Not refused, so it must behave as a LITERAL: it matches itself and
    // nothing a wildcard would also have matched.
    assert.equal(re.test(pattern), true,
      `${JSON.stringify(ch)} is neither refused nor literal — it does not even match itself`);
    for (const wildcardish of ['aXb', 'aXXXXb', 'ab', 'a/b', 'aXX/XXb']) {
      if (wildcardish === pattern) continue;
      assert.equal(re.test(wildcardish), false,
        `${JSON.stringify(ch)} expands to a WILDCARD but is not in RESERVED_SENTINELS — it matched ${JSON.stringify(wildcardish)}. ` +
        "If you introduced a new internal sentinel, add it to RESERVED_SENTINELS in glob.mjs: the refusal is derived from that list, " +
        "so a sentinel that is not in it silently turns repository-controlled data into a glob that matches everything.");
    }
  }
});
