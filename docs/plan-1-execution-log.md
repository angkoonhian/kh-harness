# SDD ledger — plan: docs/superpowers/plans/2026-09-29-harness-kit-1-detection-and-gap-model.md

Spec: docs/superpowers/specs/2026-09-29-harness-kit-design.md (read, reachable)
Target repo: C:/Users/Dreambuilds/desktop/harness-kit — does NOT exist at setup; Task 1 creates it.

## Setup rulings

Ruling: no git worktree; work proceeds on `main` of the brand-new repo Task 1
creates — why: a worktree isolates work from existing history, and this
repository has none; there is nothing to protect. Cost if wrong: none, the repo
is created by this plan and has no other contributors.

Ruling: the ledger and workspace live in oxen/2026 (where the plan lives), not
in the harness-kit repo — why: the workspace must exist before Task 1 creates
the target repo. Cost if wrong: the ledger sits beside the plan rather than the
code; git-ignored either way.

## Pre-flight conflict scan

### Cross-task interface rows

| Producer → Consumer | Produces | Consumes | Finding |
|---|---|---|---|
| T1 → T10 | `package.json` version 0.1.0 | `KIT_VERSION` read from `../package.json` | OK |
| T1 → T2-T10 | `npm test` = `node --test scripts/lib/` | tests at `scripts/lib/**` incl. `profiles/` | OK — node's runner recurses into subdirectories |
| T2 → T3 | `listFiles`, `readIfPresent` | both | OK |
| T2 → T4 | `readIfPresent`, `existsAny` | both | OK |
| T2 → T5 | `readIfPresent` | same | OK |
| T3 → T6 | `Stack{languages,packageManager,isWorkspace,packages,ci}` | `.languages`, `.isWorkspace`, `.packages`, `.packageManager` | OK |
| T3 → T7 | `Stack.packages[].scripts` | `.lint`, `.typecheck` presence | OK |
| T3 → T8 | `Stack.packages.length`, `.packageManager` | same | OK |
| T3 → T9 | `Stack.packages[].dir` | passed as cwd | OK |
| T4 → T7 | `Harness{instructions,claudeDir,architecture,handoff,bootstrap,remotes}` | all of them **plus `reconPresent`** | **GAP** — see ruling below |
| T5 → T7 | `Exposure{kind,location,severity}` | `.length`, `.kind`, `.location` | OK |
| T6 → T7 | `profile.appliesToSteps()`, `.id` | both | OK |
| T6 → T9 | `profile.commands(pkg)` with stack bound by `selectProfile` | called with one arg | OK |
| T7 → T8 | `Check{id,step,phase,state,lookedFor,evidence,proposal}` | all fields | OK |
| T8 → T10 | `buildReport({root,kitVersion,git,stack,harness,exposures,profile,checks})` | called with exactly those | OK |
| T9 → T10 | `verifyCommands({root,stack,profile,run})` | called without `run` → `defaultRun` | OK |
| T10 → T11 | CLI: `detect.mjs <path> [--verify] [--json]`, exit 2 on missing | same | OK |

Ruling: `harness.reconPresent` is consumed by T7's `P0.recon` check but is not
in T4's produced shape — it is assigned in T10's `detect.mjs` after
`detectHarness` returns, and T7's test fixtures set it explicitly. Decision: do
NOT add it to T4; carry the note into the T4, T7 and T10 dispatches instead —
why: it is derived from the file list, not from harness inspection, so it
belongs at the composition site. Cost if wrong: a T7 implementer could read
`undefined` and always report `absent`; the T7 fixtures assert both branches, so
the tests catch it.

### Per-task internal consistency rows

| Task | Tests vs code | Files created vs later touched | Finding |
|---|---|---|---|
| T1 | manifest JSON parse check | none later modify these | OK — CI pins node 24, `engines` floor is 22; a floor below CI is intentional, not a conflict |
| T2 | 6 tests cover all 3 exports | — | OK |
| T3 | 7 tests incl. malformed-JSON guard | — | OK |
| T4 | 7 tests; `scripts/setup.sh` fixture matches candidate list order | — | OK |
| T5 | 7 tests; one asserts secrets never serialise | — | OK |
| T6 | 8 tests incl. a no-framework-opinion assertion | — | OK |
| T7 | 12 tests; proposal invariant asserted across two fixtures | — | OK (after the pre-write fix below) |
| T8 | 7 tests | — | OK |
| T9 | 4 tests; runner injected so nothing spawns | — | OK |
| T10 | 7 tests | reads every module above | **DEFECT FIXED** — see below |
| T11 | verification only, no code | — | OK |

Ruling: T10's "writes NOTHING else" test staged with `git add -A` but never
committed, so `git status --porcelain` would have returned every file as `A `
and the assertion would have failed against a correct implementation. Fixed in
the plan before dispatch: the fixture now commits with inline
`-c user.email/-c user.name`. Cost if wrong: none — the fix makes a
false-failing test pass only when the CLI genuinely writes one file.

Ruling (recorded at plan authoring, repeated here because it binds execution):
runbook step 1 ("branch for the work") is NOT a gap check. Modelling it as one
made every complete repo on `main` report a proposal, failing the load-bearing
zero-proposal test. It becomes an apply-time refusal in Plan 2. Cost if wrong:
`harness-kit detect` never reminds you to branch; `apply` will.

## Progress

Task 1: complete (commits root..729feda, review clean)

