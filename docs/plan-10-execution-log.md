# Plan 10 execution log — one entry script per tool-call event

Preserved from the SDD workspace ledger, per this repository's convention for plans 1–9.

Plan: docs/superpowers/plans/2026-11-25-hook-merge.md
Spec: docs/superpowers/specs/2026-11-25-hook-merge-design.md
Branch: angkoonhian/stage0-hook-merge, base master at eead407.

The ledger below is copied as it stood after the review of this log (Task 9) and before its fix round was recorded; Tasks 1 to 8 are complete in it. Test durations were not recorded per task in the ledger; the suite run this log records is under "Test suite".

Worktree: /home/kinghian/orca/workspaces/kh-harness/stage0-hook-merge (branch angkoonhian/stage0-hook-merge, base master eead407)
Spec: docs/superpowers/specs/2026-11-25-hook-merge-design.md
Next plan after this one: docs/superpowers/plans/2026-11-25-contract-and-extension-point.md (part B, own workspace + ledger)
Models: implementers opus, reviewers opus on Tasks 1,2,6,7 (behaviour-preservation / migration risk), sonnet elsewhere. Owner's standing preference: quality over tokens.
Docs commit: 37d7c62

### Pre-flight scan (2026-11-25)

| Tasks | Shared file / interface | Finding |
|---|---|---|
| 1 → 2 | gateHalf/logHalf/lintHalf/loopHalf return `{json, stderr, exitCode}` or null; Task 2's core consumes them | consistent with the fixed interface in the plan header |
| 2 → 5 | `cli.test.mjs` script count: interim form in Task 2, final form in Task 5 | intended two-step; reviewer of Task 2 must not flag the interim form as final |
| 2 → 4 | `ENTRY_SCRIPTS` table lives in `hook-evidence.mjs` (decision 10) | Task 4 readers consume it; check name on dispatch of Task 4 |
| 5 ↔ 1 | Two install-layout assertions (`tool-gate.test.mjs:569`, `loop-watch.test.mjs:427`) are edited in Task 5 only | Global Constraints name this exception |
| 6 → 7 | `settings-hook-replace` kind (Task 6) used by `P0.hookmerge` generator (Task 7) | consistent |
| 2 → part B | `preHalves` exported from dispatch-pre-tool.mjs; path constant `DISPATCH_PRE_PATH` | part B plan aligned to this name |
| each task | self-consistency | plan author ran the skill's self-review; no contradiction found in headers/decisions read by controller. Full step text not re-read by controller: review loop is the net. |

Ruling: design says a throwing half is "contained … prints nothing"; plan decision 5 agrees — no conflict.
Ruling: design "every existing test passes unchanged, except two assertions" matches plan Task 5 — no conflict.
Ruling: git had no author identity on this machine; set repo-local user.name/user.email from the repository's last commit author — commits need an author — cost if wrong: owner resets `git config --local`.

