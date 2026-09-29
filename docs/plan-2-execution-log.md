# SDD ledger — plan: docs/superpowers/plans/2026-09-29-harness-kit-2-apply-engine.md

Spec: docs/superpowers/specs/2026-09-29-harness-kit-design.md (revised 2026-09-29 after Plan 1)
Repo: C:/Users/Dreambuilds/desktop/harness-kit, branch `feat/apply-engine` off `27fb27d`
Baseline: 161 tests passing, CI green on ubuntu-latest and windows-latest

## Setup rulings

Ruling: work proceeds on a new branch `feat/apply-engine`, unlike Plan 1 which
ran on the default branch — why: Plan 1's repo was brand new with no history and
nothing to protect. It now has 36 commits and a remote, and Plan 2's own Global
Constraints make `apply` refuse to write on a default branch. Executing this
plan on `master` would contradict the rule the plan itself is implementing.
Cost if wrong: one merge at the end.

## Pre-flight conflict scan

### Cross-task interface rows

| Producer → Consumer | Produces | Consumes | Finding |
|---|---|---|---|
| T1 → T5 | `harness.projectDocs`, `check.decidable` | propose reads `c.decidable` | OK |
| T2 → T3 | `sha256` | hashing canonical entry JSON | OK |
| T2 → T5 | `manifest.files[].path` | dedupe against already-written | OK |
| T2 → T6 | `classify(root, manifest, rel)` → 3 states | write gate | OK |
| T2 → T7 | `classify`, `MANIFEST_PATH` | removal gate, manifest deletion | OK — `MANIFEST_PATH` is exported in T2 step 3 and imported by T7's test |
| T3 → T6 | `addHookEntry` → `{settings, patch}` | settings write + manifest patch record | OK |
| T3 → T7 | `revertPatch` → `{settings, reverted}` | revert gate | OK |
| T4 → T5 | `render`, `versionStamp`; `assets/templates/HANDOFF.md.tmpl`; `assets/scripts/session-brief.mjs` | propose reads all three | OK |
| T5 → T6 | `Proposal{kind,path,contents,event,entry,step,checkId,reason}` | apply switches on `kind` | OK |
| T5 → T8 | `BRIEF_PATH` = `.claude/scripts/session-brief.mjs` | lifecycle asserts that exact path | OK |
| T6 → T7 | `ApplyResult.manifest` | uninstall's input | OK |
| T6 → T8 | CLI `apply.mjs <repo> [--yes] [--allow-default-branch] [--allow-dirty]` | lifecycle invokes all four forms | OK |
| T7 → T8 | CLI `uninstall.mjs <repo> [--yes]` | lifecycle invokes `--yes` | OK |
| Plan 1 → T5 | `harness.claudeDir.hookEvents` | propose skips an already-registered hook | OK — shipped in Plan 1's fix wave |

### Per-task internal consistency rows

| Task | Tests vs code | Finding |
|---|---|---|
| T1 | 3 tests; fixtures set `projectDocs` explicitly | OK |
| T2 | 8 tests incl. corrupt manifest and deleted file | OK |
| T3 | 7 tests; the index-vs-hash test is the load-bearing one | OK |
| T4 | 8 tests across render + the shipped hook script | OK |
| T5 | 8 tests; the decidability gate has its own | OK |
| T6 | 9 tests; two REFUSES tests plus an allowlist pair | OK |
| T7 | 7 tests; plan/run split so planning is provably read-only | OK |
| T8 | 3 tests; stage 4 closes the loop | OK |
| T9 | validation only, no unit tests | OK by design |

Scan clean. Two notes carried into dispatches rather than treated as conflicts:

Ruling: T6's `ApplyResult` documents `skipped`, `redirected` and `manifest`
alongside `written`/`patched`. The plan's original interface line omitted
`skipped` while its own tests asserted on it; corrected during plan self-review
before execution. Cost if wrong: none, caught pre-flight.

Ruling: T1 widens `projectDocs` to documentation anywhere in the repo. This can
only move a check from decidable to undecidable, never the reverse, so it can
only REMOVE proposals — it cannot cause a write. Carried into the T1 dispatch so
the implementer knows the direction is one-way. Cost if wrong: a repo with docs
in an unusual place gets a question instead of a proposal, which is the intended
failure direction.

## Progress

Task 1: implemented (commit 18fd042, 161 -> 169 tests).

