# Plan 5 execution log — intent and rules (Phase 3)

Preserved from the SDD workspace ledger, per this repository's convention for plans 1–4.

# SDD ledger — plan: docs/superpowers/plans/2026-11-02-intent-and-rules.md

Spec: docs/superpowers/specs/2026-11-02-intent-and-rules-design.md (read, reachable)
Branch: feat/intent-and-rules, cut from master @ 59893f7. Working tree was clean.

## Setup rulings

Ruling: branch in place, no git worktree — why: the working tree was clean and this is the kit's own dev repo; nothing else is being edited here. Cost if wrong: none beyond a `git stash` if the user needs master mid-flight.
Ruling: execution method = native (executing-plans) chosen by me, not the user — why: user asked to implement and is running an autonomous loop; the 12 tasks share interfaces tightly. Cost if wrong: one fewer review gate per task; mitigated by the final fresh reviewer.

## Pre-flight conflict scan

| Producer → Consumer | Produces | Consumes | Finding |
|---|---|---|---|
| T1 → T3 | `parseRules`, `findRules`, `RULES_PATH` from the asset | same, via `../../assets/scripts/harness-redact.mjs` | OK |
| T1 → T6 | same | hook imports `./harness-redact.mjs` | OK |
| T2 → T4 | `intentEvidence(root)`, `INTENT_SECTIONS`, `INTENT_PATH` | same | OK |
| T3 → T4 | `rulesRegistryEvidence(root, harness)`, `ruleShapedLines(root, harness)` | same | OK |
| T4 → T6 | `RULES_BRIEF_PATH` exported from propose.mjs | generator + gap-model registeredHook | OK — gap-model already imports propose.mjs one-directionally |
| T5 → T7 | `RULES_PATH` re-exported from propose.mjs; template `RULES.md.tmpl` | uninstall imports both constants from propose.mjs; `templateFor` returns `'RULES.md.tmpl'` | OK |
| T4 ↔ T6 | P3.reinject is decidable only with ≥1 rule | generator must not propose with 0 rules | GAP — see ruling |
| T4 | P3.reinject question when registry absent | every question lands in couldNotDerive | NOISE — see ruling |