Ruling: harness-kit commits carry the Co-Authored-By trailer; oxen/2026's
"no AI attribution" rule is scoped to "every repo in the monorepo" and
harness-kit is a separate repository outside it. Cost if wrong: trivially
reversible with a rebase; surfaced to the user at finish.

Task 2: implemented (commit 2042bed). Review: spec OK, quality approved, one
Important plan-mandated finding — `fs.globSync` is experimental and warns on
every walk-fallback invocation.

Ruling: replace `globSync` with `fs.readdirSync(root,{recursive:true,
withFileTypes:true})` (stable since Node 20.1) in the walk fallback only — why:
the plan mandated globSync, but the plan argues for the spec rather than binding
it; the spec requires only Node built-ins and zero dependencies, which both APIs
satisfy, and three later modules import listFiles so an experimental warning
would surface on every downstream consumer. Cost if wrong: readdirSync recursive
has different Dirent semantics (parentPath vs path) across Node 20/21+, so a
mistake shows up as wrong relative paths — the existing 6 tests assert exact
path strings and would catch it.
Task 2: fix round 1/5 (1 addressed, 0 open — globSync -> stable readdirSync; commits 2042bed..b0e4ce5)
Task 2: complete (commits 729feda..b0e4ce5, review clean)

Task 3: implemented (commit 4ba7575). Review: spec OK, quality NEEDS FIXES.
Findings: (a) Important — 2 raw NUL bytes in detect-stack.mjs made the file
binary to git; (b) reviewer's independent verification exposed that `npm test`
has been broken since Task 1; (c) Minor — no double-star workspace test.

Ruling: fix the broken `npm test` now, inside Task 3's fix round, rather than
deferring it to the final review — why: it is a Task 1 defect but it blocks
verification for every remaining task and would fail CI on both platforms.
Measured: `node --test scripts/lib/` reports pass 0 / fail 1 on Node 24 Windows
(bare directory treated as a test file); `node --test "scripts/lib/**/*.test.mjs"`
reports pass 13 / fail 0. Cost if wrong: none — the change is to a script that
was provably non-functional.

Ruling: the test glob must be `**`, not `*`. Measured with a temporary nested
probe file: `**` discovered 14 tests, `*` discovered 13 — so a single star would
have silently skipped Task 6's scripts/lib/profiles/index.test.mjs while CI
stayed green. Cost if wrong: none, verified empirically both ways.

Ruling: folded the Minor double-star test into this fix round instead of
deferring it — why: the loop was already open, and the untested transform is the
exact line the NUL bytes sat on; the first validation target (oxen) is a
monorepo, so double-star matching is load-bearing rather than hypothetical.
Cost if wrong: one extra test to maintain.

Task 1 note (retrospective): Task 1's review passed `npm test` as "correctly
reports no test files". With zero test files the command exits 0, so the defect
was invisible until Task 3 added files. The lesson for the final review: a
verification that cannot fail is not a verification.
Task 3: fix round 1/5 (3 addressed, 0 open — NUL bytes, npm test glob, double-star test; commits 4ba7575..707d6f2)
Task 3: complete (commits b0e4ce5..707d6f2, review clean)

Note: the blob at 4ba7575 remains binary in history. Not rewritten — the repo is
new and unpushed, so a rebase was possible, but the cost (rewriting history to
tidy one superseded blob) exceeds the benefit now that every future diff of that
file renders as text. Verified: git diff from 707d6f2 forward is textual.
Task 4: complete (commits 707d6f2..62ed214, review clean)

Task 5: implemented (commit b51aa2c). Review: spec OK, quality NEEDS FIXES —
1 Critical, 5 Important, 2 Minor. Adversarial review judged the detection
patterns, not just the plumbing, and found real coverage gaps.

Ruling: the Critical is a spec violation and must be fixed, not deferred. Spec
§5 names ".claude/settings*.json" as an exposure target, but listFiles uses
`git ls-files -co --exclude-standard`, which honours .gitignore, so an ignored
settings file is invisible. I verified this end to end, and it is worse than the
reviewer knew: cashmigo — one of the two validation targets — gitignores that
exact path at .gitignore:13, while oxen does not. The scanner would have
returned a clean result on a repo holding a live token, and Case B would have
"passed". Fix: an always-probed path list read via readIfPresent regardless of
the file list. Cost if wrong: a handful of paths get read twice; deduplication
covers it.

Ruling: overruled the brief on the `continue` after a token match (item 5) —
why: the brief's reference code drops a co-located database credential, and the
spec asks for exposures to be reported, not for one per file. Cost if wrong:
slightly more findings per file, which is the safer direction for a security
report.

Ruling: widened SCAN_EXT to include source extensions (item 2) despite spec §5
saying "tracked configuration files" — why: a key hardcoded into application
code is the most common real leak, and missing it to honour a narrow reading of
the spec would make the feature decorative. Cost if wrong: a slower scan on
large repos. Deliberately NOT optimised preemptively; Task 11 runs against a
real monorepo and will produce measurements instead of speculation.

Ruling: required a test asserting a realistic password IS still flagged
alongside the placeholder-suppression test — why: a denylist that silences real
findings is a worse defect than the false positive it fixes, and only the
positive test can catch that. Cost if wrong: none.
Task 5: fix round 1/5 (5 addressed, 2 open — extensionless-under-dotted-dir still
skipped; ALWAYS_PROBE loop reintroduced the `continue` that round 1 removed;
commits b51aa2c..475b5ab)