FINDING, and it is mine: the brief's Step-1 tests PASSED against unmodified
code. They set `projectDocs` directly on the harness fixture, so the fixture
supplied the answer the code was supposed to compute — the bug was entirely in
detect-harness.mjs's collection, never in the decidability policy the tests
exercised. That is the eighth occurrence of "a verification that cannot fail" in
this project, and the first one I authored.

The implementer caught it unprompted and added detect-harness-level plus
full-pipeline (detectHarness -> buildGaps) tests to obtain genuine pre-fix
failures. Controller-verified: reverting the collection to docs/ + .md fails 4
tests including both end-to-end F1 reproductions; the brief's own three tests
would have caught none of them.

Ruling: accept the implementer's deviation from the brief's test list — why: the
brief's tests were unfalsifiable against the real defect, and writing to the
brief exactly would have shipped the fix with no evidence it worked. An
implementer that notices its instructions cannot detect the bug, and says so,
is doing the job the instructions were for. Cost if wrong: 5 extra tests.

Ruling: accept the generalised P1.architecture question wording and the one
pre-existing test updated for it — why: the old wording hardcoded "docs/ holds N
markdown files", which becomes false once documentation can live elsewhere in
other formats. A question that misdescribes what was found is worse than none.
Cost if wrong: one test regex changed, visible in the diff.
Task 1: complete (commits 27fb27d..18fd042, review clean, 169 tests)
  Reviewer independently reproduced the mutation: exactly 4 failures, and the
  brief's own 3 tests did NOT fail — confirming they were unfalsifiable against
  the real defect. One-way widening confirmed by inspection: PROJECT_DOC_EXTENSIONS
  is a strict superset and the only consumer routes to decidable:false, so growth
  can flip propose->ask but never the reverse.
Task 1: minor (deferred): `.txt` in PROJECT_DOC_EXTENSIONS means a repo with only
  LICENSE.txt or requirements.txt asks instead of proposing. Fail-safe direction;
  a spurious question, never a wrong "declared".
Task 1: minor (deferred): gap-model's docs.slice(0,3) shows 3 filenames where the
  brief said "up to five". Pre-existing, untouched by this diff.

Task 2: implemented (commit 83990e6, 177 tests). Review: spec OK, quality
approved, two Important findings — both plan-mandated, i.e. my brief's code.

Ruling: hash raw BYTES, not decoded text — why: the reviewer demonstrated two
different byte sequences (41 FF 42 and 41 FE 42) that both decode to the same
replacement-character string and therefore hash identically. A non-injective
hash in a function whose job is "has this changed?" means a replaced file can
read as ours-unmodified, and Task 6 would then overwrite it — precisely the
outcome this module exists to prevent. The fix is strictly stronger with no
downside. Cost if wrong: none identified.

Ruling: `classify` gets its own containment guard, returning 'theirs' for a path
that is absolute or escapes the root — why: Task 6 will add an allowlist, but
this module IS the product's safety property and currently has no defence of its
own, and Tasks 6 and 7 are about to route paths through it. 'theirs' is the safe
answer because it means never touch. Not a throw: the module's contract is that
no exported function throws. Cost if wrong: a legitimate path containing `..`
that resolves inside the root must still work — pinned by its own test.

Informational, from the reviewer, not fixed: git's core.autocrlf could rewrite a
tracked file between apply and a later audit, which would present as drift the
tool did not cause. The module itself does no newline translation (Node's fs
never does), and a genuine byte difference correctly yields ours-modified. The
exposure is external and only on a fresh clone, since the tool writes directly
to the working tree rather than through git. Recorded for the final review.
Task 2: fix round 1/5 (2 addressed — raw-byte hashing, root containment;
commits 83990e6..ac49885)
Task 2: complete (commits 18fd042..ac49885, review clean, 182 tests)
  My suspected prefix bug was WRONG: the guard uses path.relative, which is
  segment-based, so /a/repo vs /a/repo-backup is correctly rejected. Worth
  recording as a case where the cheap-looking fix was already the right one.
Task 2: minor (deferred): an absolute or UNC path in a manifest entry returns
  'ours-modified' rather than the spec's 'theirs'. path.join neutralises such a
  path into a literal in-tree subpath that does not exist, so nothing outside
  the repo is ever read and writes stay blocked — every consumer treats
  ours-modified as "do not touch" too. A labelling gap, not a safety one, and
  manifests are program-generated. Untested; note for the final review.

