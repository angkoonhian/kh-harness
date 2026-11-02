# Plan 8 execution log — audit Tier 3, performance and noise

Preserved from the SDD workspace ledger, per this repository's convention for plans 1–7.

# SDD ledger — plan: docs/superpowers/plans/2026-11-02-audit-tier3-performance.md

Spec: docs/superpowers/specs/2026-11-02-audit-tier3-performance-design.md (read, reachable; hook-schema facts verified against the Claude Code hooks reference on 2026-11-02)
Branch: fix/audit-findings, continuing from dee72e8 (Tier 2 complete at 72c42df, under final review while Task 1 — an isolated file — starts).

## Setup rulings

Ruling: Task 1 (harness-redact.mjs mask rules) starts while the Tier 2 review runs — it touches a file Tier 2 never did, and a Tier 2 fix pass cannot collide with it. Every other task waits for that fix pass. Cost if wrong: an interleaved commit in the history.

## Pre-flight conflict scan

| Producer → Consumer | Produces | Consumes | Finding |
|---|---|---|---|
| T2 → T3 | `runBounded`, `killTree` in harness-redact.mjs | lint-touched.mjs imports both | OK |
| T5 → T6 | exec-form entries `{command:'node', args:[…]}` | renderDiff prints the entry; terse summary is for FILE proposals only | OK |
| T5 → (Tier 2 T2) | `hasEquivalentHook(settings, event, entry, matcher)` | widens Tier 2's `(…, command, matcher)`; one caller | OK — signature change ledgered here |
| T7 → T8 | none | none | OK |

