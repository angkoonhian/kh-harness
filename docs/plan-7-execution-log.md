# Plan 7 execution log — audit Tier 2, robustness

Preserved from the SDD workspace ledger, per this repository's convention for plans 1–6.

# SDD ledger — plan: docs/superpowers/plans/2026-11-02-audit-tier2-robustness.md

Spec: docs/superpowers/specs/2026-11-02-audit-tier2-robustness-design.md (read, reachable)
Branch: fix/audit-findings, continuing from b89e7b3 (Tier 1 complete, reviewed, ledger preserved as docs/plan-6-execution-log.md).

## Setup rulings

Ruling: same branch, native execution, as for Tier 1 (see docs/plan-6-execution-log.md setup rulings). Cost if wrong: same.
Ruling: finding 15's `why` field persisted on a kept settings patch is NOT removed — uninstall-lib.test.mjs pins it as the durable record of why a patch was left (spec Non-goals). Cost if wrong: one extra field in the manifest.

## Pre-flight conflict scan

| Producer → Consumer | Produces | Consumes | Finding |
|---|---|---|---|
| T2 → (Tier 3 D1) | `hasEquivalentHook(settings, event, command, matcher)` | Tier 3 will widen to `(settings, event, entry, matcher)` | noted; no conflict inside this plan |
| T5 | `denyRuleCoverage` in protected-evidence.mjs | gap-model P2.protected | OK — same module the check already imports from |
Pre-flight: no other shared interfaces (T1, T3, T4, T6, T7, T8 are disjoint).

## Progress
Task 1: complete (commits b89e7b3..ef79cfc, tests: node --test scripts/lib/scan.test.mjs scripts/lib/detect-exposure.test.mjs → ℹ duration_ms 17049.9326)
Task 1 note: the full suite before the commit was red only on DOGFOOD, over a sentence in docs/plan-6-execution-log.md (`pwd:/api_key:,` parses as a credential line); reworded in its own commit. Everything else: 914 pass.
Task 2: complete (commits ef79cfc..b2e48d6, tests: node --test scripts/lib/apply-lib.test.mjs scripts/lib/settings-merge.test.mjs → ℹ duration_ms 355.1999)
Task 3: complete (commits b2e48d6..83588b7, tests: node --test scripts/lib/manifest.test.mjs scripts/lib/apply-lib.test.mjs → ℹ duration_ms 285.8162)
Ruling (T3): the two writeManifest tests passed BEFORE the change — atomicity (temp file + rename) is not observable from a single-threaded synchronous test without injecting fs, which would be test-only code in production. They are kept as contract guards (no temporary residue; a failed replace leaves the target intact), the atomic write itself is verified by reading the ten lines. The kitVersion test was RED→GREEN. Cost if wrong: a regression to an in-place write would pass the suite.
Task 4: complete (commits 83588b7..60a6858, tests: node --test scripts/lib/verify.test.mjs scripts/lib/detect-cli.test.mjs → ℹ duration_ms 25669.7207)
Task 5: complete (commits 60a6858..e7aa4a0, tests: node --test scripts/lib/protected-evidence.test.mjs scripts/lib/gap-model.test.mjs → ℹ duration_ms 1306.4749)
Ruling (T5): the Task 8b top-up test pinned the sentence "1 of 2 deny rule(s) … already present"; the unit of coverage is now a protected PATH (a user rule of any spelling may cover it), so the sentence became "1 of 2 protected path(s) already covered: … covered by …" and the test regex moved with it — the behaviour it guards (a top-up is disclosed, never silent) is unchanged. Cost if wrong: none.
Task 6: complete (commits e7aa4a0..8e5da9e, tests: node --test scripts/lib/scan.test.mjs → ℹ duration_ms 15918.7471)
Task 6 note: the junction test was RED before the fix — the recursive readdir followed a Windows junction and listed linked/x.ts, so the pruned walk also closes a containment gap the audit did not name. Ruling (T6): the walk timing assertion times walkFiles (exported for this) relative to enumerating everything in the same process (walk < enumerate/3) after a fixed 200 ms bound flaked under the full suite and listFiles's own git probes (~170 ms) swamped the measurement. Cost if wrong: one exported helper.
Task 7: complete (commits 8e5da9e..5968192, tests: node --test scripts/lib/lifecycle.test.mjs scripts/lib/uninstall-lib.test.mjs → ℹ duration_ms 61069.1536)
Task 8: complete (commits 5968192..712554b, tests: node --test scripts/lib/detect-cli.test.mjs → ℹ duration_ms 23943.1313)
Task 9: complete (commits 712554b..72c42df, tests: node --test scripts/lib/detect-exposure.test.mjs → ℹ duration_ms 14927.8729)

## Final review (fresh reviewer, fable, range b89e7b3..72c42df) — "With fixes", no Critical
Final: fixed Important 1 (registeredHook ignored the matcher; sensor under Bash read declared) — tests 'hookRegistrations records…', 'P2.sensor is absent, with evidence naming the matcher…', 'detect reports P2.sensor absent when the sensor script is registered under Bash' RED→GREEN; the LOAD-BEARING fixtures and withHooks helper gained hookRegistrations.
Final: fixed Important 2 (timedOut by killed/signal) — err.code === 'ETIMEDOUT'; the timeout test now also asserts exitCode null (guard; the detection change is not observable on Windows without a non-timeout SIGTERM).
Final: fixed Minor 3 (// and ~/ credited as covering; ./ unrelated) — test 'denyRuleCoverage: ./ and one leading / are project-relative; // and ~/ never cover' RED→GREEN.
Final: fixed Minor 5 (stale .tmp-* never removed) — test 'writeManifest removes a stale temporary sibling…' RED→GREEN.
Final: fixed Minor 4, 6, 7, 8, 9, 10, 11 — wording, docs, matcher set equality (tests 'normalizeMatcher…', 'matcherCovers…', 'hasEquivalentHook treats Edit|Write as Write|Edit…'), the applyProposals matcher guard, stdout-empty assertion, isWellFormedHooks doc, 1,500-file fixture.
Final: Ruling: a NARROWER registration of a match-all proposal counts as equivalent (hasEquivalentHook) and as declared (registeredHook) — narrowing an event we need no matcher on is the user's choice; the Tier 2 test that asserted the opposite was reversed and says why. Cost if wrong: a user who narrowed our SessionStart brief to startup|resume is not offered a second registration.
Final: Ruling on "Declined to judge": verification records not rendered in the summary, the fallback walk's nested filter, one unreadable subdirectory aborting the walk, EXCLUDE_DIRS hiding dist/ from fallback evidence, usage EXIT_CODES wording, two concurrent apply runs, hasEquivalentHook on args (Tier 3), the gitignored-.claude branch, the untracked detect.json — all stand; the first is Tier 4 material. Cost if wrong: none observed.
Final suite: npm test → 964 tests, 963 pass, 0 fail