Task 3: implemented (commit 6463a70, 189 tests). Implementer found and fixed a
SEVERE bug in my brief's reference code, unprompted.

FINDING: the brief's canon() used `JSON.stringify(entry, Object.keys(entry).sort())`
— a replacer ARRAY, which filters properties at EVERY nesting level to only the
named keys. For {hooks:[{type,command}]} that yields {"hooks":[{}]} for ANY
hook, so every patch would have hashed identically. Controller-verified: two
entries with completely different commands produced byte-identical canonical
forms under the brief's code.

Consequence had it shipped: revertPatch's findIndex would have matched the FIRST
same-shaped entry — the user's hook — and deleted it while leaving ours. That is
precisely the disaster the hash identity was introduced to prevent, caused by
the mechanism meant to prevent it. Fixed with a recursive replacer function that
sorts keys at all depths.

Worth recording: my own test `revertPatch removes by hash, not by index` WOULD
have caught this, because it inserts a differently-shaped user entry and asserts
ours is the one removed. The test was well-designed even though the code beside
it was not — which is the argument for writing the adversarial test first and
letting it judge the implementation, rather than trusting reference code.
Task 3: review clean (189 tests). Reviewer independently confirmed the suite
catches the brief's broken canon on its own — the same two tests fail under both
the `idx = 0` mutation and the original replacer-array form. No new test needed
to cover my bug; the one I wrote was already the right shape.

Ruling: fix the one Minor now rather than defer it — revertPatch throws on a
patch missing `.container`. Why: Task 7's uninstall reads settingsPatches
straight from the manifest and passes each to revertPatch, and readManifest
validates schema and the files array but NOT individual patch shapes. A
hand-edited, version-mismatched or truncated manifest therefore crashes
uninstall — the worst place for a crash, since uninstall exists for exactly the
users whose state is already strange. Returning {reverted:false} is also the
correct semantic: a patch we cannot identify is one we must not act on.
Cost if wrong: a guard too strict would stop uninstall working, which is why I
required a test asserting a valid patch still reverts.
Task 3: fix round 1/5 (1 addressed — revertPatch defensive guards; commits
6463a70..24a3c46)
Task 3: complete (commits ac49885..24a3c46, review clean, 195 tests)
  Reviewer wrote "None can fail" about the six new tests, which is the exact
  phrase this project has been bitten by eight times. Controller settled it by
  running the new tests against the PRE-FIX implementation: 3 of 6 fail by name.
  The reviewer meant "no malformed case can throw", not "the tests are vacuous".
  The other 3 pass pre-fix because it happened not to throw on those shapes —
  they exist to catch an OVER-STRICT guard, which is why I required them.

Task 4: implemented (commit c5de57a, 203 tests). Shipped hook verified robust by
the reviewer under adversarial input: directory-as-file, ACL-denied read, 10 KB
binary, and a 50 MB / 500k-line file in 0.22s — all exit 0, no stderr.

Ruling: fix the truncation test, which asserts only a line count and the word
"truncated" — both true of an output containing NO handoff content. Setting
MAX_LINES to 0 would emit a truncation notice briefing the user on nothing, and
the test would pass. Required a boundary assertion (line 59 present, line 60
absent) rather than mere existence, so it fails if MAX_LINES drifts either way.
Cost if wrong: none.

Ruling: accept the cwd behaviour (silent "no HANDOFF.md" from a subdirectory)
rather than walking up to find .git — why: Claude Code runs SessionStart hooks
with cwd at the repository root, so the failing case does not arise, and the
walk-up would be untested complexity in shipped code. But require the assumption
be WRITTEN DOWN in the file that depends on it: the next reader otherwise cannot
tell a considered decision from an oversight. Cost if wrong: a user invoking the
hook by hand from a subdirectory sees "no HANDOFF.md" instead of their file.

Forward-looking, from the reviewer: versionStamp's default comment marker is '#',
which would render as a literal H1 inside a markdown template. Task 5's propose
code passes '<!--' explicitly for HANDOFF, so it is handled — confirm during
Task 5 review rather than assuming.
Task 4: fix round 1/5 (3 addressed — boundary assertions, cwd comment, sharpened
template prose; commits c5de57a..ef38c61)
Task 4: complete (commits 24a3c46..ef38c61, review clean, 203 tests)
  Boundary arithmetic independently confirmed: slice(0,60) includes indices
  0-59, and the truncation notice ("440 more lines in HANDOFF.md") contains no
  "line 60" substring, so doesNotMatch cannot fire for an unrelated reason.

