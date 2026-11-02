# Plan 6 execution log — audit Tier 1, false assurance

Preserved from the SDD workspace ledger, per this repository's convention for plans 1–5.

# SDD ledger — plan: docs/superpowers/plans/2026-11-02-audit-tier1-false-assurance.md

Spec: docs/superpowers/specs/2026-11-02-audit-tier1-false-assurance-design.md (read, reachable)
Branch: fix/audit-findings, cut from feat/intent-and-rules @ 09013c0. Working tree had two untracked files (docs/2026-11-02-audit-findings.md, docs/harness/detect.json).

## Setup rulings

Ruling: one branch `fix/audit-findings` for every audit tier, stacked on `feat/intent-and-rules` — why: the fixes touch Phase 3 files (rules-brief comment, RULES.md R6) and the user has not yet decided how to integrate Phase 3; one stacked branch keeps a single review. Cost if wrong: a rebase if Phase 3 is merged with changes.
Ruling: execution method = native (executing-plans), chosen by me — the user asked to "fix it" autonomously and the five tasks are independent. Cost if wrong: no per-task review gate; mitigated by the final fresh reviewer.
Ruling: finding 5 (dry run refused on the default branch) is folded into Tier 1 Task 4 — same code as finding 3. Cost if wrong: none; it would otherwise be the first Tier 2 task.

## Pre-flight conflict scan

Pre-flight: no shared interfaces (Tasks 1–5 touch disjoint modules; Task 2 reads Task 1's `line` field but only through the finding objects both tests construct by hand).

## Progress
Task 1: complete (commits 40d3925..499df32, tests: npm test → ℹ duration_ms 62568.4171)
Ruling (T1): CREDENTIAL_RULES[7] in harness-redact.mjs was NOT restructured — the DOGFOOD run never named it (a `)` sits between the key and `=`), so the plan step was conditional and unneeded. Ruling (T1): ENV_REFERENCE tolerates a surrounding markdown backtick so a documented `${VAR}` example is not a finding; REFERENCE_VALUE left as is (out of scope). Cost if wrong: none observed. Files reworded/assembled for DOGFOOD: docs/plan-3-execution-log.md, detect-exposure.mjs comment, detect-exposure.test.mjs, detect-harness.test.mjs, eval-suite.test.mjs, harness-redact.test.mjs, lint-touched.test.mjs (6 spots), verify-touched.test.mjs, the new plan and spec.
Task 2: complete (commits 499df32..951c899, tests: node --test scripts/lib/detect-exposure.test.mjs scripts/lib/gap-model.test.mjs scripts/lib/report.test.mjs → ℹ duration_ms 14079.2934)
Task 2 note: full suite run recorded in scratchpad t2-suite.txt before the commit (see grep above: 0 fail).
Task 3: complete (commits 951c899..e48ae6e, tests: node --test scripts/lib/harness-redact.test.mjs scripts/lib/lint-touched.test.mjs scripts/lib/verify-touched.test.mjs → ℹ duration_ms 12153.776)
Task 3 note: suite (minus the two not-yet-implemented Task 4 test files) run before the commit, 0 fail. Ruling (T3): the lint fixture is a lint.cjs FILE rather than a `node -e` body — a `-e` body puts the diagnostic text into the command tokens, which real lint scripts never do. Cost if wrong: none.
Task 3 correction: the suite run before the Task 3 commit showed DOGFOOD red (harness-redact.test.mjs:104, a --api-key=value literal, caught at severity low by the new path role); fixed by assembling the fixture in a follow-up commit. Ruling: not amended — history stays honest. Cost if wrong: one extra commit.
Task 4: complete (commits e48ae6e..025c25b, tests: node --test --test-skip-pattern=CRLF scripts/lib/git-info.test.mjs scripts/lib/apply-gates.test.mjs scripts/lib/lifecycle.test.mjs scripts/lib/cli.test.mjs scripts/lib/detect-cli.test.mjs → ℹ duration_ms 60330.2386)
Task 4 note: full suite (906 tests, 0 fail) ran before the usage-text fix; task-done re-ran the gate, lifecycle, cli and detect-cli files with the not-yet-implemented Task 5 CRLF tests skipped. Ruling (T4): gitInfo/defaultBranches take an optional { env } so a test can take git away; production never passes it — a parameter, not a test hook in disguise. Ruling (T4): when git cannot answer, --yes needs BOTH waivers (neither gate could run) — stricter than the audit asked. Cost if wrong: one extra flag for a user without git.
Task 5: complete (commits 025c25b..ccac234, tests: node --test scripts/lib/manifest.test.mjs scripts/lib/uninstall-lib.test.mjs scripts/lib/lifecycle.test.mjs → ℹ duration_ms 56075.5768)
Task 5 note: full suite run before the commit (see t5-suite.txt), 0 fail.
Task 6: complete (commits ccac234..e93daba, tests: npm test → ℹ duration_ms 73429.2991)
Ruling (T6): the ledger copy to docs/plan-6-execution-log.md is deferred until after the final review and fix pass, so it carries the Final: lines as plan 5's does. Cost if wrong: none.

## Final review (fresh reviewer, fable, range 09013c0..e93daba) — "With fixes", no Critical
Final: fixed Important 1 (sk- rule flagged hyphenated prose) — test 'a provider-token shape inside a longer word, or hyphenated prose starting with sk-, is not a token' RED→GREEN
Final: fixed Important 2 (xxx inside a real key skipped as placeholder) — test 'a real key whose random body happens to contain xxx is still found; an all-filler body is not' RED→GREEN
Final: fixed Important 3 (specs/ treated as a test directory) — pathRole test extended with docs/specs paths RED→GREEN
Final: fixed Important 4 (uninstall --help and INTENT.md said byte-identical) — prose; covered by the suite
Final: fixed Minor 8 re-graded Important (URL/userinfo token exempt from layer 1) — test 'pathTokenExemptions: a URL token is never exempt…' RED→GREEN
Final: fixed Minor 10 re-graded Important (both waivers over a git error were silent) — test 'apply --yes with both waivers proceeds when git cannot run, and still says so' RED→GREEN
Final: fixed Minor 5, 6, 7 (stale comments, undocumented regex grouping, dangling cross-reference) — prose, same commit
Final: Ruling: reviewer's filler suggestion `(.)\1{7,}$` dropped — every fixture token in the suite is a repeated letter, and over-reporting a repeated letter is the safe direction; kept the x/*/# filler and the word fillers. Cost if wrong: a documentation key of 20 identical letters reads as a finding.
Final: Ruling (deviation 11): every gate refusal is printed, not only the first — more useful to the user; plan text said "the first". Cost if wrong: none.
Final: minor (deferred): 9 — ENV_REFERENCE accepts ${VAR:-literal} as a reference
Final: minor (deferred): 12 — api_key: ${{ secrets.X }} with spaces yields no finding rather than a reference (the \S{8,} capture stops at the space)
Final: minor (deferred): 13 — the Exposures heading "rotate by hand" also heads low fixture entries
Final: Ruling on "Declined to judge" lines: Bearer prose body, `\S{8,}` heuristics on the password, pwd and api_key keys, e2e//mocks/ demotion, missing *_spec.rb/*Test.java patterns, no kit version bump, no git-error field in detect --json, extra dry-run spawns — all stand as designed; the version bump and the detect.json field are Tier 3/4 material. Cost if wrong: a reader of detect --json cannot tell a git failure from a non-repository without stderr.
Final suite: npm test → 915 tests, 914 pass, 0 fail
