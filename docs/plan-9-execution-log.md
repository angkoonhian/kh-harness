# Plan 9 execution log — audit Tier 4, cleanup, docs, CI and tests

Preserved from the SDD workspace ledger, per this repository's convention for plans 1–8.

# SDD ledger — plan: docs/superpowers/plans/2026-11-03-audit-tier4-cleanup.md

Spec: docs/superpowers/specs/2026-11-03-audit-tier4-cleanup-design.md (read, reachable)
Branch: fix/audit-findings, continuing from 0beb528 (Tier 3 complete at 3d674e7, under final review).

## Setup rulings

Ruling: Tier 4 starts while the Tier 3 review runs — one working tree, sequential commits, so a Tier 3 fix pass edits whatever state is current; the only cost is interleaved history. Cost if wrong: a fix-pass commit touching a file a Tier 4 task also touched, resolved in the same tree.

## Pre-flight conflict scan

| Producer → Consumer | Produces | Consumes | Finding |
|---|---|---|---|
| T2 → T9 | `DETECT_REPORT_PATH` from report.mjs | lifecycle fixtures may reference it | OK |
| T3 → T9 | `detectIndent` in apply-lib.mjs | lifecycle round-trip test | OK |
| T7 → T9 | `redirected` removed from applyProposals' result | lifecycle tests never read it (grep: 0) | OK |
Pre-flight: T1, T4, T5, T6, T8 share nothing.

## Progress
Task 1: complete (commits 0beb528..641fd1b, tests: node --test scripts/lib/report.test.mjs scripts/lib/gap-model.test.mjs scripts/lib/detect-cli.test.mjs → ℹ duration_ms 22920.0462)
Task 2: complete (commits 641fd1b..27a6062, tests: node --test scripts/lib/lifecycle.test.mjs scripts/lib/detect-cli.test.mjs → ℹ duration_ms 72158.9639)
Task 3: complete (commits 27a6062..6382b4c, tests: node --test scripts/lib/apply-lib.test.mjs scripts/lib/uninstall-lib.test.mjs → ℹ duration_ms 652.3846)
Ruling (T3): the F7 test used a four-space file as its "non-canonical" example; a four-space file IS canonical now (that is the fix), so the fixture became an inconsistently indented file. Cost if wrong: none.
Task 4: complete (commits 2ea166d..7ceeba6, tests: node --test scripts/lib/detect-cli.test.mjs scripts/lib/detect-harness.test.mjs scripts/lib/gap-model.test.mjs → ℹ duration_ms 26567.9307)
Task 5: complete (commits 7ceeba6..c26552f, tests: node --test scripts/lib/rules-brief.test.mjs → ℹ duration_ms 1778.839)
Task 6: complete (commits c26552f..bc4f980, tests: node --test scripts/lib/harness-redact.test.mjs scripts/lib/verify-touched.test.mjs scripts/lib/lint-touched.test.mjs → ℹ duration_ms 23742.9632)
Ruling (T7): the scan.mjs "known blind spot" comment and its .git-as-file test agree with the detector — the fixture is NOT detected (the test asserting so passes) — so the audit item was wrong and nothing changed. Ruling (T7): the forged-CLAUDE.md uninstall test accepts either path gate as the refusal reason, since CLAUDE.md now fails the allowlist before the producible check. Cost if wrong: none.
Task 7: complete (commits bc4f980..34143aa, tests: node --test scripts/lib/apply-lib.test.mjs scripts/lib/uninstall-lib.test.mjs scripts/lib/lifecycle.test.mjs → ℹ duration_ms 68655.9258)
Task 8: complete (commits 34143aa..929e0b7, tests: node --test scripts/lib/plugin-version.test.mjs scripts/lib/skill-phases.test.mjs scripts/lib/cli.test.mjs → ℹ duration_ms 1745.183)
Task 9 measurement: suite wall time 99591.429 ms before the split → 64769.6416 ms after (same machine, same load class); 39 tests preserved across the three files (17 + 14 + 8).
Task 9: complete (commits 929e0b7..f573c78, tests: node --test scripts/lib/lifecycle.test.mjs scripts/lib/lifecycle-gates.test.mjs scripts/lib/lifecycle-regressions.test.mjs scripts/lib/verify-touched.test.mjs → ℹ duration_ms 42971.6596)
Task 10: complete (commits f573c78..a78358a, tests: node --test scripts/lib/detect-exposure.test.mjs → ℹ duration_ms 12250.5319)