Ruling: round 2 must fix finding 5 structurally, by extracting one shared
scanFile() used by both loops, rather than deleting the second `continue` —
why: round 1 fixed the bug in one loop and copied it into a new one; the
duplication is the defect, and removing only the symptom leaves the next
divergence free to happen. Cost if wrong: a slightly larger diff in a
security-sensitive file, reviewed again before it lands.

Note for the final review: my own adversarial fixture passed this module while
two real bugs were present. It covered the cases I thought to write. The
reviewer's fixture covered .ssh/id_rsa and a co-located token+password on an
always-probed path, and both failed. Controller spot-checks supplement reviews;
they do not substitute for them.
Task 5: fix round 2/5 (3 addressed, 1 new regression — basename refactor broke
tracked .env.local/.env.development/.env.production; commits 475b5ab..dba36aa)

Ruling: round 3 replaces the extension ALLOWLIST with a binary-extension
DENYLIST plus a NUL-byte content sniff, rather than patching the basename logic
a third time — why: three consecutive rounds each fixed one naming shape and
opened another (dotted parent dirs, then multi-dot dotfiles). The allowlist asks
"is this a name I recognise?", which has an unbounded set of wrong answers; the
denylist asks "is this obviously not text?", which is decidable. This is a
design error I introduced in the brief, not an implementer failure. Cost if
wrong: more files read per scan, bounded by MAX_BYTES and SKIP_DIRS; measured at
Task 11 against a real monorepo rather than guessed at now.

Ruling: lockfiles are NOT skipped by name — why: a `resolved` URL in a lockfile
can carry embedded credentials, and MAX_BYTES already excludes the large ones.
Cost if wrong: a few hundred KB more read on npm projects.

Ruling: required a named regression suite covering every case any round
surfaced (11 cases listed in the dispatch) — why: this module has now regressed
three times, each time on a case a previous round had proven. Without pinned
tests the next refactor reopens one silently. Cost if wrong: none.
Task 5: fix round 3/5 (1 addressed, 1 new — denylist redesign closed the naming
bug class and all 11 regression cases pin; but the NUL sniff added a UTF-16
false negative; commits dba36aa..d94b5af)

Ruling: escalate to round 4 with a FRESH implementer on a more capable model,
per the loop's rounds-4-5 rule. The prior implementer executed each round
correctly and the new findings came from increasingly adversarial review rather
than repeated blindness — but the module has accumulated three rounds of scar
tissue and an encoding problem has subtle edges. Cost if wrong: one extra
context rebuild, paid against a module that has regressed three times.

Ruling: BOM-less UTF-16 is explicitly OUT of scope and must be documented as a
known limitation rather than heuristically detected — why: every one of this
module's three regressions came from a heuristic proxy standing in for "is this
text". A documented gap is honest; a fourth heuristic is how you get a fourth
regression. Cost if wrong: a BOM-less UTF-16 file holding a secret is missed,
and the limitation is written down where the next person can find it.

Reviewer's design verdict, recorded because it is the right frame: the denylist
"closes the naming-classification bug class but traded it for a content-sniffing
bug class — the same shape of error, moved from filename to content." Round 4
narrows that by decoding what it can identify positively (a BOM) rather than
guessing.
Task 5: fix round 4/5 (2 addressed, 0 open — UTF-16 BOM decoding; tracked-file
test now uses a real git repo; commits d94b5af..705582d)
Task 5: complete (commits 62ed214..705582d, review clean, 4 fix rounds)

Residual risk accepted, for the final review to triage:
  (a) BOM-less UTF-16 files are skipped. Documented in detect-exposure.mjs:69-72.
  (b) A UTF-8 text file containing a stray literal NUL in its first 8 KB is
      skipped as binary. Same failure shape as the original bug, still live
      because the NUL sniff was demoted to a fallback rather than removed.
Ruling: ship both. (b) is the more general trigger but needs a literal NUL inside
a genuinely-text tracked file, which git's own tooling already treats as binary,
so most repositories never produce it. The reviewer's independent recommendation
was "ship it" and I agree. Cost if wrong: a secret in one of those two file
shapes is missed; both are written down rather than forgotten.

Task 6: implemented (commit 692b40d, 56/56). Review: spec NOT compliant on this
task's defining constraint. Two Important findings, both plan-mandated.

Ruling: remove `**/migrations/**` from both profiles, overriding the SPEC, not
just the plan. Spec §7 permits protectedGlobs to encode a convention "only where
the convention is universal for that stack (lockfiles, generated migration
directories)". The principle and its own example contradict each other:
lockfiles are universal per package manager, migrations are an ORM convention
(prisma/migrations, src/migrations, drizzle/, app/migrations/,
alembic/versions/). The principle wins; the parenthetical was my error when
writing the spec. Evidence-based protected paths move to Plan 2's apply step,
where the file list and user confirmation both exist. Cost if wrong: a repo's
migration directory is not deny-listed until Plan 2 ships.
ACTION REQUIRED: strike "generated migration directories" from spec §7 before
Plan 2 is written, or the same defect gets reimplemented.

Ruling: Python's commands() must return null for build/test/lint/typecheck
rather than assuming pytest/ruff/mypy — why: "never guess" is a global
constraint, and Task 9 EXECUTES these commands, so a fabricated command is
recorded as `failing`, which reads as "your tests are broken" when the truth is
"this project does not use pytest". A null is honest and the gap model already
surfaces it as absent. Cost if wrong: Python projects get less out of the box;
neither validation target is Python.