## Progress
Task 1: complete (commits dee72e8..73b50d8, tests: node --test scripts/lib/harness-redact.test.mjs scripts/lib/lint-touched.test.mjs scripts/lib/verify-touched.test.mjs → ℹ duration_ms 13272.173)
Ruling (setup, extended): Tasks 2–4 touch only assets/scripts/* (files Tier 2 never changed), so they proceed while the Tier 2 review runs; Tasks 5–8 wait for its fix pass. Cost if wrong: interleaved commits.
Task 2: complete (commits 73b50d8..5e8c55e, tests: node --test scripts/lib/verify-touched.test.mjs scripts/lib/harness-redact.test.mjs → ℹ duration_ms 12003.8448)
Task 3: complete (commits 5e8c55e..414d841, tests: node --test scripts/lib/lint-touched.test.mjs → ℹ duration_ms 18483.2902)
Ruling (T3): `;` is not a compound-command separator for the append rule — it sits inside quoted `node -e` bodies far more often than between shell commands (two existing fixtures), and missing a `;`-chain is the pre-existing behaviour. Cost if wrong: a path appended to the last stage of a `;`-chain, as before. Ruling (T3): the chain test uses `||` so the last stage runs and echoes its argv — with `&&` the test passed vacuously.
Task 4: complete (commits 0cd3d96..28c803f, tests: node --test scripts/lib/verify-touched.test.mjs scripts/lib/detect-exposure.test.mjs → ℹ duration_ms 21116.2315)
Task 4 note: the suite was red only on DOGFOOD over a Plan 7 ledger sentence quoting the previous offending text; reworded in its own commit. Everything else: 966 pass.
Task 5: complete (commits 28c803f..064b5de, tests: node --test scripts/lib/settings-merge.test.mjs scripts/lib/detect-harness.test.mjs scripts/lib/propose.test.mjs scripts/lib/apply-lib.test.mjs scripts/lib/lifecycle.test.mjs → ℹ duration_ms 73033.0382)
Task 5 measurement (one lint-touched invocation, 20 runs, no lint script so the hook exits at once): shell form (bash -c "node …"): median 101 ms, min 98 ms;exec form (node …): median 82 ms, min 66 ms;
Task 6: complete (commits 064b5de..a5c34dd, tests: node --test scripts/lib/propose.test.mjs scripts/lib/apply-lib.test.mjs scripts/lib/detect-cli.test.mjs → ℹ duration_ms 25828.9196)
Ruling (T6): --yes keeps printing SETTINGS patch previews (hook entry, deny rules — a few lines, the most security-relevant writes; two end-to-end tests read the rule name from that output) and skips only FILE diffs. Plan said "no diffs". Cost if wrong: a few extra lines under --yes.
Task 7: complete (commits a5c34dd..497e7e6, tests: node --test scripts/lib/scan.test.mjs scripts/lib/detect-cli.test.mjs → ℹ duration_ms 27839.6456)
Task 7 measurement (cashmigo clone, 1,422 files, 10 runs, median): listFiles 350 ms → 213 ms; detect CLI after Tasks 1–7: 1,018 ms (the audit measured 2.3 s before any fix; the kit repo itself, 135 files: listFiles 214 ms, CLI 527 ms before Task 7). detectExposures before Task 8: 366 ms median on the clone.
Task 8: complete (commits 497e7e6..a80de6f, tests: node --test scripts/lib/detect-exposure.test.mjs scripts/lib/gap-model.test.mjs → ℹ duration_ms 11467.0042)
Task 8 measurement (cashmigo clone, 1,422 files, 10 runs, median): detectExposures 366 ms → 273 ms; detect CLI 1,018 ms → 829 ms (after Tasks 7+8; the audit measured 2.3 s before any fix).
Task 9: complete (commits a80de6f..3d674e7, tests: node --test scripts/lib/detect-exposure.test.mjs → ℹ duration_ms 12670.6218)

## Final review (fresh reviewer, fable, range dee72e8..3d674e7) — "No" (one Critical), NOT YET FIXED — session stopped at the usage limit
Final: OPEN Critical 1 — treeFingerprint (verify-touched.mjs) stats `join(root, path)` but `git status` paths are repository-root relative; a project rooted below the git toplevel (monorepo package) loses the size/mtime signal and skips verification after its first pass. Fix: `git rev-parse --show-toplevel` once and stat against it; add a fixture with package.json in a subdirectory (two Stops, second after re-editing an already-modified file, must run).
Final: OPEN Important 2 — the two git spawns in treeFingerprint have no timeout (add `timeout: 10_000`; the header comment "every spawn is bounded" is false until then).
Final: OPEN Important 3 — the URL-userinfo mask requires a non-empty username; `redis://:secret@host` passes raw (fix: `[^/\s:@]*`).
Final: OPEN Minor 4 — mask rule lengths use {6,} instead of the spec's lengths and over-mask identifiers such as npm_config_cache, hf_transfer, ghp_client, pwd: paths.
Final: OPEN Minor 5 — stale comments: lint-touched.mjs:517, :46-48, :453, :64-67; verify-touched.mjs:49-51; lint-touched.test.mjs:581.
Final: OPEN Minor 6 — renderDiff one-liner says "stamped on line 2" (line 1 for harness-redact.mjs); D7 deviation (trusts assetSource + propose.test pin) un-ledgered.
Final: OPEN Minor 7 — appendTarget drops only a TRAILING bare `.`; `eslint . --ext .ts` keeps the dot.
Final: OPEN Minor 8, 9, 10 — resolver edge cases (`"${CLAUDE_PROJECT_DIR}"/x`, node flags before the script, any shell token treated as ours), fingerprint blind spots (ignored files; rename record's second path), FIFO open without O_NONBLOCK.
Final: reviewer recommendation — a lastFailedFingerprint so a failing tree is not re-typechecked only to print "already reported".

## Final review fix pass (after the usage-limit pause)
Final: fixed Critical 1 — test 'a project rooted below the git toplevel still re-verifies a file edited twice' RED→GREEN (stat against `git rev-parse --show-toplevel`).
Final: fixed Important 2 — both fingerprint spawns bounded at 10 s (no separate test: a timeout resolves to "no fingerprint", the existing non-git path).
Final: fixed Important 3 — test 'maskCredentials masks a URL password with an empty user name, the standard Redis form' RED→GREEN.
Final: fixed Minor 4 — test 'maskCredentials leaves ordinary identifiers that merely start like a vendor prefix alone' RED→GREEN. Ruling: floors are TEN characters of body (hf twelve), a little below the sweep's patterns rather than the spec D8 lengths — a mask that stars a shorter string than the sweep flags is the safe direction, and the pre-existing fixtures (13-character sk- bodies) pin that the mask stays at least that eager. Cost if wrong: a 10-character identifier after a vendor prefix is starred.
Final: fixed Minor 7 — test 'a bare "." target anywhere in a plain command is replaced…' RED→GREEN. Minor 8 (quote closing before the path) — test 'normalizeHookPath strips a quote that closes before the path' RED→GREEN. Minor 9 — rename records skipped, ignored-files blind spot commented. Minor 5, 6 — comments and the one-liner wording.
Final: Ruling (D7 deviation, Minor 6): renderDiff trusts `assetSource` plus propose.test's pin that the contents equal the asset plus the stamp, rather than re-reading the asset in apply-lib — proposals have no deserialised input path, so the flag cannot be forged. Cost if wrong: a generator that sets assetSource on non-verbatim contents is caught by the pin, not at render time.
Final: Ruling (T5 token rule deviation, Minor 8): every shell-form token is a candidate script (the plan said "first path token after node"); more robust for real commands, at the cost that `node build.mjs .claude/scripts/x.mjs` reads as ours. Cost if wrong: a user's build script naming our path as an argument is credited as our hook.
Final: minor (deferred): 8 — an exec form with a node flag before the script (args[0] is a flag) is not recognised.
Final: minor (deferred): 10 — openAndRead has no O_NONBLOCK for a FIFO (unreachable through the scan).
Final: minor (deferred): reviewer recommendation — a lastFailedFingerprint so a failing tree is not re-typechecked only to print "already reported".
Final suite: npm test → 996 tests, 995 pass, 0 fail
