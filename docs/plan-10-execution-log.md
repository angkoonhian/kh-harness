# Plan 10 execution log — one entry script per tool-call event

Preserved from the SDD workspace ledger, per this repository's convention for plans 1–9.

Plan: docs/superpowers/plans/2026-11-25-hook-merge.md
Spec: docs/superpowers/specs/2026-11-25-hook-merge-design.md
Branch: angkoonhian/stage0-hook-merge, base master at eead407.

The ledger below is copied as it stood when this log was written. Task 8's documentation commit (3ca85c3) was still under review then. Test durations were not recorded per task in the ledger; the one suite run this log records is under "Test suite".

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

Task 9: this log, with the latency measurement below.

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

Deferred in the ledger and not fixed. Ledger wording, shortened only where the ledger line was long.

- Task 1: lint-touched.mjs comment above `report` says "ONLY place … builds a result's stderr" though two helpers build `stderr: ''`.
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
- Task 8 (implementer's concerns, review pending): base wording; old example counts '12 proposals' and '35 actions to close 9 capability gaps' left; two skip reasons taken from code, not a live run.
- Pending, not a finding: the Task 8 review has not returned.

## Latency, before and after

What was measured: the time to start one hook script as Claude Code would (`node <script>` with the event payload on standard input), less a bare `node -e 0` start, for the layout at `eead407` (before) and at HEAD `3ca85c3` (after).

- Machine: Linux 7.3.5-2-cachyos, 16 logical CPUs, Node v26.13.1, 2026-11-25.
- The machine was not quiet. A Blender render (about 1100% CPU) and other processes ran throughout; the load average read 11 to 40 during the runs (17:40 to 17:52). The brief asks for a quiet machine; there was none. The fastest-of-40 method discounts load but does not remove it: the fastest bare start differed from run to run between 15.7 and 42.5 ms. Differences of a few milliseconds below are inside that spread.
- Before: a second checkout of `eead407` (`git worktree add --detach <scratch>/before eead407`, removed afterwards). Its scripts are `tool-gate.mjs`, `session-log.mjs`, `loop-watch.mjs`, `lint-touched.mjs`. After: this checkout's `assets/scripts/dispatch-pre-tool.mjs`, `dispatch-post-tool.mjs`, `dispatch-tool-failure.mjs`.
- Every run used the same payloads, one temporary data directory, one temporary repository with the log enabled (`setEnabled(root, true)`), no gate file, and `addedLatency` from `scripts/lib/latency-fixtures.mjs` (40 pairs, hook and bare run alternating which goes first, fastest of each reported). The payload is a `Bash` call `npm test`; the failure payload carries a different `error` text on each run.

### The brief's command, as run

The brief's command spawns `assets/scripts/<script>` relative to the checkout it runs in, and its rows name `dispatch-*.mjs` (which do not exist at `eead407`) beside `tool-gate.mjs`, `session-log.mjs` and `loop-watch.mjs`. Run as written it measures only the layout at HEAD, where the three single scripts still exist but are no longer what an install registers. I changed three things and nothing else:

1. The command is saved as a script, `measure.mjs <checkout> <before|after>`, that takes the checkout directory. It imports `addedLatency` from this checkout and `harness-log.mjs` (for `setEnabled`) from the checkout under test, so the log format is the one that checkout writes.
2. `before` runs the five single-script rows of the brief's eight that exist at `eead407` (`tool-gate.mjs` and `session-log.mjs` on PreToolUse; `session-log.mjs` on PostToolUse; `loop-watch.mjs` and `session-log.mjs` on PostToolUseFailure); `after` runs the brief's three `dispatch-*` rows. The brief's command is otherwise unchanged.
3. The brief measures no lint hook. Because the before layout runs `lint-touched.mjs` on PostToolUse, a sixth `before` row, `lint-touched.mjs` on the same `Bash` payload (which the lint hook does not lint), was run separately with the same method (`measure-lint.mjs`, the same file with the row list reduced to that row).

The measuring scripts are outside the repository (in the session scratchpad); the command text is the brief's, with `spawnSync(process.execPath, [checkout + '/assets/scripts/' + script], ...)` for its `'assets/scripts/' + script`.

### The eight lines

The brief expects eight lines from one run. Five single-script lines come from the `before` checkout and three entry-script lines from HEAD, so each side was run with its own call, `node measure.mjs <before-checkout> before` and `node measure.mjs <HEAD> after`, alternating the two. That was done in two sets: set one ran before, after, after, before (load average 30 to 32 at the start); set two ran before, after, after, before, before, after (load average 12 to 40). The first run of set one, verbatim for its eight lines (the before lines are the first call's, the after lines the second call's):

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

The other nine runs are in the same form. In all, each script was run five times (two in set one, three in set two). For each script, the fastest hook run and the fastest bare start over all five runs of that script (200 pairs):

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

### Wall-clock to start the scripts, fastest of 200 pairs

"Less bare" subtracts the fastest bare start seen in the whole measurement, 15.7 ms, once for each process: two for the before layout, one for the after layout. (The brief says "each also less one bare start"; read literally that subtracts one start from the before sum too, which would count one of the two before processes as free. This log subtracts what each layout starts.)

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

For an edit (`Write` or `Edit`) the lint hook runs the linter. The table does not measure that, because the lint run dominates it; the before figure for an edit is the log hook plus the lint hook's start plus the lint run, and the after figure is the entry script's start plus the same lint run. The lint run is not changed by this plan, and its duration was not measured.

PostToolUseFailure

| | Fastest run, ms | Less bare starts, ms |
|---|---|---|
| Before: loop-watch.mjs + session-log.mjs (26.1 + 31.5) | 57.6 | 26.2 |
| After: dispatch-tool-failure.mjs | 37.5 | 21.8 |

### CPU time per process

Wall-clock under this load mostly measures the load, so CPU time (user plus system) per process was also measured, with bash's `time` keyword over 200 runs of one script with the payload on standard input, output discarded, one temporary repository with the log enabled (`cpu.sh <checkout> <script|bare> <event>`; three rounds, scripts interleaved within a round). The figure includes the fork and exec by bash, which is why a bare `node -e 0` reads about 19 ms of CPU. Means of three rounds (CPU per process, ms):

| Event | Before: first + second | Sum | Less 2 bare | After | Less 1 bare |
|---|---|---|---|---|---|
| PreToolUse | tool-gate 34.3 + session-log 35.7 | 70.0 | 32.0 | 39.1 | 20.1 |
| PostToolUse | session-log 36.1 + lint-touched (not measured) | 36.1 + lint start | not computed | 41.0 | 21.9 |
| PostToolUseFailure | loop-watch 30.4 + session-log 35.8 | 66.2 | 28.4 | 38.9 | 20.0 |

Bare means: 20.0 (PreToolUse), 19.8 (PostToolUse), 24.2 (PostToolUseFailure, one round read 34.2). The PostToolUse "less 1 bare" uses 19.1, the fastest bare round. The per-round figures vary by 3 to 4 ms for one script (for example dispatch-post-tool.mjs read 37.9, 38.2 and 46.8 in its three rounds); the CPU measurement was also run beside the Blender render and the load average read 10 to 30.

### What this shows and does not show

- Each entry script starts one Node process where the before layout started two. Per event the CPU of the two scripts together was about 66 to 70 ms and the entry script's was about 39 to 41 ms, so one process start, about 20 ms of CPU, is saved per PreToolUse and PostToolUseFailure call. That follows from the structure and the CPU rows agree with it.
- An entry script costs more than either single script it replaces: 39.1 against 34.3 and 35.7 ms of CPU on PreToolUse (3 to 5 ms), 41.0 against 36.1 on PostToolUse (the log script alone), 38.9 against 30.4 and 35.8 on PostToolUseFailure. It loads the shared core and both halves' code in one process.
- Wall-clock for the user is not the sum of two processes. As the task brief states, Claude Code starts separate hooks for an event in parallel, so before the user waited for the slower of the two scripts, not their sum: on the fastest figures above, 36.5 ms for PreToolUse (session-log), about 34.9 for PostToolUse (lint-touched) and 31.5 for PostToolUseFailure (session-log), against 31.4, 35.1 and 37.5 ms for the entry scripts. By those figures the entry script is about 5 ms faster on PreToolUse, equal on PostToolUse, and about 6 ms slower on PostToolUseFailure. These are single fastest runs under load and the differences are within the run-to-run spread; the measurement does not show a wall-clock gain or loss on any event. What it shows is lower CPU and fewer processes per call, on a machine with spare cores. Where the machine is busy (as it was here) fewer processes should matter more, but this was not measured separately.
- The PostToolUse figures are for a `Bash` call, where the lint half starts and does not lint. The figures for an edit include a linter run in both layouts, not measured.
- Not measured: the time Claude Code itself takes to start a hook and read its output, a quiet machine, Windows or macOS, a repository with real gates (the measurement used no gate file), a log with a long history, and the lint run.
- The dated comment above the latency tests in `scripts/lib/harness-dispatch.test.mjs` (linux, Node 26.13.1, 2026-11-25: the entry scripts add about 17, 15 and 16 ms over a bare start) was left as it is. It was measured on a quieter machine than this log's; the figures here were taken under load and by the same fastest-minus-bare rule, with each script's own fastest bare start, give 14.2, 17.6 and 21.5 ms: one lower and two higher, which is not a better measurement.

## Test suite

`npm test` at HEAD with this log added, 2026-11-25, same machine, exit 0: first phase 2386 tests, 2382 pass, 0 fail, 4 skipped, duration_ms 50835.2; latency phase (`latency budget: …`, run one file at a time) 5 tests, 5 pass, duration_ms 11434.8.