### Tasks
Ruling: plan B line 794 sample tripped P0.security dogfood test; reworded sample to build the value at runtime, committed separately — keeps the suite green without editing the test — cost if wrong: none.
Task 1: implemented fcebd32 (base ac72ca5). Review: spec ✅, 1 Important (plan-mandated), minors.
Ruling: runHalf's `{ env }` option is plan-mandated but used by no task in either plan — remove it; the Global Constraint "no speculative options" outranks the brief's signature — cost if wrong: a later task re-adds one parameter.
Ruling: brief asks a fresh project AND session id per compared side; tests reuse one session id — treated as a spec gap, sent to the fix round.
Task 1: minor (deferred): lint-touched.mjs comment above `report` says "ONLY place … builds a result's stderr" though two helpers build `stderr: ''` — sent with round 1 as a one-line wording fix.
Task 1: minor (deferred): lintHalf hard-codes 'Write'/'Edit'; test checks one direction against SENSOR_MATCHER — acceptable per reviewer.
Task 1: fix round 1/5 (3 addressed, 0 open; commits fcebd32..96925d7)
Task 1: complete (commits ac72ca5..96925d7, review clean)
Note: `runHalf(script, exportName, root, payload)` has NO env option (ruling above) — carry into Task 2+ dispatches.
Task 2: implemented 10846c5 (base 96925d7), DONE_WITH_CONCERNS: (a) attribution line, (b) hooks-doc pin (Global Constraint line 26) not done.
Ruling: commit attribution — each implementer follows the attribution reminder its own session gives it (the line names the model that wrote the commit); existing commits are left as they are — cost if wrong: owner amends trailers before merging.
Task 2: review — spec ❌ (hooks-reference pin for exit-2/stdout missing), Important plan-mandated (run-and-exit block copied in three entry scripts), minors.
Ruling: the exit-2 pin belongs to Task 2 (first code depending on the rule; no task owns it in the plan) — fix in round 1.
Ruling: duplication — add one core export `dispatch(event, halves)` composing readPayload → runHalves → combine → emit and returning the exit code; entry scripts keep only core-load, coreNotice and their halves list. The four fixed exports stay (part B relies on them and on `preHalves`). Spec is silent; DRY outranks the brief's verbatim copies — cost if wrong: part B's Task 2 reads the entry script slightly differently; carry into part B dispatch.
Ruling: a half returning a malformed result must not reach `process.exit(NaN)` (would print a stack trace, breaching a Global Constraint) — treated as a real gap, fix in round 1: runHalves drops results that are not `{json: object|null, stderr: string, exitCode: 0|2}`.
Task 2: minor (deferred): core-load check uses `name in core` while half() uses typeof function — a non-function export fails silently.
Task 2: minor (deferred): core missing/older tested only through dispatch-tool-failure.mjs; loop over ENTRY_SCRIPTS.
Task 2: minor (deferred): notice tests stop at " — "; pin each entry script's REMEDY copy to tool-gate's.
Task 2: fix round 1/5 (2 addressed: dispatch export, malformed result; 1 open — hooks-reference pin; commits 10846c5..95ae3a4). Implementer BLOCKED on the pin: the reference contradicts the premise.
Ruling (controller read the reference itself, hooks.md lines 815, 843-856, 1050-1051, 2026-11-25): on exit 2 Claude Code "still reads the fields" of valid JSON and stderr is shown to Claude on PostToolUse/PostToolUseFailure. So `combine` must KEEP the JSON on exit 2 and leave stderr as the halves produced it; no notice is moved to stderr. This preserves each message's reader, which is the design's goal. Design and plan constraint corrected (commit after 95ae3a4). Plan decision 3/4 and Review Focus 2 are superseded where they say the JSON is dropped — cost if wrong: on a real session a lint report could be hidden when JSON is also present; mitigation: empirical headless check to run before the final review (TODO for controller, like the earlier hook experiments).
TODO(controller): empirical check in a real Claude Code session that a PostToolUse hook printing JSON {systemMessage} + stderr + exit 2 delivers both.
Task 2: fix round 2/5 (pin + exit-2 ruling implemented, 250969b; awaiting re-review of 10846c5..HEAD)
DONE(controller) empirical check, Claude Code 2.1.332, one headless run, cost $0.005: a PostToolUse hook printing JSON {systemMessage, hookSpecificOutput.additionalContext} on stdout + text on stderr + exit 2 delivered all three: systemMessage as a person-facing notice ("PostToolUse:Bash says: …"), stderr to the model as the hook's blocking error, additionalContext to the model. The R1 ruling holds in practice. Raw output: scratchpad/exit2-check/out.jsonl.
Task 2: fix round 2/5 (3 addressed, 0 open; commits 10846c5..250969b; re-review clean)
Task 2: complete (commits 96925d7..250969b, review clean). Core exports now: readPayload, runHalves, combine, emit, dispatch(event, halves), half(name, file, exportName, load). On exit 2 the JSON is KEPT.
Task 2: minor (deferred): entry scripts' CORE list still names combine/emit/readPayload/runHalves though they call only dispatch and half.
Note for part B: entry scripts call `core.dispatch(EVENT, [...halves])`; `preHalves` unchanged; path constant DISPATCH_PRE_PATH.
Task 3: complete (commits aa65c64..3274b18, review clean). Measured adds: pre ~17 ms, post ~15 ms, failure ~16 ms (linux, Node 26.13.1).
Task 3: minor (deferred): pre latency test does not assert stdout '' (gate loaded and did not match).
Task 3: minor (deferred): post latency run does not include the lint spawn path (Bash payload) — stated in the comment.
Task 4: implemented 0d82cc0 (base 3274b18), DONE_WITH_CONCERNS: directRegistrations/loggingScript unused until later tasks; extra evidence line for matcher mismatch; unhandled install-record-only + entry mix.
Task 4: review approved; 1 Important plan-mandated (directRegistrations, loggingScript have no caller yet).
Ruling: the two exports stand — the plan schedules their callers (directRegistrations in Task 5, loggingScript in Task 7) — cost if wrong: dead code ships. CHECK at Task 5 and Task 7 completion that each is called; if not, remove it.
Task 4: complete (commits 3274b18..0d82cc0, review clean).
Task 4: minor (deferred): mixed resolved/unresolved registrations name the entry script or understate (practically unreachable).
Task 4: minor (deferred): the added matcher-mismatch evidence line (hook-evidence.mjs ~198) and P2.loopwatch evidence are not asserted by a test.
Task 4: minor (deferred): hook-evidence.mjs header caller list omits log-lib.mjs and lifecycle-fixtures.mjs; log-lib.mjs comment rewrap.
Task 5: implementer NEEDS_CONTEXT (nothing committed). directRegistrations now has a caller (mergePlan) — Task 4 check satisfied for it.
Ruling: four unnamed test edits in propose.test.mjs are allowed — each is a count or list that changes only because four kit files were added (assetSource list +4, STAMP INVARIANT 15→19, kitskew "of 11" → 14) or a fixture that must pass `{ claudeDir: {} }` now that the generator reads registrations — cost if wrong: a pinned count hides an unintended file; reviewer to check each number against the four files.
Ruling: the logging gap is a real regression against the design goal "no change in what is logged" (generic profile with a lint script: P2.sensor n/a → PostToolUse gets no registration; same for a held half). Fix in Task 5: skip a mergeable event in sessionLogProposal only when the other half's check is present in `checks`, absent and decidable; otherwise register session-log.mjs alone as today. Tests for the generic-profile case and a held-half case. This amends plan decision 11 — cost if wrong: an event registered separately that could have merged; Task 7's migration merges it later.
Task 5: second NEEDS_CONTEXT — two tests in lifecycle-regressions.test.mjs pin the separate layout (deleteEntry expects lint-touched.mjs on PostToolUse).
Ruling: option (iii) — keep both regression tests and the shared helper's sanity line unchanged; put the fixture into the separate layout first by bringing Task 7's `separateRegistrations(d)` fixture (plan line 741) forward into Task 5, in lifecycle-fixtures.mjs with exactly Task 7's signature and behaviour. The scenario those tests guard (another kit hook's recorded entry must not credit the sensor) still exists on installs that keep separate registrations, so the coverage must stay — cost if wrong: Task 7 finds the fixture needs a different shape and adjusts it. Carry into Task 7 dispatch: the fixture already exists.
Note: implementer corrected its own claim — a held tool-gate/loop-watch already held session-log at HEAD (one version unit); only the generic-profile case was a regression. Guard kept; held-half branch covered by a unit test only.
Note (pre-existing, not changed): in a generic-profile repo the kit's own .mjs scripts flip the profile to typescript-single after the first apply.
Task 5: implemented 0d5bc13 (base 0d82cc0); rulings file task-5-rulings.md; awaiting review
Task 5: complete (commits 0d82cc0..0d5bc13, review clean — approved, no Critical/Important).
Task 5: minor (deferred → CARRY INTO TASK 7): separateRegistrations lays PreToolUse out as [tool-gate, session-log]; a real pre-merge apply wrote [session-log, tool-gate] (CHECKS order). Task 7 must order the halves as the old apply did, since migration is tested against this fixture.
Task 5: minor (deferred): guard `proposing` in sessionLogProposal restates buildProposals' absent-and-decidable rule; share one predicate.
Task 5: minor (deferred): fixture SEPARATE_HALVES duplicates steps/check ids/matcher held in propose.mjs.
Task 5: minor (deferred): TDD order slipped (code before tests; RED recorded by stashing).
Task 6: implemented 6d58dcf (base 0d5bc13), DONE_WITH_CONCERNS: apply.mjs label/disclosure/result-line untested until Task 7 proposes the kind (CARRY INTO TASK 7: pin them); two unsettled choices (one element per hash; same-run staged record never dropped).
Task 6: review — Important 1: stageSettingsReplace removes any hash the proposal names; must require each `remove` hash to be a recorded patch on /hooks/<event> AND the element to run only producible kit scripts (as uninstall's revertPatch does). Global Constraint; fix round 1.
Ruling: the plan's Review Focus 4 says after a kill "the next apply finishes" — the kill tests check uninstall only; a second apply after each kill is a spec gap, in round 1.
Ruling: the same-run-staged clause (apply-lib ~332) is correct but untested and uncommented — in round 1 (two-proposal test + one-line constraint comment), since removing it breaks decision 15 silently.
Task 6: minor (deferred): proposal shape not validated (non-array/empty `remove`).
Task 6: minor (deferred → CARRY INTO TASK 7): hasEquivalentHook runs before the removal check — if the entry script is already registered while separate registrations remain, replacement is skipped as unchanged and hooks run twice; Task 7's check must notice that state. Also Task 7 must not re-propose forever after an after-settings kill (stale records in manifest), and must pin apply.mjs label/disclosure/result line.
Task 6: fix round 1/5 (3 addressed, 0 open; commits 6d58dcf..dc0c4c6; re-review clean)
Task 6: complete (commits 0d5bc13..dc0c4c6, review clean). New skip reason `not-recorded`; `runsOnlyKitScripts` exported from settings-merge.mjs; diffRenderer/renderDiff take the manifest.
Task 6: minor (deferred): `manifest?.settingsPatches ?? []` in replacementOf guards an unreachable case.
Task 6: minor (deferred): preview does not run unmetDependencies/hasEquivalentHook, so dry-run and --yes can give different skip reasons (both write nothing).
Task 7: implementer BLOCKED (nothing committed): propose.test.mjs "a script the kit has never written is held by an edited sibling…" final assertion expects a separate lint-touched.mjs registration; the brief's rule now makes that event mergeable.
Ruling: allow the one-line edit — expected proposals become [DISPATCH_POST_PATH, ...everyLoadedSibling(DISPATCH_POST_PATH), 'PostToolUse']; the test's intent ("with nothing held, the same check is proposed in full") is kept, only the form of the registration changes as the design intends — cost if wrong: a held-script regression hidden by the new expectation; reviewer to check the held half of that test is untouched.
Note: implementer added a `doubled` state (entry script + separate registrations on one event) with a change in apply-lib.mjs's `unchanged` check and result count — beyond the brief, answering carry item 3. Reviewer must scrutinise.
Note: loggingScript has callers (carry file was stale) — Task 4 check satisfied.
Task 7: implemented aed1770 (base dc0c4c6), DONE_WITH_CONCERNS (doubled state beyond brief; 'some of them' evidence; owner-removed-hook convergence untested). Awaiting review.
Task 7: review — safety core approved; Important 1: non-logging generators return entryProposals on any mergeable plan without `plan.missing.includes(half)`, and sessionLogProposal falls through — three proposals for one event (reproduced, gitignored + files absent). Fix round 1.
Ruling: because this task rewrites owners' settings in real repositories, three reviewer Minors are promoted into round 1: (a) mergePlan must judge only registrations in settings.json, not settings.local.json (else P0.hookmerge claims a fix apply cannot make — R7); (b) the eead407 real-upgrade test must also assert manifest records and run uninstall; (c) add tests for shell-form recorded registrations being migrated and for unresolved (gitignored) registrations — cost if wrong: one more round.
Task 7: minor (deferred): kept-elements computation in apply-lib.mjs:905 is positional (slice(0,-1)); doubled where the entry's own element changed is untested; owner edits other than timeout untested; two-apply convergence after a re-added half untested; doubled evidence says "some of them".
Task 7: fix round 1/5 (4 addressed, 0 open; commits aed1770..e38a7ed; re-review clean; eead407 test confirmed not skipped: 13 pass 0 skipped)
Task 7: complete (commits dc0c4c6..e38a7ed, review clean).
Task 7: minor (deferred — FINAL REVIEW SHOULD FIX): an entry script the owner put in settings.local.json beside halves recorded in settings.json reads `mergeable`, not `doubled` → a second entry script would be registered and hooks run twice. Sturdier rule: any kit-script registration in settings.local.json on an event makes that event left alone.
Task 7: minor (deferred): `?? SETTINGS_PATH` default exists only for hand-built unit fixtures.
Task 7: minor (deferred, pre-existing edge): logging hook only in settings.local.json with no record + unresolvable script → P5.sessionlog absent while plan mergeable → logging runs twice.
Task 8: implemented 3ca85c3 (base e38a7ed), DONE_WITH_CONCERNS (base wording; old example counts '12 proposals'/'35 actions to close 9 capability gaps' left; two skip reasons taken from code not a live run). Awaiting review. Task 9 dispatched concurrently with Task 8's review (different files; reviewer is read-only).
Task 8: complete (commits e38a7ed..3ca85c3, review clean — approved, every prioritised claim checked true against code at HEAD; reviewer reproduced the dry-run/patched output on an eead407 install).
Task 8: minor (deferred — FINAL REVIEW SHOULD FIX, user-facing wording): CHANGELOG.md ~:49 and docs/guide/commands.md ~:167 say an event the owner edited or removed "is left alone"/"is not proposed" without saying a hook the owner removed is offered again by its own check on that apply.
Task 8: minor (deferred — FINAL REVIEW SHOULD FIX): README.md ~:383 says an older install is moved "by the next `apply`"; it is moved only by `apply --yes`.
Task 8: minor (deferred): history narration in how-it-works.md ~:186 ("as it did under its own …") and ~:305 ("as before"); ragged wrapping README ~:380, troubleshooting ~:487.
Task 8: minor (deferred, pre-existing): example counts "12 proposals…" (real: 16 = 11/4/1 at eead407 and HEAD) and "35 actions to close 9 capability gaps" (real: 37/11 at eead407, 38/11 at HEAD) were stale before this branch — separate docs pass.
Task 9: implemented acc6055 (base 3ca85c3), DONE_WITH_CONCERNS: machine loaded (Blender render, load 11-40) so ms-level differences are noise; test comment numbers not updated; finding: one process saves ~20 ms CPU per event but wall-clock vs parallel separate hooks is within noise (≈ -5/0/+6 ms).
Task 9: review — Needs fixes (document only): (1) "about 20 ms CPU saved" does not follow from the table (raw 30.9 and 27.3 ms; 20.1/20.0 is the entry script's own cost less bare); (2) CPU "less bare" columns use bare figures the log does not print; (3) "3 to 5 ms more CPU" false for PostToolUseFailure (8.5 ms vs loop-watch); (4) parallel-start claim attributed to the brief, which does not say it — needs the hooks reference citation; (5) Task 8 status contradictory and its four deferred minors missing from the open list; Step 3 deferral must be stated as deferred, not justified by an unrecorded "quieter machine". Fix round 1.
Ruling: the test comment in harness-dispatch.test.mjs is NOT overwritten with loaded-machine figures; the quiet-machine re-measurement is deferred to the owner (machine was running a render, load 10–40) and stated as deferred in the log — cost if wrong: the dated comment stays at the Task 3 figures a little longer.
Ruling: the measuring script and all raw run lines go INTO the log as an appendix so a reader can recompute every table — cost: a longer document.
CORRECTION owed to the owner: controller relayed "about 20 ms CPU saved"; the log's own table gives about 31 and 27 ms raw.

## Deviations from the plan

Each is taken from the ledger above.

- Exit code 2. The plan said an entry script drops the JSON when a half exits 2 and moves notices to stderr. The hooks reference (read 2026-11-25) says Claude Code still reads the JSON fields on exit 2 and shows stderr to Claude on PostToolUse and PostToolUseFailure. `combine` therefore keeps the JSON and leaves each half's stderr as the half produced it. One headless run on Claude Code 2.1.332 delivered the JSON `systemMessage`, the stderr text and `additionalContext` together. The design and the plan constraint were corrected after commit 95ae3a4.
- An added export, `dispatch(event, halves)`, in `harness-dispatch.mjs`. It composes readPayload, runHalves, combine and emit and returns the exit code, so the three entry scripts do not each copy the run-and-exit block. The four exports the plan fixed stay.
- A malformed half result. `runHalves` drops results that are not `{json: object|null, stderr: string, exitCode: 0|2}`, so a half cannot make the entry script call `process.exit(NaN)`.
- The logging-hook guard on fresh installs. In a generic-profile repository with a lint script, a fresh install would have left PostToolUse with no logging registration. `sessionLogProposal` skips a mergeable event only when the other half's check is present in `checks`, absent and decidable; otherwise it registers `session-log.mjs` alone as before. This amends plan decision 11.
- `separateRegistrations(d)`, planned for Task 7, was brought forward into Task 5 (in `lifecycle-fixtures.mjs`) because two regression tests in `lifecycle-regressions.test.mjs` pin the separate layout.
- Four test edits in `propose.test.mjs` that the plan did not name: three counts or lists that change because four kit files were added (assetSource list +4, STAMP INVARIANT 15 to 19, kitskew "of 11" to 14), and a fixture that must pass `{ claudeDir: {} }`. A fifth, in Task 7: the held-script test now expects `[DISPATCH_POST_PATH, ...everyLoadedSibling(DISPATCH_POST_PATH), 'PostToolUse']`.
- The `not-recorded` safeguard (Task 6). A replacement proposal removes only registrations the manifest records as apply patches on that event and only elements that run producible kit scripts; any other element is skipped with the reason `not-recorded`. `runsOnlyKitScripts` is exported from `settings-merge.mjs`; `diffRenderer` and `renderDiff` take the manifest.
- The `doubled` state (Task 7), beyond the brief: an event with the entry script and separate kit registrations both present. The `unchanged` check in `apply-lib.mjs` and the result count changed with it, so that this state is no longer read as `unchanged`.
- The `settings.json`-only rule (Task 7 fix round 1). The migration judges only registrations in `.claude/settings.json`, not `settings.local.json`, because apply cannot rewrite the local file.
- Each mergeable tool-call event is proposed by one generator (Task 7 fix round 1), after the review reproduced three proposals for one event.

## Open minor findings

Deferred in the ledger and not fixed. Ledger wording, shortened only where the ledger line was long. The ledger marks some of these "FINAL REVIEW SHOULD FIX".

- Task 1 (the ledger sent this one to fix round 1 as a wording fix and says that round addressed 3 findings without naming them; not checked here): lint-touched.mjs comment above `report` says "ONLY place … builds a result's stderr" though two helpers build `stderr: ''`.
- Task 1: lintHalf hard-codes 'Write'/'Edit'; the test checks one direction against SENSOR_MATCHER.
- Task 2: core-load check uses `name in core` while half() uses typeof function — a non-function export fails silently.
- Task 2: core missing/older tested only through dispatch-tool-failure.mjs; loop over ENTRY_SCRIPTS.
- Task 2: notice tests stop at " — "; pin each entry script's REMEDY copy to tool-gate's.
- Task 2: entry scripts' CORE list still names combine/emit/readPayload/runHalves though they call only dispatch and half.
- Task 3: pre latency test does not assert stdout '' (gate loaded and did not match).
- Task 3: post latency run does not include the lint spawn path (Bash payload) — stated in the comment.
- Task 4: mixed resolved/unresolved registrations name the entry script or understate (practically unreachable).
- Task 4: the added matcher-mismatch evidence line (hook-evidence.mjs ~198) and P2.loopwatch evidence are not asserted by a test.
- Task 4: hook-evidence.mjs header caller list omits log-lib.mjs and lifecycle-fixtures.mjs; log-lib.mjs comment rewrap.
- Task 5: separateRegistrations lays PreToolUse out as [tool-gate, session-log]; a real pre-merge apply wrote [session-log, tool-gate] (CHECKS order). Task 7 was to order the halves as the old apply did (the ledger does not record that it did).
- Task 5: guard `proposing` in sessionLogProposal restates buildProposals' absent-and-decidable rule; share one predicate.
- Task 5: fixture SEPARATE_HALVES duplicates steps/check ids/matcher held in propose.mjs.
- Task 5: TDD order slipped (code before tests; RED recorded by stashing).
- Task 6: proposal shape not validated (non-array/empty `remove`).
- Task 6: `manifest?.settingsPatches ?? []` in replacementOf guards an unreachable case.
- Task 6: preview does not run unmetDependencies/hasEquivalentHook, so dry-run and --yes can give different skip reasons (both write nothing).
- Task 7 (marked "FINAL REVIEW SHOULD FIX"): an entry script the owner put in settings.local.json beside halves recorded in settings.json reads `mergeable`, not `doubled`, so a second entry script would be registered and hooks would run twice. Sturdier rule: any kit-script registration in settings.local.json on an event makes that event left alone.
- Task 7: kept-elements computation in apply-lib.mjs:905 is positional (slice(0,-1)); doubled where the entry's own element changed is untested; owner edits other than timeout untested; two-apply convergence after a re-added half untested; doubled evidence says "some of them".
- Task 7: `?? SETTINGS_PATH` default exists only for hand-built unit fixtures.
- Task 7 (pre-existing edge): logging hook only in settings.local.json with no record and an unresolvable script: P5.sessionlog absent while the plan reads mergeable, so logging runs twice.
- Task 8 (FINAL REVIEW SHOULD FIX, user-facing wording): CHANGELOG.md ~:49 and docs/guide/commands.md ~:167 say an event the owner edited or removed "is left alone"/"is not proposed" without saying a hook the owner removed is offered again by its own check on that apply.
- Task 8 (FINAL REVIEW SHOULD FIX): README.md ~:383 says an older install is moved "by the next `apply`"; it is moved only by `apply --yes`.
- Task 8: history narration in how-it-works.md ~:186 ("as it did under its own …") and ~:305 ("as before"); ragged wrapping README ~:380, troubleshooting ~:487.
- Task 8 (pre-existing): example counts "12 proposals…" (real: 16 = 11/4/1 at eead407 and HEAD) and "35 actions to close 9 capability gaps" (real: 37/11 at eead407, 38/11 at HEAD) were stale before this branch; a separate docs pass.
- Task 9: no measurement on a quiet machine. The dated comment above the latency tests in scripts/lib/harness-dispatch.test.mjs keeps the Task 3 figures; the brief's Step 3 is deferred to the owner (see the latency section).


## Latency, before and after

What was measured: the time to start one hook script as Claude Code would (`node <script>` with the event payload on standard input), less a bare `node -e 0` start, for the layout at `eead407` (before) and at HEAD `3ca85c3` (after).

- Machine: Linux 7.3.5-2-cachyos, 16 logical CPUs, Node v26.13.1, 2026-11-25.
- The machine was not quiet. A Blender render (about 1100% CPU) and other processes ran throughout; the 1-minute load average read between 11.8 and 39.8 at the start of each wall-clock run (17:40 to 17:52; headers `## HH:MM:SS load` in the appendix). The brief asks for a quiet machine; there was none. The fastest-of-40 method discounts load but does not remove it: the fastest bare start differed from run to run between 15.7 and 42.5 ms. Differences of a few milliseconds below are inside that spread.
- Before: a second checkout of `eead407` (`git worktree add --detach <scratch>/before eead407`, removed afterwards). Its scripts are `tool-gate.mjs`, `session-log.mjs`, `loop-watch.mjs`, `lint-touched.mjs`. After: this checkout's `assets/scripts/dispatch-pre-tool.mjs`, `dispatch-post-tool.mjs`, `dispatch-tool-failure.mjs`.
- Every run used the same payloads, one temporary data directory, one temporary repository with the log enabled (`setEnabled(root, true)`), no gate file, and `addedLatency` from `scripts/lib/latency-fixtures.mjs` (40 pairs, hook and bare run alternating which goes first, fastest of each reported). The payload is a `Bash` call `npm test`; the failure payload carries a different `error` text on each run.

### The brief's command, as run

The brief's command spawns `assets/scripts/<script>` relative to the checkout it runs in, and its rows name `dispatch-*.mjs` (which do not exist at `eead407`) beside `tool-gate.mjs`, `session-log.mjs` and `loop-watch.mjs`. Run as written it measures only the layout at HEAD, where the three single scripts still exist but are no longer what an install registers. I changed three things and nothing else:

1. The command is saved as a script, `measure.mjs <checkout> <before|after>`, that takes the checkout directory. It imports `addedLatency` from this checkout and `harness-log.mjs` (for `setEnabled`) from the checkout under test, so the log format is the one that checkout writes.
2. `before` runs the five single-script rows of the brief's eight that exist at `eead407` (`tool-gate.mjs` and `session-log.mjs` on PreToolUse; `session-log.mjs` on PostToolUse; `loop-watch.mjs` and `session-log.mjs` on PostToolUseFailure); `after` runs the brief's three `dispatch-*` rows. The brief's command is otherwise unchanged.
3. The brief measures no lint hook. Because the before layout runs `lint-touched.mjs` on PostToolUse, a sixth `before` row, `lint-touched.mjs` on the same `Bash` payload (which the lint hook does not lint), was run separately with the same method (`measure-lint.mjs`, the same file with the row list reduced to that row by `sed`).

The measuring scripts were kept outside the repository; they and every raw output line are in the appendix. The command text is the brief's, with `spawnSync(process.execPath, [checkout + '/assets/scripts/' + script], ...)` for its `'assets/scripts/' + script`.

### The eight lines

The brief expects eight lines from one run. Five single-script lines come from the `before` checkout and three entry-script lines from HEAD, so each side was run with its own call, `node measure.mjs <before-checkout> before` and `node measure.mjs <HEAD> after`, alternating the two. That was done in two sets: set one ran before, after, after, before (load average 30.5 to 32.3 at the start of each run); set two ran before, after, after, before, before, after (load average 11.8 to 36.6 at the start of each run). The first run of set one, verbatim for its eight lines (the before lines are the first call's, the after lines the second call's):

```
before PreToolUse tool-gate.mjs — fastest hook run 35.9 ms, fastest bare node start 18.0 ms (medians 91.9 and 52.1 ms) over 40 interleaved pairs
before PreToolUse session-log.mjs — fastest hook run 36.5 ms, fastest bare node start 16.3 ms (medians 85.9 and 42.3 ms) over 40 interleaved pairs
before PostToolUse session-log.mjs — fastest hook run 32.3 ms, fastest bare node start 19.1 ms (medians 90.9 and 59.2 ms) over 40 interleaved pairs
before PostToolUseFailure loop-watch.mjs — fastest hook run 31.1 ms, fastest bare node start 19.4 ms (medians 76.3 and 50.4 ms) over 40 interleaved pairs
before PostToolUseFailure session-log.mjs — fastest hook run 35.0 ms, fastest bare node start 17.2 ms (medians 89.2 and 55.7 ms) over 40 interleaved pairs
after PreToolUse dispatch-pre-tool.mjs — fastest hook run 35.3 ms, fastest bare node start 17.9 ms (medians 96.6 and 58.8 ms) over 40 interleaved pairs
after PostToolUse dispatch-post-tool.mjs — fastest hook run 39.2 ms, fastest bare node start 17.5 ms (medians 98.9 and 60.3 ms) over 40 interleaved pairs
after PostToolUseFailure dispatch-tool-failure.mjs — fastest hook run 37.5 ms, fastest bare node start 17.6 ms (medians 88.5 and 46.7 ms) over 40 interleaved pairs
```

The other runs are in the appendix. In all, each single script and each entry script was run five times (two in set one, three in set two), the lint-touched.mjs row three times. For each script, the fastest hook run and the fastest bare start over all five runs of that script (200 pairs):

| Event | Script | Runs (pairs) | Fastest run, ms | Fastest bare start in those runs, ms |
|---|---|---|---|---|
| PreToolUse | before: tool-gate.mjs | 5 (200) | 30.1 | 18.0 |
| PreToolUse | before: session-log.mjs | 5 (200) | 36.5 | 16.3 |
| PreToolUse | after: dispatch-pre-tool.mjs | 5 (200) | 31.4 | 17.2 |
| PostToolUse | before: session-log.mjs | 5 (200) | 32.3 | 17.7 |
| PostToolUse | before: lint-touched.mjs, a Bash call | 3 (120) | 34.9 | 27.4 |
| PostToolUse | after: dispatch-post-tool.mjs | 5 (200) | 35.1 | 17.5 |
| PostToolUseFailure | before: loop-watch.mjs | 5 (200) | 26.1 | 16.2 |
| PostToolUseFailure | before: session-log.mjs | 5 (200) | 31.5 | 15.7 |
| PostToolUseFailure | after: dispatch-tool-failure.mjs | 5 (200) | 37.5 | 16.0 |

The lint row's three runs are a third set (before-lint then after, three times), run at load 38 to 40, and its own bare floor was 27.4 ms, so it is the least comparable figure here. The `after` PostToolUse lines in that third set read 61.7, 55.3 and 56.4 ms and are not in the table (the table above uses the five runs of the first two sets).

### Wall-clock to start the scripts: sums of the two processes

These tables add the two before processes. They are not what a user waits for when hooks run in parallel (next table). "Less bare" subtracts the fastest bare start seen in the whole measurement, 15.7 ms, once for each process: two for the before layout, one for the after layout. (The brief says "each also less one bare start"; read literally that subtracts one start from the before sum too. This log subtracts what each layout starts.) Each figure is the fastest of 200 pairs, except the lint row (120 pairs).

PreToolUse

| | Fastest run, ms | Less bare starts, ms |
|---|---|---|
| Before: tool-gate.mjs + session-log.mjs (30.1 + 36.5) | 66.6 | 35.2 |
| After: dispatch-pre-tool.mjs | 31.4 | 15.7 |

PostToolUse (a `Bash` call: the lint hook starts and does not lint)

| | Fastest run, ms | Less bare starts, ms |
|---|---|---|
| Before: session-log.mjs + lint-touched.mjs (32.3 + 34.9) | 67.2 | 35.8 |
| After: dispatch-post-tool.mjs | 35.1 | 19.4 |

For an edit (`Write` or `Edit`) the lint hook runs the linter. The table does not measure that, because the lint run dominates it; the before figure for an edit is the log hook plus the lint hook's start plus the lint run, and the after figure is the entry script's start plus the same lint run. The lint run is not changed by this plan and was not measured.

PostToolUseFailure

| | Fastest run, ms | Less bare starts, ms |
|---|---|---|
| Before: loop-watch.mjs + session-log.mjs (26.1 + 31.5) | 57.6 | 26.2 |
| After: dispatch-tool-failure.mjs | 37.5 | 21.8 |

### Wall-clock a user waits, if the hooks of an event run in parallel

The Claude Code hooks reference, https://code.claude.com/docs/en/hooks, read 2026-11-25, says: "When an event fires, its matching hooks run in parallel." The wait before is then the slower of the two scripts. Taking the larger of two independently chosen minima favours the before layout: the larger of two runs in the same pair is never below it, so the real before wait is at least this figure, and the "after minus before" differences below are upper bounds on the entry script's extra wait (the worst case for the entry script) and lower bounds on its gain.

| Event | Before: larger of the two fastest runs, ms | After: fastest run, ms | After minus before, ms |
|---|---|---|---|
| PreToolUse | 36.5 (session-log.mjs) | 31.4 | -5.1 |
| PostToolUse (Bash call) | 34.9 (lint-touched.mjs) | 35.1 | +0.2 |
| PostToolUseFailure | 31.5 (session-log.mjs) | 37.5 | +6.0 |

These are single fastest runs under load; the fastest bare start moved between 15.7 and 42.5 ms from run to run, and differences of this size are inside that spread. The measurement shows no wall-clock gain or loss on any event that it can tell apart from noise.

### CPU time per process

Wall-clock under this load mostly measures the load, so CPU time (user plus system) per process was also measured with bash's `time` keyword over 200 runs of one script with the payload on standard input and output discarded, in one temporary repository with the log enabled (`cpu.sh`, `cpu-all.sh` in the appendix; three rounds, scripts interleaved within a round, the same round numbers pair a before row with an after row). The figure includes bash's fork and exec of the process, which is why a bare `node -e 0` reads about 20 ms.

Raw values, ms of CPU per process, rounds 1 / 2 / 3:

| Event | Row | Rounds 1 / 2 / 3 | Mean | Median |
|---|---|---|---|---|
| PreToolUse | bare `node -e 0` | 21.1 / 19.0 / 20.0 | 20.0 | 20.0 |
| PreToolUse | before: tool-gate.mjs | 35.6 / 32.1 / 35.2 | 34.3 | 35.2 |
| PreToolUse | before: session-log.mjs | 36.6 / 34.3 / 36.1 | 35.7 | 36.1 |
| PreToolUse | after: dispatch-pre-tool.mjs | 40.1 / 37.8 / 39.5 | 39.1 | 39.5 |
| PostToolUse | bare `node -e 0` | 20.1 / 19.1 / 20.1 | 19.8 | 20.1 |
| PostToolUse | before: session-log.mjs | 36.3 / 34.7 / 37.4 | 36.1 | 36.3 |
| PostToolUse | before: lint-touched.mjs | not measured | | |
| PostToolUse | after: dispatch-post-tool.mjs | 38.2 / 37.9 / 46.8 | 41.0 | 38.2 |
| PostToolUseFailure | bare `node -e 0` | 18.9 / 19.4 / 34.2 | 24.2 | 19.4 |
| PostToolUseFailure | before: loop-watch.mjs | 30.2 / 30.7 / 30.3 | 30.4 | 30.3 |
| PostToolUseFailure | before: session-log.mjs | 35.0 / 37.3 / 35.0 | 35.8 | 35.0 |
| PostToolUseFailure | after: dispatch-tool-failure.mjs | 37.7 / 40.3 / 38.7 | 38.9 | 38.7 |

Derived, per round, from the rows above (the before sum is the two before rows of the same round):

| Event | Before sum minus after, per round (rounds 1 / 2 / 3), ms | Mean | Less one bare start (bare median of the event: 20.0, 19.4), mean |
|---|---|---|---|
| PreToolUse | 32.1 / 28.6 / 31.8 | 30.8 | 10.8 |
| PostToolUseFailure | 27.5 / 27.7 / 26.6 | 27.3 | 7.9 |

- "Before sum minus after" is the CPU saved per call by running one process in place of two: about 29 to 32 ms on PreToolUse and about 27 to 28 ms on PostToolUseFailure. It contains the start of the second process (about 20 ms, the bare row) and the work the two scripts did twice (loading the shared modules). The same figure less one bare start, about 11 ms and about 8 ms, is the saving other than a process start.
- PostToolUse has no comparison: lint-touched.mjs's CPU was not measured, and against session-log.mjs alone the entry script costs more (rounds 1 / 2 / 3: +1.9 / +3.2 / +9.4 ms; the third round is the outlier).
- The entry script costs more CPU than any one single script it replaces: against each single script, by round, +4.5 / +5.7 / +4.3 and +3.5 / +3.5 / +3.4 (PreToolUse: tool-gate, session-log), +7.5 / +9.6 / +8.4 and +2.7 / +3.0 / +3.7 (PostToolUseFailure: loop-watch, session-log), +1.9 / +3.2 / +9.4 (PostToolUse: session-log). Across every row the difference is between 1.9 and 9.6 ms. One script's own value moved by 3 to 9 ms between rounds (dispatch-post-tool.mjs: 38.2, 37.9, 46.8), so the difference is of the same size as the round-to-round spread and a comparison of one entry script with one single script is not resolved by this measurement.
- Load: the CPU rounds ran beside the same render; the 1-minute load average read 10.1 after a first attempt that was discarded (it ran a wrong path and measured nothing) and 11.1 after the three rounds; it was not recorded per round. CPU time is less sensitive to load than wall-clock but not independent of it (one bare round read 34.2 ms).

### What this shows and does not show

- Each entry script starts one Node process where the before layout started two. On the CPU rows, that is about 29 to 32 ms of CPU per PreToolUse call and about 27 to 28 ms per PostToolUseFailure call, each across three rounds, of which about 20 ms is the second process start.
- Wall-clock a user waits is a different quantity, because the hooks of an event run in parallel. On the fastest runs the entry script is 5.1 ms faster on PreToolUse, 0.2 ms slower on PostToolUse and 6.0 ms slower on PostToolUseFailure; each difference is inside the run-to-run noise, so no wall-clock gain or loss is shown. What is shown is lower CPU and one process instead of two per call, which matters where cores are scarce; that was not measured separately.
- The PostToolUse figures are for a `Bash` call, where the lint half starts and does not lint. The figures for an edit include a linter run in both layouts, not measured.
- Not measured: a quiet machine, Windows or macOS, a repository with real gates (no gate file was used), a log with a long history, lint-touched.mjs CPU, the lint run, and the time Claude Code itself takes to start a hook and read its output.

### Re-measurement on a quiet machine: deferred to the owner

A quiet-machine re-measurement (wall-clock sets, the CPU rounds and a lint-touched.mjs CPU row) was to run if the 1-minute load average was below 2 at the start and stayed near 3. It was not run. After the measurement above, the machine read:

```
 17:58:24 up 2 days, 16:29,  1 user,  load average: 3.09, 12.91, 16.14
 17:58:37 up 2 days, 16:29,  1 user,  load average: 2.88, 12.39, 15.92
```

then, after waiting several minutes for it to fall further, `cat /proc/loadavg` read `5.26 9.06 13.96`, then `5.39 7.58 12.66` and `6.26 7.55 12.44`, with `ps -eo pcpu,comm --sort=-pcpu` showing blender at 99 to 100% and vyugate-edge at 166% CPU. The load never reached 2. The brief's Step 3, copying quiet-machine figures into the dated comment above the latency tests in `scripts/lib/harness-dispatch.test.mjs`, is therefore deferred as well, and that comment keeps the figures Task 3 recorded (linux, Node 26.13.1, 2026-11-25: 17, 15 and 16 ms added over a bare start). The ledger does not record the machine's load when Task 3 measured them. The figures in this log, by the same fastest-minus-bare rule with each script's own fastest bare start, were 14.2, 17.6 and 21.5 ms under load; they are not offered as a replacement.

## Test suite

`npm test` at HEAD with this log in its revised form, 2026-11-25, same machine, exit 0: first phase 2386 tests, 2382 pass, 0 fail, 4 skipped, duration_ms 50459.6; latency phase (`latency budget: …`, run one file at a time) 5 tests, 5 pass, duration_ms 11870.9.

## Appendix: measuring scripts and raw output

The tables above can be recomputed from this. The runs were made in this order: `out.txt` (set one), `out2.txt` (set two), `out3.txt` (lint-touched runs), then `cpu-out.txt`. A first CPU attempt used a loop that did not split its arguments in zsh, ran nonexistent script paths and printed errors; it was discarded and is not reproduced.

### measure.mjs (as run for sets one and two: `node measure.mjs <checkout> <before|after>`)

```
// usage: node measure.mjs <checkout> <before|after>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [checkout, which] = process.argv.slice(2);
const HEAD = '/home/kinghian/orca/workspaces/kh-harness/stage0-hook-merge';
const { addedLatency } = await import(HEAD + '/scripts/lib/latency-fixtures.mjs');
process.env.KH_DATA_DIR = mkdtempSync(join(tmpdir(), 'hk-measure-data-'));
process.env.HK_MARKER_DIR = mkdtempSync(join(tmpdir(), 'hk-measure-marks-'));
const { setEnabled } = await import(checkout + '/assets/scripts/harness-log.mjs');
const root = mkdtempSync(join(tmpdir(), 'hk-measure-repo-'));
mkdirSync(join(root, '.git'));
setEnabled(root, true);
const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
const call = { session_id: 'measure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' };
const rows = which === 'before' ? [
  ['PreToolUse', 'tool-gate.mjs'], ['PreToolUse', 'session-log.mjs'],
  ['PostToolUse', 'session-log.mjs'],
  ['PostToolUseFailure', 'loop-watch.mjs'], ['PostToolUseFailure', 'session-log.mjs'],
] : [
  ['PreToolUse', 'dispatch-pre-tool.mjs'], ['PostToolUse', 'dispatch-post-tool.mjs'], ['PostToolUseFailure', 'dispatch-tool-failure.mjs'],
];
for (const [event, script] of rows) {
  const stdin = JSON.stringify({ ...call, hook_event_name: event, error: 'Exit code ' + Math.random() });
  const { summary } = addedLatency({ runHookOnce: () => spawnSync(process.execPath, [checkout + '/assets/scripts/' + script], { input: stdin, env }), stdin, env, pairs: 40 });
  console.log(which, event, script, '—', summary);
}
```

### measure-lint.mjs (as run for the lint-touched rows: `node measure-lint.mjs <checkout> <before|after>`; it is measure.mjs with its before rows reduced to the lint-touched row and its other rows blanked by sed)

```
// usage: node measure.mjs <checkout> <before|after>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [checkout, which] = process.argv.slice(2);
const HEAD = '/home/kinghian/orca/workspaces/kh-harness/stage0-hook-merge';
const { addedLatency } = await import(HEAD + '/scripts/lib/latency-fixtures.mjs');
process.env.KH_DATA_DIR = mkdtempSync(join(tmpdir(), 'hk-measure-data-'));
process.env.HK_MARKER_DIR = mkdtempSync(join(tmpdir(), 'hk-measure-marks-'));
const { setEnabled } = await import(checkout + '/assets/scripts/harness-log.mjs');
const root = mkdtempSync(join(tmpdir(), 'hk-measure-repo-'));
mkdirSync(join(root, '.git'));
setEnabled(root, true);
const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
const call = { session_id: 'measure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' };
const rows = which === 'before' ? [
  
  ['PostToolUse', 'lint-touched.mjs'],
  
] : [
  ['PreToolUse', 'dispatch-pre-tool.mjs'], ['PostToolUse', 'dispatch-post-tool.mjs'], ['PostToolUseFailure', 'dispatch-tool-failure.mjs'],
];
for (const [event, script] of rows) {
  const stdin = JSON.stringify({ ...call, hook_event_name: event, error: 'Exit code ' + Math.random() });
  const { summary } = addedLatency({ runHookOnce: () => spawnSync(process.execPath, [checkout + '/assets/scripts/' + script], { input: stdin, env }), stdin, env, pairs: 40 });
  console.log(which, event, script, '—', summary);
}
```

### cpu.sh

```
#!/usr/bin/env bash
# usage: cpu.sh <checkout> <script|bare> <event>  -> mean user+sys CPU ms per process over N runs
checkout=$1; script=$2; event=$3; N=200
export KH_DATA_DIR=$(mktemp -d) HK_MARKER_DIR=$(mktemp -d)
root=$(mktemp -d); mkdir "$root/.git"
CHECKOUT=$checkout ROOT=$root node --input-type=module -e "const {setEnabled}=await import(process.env.CHECKOUT+'/assets/scripts/harness-log.mjs'); setEnabled(process.env.ROOT,true)"
export CLAUDE_PROJECT_DIR=$root
printf '{"session_id":"cpu","hook_event_name":"%s","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"t1","error":"Exit code 1"}' "$event" > "$root/in.json"
if [ "$script" = bare ]; then cmd=(node -e 0); else cmd=(node "$checkout/assets/scripts/$script"); fi
TIMEFORMAT='%U %S'
t=$( { time (for ((i=0;i<N;i++)); do "${cmd[@]}" < "$root/in.json" >/dev/null 2>&1; done) ; } 2>&1 )
echo "$event $script $t" | awk -v n=$N '{printf "%s %s cpu %.1f ms/process (user %.1f + sys %.1f)\n",$1,$2,($3+$4)/n*1000,$3/n*1000,$4/n*1000}'
```

### cpu-all.sh (run as `bash cpu-all.sh <scratch> <head-checkout>`)

```
#!/usr/bin/env bash
S=$1; H=$2
for round in 1 2 3; do
for spec in "H bare PreToolUse" "B tool-gate.mjs PreToolUse" "B session-log.mjs PreToolUse" "A dispatch-pre-tool.mjs PreToolUse" "H bare PostToolUse" "B session-log.mjs PostToolUse" "A dispatch-post-tool.mjs PostToolUse" "H bare PostToolUseFailure" "B loop-watch.mjs PostToolUseFailure" "B session-log.mjs PostToolUseFailure" "A dispatch-tool-failure.mjs PostToolUseFailure"; do
  read w script ev <<< "$spec"
  case $w in B) co=$S/before;; *) co=$H;; esac
  echo "r$round $(bash $S/cpu.sh $co $script $ev)"
done; done
```

### Wall-clock set one (out.txt)

```
## 17:40:05 load 30.48 22.17 14.81 before
before PreToolUse tool-gate.mjs — fastest hook run 35.9 ms, fastest bare node start 18.0 ms (medians 91.9 and 52.1 ms) over 40 interleaved pairs
before PreToolUse session-log.mjs — fastest hook run 36.5 ms, fastest bare node start 16.3 ms (medians 85.9 and 42.3 ms) over 40 interleaved pairs
before PostToolUse session-log.mjs — fastest hook run 32.3 ms, fastest bare node start 19.1 ms (medians 90.9 and 59.2 ms) over 40 interleaved pairs
before PostToolUseFailure loop-watch.mjs — fastest hook run 31.1 ms, fastest bare node start 19.4 ms (medians 76.3 and 50.4 ms) over 40 interleaved pairs
before PostToolUseFailure session-log.mjs — fastest hook run 35.0 ms, fastest bare node start 17.2 ms (medians 89.2 and 55.7 ms) over 40 interleaved pairs
## 17:40:32 load 30.52 23.02 15.33 after
after PreToolUse dispatch-pre-tool.mjs — fastest hook run 35.3 ms, fastest bare node start 17.9 ms (medians 96.6 and 58.8 ms) over 40 interleaved pairs
after PostToolUse dispatch-post-tool.mjs — fastest hook run 39.2 ms, fastest bare node start 17.5 ms (medians 98.9 and 60.3 ms) over 40 interleaved pairs
after PostToolUseFailure dispatch-tool-failure.mjs — fastest hook run 37.5 ms, fastest bare node start 17.6 ms (medians 88.5 and 46.7 ms) over 40 interleaved pairs
## 17:40:50 load 32.25 23.88 15.78 after
after PreToolUse dispatch-pre-tool.mjs — fastest hook run 39.4 ms, fastest bare node start 17.2 ms (medians 96.5 and 53.4 ms) over 40 interleaved pairs
after PostToolUse dispatch-post-tool.mjs — fastest hook run 35.1 ms, fastest bare node start 19.6 ms (medians 90.4 and 52.2 ms) over 40 interleaved pairs
after PostToolUseFailure dispatch-tool-failure.mjs — fastest hook run 39.5 ms, fastest bare node start 16.0 ms (medians 96.0 and 52.4 ms) over 40 interleaved pairs
## 17:41:08 load 32.23 24.30 16.04 before
before PreToolUse tool-gate.mjs — fastest hook run 30.1 ms, fastest bare node start 19.2 ms (medians 89.1 and 58.7 ms) over 40 interleaved pairs
before PreToolUse session-log.mjs — fastest hook run 38.8 ms, fastest bare node start 18.6 ms (medians 104.4 and 60.7 ms) over 40 interleaved pairs
before PostToolUse session-log.mjs — fastest hook run 38.1 ms, fastest bare node start 18.9 ms (medians 89.7 and 53.4 ms) over 40 interleaved pairs
before PostToolUseFailure loop-watch.mjs — fastest hook run 29.6 ms, fastest bare node start 19.2 ms (medians 82.7 and 55.7 ms) over 40 interleaved pairs
before PostToolUseFailure session-log.mjs — fastest hook run 63.3 ms, fastest bare node start 40.6 ms (medians 95.8 and 66.5 ms) over 40 interleaved pairs
```

### Wall-clock set two (out2.txt)

```
## 17:48:28 load 11.78 14.12 14.60 before
before PreToolUse tool-gate.mjs — fastest hook run 53.4 ms, fastest bare node start 32.3 ms (medians 80.1 and 50.7 ms) over 40 interleaved pairs
before PreToolUse session-log.mjs — fastest hook run 59.8 ms, fastest bare node start 35.6 ms (medians 107.4 and 58.0 ms) over 40 interleaved pairs
before PostToolUse session-log.mjs — fastest hook run 35.3 ms, fastest bare node start 17.7 ms (medians 46.8 and 24.6 ms) over 40 interleaved pairs
before PostToolUseFailure loop-watch.mjs — fastest hook run 26.1 ms, fastest bare node start 16.2 ms (medians 32.8 and 21.0 ms) over 40 interleaved pairs
before PostToolUseFailure session-log.mjs — fastest hook run 31.5 ms, fastest bare node start 15.7 ms (medians 37.2 and 19.0 ms) over 40 interleaved pairs
## 17:48:49 load 17.92 15.40 15.01 after
after PreToolUse dispatch-pre-tool.mjs — fastest hook run 31.4 ms, fastest bare node start 17.3 ms (medians 43.6 and 22.1 ms) over 40 interleaved pairs
after PostToolUse dispatch-post-tool.mjs — fastest hook run 60.1 ms, fastest bare node start 30.8 ms (medians 107.1 and 58.6 ms) over 40 interleaved pairs
after PostToolUseFailure dispatch-tool-failure.mjs — fastest hook run 40.4 ms, fastest bare node start 24.2 ms (medians 104.8 and 53.6 ms) over 40 interleaved pairs
## 17:49:05 load 19.67 15.88 15.17 after
after PreToolUse dispatch-pre-tool.mjs — fastest hook run 48.8 ms, fastest bare node start 32.9 ms (medians 89.2 and 56.7 ms) over 40 interleaved pairs
after PostToolUse dispatch-post-tool.mjs — fastest hook run 56.9 ms, fastest bare node start 26.5 ms (medians 100.8 and 61.1 ms) over 40 interleaved pairs
after PostToolUseFailure dispatch-tool-failure.mjs — fastest hook run 42.1 ms, fastest bare node start 32.3 ms (medians 100.5 and 61.4 ms) over 40 interleaved pairs
## 17:49:24 load 26.32 17.68 15.78 before
before PreToolUse tool-gate.mjs — fastest hook run 49.1 ms, fastest bare node start 25.1 ms (medians 95.6 and 56.5 ms) over 40 interleaved pairs
before PreToolUse session-log.mjs — fastest hook run 57.6 ms, fastest bare node start 21.7 ms (medians 93.2 and 53.3 ms) over 40 interleaved pairs
before PostToolUse session-log.mjs — fastest hook run 56.5 ms, fastest bare node start 31.7 ms (medians 90.5 and 56.1 ms) over 40 interleaved pairs
before PostToolUseFailure loop-watch.mjs — fastest hook run 53.4 ms, fastest bare node start 33.5 ms (medians 84.2 and 54.9 ms) over 40 interleaved pairs
before PostToolUseFailure session-log.mjs — fastest hook run 48.4 ms, fastest bare node start 27.3 ms (medians 91.5 and 57.4 ms) over 40 interleaved pairs
## 17:49:54 load 32.74 20.13 16.66 before
before PreToolUse tool-gate.mjs — fastest hook run 59.3 ms, fastest bare node start 33.5 ms (medians 100.5 and 57.8 ms) over 40 interleaved pairs
before PreToolUse session-log.mjs — fastest hook run 59.0 ms, fastest bare node start 22.6 ms (medians 97.8 and 57.2 ms) over 40 interleaved pairs
before PostToolUse session-log.mjs — fastest hook run 63.8 ms, fastest bare node start 38.5 ms (medians 98.4 and 63.5 ms) over 40 interleaved pairs
before PostToolUseFailure loop-watch.mjs — fastest hook run 46.1 ms, fastest bare node start 42.5 ms (medians 82.9 and 60.5 ms) over 40 interleaved pairs
before PostToolUseFailure session-log.mjs — fastest hook run 64.5 ms, fastest bare node start 33.8 ms (medians 98.2 and 56.1 ms) over 40 interleaved pairs
## 17:50:25 load 36.56 22.47 17.57 after
after PreToolUse dispatch-pre-tool.mjs — fastest hook run 68.0 ms, fastest bare node start 31.2 ms (medians 103.6 and 59.0 ms) over 40 interleaved pairs
after PostToolUse dispatch-post-tool.mjs — fastest hook run 64.2 ms, fastest bare node start 29.9 ms (medians 116.1 and 66.6 ms) over 40 interleaved pairs
after PostToolUseFailure dispatch-tool-failure.mjs — fastest hook run 88.3 ms, fastest bare node start 36.2 ms (medians 128.2 and 67.1 ms) over 40 interleaved pairs
```

### lint-touched runs, with the matching after lines (out3.txt)

```
## 17:51:03 load 38.07 24.45 18.42
before PostToolUse lint-touched.mjs — fastest hook run 34.9 ms, fastest bare node start 27.4 ms (medians 85.5 and 63.3 ms) over 40 interleaved pairs
after PostToolUse dispatch-post-tool.mjs — fastest hook run 61.7 ms, fastest bare node start 36.3 ms (medians 104.1 and 64.3 ms) over 40 interleaved pairs
## 17:51:30 load 39.74 25.94 19.07
before PostToolUse lint-touched.mjs — fastest hook run 48.0 ms, fastest bare node start 36.2 ms (medians 85.3 and 58.4 ms) over 40 interleaved pairs
after PostToolUse dispatch-post-tool.mjs — fastest hook run 55.3 ms, fastest bare node start 31.2 ms (medians 103.5 and 57.5 ms) over 40 interleaved pairs
## 17:51:56 load 39.81 27.25 19.73
before PostToolUse lint-touched.mjs — fastest hook run 47.3 ms, fastest bare node start 30.3 ms (medians 78.5 and 51.7 ms) over 40 interleaved pairs
after PostToolUse dispatch-post-tool.mjs — fastest hook run 56.4 ms, fastest bare node start 31.4 ms (medians 90.1 and 52.9 ms) over 40 interleaved pairs
```

### CPU rounds (cpu-out.txt)

```
r1 PreToolUse bare cpu 21.1 ms/process (user 14.2 + sys 6.9)
r1 PreToolUse tool-gate.mjs cpu 35.6 ms/process (user 27.4 + sys 8.2)
r1 PreToolUse session-log.mjs cpu 36.6 ms/process (user 28.0 + sys 8.7)
r1 PreToolUse dispatch-pre-tool.mjs cpu 40.1 ms/process (user 30.3 + sys 9.8)
r1 PostToolUse bare cpu 20.1 ms/process (user 13.7 + sys 6.4)
r1 PostToolUse session-log.mjs cpu 36.3 ms/process (user 27.8 + sys 8.6)
r1 PostToolUse dispatch-post-tool.mjs cpu 38.2 ms/process (user 28.8 + sys 9.4)
r1 PostToolUseFailure bare cpu 18.9 ms/process (user 13.0 + sys 5.9)
r1 PostToolUseFailure loop-watch.mjs cpu 30.2 ms/process (user 22.3 + sys 7.9)
r1 PostToolUseFailure session-log.mjs cpu 35.0 ms/process (user 26.8 + sys 8.2)
r1 PostToolUseFailure dispatch-tool-failure.mjs cpu 37.7 ms/process (user 28.6 + sys 9.1)
r2 PreToolUse bare cpu 19.0 ms/process (user 12.9 + sys 6.1)
r2 PreToolUse tool-gate.mjs cpu 32.1 ms/process (user 24.7 + sys 7.4)
r2 PreToolUse session-log.mjs cpu 34.3 ms/process (user 26.5 + sys 7.9)
r2 PreToolUse dispatch-pre-tool.mjs cpu 37.8 ms/process (user 28.9 + sys 9.0)
r2 PostToolUse bare cpu 19.1 ms/process (user 13.0 + sys 6.2)
r2 PostToolUse session-log.mjs cpu 34.7 ms/process (user 26.5 + sys 8.2)
r2 PostToolUse dispatch-post-tool.mjs cpu 37.9 ms/process (user 28.3 + sys 9.6)
r2 PostToolUseFailure bare cpu 19.4 ms/process (user 13.0 + sys 6.4)
r2 PostToolUseFailure loop-watch.mjs cpu 30.7 ms/process (user 22.8 + sys 7.9)
r2 PostToolUseFailure session-log.mjs cpu 37.3 ms/process (user 28.8 + sys 8.5)
r2 PostToolUseFailure dispatch-tool-failure.mjs cpu 40.3 ms/process (user 30.5 + sys 9.8)
r3 PreToolUse bare cpu 20.0 ms/process (user 13.5 + sys 6.5)
r3 PreToolUse tool-gate.mjs cpu 35.2 ms/process (user 26.9 + sys 8.2)
r3 PreToolUse session-log.mjs cpu 36.1 ms/process (user 27.9 + sys 8.2)
r3 PreToolUse dispatch-pre-tool.mjs cpu 39.5 ms/process (user 29.6 + sys 9.8)
r3 PostToolUse bare cpu 20.1 ms/process (user 13.5 + sys 6.6)
r3 PostToolUse session-log.mjs cpu 37.4 ms/process (user 28.8 + sys 8.5)
r3 PostToolUse dispatch-post-tool.mjs cpu 46.8 ms/process (user 35.9 + sys 10.9)
r3 PostToolUseFailure bare cpu 34.2 ms/process (user 22.8 + sys 11.4)
r3 PostToolUseFailure loop-watch.mjs cpu 30.3 ms/process (user 22.5 + sys 7.9)
r3 PostToolUseFailure session-log.mjs cpu 35.0 ms/process (user 27.2 + sys 7.8)
r3 PostToolUseFailure dispatch-tool-failure.mjs cpu 38.7 ms/process (user 29.1 + sys 9.6)
```