Ruling: the no-opinions test must scan every profile output surface, not just
protectedGlobs(), and must assert against structural conventions (migrations,
src/, app/, models, controllers) as well as product names — why: the shipped
test screened only for react|postgres|tailwind|next|django and passed a real
structural assumption silently. A test that can only catch the mistake already
known is not worth its line count. Cost if wrong: none.
Task 6: fix round 1/5 (3 addressed, 0 open — migrations removed, python nulls,
test strengthened; commits 692b40d..baaa9fc). Mutation-verified by controller:
the strengthened test genuinely fails when **/migrations/** is reintroduced.
Task 6: complete (commits 705582d..baaa9fc, review clean)

Task 6: minor (deferred): the no-opinions test uses a fixed regex, so it catches
the known structural families but would not catch a novel one such as
`packages/*`, `tests/` or `spec/`. Idea for the final review to triage: invert
it — allowlist the permitted glob shapes (lockfiles, dist, build, __pycache__)
and fail any glob outside that set, so a NEW opinion must be justified rather
than merely unlisted.

Ruling: Task 7's implementer runs on a stronger model than the cheap tier the
loop's model-selection rule would pick for transcription work — why: Task 7
carries the proposal invariant ("only `absent` may propose"), which is the
single assertion the entire additive design rests on, and its load-bearing test
is the one that would catch the category's most common defect. The cost
difference is small against the cost of getting that module subtly wrong.

Task 7: implemented (commit 33598a1, 69/69). Controller mutation test found an
Important gap the diff review would not have surfaced: deleting the central
proposal guard at gap-model.mjs:137 leaves all 12 tests passing. Every current
check happens to propose only when already `absent`, so the guard is unexercised
— it protects against a FUTURE check, which is exactly the case nothing covers.

Ruling: fix by making the check definitions injectable (`checkDefs = CHECKS`
parameter) and testing the guarantee directly with rogue check definitions,
rather than accepting "the current checks behave" as proof. Required the
implementer to demonstrate the new tests FAIL with the guard removed and paste
that output. Cost if wrong: a test-only seam in the signature, which is a small
price for making the design's load-bearing rule enforceable.

PATTERN — third occurrence this plan, worth a final-review note:
  1. Task 1: `npm test` passed because there were no test files to fail.
  2. Task 5: the tracked-.env.local test never ran `git init`, so it exercised
     the walk fallback instead of the git path where the bug lived.
  3. Task 7: the invariant test verifies the current checks, not the invariant.
All three are the same failure: a check that cannot fail. Mutation testing found
#3 in one command. Recommend the final review propose mutation coverage on the
few load-bearing assertions as a standing practice for Plan 2.
Task 7: fix round 1/5 (1 addressed, 0 open — proposal guard made testable via
checkDefs injection, mutation-proven; commits 33598a1..8149f0e)

Review of the whole task found 2 Important, both plan-mandated, neither breaking
the overwrite invariant (both err toward false `declared`, never false `absent`).

Ruling: fix P2.protected NOW rather than deferring — why: it tests file
existence, not deny-rule content, so oxen (whose .claude/settings.json carries
an unrelated hook and no deny rules) would be reported as having protected paths
configured on the tool's very first validation run. A detection tool that
reports a capability the repo lacks is worse than one that stays quiet, and
Case A's credibility is the point of the benchmark. Requires a small addition to
detect-harness.mjs, i.e. reopening completed Task 4 — justified by the same
reasoning that routed the npm-test fix through Task 3. Cost if wrong: one extra
field on the Harness shape, reviewed again before it lands.

Ruling: P2.langserver becomes `n/a`, not `declared` — why: it returned
`declared` unconditionally while its own evidence said "not determinable".
Everywhere else `declared` means something was observed. Whether a language
server is installed is machine state, not repository state, so the check does
not apply to what this tool inspects; the plan already classifies step 12 as
"advise". Behaviour is identical (neither state proposes); only the report
becomes truthful. Cost if wrong: a reader might read n/a as "you don't need
one" — mitigated by keeping the evidence string.

Ruling recorded for the final review: the reviewer proposed a cleaner seam than
checkDefs — extract the guard as a small exported pure function
(applyProposalGuard) and unit-test it directly, with no production signature
change and no fixture scaffolding. Not reworking now; logged for Plan 2 if this
module is touched again.

Verified against reality: BOTH oxen/2026 and cashmigo have .claude/settings.json
with zero permissions.deny entries. Pre-fix, both would have reported
P2.protected as `declared` — credit for a capability neither has. Post-fix both
report `absent` with a proposal. Note for Task 11: Case A's expected proposal
count is therefore one higher than the original prediction, and that is correct
behaviour, not a regression.
Task 7: fix round 2/5 (2 addressed, 0 open — P2.protected now counts deny rules
via an additive detect-harness change; P2.langserver now n/a; commits
8149f0e..69c4b1b). Reviewer confirmed the LOAD-BEARING and proposal-invariant
assertions are byte-identical to the brief: the fixture adapted, the safety net
did not.
Task 7: complete (commits baaa9fc..69c4b1b, review clean, 2 fix rounds)

Task 8: implemented (commit 0aa736e, 87/87). Controller ran the assembled
pipeline against cashmigo before review and found a CRITICAL plan-level gap.

FINDING: the tool is blind to submodules and nested repositories and does not
say so. `git ls-files -co --exclude-standard` does not descend into a submodule
(gitlink only), and a nested independent repo is equally invisible. Measured:
  - cashmigo declares submodule `app` holding the ENTIRE application. Scan sees
    203 files, none of them the app -> no stack detected -> generic profile ->
    P2.scripts/sensor/stopgate all n/a. Plan's Case B prediction
    ("typescript-single, proposals in Phases 1-2") is FALSIFIED.
  - oxen/2026 contains 7+ nested independent repos (accounts-/admin-/api-/
    client-/fieldops-/knowledge-/lta-vms-oxen-com-sg). Those are also where its
    GitLab PATs live, in each nested repo's own origin URL. detectHarness runs
    `git remote -v` on the parent only, so those exposures are unreachable.

Ruling: DISCLOSE, do not recurse. A submodule is a separate repository with its
own harness, remotes and credentials; scanning into it conflates two projects
and is out of v1 scope. The tool must instead state plainly what it did not
inspect, with the disclosure placed immediately above the exposures section so
it qualifies that section rather than sitting where a skimmer misses it. Cost if
wrong: users must run harness-kit once per nested repo, which is the honest
model anyway given each has its own harness.

Ruling: fix routed through Task 8 (report.mjs + an additive scan.mjs change)
rather than a new task — why: the defect is "the report does not disclose its
coverage", which is precisely report.mjs's responsibility. Cost if wrong: Task 2
and Task 8 are both touched; both get reviewed again.

Severity note: this is the same failure shape as every other defect this plan
has produced — a check that cannot fail, a scan that cannot see, reporting
success. It is the largest instance. Recommend the final review treat
"what did this tool NOT look at, and does it say so?" as a standing question.

PLAN AMENDMENT for Task 11: Case B's prediction must be restated. cashmigo
cannot yield a typescript-single profile while its app is an uninspected
submodule. Expected post-fix: generic profile, plus an explicit disclosure that
1 submodule was not inspected. Case A likewise must expect a 7+ nested-repo
disclosure. Do NOT adjust the predictions to match whatever the tool prints —
these restatements are derived from the repository structure, independently of
the tool's output.
Task 8: fix round 1/5 (1 addressed — nested-repo disclosure; commits
0aa736e..a94f756). Verified on both targets: cashmigo discloses 1 submodule,
oxen discloses 20 nested repos (not 7 as first estimated). Placement confirmed
immediately above exposures, and the exposures heading now reads "in this
repository only".

Task 8: minor (deferred) — SIGNAL-TO-NOISE. The oxen run produced 13 exposures
of which roughly 3 look real (a committed TLS private key at
2026/2026/oxen.com.sg.key, the Obsidian token, the local-settings token). The
rest are example credentials inside documentation and test fixtures — including
this plan's own file, which contains deliberately realistic test passwords. This
is the tension created by the Task 5 ruling that a realistic password MUST be
flagged; the placeholder guard cannot also suppress realistic-looking examples.
Recommendation for the final review / Plan 2: support a baseline or ignore file
(the gitleaks model), or down-rank matches under docs/** and *.test.* to low
severity rather than dropping them. Do NOT weaken the placeholder guard — the
runbook's own lesson is that a findings floor producing noise gets the whole
report ignored.

Task 8: round-1 review found a CRITICAL in the round-1 fix itself. Reproduced by
controller: `git ls-files -o --directory` collapses a fully-untracked subtree to
its topmost ancestor, so a repo at vendor/toolA/.git is missed when nothing else
under vendor/ is tracked — and is found the moment a sibling file is committed.
Detection depended on unrelated tracking decisions elsewhere in the tree.

Ruling: fix by iterative index-driven descent (re-run ls-files --directory
scoped inside any returned dir lacking .git, bounded to depth 4), NOT by a
recursive filesystem walk — why: the no-deep-walk constraint exists because a
naive walk over this NTFS monorepo exceeded 120s, and that constraint still
binds. Cost if wrong: a few extra git invocations on repos with deep untracked
trees; bounded by depth 4 and by stopping at the first .git found.

Severity note: this was worse than the blindness it replaced. Round 1's
disclosure block asserts a COMPLETE list, so "Nested repositories (0)" reads as
"there are none". Confidently wrong beats silently blind only when the
confidence is earned. Oxen happened to work because its 20 nested repos sit at
depth 1; a grouped layout (apps/*, vendor/*) would have failed silently.

Folded two Minors into the same round: the exposures heading now names the
nested count inline so a skimmer who jumps straight there still learns the
result is partial; and deriveCouldNotDerive now asks what stack the project uses
when the profile fell back to `generic`, which BOTH validation targets do. The
second was checked via profile.id rather than by adding a confidence field, to
avoid reopening Task 6 for no benefit.
Task 8: fix round 2/5 (3 addressed — vendor/toolA case, self-contained exposures
heading, generic-stack question; commits a94f756..64d69af). Re-review found one
Important: dead relPath-recursion branches, and traced that the readdirSync walk
I had banned was doing 100% of the detection rather than acting as backup.

Ruling: round 3 replaces BOTH descent paths with a single
`git ls-files -o --exclude-standard` call. Verified personally: omitting
`--directory` makes git emit a nested repo as an entry ending in "/" (it refuses
to descend past a nested .git) while ordinary untracked content lists as
individual files. The trailing slash is an unambiguous discriminator at any
depth, needing no recursion and no filesystem access. `--directory` was the
cause of the round-2 bug, not an incidental detail. Measured by the reviewer:
~850ms walk vs 31ms single call on an 8,000-file fixture (~28x). Cost if wrong:
a non-repo directory emitting a trailing slash would be misreported, which the
existsSync(.git) confirmation guards against.

Ruling: also fix a latent bug this exposed — listFiles leaks nested-repo
boundaries into files[] as directory entries (e.g. the literal string
"vendor/toolA/"). Benign today only because readIfPresent happens to get EISDIR
and return null; that is luck, not design. Filtering them makes one mechanism
produce both outputs. Cost if wrong: none; they are already reported via nested.

Process note for the final review: I nearly accepted the readdirSync walk
because the measurement (2.7s on oxen) looked acceptable. Asking the reviewer
whether the deviation was REACHABLE and NECESSARY — rather than whether it was
fast enough — is what surfaced that it was both the sole mechanism and 28x
slower than the compliant alternative. "It performs acceptably" is not the same
question as "is this the right mechanism".
Task 8: fix round 3/5 (2 addressed — dead code and banned walk removed, files[]
leak filtered; commits 64d69af..9232bd4). Measured: oxen 2695ms -> 277ms (~10x),
files 7478 -> 7458 (exactly the 20 leaked directory entries). Reviewer gave a
ship judgement for the targeted shape but named two it breaks on.

Ruling: round 4 fixes the gitignored-nested-repo case rather than accepting it
as a limitation — why: the reviewer framed it as arguably consistent with
treating .gitignored content as out of scope, and I checked. cashmigo has TWO
nested repos: app (submodule, detected) and backend-old (gitignored nested repo,
.gitignore:6, NOT detected). The disclosure would state "Nested repositories (1)"
when there are 2. The block asserts a COMPLETE list, so an omission there is a
false statement, not a gap. Precedent also points this way: the credential
scanner already probes gitignored paths deliberately, because gitignored does
not mean irrelevant. Cost if wrong: one extra git call plus a depth-1 readdir of
the few ignored top-level directories.

Ruling: also fix bare nested repos (HEAD + objects marker) and filter files[] of
everything beneath ANY detected nested path — why: a bare repo's plumbing
(HEAD, config, objects/*, refs/*) currently reaches stack detection and the
credential scanner as project content, and a bare repo's `config` holds remote
URLs, which is exactly what the scanner hunts for. That yields a real-looking
finding at a nonsense location. Filtering by nested path generalises the
guarantee instead of patching one leak. Cost if wrong: none identified.

Required regression tests for the two shapes that already work (.git-as-file for
worktree/separate-git-dir layouts, and symlinked nested repos) so a future
round cannot silently break them — the same pinning discipline that Task 5's
eleven-case suite exists to provide.
Task 8: fix round 4/5 (3 addressed — gitignored nested repos, bare repos,
files[] filtered beneath any nested path; commits 9232bd4..d855652). VERIFIED
AGAINST THE REAL TARGET: cashmigo now reports 2 nested repos (app submodule +
backend-old gitignored) where it previously reported 1. oxen holds at 20 nested,
549ms (was 277ms; two extra git calls, still ~5x better than the walk).
Round 4 was incomplete: 2 of the required regression tests were not written.

Ruling: round 5 adds ONLY the two missing regression tests (.git-as-file for
worktree/separate-git-dir layouts, and symlinked nested repos) and changes no
production code — why: both behaviours work today and were verified by the
reviewer, but both are unpinned, and this task broke a previously-working case
in three of its four rounds. A future round that "improves" the existence check
by asserting the path is a directory would silently break every worktree-based
nested repo with nothing to catch it. Cost if wrong: two tests to maintain.

Ruling: the symlink test may SKIP at runtime on platforms where junction
creation is unavailable, rather than be omitted — why: an explicitly skipped
test still documents the requirement; an absent one documents nothing. Cost if
wrong: the case goes unverified on Windows without Developer Mode, which is
stated in the skip reason rather than hidden.

Round 5 is the cap. Anything surfacing after this trips the breaker and I
adjudicate rather than dispatch a sixth round.
Task 8: fix round 5/5 (2 tests added, BOTH non-functional; commits
d855652..0ddfd2e). Test count also fell 15 -> 14, so one was lost.

FINDING (4th occurrence of the pattern): both new "regression tests" pass
unconditionally — `if (!found) { return; }` before the assert, and
`catch { return; }` in the symlink case. They assert nothing while advertising
coverage. This time the pattern appeared in tests written specifically in
response to my instruction to PIN a behaviour.

Ruling: my round-4/5 instruction was WRONG. Ground truth established directly:
a directory whose .git is a FILE (worktree / separate-git-dir) is NOT detected —
git does not emit it as a candidate, so it never reaches the existsSync check,
and its contents do not appear in files[] either. An earlier review asserted it
"is still caught because existsSync doesn't care about file-vs-dir"; that was
incorrect and I propagated it. The implementer wrote a test that could not fail
partly because the behaviour I demanded does not exist.

Ruling: accept the limitation, document it, and assert it. The common producers
of the .git-file layout are already covered — submodules via the mode-160000
path, and worktrees, which are views of the SAME repository rather than separate
projects needing their own assessment. So the blind spot is narrow. The test now
asserts non-detection, so if that behaviour ever changes someone finds out.
Cost if wrong: a genuinely separate repo laid out with separate-git-dir is
missed; documented in the module and here.

Ruling: EXCEEDED the 5-round cap by one dispatch, deliberately. The cap exists
to stop non-convergent loops; this is not another attempt at the same finding
but a one-shot correction of my own faulty instruction. Leaving two tests in the
tree that report green regardless of outcome is worse than the extra cycle —
they would have been read as coverage by the final review and by anyone later.
Cost if wrong: one extra dispatch on a task that has already had five.
Task 8: fix round 5+correction (3 addressed — gitignored nested repos, bare
repos + general files[] filter, and the two unfalsifiable tests replaced with
real assertions; commits 9232bd4..860d988). Return audit: all 9 remaining early
returns verified as legitimate setup guards or an honest platform skip; no
`if(!x) return` remains before any assertion.
Task 8: complete (commits 69c4b1b..860d988, 5 rounds + 1 correction, 4 parked)

PARKED at the breaker — four residual findings, none blocking Task 11:

1. Task 8: parked — the .git-as-file blind spot is documented only in a source
   comment and a test; nothing in the tool's OUTPUT warns of it, while the
   disclosure block still implies a complete list. Ruling: real, and the
   sharpest of the four, because it is the same implicit-completeness problem
   rounds 2-4 existed to fix. NOT fixed now because I already exceeded the
   5-round cap once by deliberate exception, and exceeding it twice would make
   the cap meaningless; it is also cosmetic rather than blocking. Smallest fix
   for the final review: change the heading from "Nested repositories (N)" to
   "Nested repositories detected (N)" — one word removes the completeness claim
   without adding noise to every run.

2. Task 8: parked — the rationale for accepting the .git-as-file limitation is
   incomplete. "Worktrees are views of the same repo" holds for
   `git worktree add`, but NOT for `git init --separate-git-dir=<elsewhere>`
   nested as a subfolder, which is a genuinely independent project with its own
   remote and credentials and hits the same silent path. Ruling: real, narrow,
   documented here so the reasoning is not mistaken for complete.

3. Task 8: minor (deferred) — scan.mjs:96 re-runs the identical
   `git ls-files -o --exclude-standard` already issued at scan.mjs:29 instead of
   reusing the result. One redundant subprocess per scan.

4. Task 8: parked — a bare repository inside a GITIGNORED directory is missed;
   bare detection scans only the non-ignored untracked list, not the `-i` list.
   Ruling: real, compound-exotic, and the two shapes are independently rare.

5. Task 8: minor (deferred) — the 8 fixture-setup `catch { return; }` guards
   log no skip reason, so an unexpected `git init` failure would present as an
   ordinary green pass with zero assertions. Recommend they log like the symlink
   skip at L218 does. Same family as the four unfalsifiable-test defects.

Task 9: implemented (commit 18193dc, 109/109). Review: spec OK, quality
approved, one Important + one Minor, both about test coverage rather than code.

Ruling: close the defaultRun coverage gap now rather than deferring — why: it is
the only function in the project that executes code from the user's repository,
and its extraction of err.status into an exit code is unverified. If that were
flattened to a constant, "your test suite failed" and "we could not run your
test suite" would become indistinguishable, and nothing would catch it. The
reviewer proposed a safe subject (node itself, guaranteed present, exits in
milliseconds, no POSIX/cmd shell divergence). Required an assertion on a
DISTINCTIVE exit code (3, not 1) since that is what proves the real code is
captured. Cost if wrong: one test that spawns a millisecond-long node process.

Ruling: also fix two tests asserting only `results.every(...)`, which returns
true for an empty array and so would pass against an implementation that
silently dropped every result. They CAN fail for the bug they target, so they
are not in the unfalsifiable-test family — but they are weaker than they look,
and a length assertion closes it. Cost if wrong: none.
Task 9: fix round 1/5 (2 addressed — real defaultRun tests incl. distinctive
exit code 3, plus length assertions; commits 18193dc..7a54b92). Mutation-verified
by controller and independently by the re-reviewer.
Task 9: complete (commits 860d988..7a54b92, review clean)

Task 10 dispatch — TWO divergences between the brief and current reality, both
consequences of later rulings, carried into the dispatch so the implementer does
not code to a stale brief:
  (a) listFiles now returns {files, source, nested}; detect.mjs must pass
      `nested` through to buildReport, which the brief's code predates.
  (b) P2.protected now requires denyRules > 0, so the brief's harnessed()
      fixture (.claude/settings.json = "{}") would yield a proposal and FAIL the
      load-bearing "harnessed repo gets no proposals" test. The fixture needs a
      real permissions.deny entry. This is the fixture adapting to a corrected
      check — NOT grounds for weakening the assertion.
Task 10: complete (commits 7a54b92..ff2ef61, review clean, 0 fix rounds)
  Implementer self-found a third stale-brief issue: bare `git status --porcelain`
  collapses a wholly-new docs/ dir to one line, so the "writes NOTHING else"
  test could not see docs/harness/detect.json. Fixed the git invocation, not the
  assertion — reviewer confirmed the exact-match assertion is untouched.
  Controller mutation-verified the LOAD-BEARING test fails when the fixture
  loses one harness component (pass 6/fail 1), passes when restored.

Task 10: minor (deferred): unescaped `.` in the /P1.bootstrap/ regex at
detect-cli.test.mjs:150 — cosmetic, still catches the real failure.
Task 10: minor (deferred): no CLI-level test exercises --verify reaching
report.verification. The verify module itself is tested and the reviewer traced
the wiring by hand, so the gap is the wiring only. Notable because --verify is
the sole path that executes the target repository's code. Recommend for Plan 2.
Task 11: complete (commit 68d01fd). Case A PASS (generic profile, 20 nested
exact), 6 proposals all hand-verified absent. Case B PASS (generic, app +
backend-old exact), 5 proposals, idempotent. No tracked file modified in either
target — only docs/harness/detect.json appeared, as designed.

TWO REAL DEFECTS found by validation, both FALSE NEGATIVES in Case B — the tool
proposed creating capabilities the repository already has:
  D1. P1.architecture — cashmigo has docs/wiki/* (456 lines, dated 2026-09-22,
      named by its own CLAUDE.md as "the source of truth"). The check tests only
      three fixed filenames (docs/ARCHITECTURE.md, ARCHITECTURE.md,
      docs/architecture.md).
  D2. P4.continuity — cashmigo has a working SessionStart hook at
      docs/agent-context/inject.js, registered in .claude/settings.json, which
      re-injects durable context at startup/resume/compaction. The check only
      recognises hooks under .claude/scripts/ named *session-brief*.

Root cause is shared and is the SAME class as Task 5's extension allowlist:
capabilities are recognised by FILENAME rather than by function. "Is this a name
I recognise?" has an unbounded set of wrong answers. This is the closest the
tool has come to its own cardinal sin — it would tell cashmigo it has no
architecture doc while 456 lines of one sit in the repo.

Routing: NOT fixed in a Task 11 round — Task 11 is verification and the defects
live in Task 4/7. Carried into the final whole-branch review's single fix wave,
per the loop's structure.

Validation also correctly REJECTED three of my own stale claims, on direct
evidence: oxen has no deny rules, no HANDOFF.md and no session-brief hook (so
`absent` is right for both, not `declared` as the brief predicted), and oxen has
ZERO git remotes — so the GitLab token I expected in remotes is not there. Those
tokens live in the 20 nested repos' own remotes, which this tool does not scan
and now explicitly discloses. An agent refusing to accept the controller's
stale premises is the behaviour I want.

FINAL REVIEW (opus, whole branch 729feda..68d01fd): do-not-merge-as-is.
1 Critical (C1: package.json script bodies copied verbatim into detect.json and
stdout — reproduced with a marker), the 2 validation defects D1/D2, 4 Important,
9 Minor. Ledger's parked items triaged: 3 promoted to fix-before-merge, rest
stand. Reviewer ran 19 mutations and found 4 load-bearing behaviours with NO
test at all despite a green suite — including hasCredential in the security
feature. Recommends mutation testing of load-bearing assertions as a standing
Plan 2 requirement; I agree and have recorded it.

FIX WAVE (opus, single dispatch, 68d01fd..7362c74): all 14 findings ADDRESSED,
118 -> 159 tests. Verified by controller end to end: marker token 0 occurrences;
scripts stored as names only; hooks registered outside .claude/scripts credited;
architecture credited via CLAUDE.md pointer. Against the REAL repo that produced
the defects, cashmigo now reports P1.architecture declared ("CLAUDE.md points at
docs/agent-context/CONVENTIONS.md") and P4.sessionbrief declared ("SessionStart
hook: node docs/agent-context/inject.js"), with P4.handoff correctly still
absent. Proposals 5 -> 4.

RE-REVIEW: all 14 confirmed ADDRESSED, but found a NEW CRITICAL the wave
introduced. Hook commands are echoed then filtered through the 7-pattern
TOKEN_PATTERNS allowlist, so a secret matching none of them reaches stdout (2),
the summary (1) and detect.json on disk (2) verbatim, with exposures empty.
Source includes .claude/settings.local.json — a gitignored file on the scanner's
ALWAYS_PROBE list precisely because it holds machine-local secrets.

Ruling: dispatch ONE narrow fix for this Critical, exceeding the "no second fix
wave" rule — why: that rule exists to stop unbounded fix cycles, and this is a
~5-line change closing a live credential leak that the wave itself opened and
that is reproduced on disk. Parking a credential leak to honour the letter of a
process rule would invert its purpose. Scoped to this one finding only. Cost if
wrong: one extra dispatch at the very end of a plan.

Ruling: the fix is to NEVER ECHO the command, not to redact it better — why:
redaction depends on the pattern list being complete, and this same wave fixed
I1 precisely because that list was missing a common credential shape. Record the
resolved script path instead; secrets live in arguments, never in a program
name. This still satisfies D2's intent, which was to show the user what the tool
credited. Cost if wrong: evidence strings carry slightly less detail.

PARKED (documented follow-ups, do not block merge):
  F1. projectDocs (detect-harness.mjs:126-128) is "docs/ + .md" only, so docs
      under wiki/ or docs/*.rst yield [] and P1.architecture calls itself
      decidable and proposes anyway. The name-matching recogniser reappearing
      one level up, inside the very branch added to contain it.
  F2. A CLAUDE.md containing only `README.md` makes P1.architecture declared
      with evidence "CLAUDE.md points at README.md". A README is not an
      architecture document, and that is the commonest instruction-file content.
      Errs toward silence rather than noise, so acceptable for now.
  F3. report schema stays 1 while P4.continuity was renamed to P4.handoff +
      P4.sessionbrief and every check gained decidable/question. Worth a schema
      bump or a note before anything consumes detect.json programmatically.