Task 5: implemented (commit ac569e7, 211 tests). Review found 2 Important, one
of them plan-mandated (my reference code).

FINDING (10th of the family, mine): the settings-hook dedupe branch is dead,
broken, AND defended by a fabricated test. It compares hookEvents entries against
the full command string `node .claude/scripts/session-brief.mjs`, but Plan 1's
final fix wave deliberately made hookEvents store only the RESOLVED SCRIPT PATH
— never the command — precisely so secrets in arguments could not leak. So the
comparison can never match real data. It is also unreachable: when state is
`absent`, hookEvents.SessionStart is provably undefined. The test passes only
because it fabricates a shape the real scanner never produces.

Ruling: delete the branch and the unused hasEquivalentHook import rather than
repairing the comparison — why: the real protection already exists one layer up
and is correct (a registered hook makes the check `declared`, so the generator
is never reached). A redundant guard that cannot fire is not defence in depth,
it is a place for false confidence to live. Required the test be REPLACED, not
deleted, by one asserting the mechanism that actually protects users.
Cost if wrong: if the layer above ever stops setting `declared`, nothing in the
generator catches it — but that layer has its own tests.

Ruling: widen the generator contract to gen({kitVersion, harness, root, stack,
checks}) now — why: `root` is in the documented interface and silently dropped,
and Plan 3's per-edit-sensor generator needs stack.packages for per-package lint
commands. As shaped, adding it would mean editing buildProposals' signature and
call site, not just adding a table row. An extension point that requires editing
the extension mechanism is not one. Cheaper now with one consumer than in Plan 3
with several. Cost if wrong: two generators ignore arguments they do not use.
Task 5: fix round 1/5 (2 addressed — dead dedupe branch removed, generator
contract widened; commits ac569e7..b499231)
Task 5: complete (commits ef38c61..b499231, review clean, 212 tests)
  Reviewer confirmed the replacement test CAN fail (mutation turns it red), that
  the upstream registeredHook guarantee is uniform across all three hook checks
  rather than specific to the one I reasoned from, and that Plan 3 can add a
  sensor generator without touching buildProposals. Note: stack.packages carries
  script NAMES only, never bodies — Plan 1's C1 fix — so Plan 3 must construct
  commands by convention (`<pm> run lint`), which is the correct shape anyway.
Task 5: minor (deferred): TEST.contextcheck is test-only scaffolding embedded in
  the production GENERATORS export. Unreachable (no real check carries that id)
  so no functional risk, but it is clutter in the extension point this very fix
  round was meant to make clean. Fold into the final review's fix wave; a test
  should inject its generator rather than production shipping a fixture.

Task 6: implemented (commit 99bd686, 221 tests). Review (opus): spec NOT
compliant — 2 Critical, 5 Important. The file-write path itself survived eight
attack shapes; every defect is around it.

C1: an unparseable .claude/settings.json is SILENTLY DESTROYED. readSettings
swallows the parse error, returns {}, and a fresh file is written — verified end
to end, losing permissions.deny and env. Trailing commas and // comments are
common in hand-edited config. The never-overwrite promise failing, silently, on
the most security-relevant file in the repo.

Ruling: on parse failure write NOTHING and report why:'unparseable' — why: the
tool cannot distinguish "empty settings" from "settings I could not read", and
guessing the first destroys the second. Same treatment for a non-object parse
(C2), which currently reports patched=1 against an unchanged file and records a
manifest entry for a write that never happened. Cost if wrong: a user with
malformed JSON must fix it before the hook can be added, which is the correct
demand.

Ruling on atomicity (I1): applyProposals must not THROW on an I/O failure. Catch,
stop, and return normally with everything written so far recorded, plus a
`failed` entry — then the CLI writes the manifest and exits 2. Why: a mid-batch
EEXIST currently leaves files on disk with the manifest never written, so the
next run classifies them `theirs` and the kit can never update or revert its own
files. A partially applied repo that is ACCURATELY RECORDED is recoverable; one
that is not is not. Cost if wrong: a failed run leaves real files behind, but
they are known and removable.