Final review: fresh reviewer (Agent, model fable) on 0beb528..a78358a (Tier 4 incl. the Tier 3 fix pass f72a656); verdict "With fixes", no Critical, 3 Important, 8 Minor. Suite at review 1008/1007/0 fail/1 skipped.
Final: fixed Important 1 (INTENT_LIKE substring match took production.md, provisioning.md, revision-history.md, reproduction.md for intent statements) — `P3.intent does not credit a pointer whose name merely contains an intent word` RED→GREEN; namedForIntent() matches whole tokens of the basename split on -, _, . and space.
Final: fixed Important 2 (a column-0 `#` comment ended the pnpm `packages:` list) — `a column-0 comment or blank line inside the pnpm packages: list does not end it` RED→GREEN; comment and blank lines are skipped before the top-level-key test.
Final: fixed Important 3 (settingsReformattedNote still claimed "always rewrites it as JSON.stringify(settings, null, 2)") — `settingsReformattedNote names the behaviour and accepts the caller's own verb clause` RED→GREEN (new assertions); the note now says the indentation and the trailing newline are kept and key order and inline spacing are normalised; the comments at apply-lib.mjs (two), apply.mjs, uninstall.mjs, uninstall-lib.mjs and lifecycle-gates.test.mjs that described the two-space rewrite were rewritten; the two end-to-end assertions follow the wording ("was re-serialised").
Final: Ruling: Minors 4, 5, 6 and 8 were fixed in the same pass although the skill sends minors to the ledger — the user's standing instruction (quality over tokens; no dead code; no bugs) outranks the skill's minor rule, and each of the four is one of those: 4 a truncated dangling status line and a doubled `**` under the Tier 4 heading of the audit doc (removed); 5 fifteen unused imports the lifecycle split left in three files (removed); 6 the "byte bound counts the delimiter" test passed with the reservation reverted (rewritten to measure the full block and bound it one byte short; proved RED with the reservation removed: 321 bytes for a bound of 320, then restored); 8 the P1.pathrules evidence said "single-package repository" while the comment above it explains the criterion is stack.isWorkspace (evidence now says "not a workspace (stack.isWorkspace is false)"; the test matches that) — cost if wrong: four small diffs the user did not ask for, each covered by the suite.
Final: minor (deferred): 7 appendTarget drops a `.` that is a flag's value (`--resolve-plugins-relative-to .`) and its split/join collapses whitespace inside a quoted argument; a plain-command lint script with either is rare, and a linter that then errors on the missing value does not mention the edited file, so the sensor stays silent rather than blocking.
Final: minor (deferred): 9 no end-to-end CLI test round-trips a four-space settings.json through apply then uninstall; both writers are covered by unit tests on the same code path.
Final: minor (deferred): 10 detect.json `schema` stays 1 while `repo.root` became `repo.name`; the only consumer is the skill, updated on this branch — bump the schema together with the kit version (a user decision still open).
Final: minor (deferred): 11 detectIndent returns an indent wider than 10 characters, which JSON.stringify clamps to 10; such a file is re-indented to 10 and the reformat note discloses it.
Final: deferred (outside this plan's range, pre-existing): apply.mjs trackedChanges compares repository-root-relative status paths to project-root-relative ownedByUs entries — the same class as Tier 3 Critical 1, in a nested project root; a follow-up finding.
Final: deferred: the branch has no CI run yet; push so the Linux Node 22/24 jobs exercise O_NOFOLLOW, the uid check and the POSIX symlink tests this machine skips.
Final: suite after the fix pass: npm test → 1010 tests, 1009 pass, 0 fail, 1 skipped (win32 mode bits).
