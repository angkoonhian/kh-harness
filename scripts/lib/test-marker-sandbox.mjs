// scripts/lib/test-marker-sandbox.mjs
//
// NOT A TEST, and not production code: a shared setup/teardown for every test
// file that causes a session marker to be written. Named `test-*` rather than
// `*.test.mjs` deliberately, so `npm test`'s own glob
// (`scripts/lib/**/*.test.mjs`) does not pick it up as a suite.
//
// WHY THIS EXISTS. `markerDir()` is one fixed directory per OS user —
// `<tmpdir>/kh-harness-stop-<userTag>` — shared by every run of every test.
// Markers are keyed by `(rootTag, namespace, sessionId)`, so a `mkdtemp`
// fixture gets ISOLATION by accident of its random path, but nothing isolates
// the DIRECTORY, and nothing ever removes what a run leaves there. Measured on
// this machine before this module existed:
//
//     <tmpdir>/kh-harness-stop-28d5673005cc744e: 8983 files
//
// Eight thousand nine hundred and eighty-three entries in one NTFS directory,
// in a suite where several tests deliberately set sub-second bounds through
// `HK_LINT_TIMEOUT_MS`/`HK_VERIFY_TIMEOUT_MS`/`HK_STDIN_TIMEOUT_MS`. That is a
// credible mechanism for a rare, unattributable test failure — and a test
// suite that leaves durable state outside its own fixtures has no business
// being surprised by one. The suite already owns the processes it spawns;
// markers are the same kind of state and are owned the same way now.
//
// `HK_MARKER_DIR` (see `markerDir`'s own comment) is the production override
// this uses. Set in the test PROCESS, so it reaches every spawned hook for
// free: both hook test helpers spawn with `{ ...process.env, ... }`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

/**
 * Points `HK_MARKER_DIR` at a fresh per-run directory and registers the
 * teardown that removes it. Call once, at the top of a test file, before any
 * test body runs.
 *
 * `after()` runs on pass, on fail AND on throw, which is the point: a
 * teardown that only runs when the suite is green leaves exactly the litter
 * this exists to prevent, on exactly the runs where someone is debugging.
 * `rmSync` is `force: true` so a teardown can never itself become the
 * failure, and the path is reported if it cannot be removed rather than
 * swallowed — litter that is announced is a nuisance; litter that is hidden
 * is this defect again.
 */
export function sandboxMarkerDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hk-markers-'));
  process.env.HK_MARKER_DIR = dir;
  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`test-marker-sandbox: could not remove ${dir}: ${err?.message ?? err}\n`);
    }
  });
  return dir;
}