Ruling (T6): the P3.reinject generator ALSO returns [] when the registry has <1 rule — same defensive second gate `bootstrapProposal` keeps independent of the check-level `decidable`. Cost if wrong: none; redundancy only.
Ruling (T4): when the registry is ABSENT, P3.reinject is `absent`, `decidable:false`, with evidence "no docs/harness/RULES.md yet — nothing to inject" and NO question (P3.rules' own proposal already says what to do, and a second question in couldNotDerive on every first run is noise). The question fires only when the registry EXISTS and parses to 0 rules. Deviation from plan Task 4 text, which gave the same question for both. Cost if wrong: a first-run reader misses one sentence that P3.rules already carries.

## Progress
Ruling (T1): registry gains optional keys status (active|superseded, default active) and last-verified (YYYY-MM-DD) from the research sweep; Markdown kept over the research's JSON recommendation because the file is human-edited and the kit has no YAML parser (spec §3). Cost if wrong: two unused fields.
Task 1: complete (commits 59893f7..4db638d, tests: node --test scripts/lib/rules-registry.test.mjs → ℹ duration_ms 218.2846)
Ruling (T2): canonical section 3 is 'How it works' (research: spec-kit user scenarios, OpenAI product-specs), with Behaviour/Behavior as aliases — plan said Behaviour canonical. Also reads an optional '- last-reviewed: YYYY-MM-DD' line as freshness evidence (Google SWE book, MS ms.date). Cost if wrong: one alias table entry.
Task 2: complete (commits 4db638d..7ff90da, tests: node --test scripts/lib/intent-evidence.test.mjs → ℹ duration_ms 344.1474)
Task 3: complete (commits 7ff90da..c24ee14, tests: node --test scripts/lib/rules-evidence.test.mjs → ℹ duration_ms 309.2915)
Ruling (T4): phase-3 evidence (intent, rulesRegistry, ruleShapedLines) is computed in detectHarness and carried on `harness`, not read from `root` inside the checks — why: every existing check decides from the harness object, and the LOAD-BEARING zero-proposals fixture (no root) must keep working; the two end-to-end "harnessed" fixtures in detect-cli.test.mjs gained INTENT.md, RULES.md and a UserPromptSubmit hook so "fully harnessed" still means zero proposals (foreign-hook test count 4 → 5). Cost if wrong: none; a later caller that wants file-backed checks reads detectHarness.
Task 4: complete (commits c24ee14..8d1b572, tests: node --test scripts/lib/gap-model.test.mjs scripts/lib/report.test.mjs scripts/lib/profiles/index.test.mjs scripts/lib/detect-harness.test.mjs → ℹ duration_ms 25198.5385)
Ruling (T5): the uninstall half of Task 7 (RULES_PATH generator-producible + templateFor → RULES.md.tmpl, with its two tests) is pulled forward into Task 5 — why: once apply writes the scaffold, three existing lifecycle tests (full apply→uninstall cycle leaves git clean) go red until uninstall can remove it; the plan ordered the two the wrong way round. Task 7 keeps the allowlist/KIT_OUTPUT and rules-brief.mjs halves. Cost if wrong: none; same code, earlier commit.
Task 5: complete (commits 8d1b572..ee8f1bd, tests: node --test scripts/lib/propose.test.mjs scripts/lib/uninstall-lib.test.mjs → ℹ duration_ms 1132.1337)
Task 6: complete (commits ee8f1bd..0f476b5, tests: node --test scripts/lib/rules-brief.test.mjs scripts/lib/propose.test.mjs → ℹ duration_ms 1413.1063)
Ruling (T7): the uninstall producible/templateFor and the KIT_OUTPUT_FILES halves were already landed in Tasks 4-6 (ledgered there); Task 7 adds only the allowlist entry and the three pins. Cost if wrong: none.
Task 7: complete (commits 0f476b5..6e2fb7d, tests: node --test scripts/lib/apply-lib.test.mjs scripts/lib/detect-harness.test.mjs scripts/lib/uninstall-lib.test.mjs → ℹ duration_ms 24591.3443)
Task 8: complete (commits 6e2fb7d..258ca76, tests: node --test scripts/lib/lifecycle.test.mjs → ℹ duration_ms 66077.3991)
Note (T8): full-suite run showed one failure in verify-touched.test.mjs ('TIMEOUT: a second Stop in the same session SKIPS re-running') that does not reproduce alone (32/32) — a load-induced timing flake in a pre-existing timeout-path test, not touched by this plan. Re-check on the final full run.
Task 9: complete (commits 258ca76..9089786, tests: node --test scripts/lib/skill-prompts.test.mjs scripts/lib/skill-phases.test.mjs scripts/lib/skill-links.test.mjs → ℹ duration_ms 250.1366)
Task 10: complete (commits 9089786..523d17c, tests: node --test scripts/lib/dogfood-intent.test.mjs → ℹ duration_ms 471.1353)
Task 11: complete (commit cd465df, tests: cli/dogfood/detect-exposure green). Task 12 NOT run: usage limit reached before whole-branch verification, plugin validate, cashmigo trial and the fresh reviewer. Final review: not performed.
Task 11: complete (commits 523d17c..04ae38e, tests: node --test scripts/lib/cli.test.mjs → ℹ duration_ms 1518.8609)
Final: fixed UPGRADE SKEW (Critical, found by the cashmigo trial, not by the reviewer): stale unmodified shared asset kept by the manifest dedupe → hook crashed at import. Tests "UPGRADE: a manifest-recorded shared asset ... IS re-proposed" and "an older harness-redact.mjs beside the hook produces one stderr line ... exit 1" RED→GREEN; suite 850/851 (1 skipped).
Final: Ruling: a repository whose hook checks are ALL declared gets no upgrade proposal for a stale shared asset (generators run only for absent checks) — the hook's own fail-visible guard covers it, and a general "upgrade" command is out of this plan's scope. Cost if wrong: a user on 0.1.0 with every hook installed sees a one-line hook-error notice per prompt until they re-run apply after a check goes absent, or a later plan adds `apply --upgrade`.
Final: minor (deferred): `detect` modifies the tracked docs/harness/detect.json in repositories that commit it (cashmigo), so the very next `apply` refuses with "uncommitted changes to tracked files" — pre-existing, surfaced by the trial; README should say detect.json is best left untracked, or apply should excuse that one path.
Final: minor (deferred, but IMPORTANT for Windows users): with git core.autocrlf=true, the kit's own installed files are rewritten to CRLF on checkout/renormalisation, so `classify` (sha256 of raw bytes vs manifest) reports every one of them `ours-modified`. Measured in the real cashmigo working copy: harness-redact.mjs on disk hashes c9dc2000…, manifest records f0a1c1de…. Consequences: no update path ever fires on Windows checkouts (the upgrade fix in 06bbfa5 is inert there), and uninstall keeps every kit file as "modified". Pre-existing, not introduced by this plan. Candidate fix: normalise CRLF→LF before hashing in classify AND when recording — a one-function change in manifest.mjs with a CRLF fixture test.
Final review: fresh reviewer (Fable) on review-59893f7..06bbfa5.diff — verdict "With fixes": 0 Critical, 4 Important, 9 Minor.
Final: fixed Important 1 (shared asset re-proposed once per check) — REVIEW-1 RED→GREEN.
Final: fixed Important 2 (update path trusted the manifest hash alone) — REVIEW-2 RED→GREEN; onDiskCarriesStamp mirrors uninstall's carriesOurStamp.
Final: fixed Important 3 (three comments stating the dead never-re-propose invariant) — re-justified in apply.mjs, apply-lib.mjs, propose.mjs.
Final: fixed Important 4 + Minor 6 (skew notice without a working fallback; missing asset → stack trace) — REVIEW-4 and REVIEW-6 RED→GREEN.
Final: fixed Minor 5 (reference claimed the hook always exits 0) — phase-3-intent.md re-states the visible-failure exception.
Final: minor (deferred): 7 parser problem strings echo a full rejected enforced-by/status value; bound to ~40 chars.
Final: minor (deferred): 8 "three hooks"/"both hooks" prose in harness-redact.mjs, propose.mjs stamp text, README, cli.mjs after a fourth hook.
Final: minor (deferred): 9 stripNonContent duplicated in intent-evidence and rules-evidence; neither handles ~~~ or indented fences; parseRules strips comments but not fences.
Final: minor (deferred): 10 any multi-word H2 parses as a rule with its first word as the id — say so in the template's FORMAT block.
Final: minor (deferred): 11 the literal 1500 appears in six places.
Final: minor (deferred): 12 lifecycle test asserts the filled registry survives uninstall but not the user-authored-body reason.
Final: minor (deferred): 13 the §8 citation was corrected in propose.mjs; propose.test.mjs:~1378 still says "spec's own manifest table (§8)".
Final: Ruling: detect.json dirtying a tracked file (reviewer declined) — stands as pre-existing; flagged to the user. Cost if wrong: a confusing refusal on the next apply in repos that commit detect.json.
Final: Ruling: CRLF byte-exact hashing (reviewer declined as root cause) — stands as pre-existing but is the most important follow-up for a Windows user; flagged to the user with the measured hashes. Cost if wrong: no update path and no clean uninstall on Windows checkouts.
Verification: npm test 855 tests / 854 pass / 1 skipped / 0 fail; `claude plugin validate . --strict` → "Validation passed"; cashmigo local-clone trial: scaffold → fill → hook → detect declared → uninstall keeps the filled registry; the hook's skew guard fired for real on the 0.1.0 asset.
