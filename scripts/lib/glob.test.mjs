import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