CONSEQUENCE OF A PARKED MINOR: TEST.contextcheck, which I parked at the end of
Task 5 as harmless clutter, proposes `.context-verified` — a path assertAllowed
refuses — and is therefore a live route to the CLI throwing exit 1 with a raw
stack trace. Parking it was wrong; test scaffolding in a production table is not
merely untidy. Now being removed as part of I2.
Task 6: fix round 1/5 (2 Critical + 5 Important + 3 Minor addressed; commits
99bd686..8be4940)
Task 6: complete (commits b499231..8be4940, review clean, 231 tests)
  Re-reviewer ran ten targeted mutations, one per new test — each killed exactly
  its intended test, no survivors. Recovery explicitly tested: after a partial
  apply, run 2 writes the remainder and run 3 reports no proposals; files are
  re-classified ours-unmodified, never `theirs`. The trap I1 described is gone.
  Containment probed for FALSE rejections too: clean install, `.claude` as an
  in-repo junction, and an in-repo file symlink all proceed correctly.

Task 6: minor (deferred) x4, all for the final review:
  a) An unreadable (EACCES/EISDIR) settings.json and a valid-JSON array both
     report `unparseable`, so a permissions problem is described as bad JSON,
     and JSON.parse's line/column is never surfaced — no locator in a big file.
     This is the real cost of collapsing C1 and C2 onto one tag.
  b) writeFileSync is not atomic: a failure DURING a write leaves a truncated
     file with no manifest entry — I1 reopened in a much narrower form. Consider
     write-temp-then-rename.
  c) `redirected` is recorded before the write, so a failed redirect still
     reports a redirection.
  d) The symlink test uses symlinkSync(...,'file'), which needs Developer Mode
     on Windows; it errors rather than skipping. DIFF_LINE_BAILOUT is untested.

Task 6: parked (out of scope, pre-existing): apply.mjs gates both the
default-branch and dirty-tree refusals on git.isRepo, so a NON-GIT directory
bypasses both. The justification for those guards is that a user must be able to
`git diff` what the tool did — which is exactly what does not hold there. Worth
a warning rather than silent acceptance.

Task 7: implemented (commit b90ba1c, 238 tests). Review: spec NOT compliant —
2 Critical plus an inaccurate mutation claim.

C2 is the one that matters: uninstall REPEATS THE EXACT PARTIAL-FAILURE FLAW
Task 6 had to fix, in mirror image. runUninstall decides whether to delete the
manifest from the pre-computed PLAN, never from what actually happened, and
rmSync failures are swallowed. Reproduced: a removal failed, the file stayed on
disk, and the manifest was deleted anyway — orphaning it with no record it was
ever ours. That is precisely the orphaned configuration this feature exists to
prevent, and it is the single most-cited long-term complaint about tools in this
category.

Ruling: the Task 6 principle applies in reverse. There I ruled that a partially
APPLIED repo which is accurately recorded is recoverable and one that is not is
not; the same holds for a partially UNINSTALLED one. Track real per-file removal
outcomes, delete the manifest only when nothing was kept AND nothing failed,
keep failed entries so they stay attributable and a re-run can finish. Cost if
wrong: a manifest survives with entries for files already gone, which the next
run re-classifies harmlessly.

C1: runUninstall's settings read is unguarded where planUninstall's is guarded,
so a settings file deleted or corrupted between plan and run crashes the CLI
with a stack trace. A crash during UNINSTALL is the worst moment to crash — the
user is already trying to get the tool out.

C3: the implementer's mutation evidence claimed 4 failing tests; reproducing it
gives 3. Noted in the dispatch as mattering beyond bookkeeping: the reason I
require mutation output is that it is checkable, and a claim that does not
survive checking is worth less than no claim.

PATTERN: the same defect class appearing independently in apply and uninstall,
written by different agents from different briefs, suggests it is inherent to
plan-then-act designs rather than an individual lapse. Recommend the final
review check every plan/act pair for "decides from the plan, not the outcome".
Task 7: fix round 1/5 (C2 + C3 addressed, C1 half-done; commits b90ba1c..7815451)
  C2 verified by the reviewer at library level, which my own CLI probe could not
  reach: a genuine rmSync failure retains the manifest, still names the file,
  reports, exits 2 — and a follow-up run finishes and then clears the manifest.
  I said plainly in the dispatch that I had NOT verified exit 2, rather than
  implying otherwise; the reviewer supplied it.

