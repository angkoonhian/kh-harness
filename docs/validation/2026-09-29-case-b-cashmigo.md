# Case B — cashmigo (thin parent repository)

Validated 2026-09-29 against kh-harness HEAD `ff2ef61` (118/118 tests passing at time of run).

## Command

```
node scripts/detect.mjs /c/Users/Dreambuilds/desktop/cashmigo
```

Run from `C:\Users\Dreambuilds\desktop\kh-harness`.

## Corrected prediction under test

The original task brief predicted the `typescript-single` profile for
cashmigo. That was corrected before any run, on structural grounds: cashmigo
keeps its entire application in a git submodule at `app` (`.gitmodules`:
`[submodule "app"] path = app`), which `git ls-files` does not descend into —
confirmed directly (`git ls-files | grep '^app/'` returns nothing) — so no
`package.json` is visible to the detector at all. Corrected prediction:

- profile: **`generic`**
- nested-repository disclosure naming **two** entries: `app` (submodule) and
  `backend-old` (a nested repo, gitignored at `.gitignore:6`, confirmed by
  direct read: `# --- nested repositories: each has its own git; never commit
  them into the parent ---` / `backend-old/`).

## Full summary output

```
kh-harness 0.1.0 — C:\Users\Dreambuilds\desktop\cashmigo
profile: generic   branch: d1-rulings

Phase 0 — Reconnaissance
  [x] P0.inventory       verified
        produced by this run
  [!] P0.security        failing
        credentials-in-doc at docs/audit/2026-09-20/01-backend-security.md
        token-in-tracked-file at docs/audit/2026-09-20/07-cross-cutting-secrets-infra.md
  [ ] P0.recon           absent
      → run the recon prompt to write docs/harness/recon.md

Phase 1 — Legible
  [-] P1.bootstrap       n/a
        not applicable to profile generic
  [~] P1.instructions    declared
        CLAUDE.md (28 lines)
  [ ] P1.architecture    absent
      → run the architecture prompt to write docs/ARCHITECTURE.md
  [ ] P1.pathrules       absent
      → scaffold .claude/rules/ with globs derived from the workspace layout

Phase 2 — Senses
  [-] P2.scripts         n/a
        not applicable to profile generic
  [-] P2.sensor          n/a
        not applicable to profile generic
  [-] P2.stopgate        n/a
        not applicable to profile generic
  [ ] P2.protected       absent
      → create .claude/settings.json with deny rules for protected paths
  [-] P2.langserver      n/a
        not applicable to profile generic

Phase 4 — Continuity
  [~] P4.remote          declared
        origin
  [ ] P4.continuity      absent
        missing: HANDOFF.md, session-brief hook
      → install HANDOFF.md and session-brief hook

Nested repositories (2) — not scanned:
  • app (submodule)
  • backend-old (nested-repo)

Exposures (2) — this repository only; 2 nested repositories not scanned — values are never printed; rotate by hand:
  ! medium credentials-in-doc at docs/audit/2026-09-20/01-backend-security.md
  ! high   token-in-tracked-file at docs/audit/2026-09-20/07-cross-cutting-secrets-infra.md

5 proposals. Nothing has been written except docs/harness/detect.json.

Could not derive — answer these before applying:
  ? This repository contains 2 nested repositories (app, backend-old). Stack detection and credential scanning covered this repository only; each nested repository must be assessed separately.
  ? Stack detection did not reach a decision (confidence below 0.5). What is this project's primary stack? Stack-specific steps were skipped as a result.
  ? No lockfile found, so the package manager is unknown. Confirm which one this project uses.
  ? An instruction file already exists. Which of its rules are decisions that cannot be re-derived from source? Those must survive any regeneration.
```

## Corrected prediction: verdict

- profile `generic`: **matches** (observed: `generic`; confirmed in code —
  `typescriptSingle.confidence()` in `scripts/lib/profiles/typescript.mjs`
  returns `0` whenever `stack.packages.length === 0`, which is exactly the
  case here since no `package.json` is visible from the parent).
- nested-repository disclosure of exactly `app` (submodule) and `backend-old`
  (nested-repo): **matches exactly**.

