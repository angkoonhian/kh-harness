import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globToRegExp, globToRegExpSource } from './glob.mjs';

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