C1 remained open in three parts, and the third is the reason the "hunt for
siblings" instruction was worth giving:
  a) plan.revert patches were not folded into keepPatches on the race, so the
     manifest recorded settingsPatches: [] while our hook was still registered —
     permanently unattributable, since planUninstall only iterates the manifest.
  b) the race exited 0, telling a user (or a script) the uninstall succeeded
     while a hook remained.
  c) the settings WRITE was unguarded, and a failure there throws PAST the
     manifest bookkeeping — undoing C2's per-outcome tracking for the whole run
     from a different code path.

Ruling: fix (c) structurally, not with a third try/catch. Collect outcomes as
the function goes and write the manifest ONCE at the end from those outcomes
alone, with no throw path between the last action and the bookkeeping. Why: three
places can now fail and each must converge on the same record; a function whose
record depends on which line threw will regrow this bug the next time an action
is added. Cost if wrong: a slightly larger refactor in a module with 7 tests.

CONFIRMED PATTERN: "decides from the plan, not the outcome" has now appeared in
apply, in uninstall's removal path, and in uninstall's revert path — three times,
across two modules and two agents. It is inherent to plan-then-act code, not a
lapse. The final review should sweep for it by name.
Task 7: fix round 2/5 (C1a addressed and mutation-killed, C1b addressed for the
reported race, C1c symptom fixed but NOT structurally; commits 7815451..c9203f7)

Round 2 left two open, both found by hunting the CLASS rather than the instance:
  1. writeManifest is itself unguarded, so the "no throw path between actions and
     bookkeeping" comment at uninstall-lib.mjs:92 is false. With the manifest
     read-only, runUninstall throws EPERM: the CLI's generic catch still exits 2,
     but the itemized report is lost and the ON-DISK MANIFEST IS LEFT STALE,
     still listing an already-removed file. The same bug class at the one call
     site the round-2 fix did not cover.
  2. A sibling of C1b: settings replaced mid-race with content that PARSES to a
     falsy value (literal `null`) sets no failure flag, yields why:'unknown', and
     EXITS 0 with our hook still registered. C1b reached through a different door.

Ruling: guard persistence so runUninstall ALWAYS returns its outcome object, with
a manifestWriteFailed flag the CLI reports and exits 2 on — why: a record
claiming a removed file still exists is exactly as misleading as one forgetting a
file was written, and the next run acts on it. Also correct the comment, which
currently asserts something untrue; a comment that lies is worse than none
because it stops the next reader looking.

Ruling: treat any settings parse that yields a non-object exactly as a read
failure — why: apply-lib.mjs already refuses a non-object settings file rather
than guessing, and the two modules must agree or the same input produces
opposite behaviour depending on which command you ran. Also banned why:'unknown'
as reachable: every kept patch must carry a reason a human can act on.

Count for the final review: "decides from the plan, not the outcome" and its
relatives have now been found FOUR times (apply write path, uninstall removal,
uninstall revert, uninstall persistence). Each was found by looking for the class
after fixing an instance. That search is worth institutionalising.
Task 7: fix round 3/5 (both named findings fixed in ONE branch each, both left
open in their SIBLING branch; commits c9203f7..c275355). Plus a new CRITICAL
found by the class hunt.

CRITICAL (5th instance of the class, and the most damaging): the removal loop
never re-classifies. It blindly rmSyncs every path in the frozen plan, so a file
the user edits BETWEEN plan and run is silently deleted, reported as a clean
success, and scrubbed from the manifest. No flag, no warning, no trace. The
tool's central promise is that it never destroys work it did not write; here it
destroys work the user wrote seconds earlier and reports success.

Also open, both siblings of round-3 fixes:
  - the manifest DELETE branch is unguarded (the WRITE branch was fixed)
  - planUninstall still lacks the non-object settings check (runUninstall got it)
  and one new test cannot fail: it asserts field types on a normal run and passes
  with the guard deleted.

Ruling: state the PRINCIPLE rather than patch three sites — planUninstall
produces a HYPOTHESIS, not a decision. The CLI shows a plan and waits for the
user, which is exactly when the world changes. Every action must re-verify its
precondition at the moment of acting, and every outcome must be recorded from
what happened. Why: three defects this round were the same mistake in three
places, and patching them individually reliably produces a fourth. Cost if
wrong: a re-classify per file at removal time, which is a stat and a hash.