**PASS** on the corrected prediction.

## Proposal count: 5

`P0.recon`, `P1.architecture`, `P1.pathrules`, `P2.protected`, `P4.continuity`.

Note on "longer list concentrated in Phases 1 and 2": Case A (oxen) produced
6 proposals against the same `generic` profile; Case B produced 5. Both
repositories resolve to `generic`, so both are restricted to the same
9-check subset the profile applies (`appliesToSteps: [1,2,3,4,6,7,11,15,16]`
in `scripts/lib/profiles/generic.mjs`) — the stack-specific Phase 2 checks
(`P2.scripts`, `P2.sensor`, `P2.stopgate`, `P2.langserver`) are `n/a` for
*both* repositories under this profile, not just cashmigo. The one-item
difference (6 vs. 5) is entirely `P4.remote`: oxen has zero git remotes
configured (see Case A record) while cashmigo has `origin`. Case B is
therefore **not** longer than Case A in raw count; it is the same size class,
for a structural reason (both being `generic`) that itself flows from the
corrected profile prediction. This is flagged as a discrepancy against the
"longer list" framing, not a tool defect — it is a downstream, mechanical
consequence of the same correction already applied to both cases, verified
above against the profile-selection code.

## No proposal contradicts the detected stack

`stack.languages` and `stack.packages` are effectively empty for cashmigo
from the parent's point of view (no manifest visible), and the report says so
explicitly via the "Stack detection did not reach a decision" clarifying
question. All 5 proposals are stack-agnostic (`generic` profile, no
`P2.scripts`/`P2.sensor`/`P2.stopgate`/`P2.langserver` proposals were even
attempted). None of the 5 proposals names or assumes a package manager,
build tool, or language — none contradicts the (absent) detected stack.

## Per-proposal hand verification

| Proposal | Hand verification | Result |
|---|---|---|
| `P0.recon` — write `docs/harness/recon.md` | `ls docs/harness/recon.md` → no such file before this run created the directory for `detect.json`. | Genuinely absent. |
| `P1.architecture` — write `docs/ARCHITECTURE.md` | Checked all 3 candidate paths — none exist. **However**: `docs/wiki/00-overview.md`, `01-workspace.md`, `10-frontend.md`, `20-backend-old.md`, `21-backend-new.md`, etc. (456 lines total) already document the workspace layout, per-repo stack, dev/build commands and remotes in detail, dated 2026-09-22, and `CLAUDE.md` line 16 names `docs/wiki/README.md` as "project structure, the source of truth." See defect below. | **Defect — see below.** |
| `P1.pathrules` — scaffold `.claude/rules/` | `ls -la .claude/rules/` → no such directory. Read `CLAUDE.md` in full (28 lines) — no directory-scoped/glob-based rule mechanism is implemented anywhere in it or elsewhere in the repo. | Genuinely absent. |
| `P2.protected` — deny rules in `.claude/settings.json` | Read `.claude/settings.json` directly: its only top-level key is `hooks` (one `SessionStart` matcher). No `permissions` key at all, hence no `permissions.deny` array. | Genuinely absent. |
| `P4.continuity` — install `HANDOFF.md` and a session-brief hook | `HANDOFF.md` / `docs/HANDOFF.md`: confirmed absent — correct half of this proposal. **But** `.claude/settings.json` already registers a `SessionStart` hook (`matcher: "startup\|resume\|compact"`) wired to `docs/agent-context/inject.js`, which reads `docs/agent-context/STATE.md` and `CONVENTIONS.md` and prints them as "AGENT CONTEXT (re-injected by SessionStart hook; treat as current state and standing conventions)" — this is a working session-continuity hook, functionally exactly what "a SessionStart brief hook" describes. See defect below. | **Defect — see below** (HANDOFF.md portion is genuinely absent; the hook portion is not). |

## Defects found (per the task's governing rule: recorded, not explained away)

Both defects share one root cause: the detector's Phase-1/Phase-4 checks use
fixed, narrow path/name allowlists instead of checking what the repository's
own instruction file points to, so they miss real capabilities that exist
under non-canonical names.