Ruling: extract the settings read-and-validate into ONE function shared by
planUninstall, runUninstall and agreeing with apply-lib — why: two copies of a
rule is how they came to disagree, and the array-from-the-start case currently
mislabels the patch `patch-modified`, blaming the user for an edit they never
made. Cost if wrong: one more shared helper.

Round 4 of 5. If round 5 does not converge, the breaker trips and I adjudicate.
Task 7: fix round 4/5 (4 addressed incl. the silent-data-loss CRITICAL; commits
c275355..4997629). Re-classify verified NOT to over-keep: with two files and one
edited after planning, the untouched file was removed and the edit survived.

The systematic enumeration I asked for worked where four rounds of opportunistic
finding had not. It listed all SEVEN decisions runUninstall makes and found that
six now derive from fresh observation and exactly one does not — convergence
evidence rather than "found another".

Sixth and final instance: uninstall-lib.mjs:79 discards revertPatch's `reverted`
flag. A hook revertible at plan time whose command the user edits before the run
is treated as reverted; the manifest is DELETED, the CLI prints "nothing was
left behind" and exits 0. Same class, same outcome, with one aggravation — the
record that would have made the leftover hook attributable is destroyed in the
same breath.

Ruling: round 5 closes both blockers and the two untested flags. Why the flags
matter now rather than as follow-ups: manifestWriteFailed and manifestDeleteFailed
have ZERO assertions anywhere, so rounds 3 and 4's guards are untested, and the
report claimed coverage that does not exist. An unverified guard is the defect
this project has shipped eleven times. Cost if wrong: two tests.

Ruling: narrow the new settingsReadFailed condition — a file-only uninstall with
no patches currently completes perfectly and then prints "hooks remain
registered" and exits 2. A false alarm on a successful run teaches users to
ignore the exit code, which is the one signal four rounds of work made
trustworthy. Cost if wrong: none.

Round 5 is the cap. Anything open after it gets parked with a ruling.
Task 7: fix round 5/5 (commit 5087881) — COMMITTED RED. Two tests failing, the
implementer describing them as needing "alignment". Diagnosed by controller:

  a) `settings array from the start is treated as unreadable` fails because MY
     round-5 instruction was wrong. I said to consider the settings file "only
     when there are patches to revert", but with an array settings file
     planUninstall cannot validate, so the patch lands in keepPatches and
     plan.revert is EMPTY — the emptiness is caused by the very problem we are
     detecting. Correct condition: validate whenever the MANIFEST carries any
     settingsPatches. The false-alarm case I wanted fixed (a manifest with no
     patches at all) is still excluded by that.

  b) `settings write fails after file removal records file as removed` fails
     because the fixture overwrites settings.json WITHOUT our hook, so under
     round 5's correct behaviour revertPatch finds nothing, returns
     reverted:false, and no write is attempted — so the write cannot fail. The
     test was written to force a write failure and instead removed the thing to
     be written. Fixture problem caused by a correct code change.

Ruling: exceeded the 5-round cap by one narrow dispatch, deliberately, for the
second time in this project. Why: the cap exists to stop non-convergent loops,
and this is neither a new finding nor another attempt at an old one — it is a
red suite plus a correction of my own faulty instruction. Parking a broken build
would honour the letter of the rule against its purpose. Cost if wrong: one
dispatch at the end of a task that has had five.

Process note for the final review: "tests need alignment" is not a state to
commit in. A failing test and the code disagree; determining which is wrong is
the work, not a follow-up. Worth an explicit instruction in future briefs.
Task 7: suite green at 244 (commit 024a593). Items 3 and 4 landed correctly
(settingsChanged guard before writing; manifest?.files guarded to match
planUninstall).

BREAKER TRIPPED — adjudicating rather than dispatching a third cap exception.

Task 7: parked — THREE failure flags have zero assertions anywhere:
settingsWriteFailed, manifestWriteFailed, manifestDeleteFailed. The guards
themselves are correct (I verified manifestWriteFailed by hand; the reviewer
verified settingsWriteFailed end to end), so this is missing coverage, not a
broken feature. Routed to the final whole-branch review's single fix wave, where
additive tests carry no design risk.