1. **`P1.architecture` false-negative.** `detectHarness()` in
   `scripts/lib/detect-harness.mjs` only checks
   `['docs/ARCHITECTURE.md', 'ARCHITECTURE.md', 'docs/architecture.md']`.
   cashmigo's `docs/wiki/` directory (`00-overview.md` through
   `60-glossary.md`, 456 lines, last touched 2026-09-22) is substantive
   architecture/workspace documentation — repo layout, per-path git/stack
   status, dev and build commands, remotes — and `CLAUDE.md` itself points
   new readers there as "the source of truth." The tool proposes writing a
   new `docs/ARCHITECTURE.md` "from template" without ever looking at what
   `docs/wiki/` already contains.

2. **`P4.continuity` partial false-negative.** `harness.claudeDir.hooks` in
   `scripts/lib/detect-harness.mjs` is built from
   `under(files, '.claude/scripts/')` — only files physically located under
   `.claude/scripts/` are ever considered hook candidates, and the
   `P4.continuity` check in `scripts/lib/gap-model.mjs` additionally requires
   the filename to match `/session-brief/`. cashmigo's actual SessionStart
   hook lives at `docs/agent-context/inject.js` and is registered directly in
   `.claude/settings.json`; it is invisible to both filters. The overall
   `P4.continuity` state is still correctly `absent` (because `HANDOFF.md` is
   genuinely missing), but the proposal text — `"missing: HANDOFF.md,
   session-brief hook"` / `"install HANDOFF.md and session-brief hook"` — is
   partially wrong: it asks for a session-brief hook that functionally
   already exists and is already wired into `SessionStart`.

Both are genuine instances of the failure mode this project exists to
prevent (a proposal, or part of one, for a capability the repository already
has), found only by reading the actual registered hook and the actual
instruction file rather than trusting the tool's fixed path list. They are
recorded here rather than rationalized away, per the task's governing rule.
They do not invalidate the corrected structural predictions (profile and
nested-repository disclosure), which are about `listFiles`/`selectProfile`
logic unrelated to these two checks, and both of which were independently
verified against the code (see above) and pass exactly.

## `git status` — proof of no harm

Baseline before any run: `git status --porcelain --untracked-files=all`
showed exactly one line, `M app` (the `app` submodule pointer is already
dirty in the working tree — pre-existing, unrelated to this tool).

After the summary run and both `--json` idempotency runs:

```
$ git status --porcelain --untracked-files=all | grep -v '^??'
 M app
$ git status --porcelain --untracked-files=all | grep 'docs/harness'
?? docs/harness/detect.json
```

The `M app` line is unchanged from the pre-run baseline. The only new item is
the untracked `docs/harness/detect.json`. No tracked file was modified.
**No harm.**

## Idempotency check

```
node scripts/detect.mjs /c/Users/Dreambuilds/desktop/cashmigo --json > b1.json
node scripts/detect.mjs /c/Users/Dreambuilds/desktop/cashmigo --json > b2.json
```

`jq` was not assumed available; compared with a short Node one-liner instead
(parse both, `delete a.generatedAt` / `delete b.generatedAt`, re-stringify
with the same formatting, compare strings):

```
IDEMPOTENT
```

Confirmed: with `generatedAt` excluded, the two `--json` outputs are
byte-identical.

## Verdict

**PASS** on the corrected structural prediction — profile `generic` and the
two-entry nested-repository disclosure (`app`, `backend-old`) both match
exactly, independently confirmed against `.gitmodules`, `.gitignore:6`, and
the `typescript-single` profile's confidence function in code. Idempotency
holds. No tracked file was modified by any run.

**However, 2 of the 5 proposals (`P1.architecture`, and the hook half of
`P4.continuity`) are defects**: they recommend building capabilities that
substantially already exist under non-canonical paths (`docs/wiki/*` and
`docs/agent-context/inject.js` registered as a real `SessionStart` hook).
These are recorded as defects per the task's governing rule rather than
explained away, and are flagged for human decision on whether Phase 1/4
detection should read the instruction file's own pointers (e.g. `CLAUDE.md`
"Start here" list) rather than relying solely on fixed candidate paths.