Task 7: parked — and this one is worse than a missing test. The test named
`settings write fails after file removal records file as removed (C1c)` was
rewritten to delete the .claude directory, which exercises the settings READ
path. Its name still claims the WRITE path. A reader auditing coverage would
conclude the write failure is tested when it is not. A missing test is a known
gap; a misnamed one is a false record. Fix the name and the coverage together.

Ruling: park rather than exceed the cap a third time. Why: I have already made
two deliberate cap exceptions in this project (Plan 1's credential leak, and
this task's red suite). A third would make the cap advisory rather than real,
and these are additive tests against code whose behaviour I have verified by
hand — genuinely follow-up material, unlike a live leak or a broken build.
Cost if wrong: three guards ship unpinned until the final fix wave, and could
regress unnoticed in between.

Task 7: complete (commits 8be4940..024a593, 5 rounds + 1 correction, 4 parked)

Task 8: implemented (commit 343a707, 247 tests). THE LIFECYCLE TEST FOUND A REAL
PRODUCT DEFECT that nine tasks of unit testing missed — which is precisely what
it was written for.

Stage 7: apply never reported drift on a manifest-tracked file, because the
capability check reads `declared` (presence-based) and propose.mjs correctly
never re-proposes a file already in the manifest. So the "apply reports drift and
leaves the edit alone" behaviour I specified in the plan was UNREACHABLE through
the CLI: the proposal filter ran before any drift check could happen. A user who
edited a file the tool wrote got silence. Fixed with a small independent
drift-report pass in apply.mjs using the existing classify(); no other module or
existing test changed. Verified end to end: "kept HANDOFF.md (modified since
harness-kit wrote it — left as-is)" with the edit preserved.

Two fixture deviations, both sound and both explained: the fixture now adds a git
remote (else P4.remote permanently pollutes stage 4's zero-proposal assertion),
and commits between stages 3 and 5 (else apply's own legitimate dirty-tree
refusal blocks the second call — the guard working correctly against the test).

Note for the final review: the Step-5 mutation breaks stage 7 rather than stage
5, because the gap model is presence-based rather than manifest-based by prior
design. Worth confirming that layering is intentional rather than incidental.
Task 8: complete (commits 024a593..343a707, review clean, 247 tests, 0 fix rounds)
  Reviewer verified the drift fix is pure-read (cannot write, cannot flag a file
  that is not ours), correctly placed (propose.mjs is locked by its own test;
  gap-model is presence-only by design), and not duplicating apply-lib's
  'ours-modified' branch — which it confirmed is currently unreachable via the
  real CLI, making this the only live drift path today.
  Both fixture deviations independently verified as not hiding a gap: P4.remote
  has no generator so is permanently unsatisfiable and unrelated to stage 4, and
  apply.mjs checks --untracked-files=no so only the tracked settings patch counts
  as dirty. Stages 4 and 7 demonstrably failed pre-fix (red runs in the report).

Task 8: minor (deferred) x3, for the final review:
  a) apply.mjs's validation-failure catch exits 2 WITHOUT calling reportDrift,
     so already-computed drift is silently dropped on that one path —
     contradicting the fix's own rationale that silent drift is drift the user
     never finds out about.
  b) reportDrift always says "modified" though classify returns 'ours-modified'
     for a DELETED file too. Pre-existing convention, not newly introduced.
  c) Stage 5's no-op guarantee remains MUTATION-UNTESTED: the specified mutation
     cannot reach it, because the gap model is presence-based and propose never
     regenerates once state is `declared`. Confirmed a real layering property
     rather than a rationalisation, but the guard for "a second apply must not
     rewrite" is unexercised.
Task 9: complete (commit 4405132) — ALL NINE STAGES PASS, no defects.
  Controller-verified cleanup: worktree removed, hk-validation branch deleted,
  /tmp/hk-case-c gone, and harness-kit left NOTHING behind in cashmigo. The
  ` M app` entry in cashmigo is a dirty submodule working tree whose files date
  from 2026-06-09 — three months old, pre-existing user work, unrelated.
  Two non-defect surprises correctly diagnosed rather than reported as bugs:
  apply proposed 1 of detect's 4 gaps (only 2 generators exist, matching Plan 2's
  declared scope), and `git worktree add` does not check out gitignored content
  so backend-old had to be copied in to exercise its disclosure — git semantics.

PLAN 2 COMPLETE: 9 tasks, 247 tests, 161 -> 247. Branch feat/apply-engine.
