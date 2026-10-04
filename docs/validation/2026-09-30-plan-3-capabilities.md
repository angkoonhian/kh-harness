# Validation: Plan 3 (capabilities) against two real repositories

- **Date run:** 2026-10-02
- **Kit version under test:** `kh-harness 0.1.0`
- **Repository / branch / commit:** `kh-harness`, `feat/capabilities`, `7bf0f00`
- **Test suite at that commit:** `tests 615 / pass 614 / fail 0 / skipped 1`, working tree clean
- **Platform:** Windows 11 (10.0.26200), Node v24.0.2, Git Bash
- **Targets:** `oxen/2026/api-oxen-com-sg` (TypeScript), `cashmigo` (generic profile)

This document is the deliverable. It is written so that a reader who was not
present can audit every claim. Every command output quoted below is verbatim
from the run, with one deliberate exception that is named and justified in
[§8](#8-secret-handling-attestation).

---

## 1. Method and the safety constraints it was run under

All three source repositories hold live uncommitted work. `oxen/2026` holds 155
uncommitted files and has **no remote at all** — that work exists on one disk and
nowhere else. The procedure was therefore constrained as follows, and the
constraints were honoured without exception:

- **`git clone --local --no-hardlinks` into the system temp directory.** Not
  `git worktree add`: `worktree add` writes metadata into the *source*
  repository's `.git/worktrees/`, whereas a local clone writes nothing to the
  source at all.
- **No `git checkout`, `git stash`, `git clean`, `git reset`, or any
  branch-switching command was ever run inside a source repository.** Those
  commands were run, repeatedly, inside the throwaway clones only.
- Each source repository's branch, short HEAD and `git status --porcelain` line
  count was recorded before starting and compared after finishing
  ([§2](#2-source-repository-state-before-and-after)).
- `cashmigo`'s `app` submodule was **not** initialised. It is uninitialised at
  source and the established ruling is *disclose, do not recurse*. An empty
  `app/` in the clone is the correct state and is recorded as a disclosure.

Clone provenance:

```
git clone --local --no-hardlinks /c/Users/Dreambuilds/desktop/oxen/2026/api-oxen-com-sg  $TEMP/hk-val-1790941543/api-oxen-com-sg
git clone --local --no-hardlinks /c/Users/Dreambuilds/desktop/cashmigo                   $TEMP/hk-val-1790941543/cashmigo
```

| Clone | Branch | HEAD | `status --porcelain` |
|---|---|---|---|
| `api-oxen-com-sg` | `fix/monitoring-company-join` | `1a19e8d` | 0 lines |
| `cashmigo` | `d4-monetisation-rules` | `ae22c23` | 0 lines |

Both clones checked out the source's own HEAD branch and were clean, which
matters: `apply` refuses to run on a default branch, and refuses to run with
uncommitted changes to tracked files.

`api-oxen-com-sg`'s clone had its `origin` URL restored to the source's own
credential-bearing URL, so that the exposure check was exercised against a real
credential rather than a local path. The URL was copied programmatically and
never printed; see [§8](#8-secret-handling-attestation).

---

## 2. Source-repository state before and after

| Repository | Branch (before → after) | Short HEAD (before → after) | `status --porcelain` lines (before → after) | Remotes (before → after) | `.git/worktrees/` after |
|---|---|---|---|---|---|
| `oxen/2026` (parent) | `feature/knowledge-chatbot` → `feature/knowledge-chatbot` | `68d656c` → `68d656c` | 155 → 155 | 0 → 0 | absent |
| `oxen/2026/api-oxen-com-sg` | `fix/monitoring-company-join` → `fix/monitoring-company-join` | `1a19e8d` → `1a19e8d` | 8 → 8 | 1 → 1 | absent |
| `cashmigo` | `d4-monetisation-rules` → `d4-monetisation-rules` | `ae22c23` → `ae22c23` | 1 → 1 | 1 → 1 | absent |

**Every field is identical before and after. No source repository was
modified.** `.git/worktrees/` is absent in all three, confirming that no
`git worktree add` was ever run against a source — the specific risk the
clone-instead-of-worktree constraint exists to avoid.

Additional post-run confirmations:

```
=== cashmigo submodule still uninitialised? ===
-7cb9600e24a25fd35920000217581b842e96608f app
=== api remote url still intact (redacted)? ===
https://[REDACTED]@gitlab.com/oxen_IT/api-oxen-com-sg.git
```

The leading `-` confirms `app` is still uninitialised at source. The `origin`
URL is intact (redacted here for display only; the redaction is this
document's, not the tool's).

The clone directory was removed:

```
=== removing clones ===
removed: /c/Users/DREAMB~1/AppData/Local/Temp/hk-val-1790941543
ls: cannot access '/c/Users/DREAMB~1/AppData/Local/Temp/hk-val-1790941543': No such file or directory
```

---

## 3. Target A — `api-oxen-com-sg` (TypeScript)

The first genuine TypeScript target this tool has met. Confirmed properties:
`tsconfig.json` present, `package-lock.json` present, 1359 tracked files,
`db/migrations/` present, package name `ost-v2`, and **35 declared script
names** including `lint` and `test` but **no** `typecheck`. It also carries an
existing tracked `CLAUDE.md` of 1025 lines, which the brief did not mention.

### 3.1 Stage-by-stage

| # | Stage | Command | Exit | Result | Evidence |
|---|---|---|---|---|---|
| 1 | detect | `detect.mjs <clone>` | 0 | **PASS** | `profile: typescript-single`, `7 proposals`, `Nothing has been written except docs/harness/detect.json` |
| 2 | dry run | `apply.mjs <clone>` | 0 | **PASS** | `10 proposals`, full diffs printed, `Dry run — nothing written.` Verified on disk: `git status` showed only `?? docs/`; `.claude/`, `HANDOFF.md`, `scripts/bootstrap.sh` all absent |
| 3 | apply | `apply.mjs <clone> --yes` | 0 | **PASS** | 6 `wrote` lines + 4 `patched` lines; manifest records 6 files + 4 settings patches |
| 4 | re-detect | `detect.mjs <clone>` | 0 | **PASS** | all 6 delivered capabilities now `declared`; `1 proposal` remains (`P0.recon`, prompt-gated) |
| 5 | apply again | `apply.mjs <clone> --yes` | 0 | **PASS** | `no proposals — this repository already satisfies every applicable step.`; whole-tree sha256 manifest diff **empty** |
| 6 | edit a generated file, apply | append a line to `scripts/bootstrap.sh`, then `apply.mjs <clone> --yes` | 0 | **PASS** | `kept scripts/bootstrap.sh (modified since kh-harness wrote it — left as-is)`; the hand-written line survived |
| 7 | uninstall (dry) | `uninstall.mjs <clone>` | 0 | **PASS** | plan printed; `Run with --yes to apply.` |
| 8 | uninstall | `uninstall.mjs <clone> --yes` | 0 | **PASS** | 5 removed, 4 patches reverted, 1 kept as `ours-modified`; manifest retained with exactly the kept entry |
| 9 | uninstall after reverting the edit | `uninstall.mjs <clone> --yes` | 0 | **PASS** | `scripts/bootstrap.sh` removed; manifest file deleted |

#### Stage 1 — detect, capability block (verbatim)

```
kh-harness 0.1.0 — C:\Users\DREAMB~1\AppData\Local\Temp\hk-val-1790941543\api-oxen-com-sg
profile: typescript-single   branch: fix/monitoring-company-join

Phase 0 — Reconnaissance
  [x] P0.inventory       verified
        produced by this run
  [!] P0.security        failing
        token-in-remote-url at git remote "origin"
        credentials-in-doc at .env.cp
        [... 65 further credentials-in-doc lines, one per file ...]
  [ ] P0.recon           absent
      → run the recon prompt to write docs/harness/recon.md

Phase 1 — Legible
  [ ] P1.bootstrap       absent
      → create scripts/bootstrap.sh from template
  [~] P1.instructions    declared
        CLAUDE.md (1025 lines)
        1025 lines exceeds the 150-line budget; prune rather than replace
  [~] P1.architecture    declared
        CLAUDE.md points at db/migrations/README.md
  [ ] P1.pathrules       absent
        this repository is not detected as a multi-package workspace (stack.isWorkspace is false) — there is no cross-package split to scope a rule to

Phase 2 — Senses
  [ ] P2.scripts         absent
        ost-v2: missing typecheck
  [ ] P2.sensor          absent
      → install scripts/lint-touched.mjs and register a PostToolUse hook
  [ ] P2.stopgate        absent
      → install scripts/verify-touched.mjs and register a Stop hook
  [ ] P2.protected       absent
      → create .claude/settings.json with deny rules for protected paths
  [-] P2.langserver      n/a
        not determinable from the repository; verify by hand

Phase 4 — Continuity
  [~] P4.remote          declared
        origin
  [ ] P4.handoff         absent
      → create HANDOFF.md from template
  [ ] P4.sessionbrief    absent
      → install scripts/session-brief.mjs and register a SessionStart hook
```

and its advice and questions:

```
7 proposals. Nothing has been written except docs/harness/detect.json.

Advice — reported only; kh-harness will not write these:
  * ost-v2: add "typecheck": "tsc --noEmit" to package.json — derived from a tsconfig.json found in this package's directory or at the repository root

Could not derive — answer these before applying:
  ? An instruction file already exists. Which of its rules are decisions that cannot be re-derived from source? Those must survive any regeneration.
  ? Path-scoped rules apply here, but this repository is not detected as a multi-package workspace, so there is no cross-package split to derive a glob from — are there subdirectories with their own conventions that should each get their own .claude/rules/ file, and if so, what glob should scope each one?
```

#### Stage 2 — the ten proposals, by header

```
kh-harness: 10 proposals for C:\...\api-oxen-com-sg
--- scripts/bootstrap.sh  [P1.bootstrap]
--- .claude/scripts/lint-touched.mjs  [P2.sensor]
--- .claude/scripts/harness-redact.mjs  [P2.sensor]
--- .claude/settings.json (hook: PostToolUse)  [P2.sensor]
--- .claude/scripts/verify-touched.mjs  [P2.stopgate]
--- .claude/settings.json (hook: Stop)  [P2.stopgate]
--- .claude/settings.json (deny rules)  [P2.protected]
--- HANDOFF.md  [P4.handoff]
--- .claude/scripts/session-brief.mjs  [P4.sessionbrief]
--- .claude/settings.json (hook: SessionStart)  [P4.sessionbrief]
Dry run — nothing written. Re-run with --yes to apply.
```

#### Stage 3 — what apply delivered

```
wrote      scripts/bootstrap.sh
wrote      .claude/scripts/lint-touched.mjs
wrote      .claude/scripts/harness-redact.mjs
wrote      .claude/scripts/verify-touched.mjs
wrote      HANDOFF.md
wrote      .claude/scripts/session-brief.mjs
patched    .claude/settings.json (PostToolUse)
patched    .claude/settings.json (Stop)
patched    .claude/settings.json (permissions.deny)
patched    .claude/settings.json (SessionStart)
```

Resulting `.claude/settings.json` (the repository had none before):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/scripts/lint-touched.mjs"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/scripts/verify-touched.mjs"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/scripts/session-brief.mjs"
          }
        ]
      }
    ]
  },
  "permissions": {
    "deny": [
      "Edit(*-lock.json)",
      "Edit(**/migrations/**)"
    ]
  }
}
```

`git status` after apply — note `CLAUDE.md` does **not** appear, so the existing
1025-line instruction file was not touched:

```
?? .claude/
?? HANDOFF.md
?? docs/
?? scripts/
```

#### Stage 5 — idempotence, byte-for-byte

A sha256 of every non-`.git` file in the clone was taken before and after the
second `apply --yes`:

```
kh-harness: no proposals — this repository already satisfies every applicable step.
=== diff of whole-tree hashes across second apply ===
IDENTICAL — byte-for-byte, no file changed
```

The manifest's `installedAt` was also unchanged, so the second run did not even
rewrite its own bookkeeping.

#### Stage 6 — a user edit to a generated file

```
=== apply --yes after user edit ===
kh-harness: no proposals for C:\...\api-oxen-com-sg.
kept       scripts/bootstrap.sh (modified since kh-harness wrote it — left as-is)
=== bootstrap.sh after apply — edit survived? ===
# environment files, or a virtual environment created or activated first?

# VALIDATION EDIT: a user added this line by hand.
```

#### Stages 8 and 9 — uninstall

```
Will remove:
  .claude/scripts/lint-touched.mjs
  .claude/scripts/harness-redact.mjs
  .claude/scripts/verify-touched.mjs
  HANDOFF.md
  .claude/scripts/session-brief.mjs
Will revert settings patches:
  /hooks/PostToolUse
  /hooks/Stop
  /permissions/deny
  /hooks/SessionStart
Will keep:
  scripts/bootstrap.sh (ours-modified)

Removed:
  .claude/scripts/lint-touched.mjs
  .claude/scripts/harness-redact.mjs
  .claude/scripts/verify-touched.mjs
  HANDOFF.md
  .claude/scripts/session-brief.mjs
Kept:
  scripts/bootstrap.sh (ours-modified)
```

The retained manifest afterwards contained exactly the one kept entry and an
empty `settingsPatches` array — an honest record of what could not be removed.
After the edit was reverted, the final uninstall removed `scripts/bootstrap.sh`
and deleted the manifest file.

Residue after a complete uninstall of a repository that had no `.claude/` at
all (see [finding 4](#7-findings)):

```
/c/.../api-oxen-com-sg/.claude          : 2 entries -> scripts/ settings.json
/c/.../api-oxen-com-sg/.claude/scripts  : 0 entries ->
/c/.../api-oxen-com-sg/scripts          : 0 entries ->
/c/.../api-oxen-com-sg/docs             : 1 entries -> harness/
/c/.../api-oxen-com-sg/docs/harness     : 1 entries -> detect.json
```

with `.claude/settings.json` containing `{}`.

### 3.2 Predictions from the brief

| Prediction | Result | Evidence |
|---|---|---|
| `P2.sensor` proposes and delivers (a `lint` script exists) | **PASS** | proposed `lint-touched.mjs` + `harness-redact.mjs` + PostToolUse patch; all three delivered; re-detect `declared` |
| `P2.stopgate` proposes and delivers via the `test` fallback (no `typecheck`) | **PASS** | see rationale quoted below |
| …and its proposal discloses the cost of running the suite at every turn end | **PASS** | `no typecheck script was found, so this falls back to the full test script, bounded at 120s, at the end of every turn (cost scales with the size of the repository, not the size of the edit — a large codebase may see 10-30s added per turn)` |
| `P2.protected` proposes `Edit(**/migrations/**)` from `db/migrations/`, plus the lockfile | **PASS** | `+"Edit(*-lock.json)"` and `+"Edit(**/migrations/**)"` |
| `P2.scripts` advises `typecheck -> tsc --noEmit`, derived from `tsconfig.json`, naming `package.json` | **PASS** | `ost-v2: add "typecheck": "tsc --noEmit" to package.json — derived from a tsconfig.json found in this package's directory or at the repository root` |
| `P1.bootstrap` generates `npm ci` plus `npm run build` and `npm run test` | **PASS** | see `scripts/bootstrap.sh` below |
| 35 script names: no script *body* appears anywhere | **PASS** | see [§6.4](#64-check-4--names-only-script-storage) |

Generated `scripts/bootstrap.sh`, verbatim and in full:

```bash
#!/usr/bin/env bash
# Generated by kh-harness 0.1.0 (runbook step 5). Edit freely — kh-harness will report your changes rather than overwrite them.
set -euo pipefail

npm ci
npm run build
npm run test

# Detection cannot prove any of this — answer above once it is known: does
# a clean checkout here also need database migrations, seed data,
# environment files, or a virtual environment created or activated first?
```

No prediction failed. No prediction was adjusted.

### 3.3 Proposed vs. delivered, both directions

| Capability | Proposed | Delivered | Exact match? |
|---|---|---|---|
| `P1.bootstrap` | `scripts/bootstrap.sh` | `scripts/bootstrap.sh` | yes |
| `P2.sensor` | `.claude/scripts/lint-touched.mjs`, `.claude/scripts/harness-redact.mjs`, `hooks.PostToolUse` patch | same three | yes |
| `P2.stopgate` | `.claude/scripts/verify-touched.mjs`, `hooks.Stop` patch | same two | yes |
| `P2.protected` | `permissions.deny` patch (2 rules) | same patch, same 2 rules | yes |
| `P4.handoff` | `HANDOFF.md` | `HANDOFF.md` | yes |
| `P4.sessionbrief` | `.claude/scripts/session-brief.mjs`, `hooks.SessionStart` patch | same two | yes |

**10 proposed, 10 delivered, nothing extra, nothing missing.**

Correctly *not* proposed, with the reason the tool gave:

| Capability | State | Why not proposed — and is that right? |
|---|---|---|
| `P0.inventory` | `verified` | produced by the run itself. Correct. |
| `P0.security` | `failing` | a disclosure, not something apply can fix. Correct — but see [finding 1](#7-findings). |
| `P0.recon` | `absent` | prompt-gated; requires judgement about this repository. Correct, and deferred to Plan 4. |
| `P1.instructions` | `declared` | an existing `CLAUDE.md` is never overwritten. **Correct and load-bearing** — 1025 lines of the user's own instructions survived every stage untouched. |
| `P1.architecture` | `declared` | already satisfied via `CLAUDE.md` → `db/migrations/README.md`. Correct. |
| `P1.pathrules` | `absent` | not a multi-package workspace, so no glob can be derived. Correct — but it is also raised as a question in the same run; see [finding 8](#7-findings). |
| `P2.scripts` | `absent` | advice only: the tool will not edit `package.json`. Correct, and the right boundary. |
| `P2.langserver` | `n/a` | not determinable from the repository. Correct. |
| `P4.remote` | `declared` | `origin` exists. Correct. |

Nothing was proposed that should not have been.

---

## 4. Target B — `cashmigo` (generic profile)

Confirmed properties: no root `package.json`, an existing tracked `CLAUDE.md`
(28 lines, 1687 bytes, sha256 `31126aa0…c613`), an existing tracked
`.claude/settings.json` carrying the user's own `SessionStart` hook, and an
uninitialised `app` submodule (empty in the clone, as expected).

### 4.1 Stage-by-stage

| # | Stage | Command | Exit | Result | Evidence |
|---|---|---|---|---|---|
| 1 | detect | `detect.mjs <clone>` | 0 | **PASS** | `profile: generic`, `3 proposals`, nested repo disclosed, 5 "could not derive" questions |
| 2 | dry run | `apply.mjs <clone>` | 0 | **PASS** | `3 proposals`; **no `CLAUDE.md` proposal**; `Dry run — nothing written.` |
| 3 | apply | `apply.mjs <clone> --yes` | 0 | **PASS** | 2 `wrote` + 1 `patched` + 1 `note`; `CLAUDE.md` sha256 unchanged; existing hook preserved |
| 4 | re-detect | `detect.mjs <clone>` | 0 | **PASS** | `P4.handoff` and `P4.sessionbrief` now `declared`; `1 proposal` (`P0.recon`) |
| 5 | apply again | `apply.mjs <clone> --yes` | **3** | **PASS (gate fired), surprising** | refused: `refusing to apply with uncommitted changes to tracked files` — caused by its *own* first run. See [finding 3](#7-findings). |
| 5b | apply again, waiving the gate | `apply.mjs <clone> --yes --allow-dirty` | 0 | **PASS** | `no proposals`; whole-tree sha256 diff `IDENTICAL — byte-for-byte` |
| 6 | edit a generated file, apply | append to `HANDOFF.md`, then apply | 0 | **PASS** | `kept HANDOFF.md (modified since kh-harness wrote it — left as-is)`; edit survived |
| 7 | uninstall (dry), with a forged manifest entry | `uninstall.mjs <clone>` | 0 | **PASS** | `Will keep: CLAUDE.md (not-generator-producible)` |
| 8 | uninstall | `uninstall.mjs <clone> --yes` | 0 | **PASS** | `CLAUDE.md` survived **byte-identical**; settings round-tripped |

#### Stage 1 — detect (verbatim, in full)

```
kh-harness 0.1.0 — C:\Users\DREAMB~1\AppData\Local\Temp\hk-val-1790941543\cashmigo
profile: generic   branch: d4-monetisation-rules

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
  [~] P1.architecture    declared
        CLAUDE.md points at docs/agent-context/CONVENTIONS.md
        CLAUDE.md points at docs/agent-context/STATE.md
        CLAUDE.md points at docs/superpowers/plans/2026-09-22-wave0-backend-security.md
        CLAUDE.md points at docs/superpowers/specs/2026-09-22-overhaul-design.md
        CLAUDE.md points at docs/wiki/10-frontend.md
        CLAUDE.md points at docs/wiki/21-backend-new.md
        CLAUDE.md points at docs/wiki/README.md
  [ ] P1.pathrules       absent
        this repository is not detected as a multi-package workspace (stack.isWorkspace is false) — there is no cross-package split to scope a rule to

Phase 2 — Senses
  [-] P2.scripts         n/a
        not applicable to profile generic
  [-] P2.sensor          n/a
        not applicable to profile generic
  [-] P2.stopgate        n/a
        not applicable to profile generic
  [-] P2.protected       n/a
        no tracked protected-path evidence (lockfile, build output, migrations, generated files) found — an untracked or gitignored file of the same kind would not be visible here
  [-] P2.langserver      n/a
        not applicable to profile generic

Phase 4 — Continuity
  [~] P4.remote          declared
        origin
  [ ] P4.handoff         absent
      → create HANDOFF.md from template
  [ ] P4.sessionbrief    absent
        SessionStart hook already registered, but not ours: docs/agent-context/inject.js
      → install scripts/session-brief.mjs and register a SessionStart hook

Nested repositories detected (1) — not scanned:
  • app (submodule)

Exposures (2) — this repository only; 1 nested repository not scanned — values are never printed; rotate by hand:
  ! medium credentials-in-doc at docs/audit/2026-09-20/01-backend-security.md
  ! high   token-in-tracked-file at docs/audit/2026-09-20/07-cross-cutting-secrets-infra.md

3 proposals. Nothing has been written except docs/harness/detect.json.

Could not derive — answer these before applying:
  ? 1 nested repository was detected (app). Stack detection and credential scanning covered this repository only; each nested repository must be assessed separately.
  ? Stack detection did not reach a decision (confidence below 0.5). What is this project's primary stack? Stack-specific steps were skipped as a result.
  ? No lockfile found, so the package manager is unknown. Confirm which one this project uses.
  ? An instruction file already exists. Which of its rules are decisions that cannot be re-derived from source? Those must survive any regeneration.
  ? Path-scoped rules apply here, but this repository is not detected as a multi-package workspace, so there is no cross-package split to derive a glob from — are there subdirectories with their own conventions that should each get their own .claude/rules/ file, and if so, what glob should scope each one?
```

#### Stage 3 — apply, and the existing settings file

```
wrote      HANDOFF.md
wrote      .claude/scripts/session-brief.mjs
patched    .claude/settings.json (SessionStart)
note       .claude/settings.json was reformatted while applying the patch above — its content is unchanged beyond what was listed, but whitespace/indentation may now differ throughout the file (this tool always rewrites it as JSON.stringify(settings, null, 2); it does not preserve the original formatting).
```

`CLAUDE.md` after apply:

```
31126aa047432dfd67a5ba87d7ee51db988967bf5272f9f58a4f88d46e31c613 */c/.../cashmigo/CLAUDE.md
```

— identical to the pre-apply hash. The file was never opened for writing.

The `git diff` of the one tracked file apply did modify shows our hook appended
after the user's, with the user's entry (including its `matcher`) untouched:

```diff
--- a/.claude/settings.json
+++ b/.claude/settings.json
@@ -9,7 +9,15 @@
             "command": "node docs/agent-context/inject.js"
           }
         ]
+      },
+      {
+        "hooks": [
+          {
+            "type": "command",
+            "command": "node .claude/scripts/session-brief.mjs"
+          }
+        ]
       }
     ]
   }
-}
\ No newline at end of file
+}
```

### 4.2 Predictions from the brief

| Prediction | Result | Evidence |
|---|---|---|
| **The existing `CLAUDE.md` is never overwritten** | **PASS** | never proposed at any stage; sha256 `31126aa0…c613` identical before apply, after apply, and after a uninstall driven by a forged manifest entry naming it; `cmp` against a pre-apply copy reported `IDENTICAL` |
| The existing `.claude/settings.json` keeps every key it had | **PASS** | deep-equal and key-order-preserving after a full round trip; see [§6.3](#63-check-3--settingsjson-round-trip) |
| `generic` profile capabilities that cannot be derived **ask** rather than propose | **PASS** | every stack-specific capability reported `n/a` with a stated reason, and five questions were raised under "Could not derive"; zero stack-specific proposals |

No prediction failed. No prediction was adjusted.

### 4.3 Proposed vs. delivered, both directions

| Capability | Proposed | Delivered | Exact match? |
|---|---|---|---|
| `P4.handoff` | `HANDOFF.md` | `HANDOFF.md` | yes |
| `P4.sessionbrief` | `.claude/scripts/session-brief.mjs`, `hooks.SessionStart` patch | same two | yes |

**3 proposed, 3 delivered, nothing extra, nothing missing.**

Correctly *not* proposed:

| Capability | State | Why not proposed — and is that right? |
|---|---|---|
| `P1.instructions` | `declared` | the user's `CLAUDE.md` already exists. **Correct; permanent design.** |
| `P1.architecture` | `declared` | already satisfied by 7 doc pointers out of `CLAUDE.md`. Correct. |
| `P1.bootstrap`, `P2.scripts`, `P2.sensor`, `P2.stopgate`, `P2.langserver` | `n/a` | `generic` profile — the tool cannot derive a lint, test or build command without a manifest, and does not guess. Correct. |
| `P2.protected` | `n/a` | no tracked protected-path evidence. Correct, **and the reason is honest about its own blind spot**: "an untracked or gitignored file of the same kind would not be visible here". |
| `P1.pathrules` | `absent` | not a workspace. Correct; see [finding 8](#7-findings). |
| `P0.recon` | `absent` | prompt-gated. Correct. |

Nothing was proposed that should not have been.

### 4.4 Disclosures rather than failures

- **The `app` submodule was not recursed into.** `git submodule status` in the
  clone reported a leading `-`, and `app/` contained 0 entries. detect disclosed
  it twice: once as `Nested repositories detected (1) — not scanned: • app
  (submodule)`, and again by scoping the exposure count — `Exposures (2) — this
  repository only; 1 nested repository not scanned`. This is the *disclose, do
  not recurse* ruling working correctly, and it is recorded here as a
  disclosure, not a failure.

---

## 5. Credential detection on a real credential

`api-oxen-com-sg`'s clone kept the source's credential-bearing `origin` URL.
The tool found it, classified it `high`, and recorded only its existence:

```
  ! high   token-in-remote-url at git remote "origin"
```

The machine-readable record in `detect.json` is:

```json
"remotes": [{"name":"origin","hasCredential":true}]
```

— a boolean, not a URL. Every exposure record in `detect.json` carries exactly
three fields:

```json
{
  "kind": "token-in-remote-url",
  "location": "git remote \"origin\"",
  "severity": "high"
}
```

No value, no matched text, no line number, no surrounding context.
`detect.json` has no top-level `root` field; the repository path appears only
under `repo.root`, which is the path the user passed in.

This is the correct design and it held on a real credential. See
[finding 1](#7-findings) for the separate matter of how much noise the
`credentials-in-doc` heuristic puts around it.

---

## 6. The four checks that postdate the brief

### 6.1 Check 1 — a forged manifest entry must not be able to delete a real file

This was the worst defect this project found, and the brief predates its fix.
The requirement now is three independent gates: a manifest entry, **and**
`classify` returning `ours-unmodified`, **and** an in-file
`Generated by kh-harness` stamp.

**Setup.** After a clean apply on the `cashmigo` clone, a manifest entry was
forged for the repository's own real `CLAUDE.md`, carrying that file's **true**
sha256 — the exact attack:

```
forged entry for CLAUDE.md with its TRUE sha256 = 31126aa047432dfd67a5ba87d7ee51db988967bf5272f9f58a4f88d46e31c613
=== does CLAUDE.md contain the stamp? ===
0 (no stamp)
```

**The attack condition was genuinely met.** Calling the kit's own `classify`
directly confirms the hash gate alone would have authorised the deletion:

```
classify(CLAUDE.md) = ours-unmodified
```

**Result.**

```
=== uninstall DRY RUN with forged entry ===
Will remove:
  HANDOFF.md
  .claude/scripts/session-brief.mjs
Will revert settings patches:
  /hooks/SessionStart
Will keep:
  CLAUDE.md (not-generator-producible)
```

```
Removed:
  HANDOFF.md
  .claude/scripts/session-brief.mjs
Kept:
  CLAUDE.md (not-generator-producible)

=== CLAUDE.md SURVIVED? ===
-rw-r--r-- 1 Dreambuilds 197121 1687 Oct  2 19:46 /c/.../cashmigo/CLAUDE.md
31126aa047432dfd67a5ba87d7ee51db988967bf5272f9f58a4f88d46e31c613 */c/.../cashmigo/CLAUDE.md
expected 31126aa047432dfd67a5ba87d7ee51db988967bf5272f9f58a4f88d46e31c613

=== byte-identical to the pre-apply copy? ===
IDENTICAL
```

**PASS.** The structural gate (`isGeneratorProducible`) refused it: `CLAUDE.md`
is a path no generator ever targets, so the refusal does not depend on content,
hash, or anything an attacker controls. The file survived byte-identical and was
reported as kept with the reason.

**Supplementary — the second gate, also against real file content.** The
structural gate cannot catch a forged entry for a path that *is* legitimately
ours. So a second case was run: the real `CLAUDE.md` content was placed at
`HANDOFF.md` (a generator-producible path), and the manifest's recorded hash was
updated to that content's true hash. Path legitimate, hash matching, content the
user's own, no stamp:

```
manifest sha for HANDOFF.md updated to the real content hash: 31126aa047432dfd67a5ba87d7ee51db988967bf5272f9f58a4f88d46e31c613
HANDOFF.md carries stamp? false
```

```
Will keep:
  HANDOFF.md (missing-stamp)

Removed:
  .claude/scripts/session-brief.mjs
Kept:
  HANDOFF.md (missing-stamp)

=== HANDOFF.md (= user content) survived? ===
IDENTICAL to CLAUDE.md — survived
```

**PASS.** Both gates were exercised against real file content from a real
repository, and each caught the forgery the other cannot.

### 6.2 Check 2 — a repository that gitignores `.claude/`

**Neither target gitignores `.claude/`.** This was checked carefully, because an
initial reading suggested otherwise:

```
=== check-ignore, one path at a time, api ===
  .claude -> exit=1  <not ignored>
  .claude/ -> exit=0  .gitignore:41:	.claude/
  .claude/settings.json -> exit=1  <not ignored>
  .claude/scripts/lint-touched.mjs -> exit=1  <not ignored>
  .claude/kh-harness.manifest.json -> exit=1  <not ignored>
```

`git check-ignore -v` reports a match for the trailing-slash form `.claude/`
and attributes it to `.gitignore:41` — but line 41 of that file is blank, the
file contains no `claude` string at all, and every path *inside* `.claude/` is
reported as not ignored. The decisive evidence is `git status`, which never
lists an ignored directory as untracked:

```
?? .claude/
?? docs/
(.claude/ listed as ?? above => NOT ignored)
```

So the trailing-slash reading was a `check-ignore` artefact.
`cashmigo` ignores only `.claude/worktrees/` and `.claude/settings.local.json`,
not `.claude/` itself. **There is no as-found real-world case among the
targets**, and this is recorded as such rather than claimed.

**Constructed variant, clearly labelled.** Because the check is worth running,
one line was added to the `api-oxen-com-sg` *clone*'s `.gitignore` and committed
in the clone. This is a real repository with a one-line change, not a fixture,
and it is labelled constructed:

```
.gitignore:47:.claude/	.claude/settings.json
.gitignore:47:.claude/	.claude/scripts/lint-touched.mjs
.gitignore:47:.claude/	.claude/kh-harness.manifest.json
```

Apply wrote all ten items as before, and `git status` then showed none of them —
our installed files were genuinely invisible to a git-aware scan:

```
=== git status (our .claude files now invisible to git) ===
?? HANDOFF.md
?? scripts/
```

detect afterwards:

```
  [~] P2.sensor          declared
        PostToolUse hook: .claude/scripts/lint-touched.mjs (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)
  [~] P2.stopgate        declared
        Stop hook: .claude/scripts/verify-touched.mjs (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)
  [~] P2.protected       declared
        2 deny rule(s) matching protected-path evidence found in this repository: Edit(*-lock.json), Edit(**/migrations/**)
  [~] P4.sessionbrief    declared
        SessionStart hook: .claude/scripts/session-brief.mjs (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)
```

**PASS, and better than the check required** — the capabilities report
`declared`, *and* the summary discloses both that the file scan could not see
them and how their presence was confirmed instead. Uninstall then also worked
normally in that state, removing all six files and reverting all four patches.

One defect was found in this state: the machine-readable field disagrees with
the human summary. See [finding 6](#7-findings).

### 6.3 Check 3 — `.claude/settings.json` round-trip

`cashmigo`'s real `.claude/settings.json` before apply:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node docs/agent-context/inject.js"
          }
        ]
      }
    ]
  }
}
```

(ending without a trailing newline — last byte `0x7d`.)

After apply and a full uninstall:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node docs/agent-context/inject.js"
          }
        ]
      }
    ]
  }
}
```

Programmatic comparison against the pre-apply copy:

```
deep-equal ignoring order : true
key ORDER preserved too   : true
raw bytes identical       : false
byte diff                 : 266 -> 253 bytes (-13)
last byte before/after    : 0x7d / 0xa
```

**PASS.** Every key the file had is intact, with its values, nesting and
ordering preserved — including the `matcher` on the user's own hook, which the
tool had to step around to append its own entry and then remove again.

The byte difference is entirely whitespace, and decomposes exactly: the
checked-out file had 14 CRLF line breaks (28 bytes) and no trailing newline;
the rewritten file has 14 LF breaks (14 bytes) plus one trailing newline
(1 byte). 266 − 28 + 15 = 253. The tool disclosed this at apply time in its
`note` line, and it is a known, disclosed limitation rather than a finding.

One consequence of it is *not* disclosed, and is recorded as
[finding 5](#7-findings): because the trailing newline is a change `git` does
see, a complete uninstall leaves the repository with `git status` still
reporting `M .claude/settings.json`.

### 6.4 Check 4 — names-only script storage

`api-oxen-com-sg` declares 35 scripts. This is the first real test of the
names-only storage that fixed an early credential leak.

How `detect.json` stores them — names only, sorted, no bodies:

```json
"packages": [
  {
    "name": "ost-v2",
    "dir": ".",
    "manifestPath": "package.json",
    "scripts": [
      "build", "format", "lint",
      "migration:generate:admin", "migration:generate:cms", "migration:generate:device", "migration:generate:user",
      "migration:revert:admin", "migration:revert:cms", "migration:revert:device", "migration:revert:user",
      "migration:run:admin", "migration:run:cms", "migration:run:device", "migration:run:user",
      "prebuild", "seed", "seed:admin", "seed:entitlements", "seed:ticket",
      "start", "start:debug", "start:dev", "start:prod",
      "test", "test:cov", "test:debug", "test:e2e", "test:ticket:service", "test:watch",
      "typeorm:admin", "typeorm:cms", "typeorm:device", "typeorm:user",
      "whatsapp_blast"
    ]
  }
]
```

*(the array is reflowed here for width; it is one name per line in the file.)*

Every one of the 35 script **bodies** was then read from `package.json` and
searched for, verbatim, as a substring of eight artefacts: `detect.json`, the
detect stdout, the dry-run stdout, the apply stdout, the generated
`scripts/bootstrap.sh`, the generated `HANDOFF.md`, the written
`.claude/settings.json`, and the manifest.

```
script bodies: 35
artefacts scanned: 8
verbatim body occurrences: 0 []
```

The check was run with no minimum length, so even the shortest body is covered:

```
short body: script "test" body length=4 in detect.json=false in stdout=false
all-length containment hits: []
```

**PASS.** Zero script bodies appear in `detect.json`, in stdout, in the summary,
or in the generated `bootstrap.sh`. The generated bootstrap invokes scripts by
name (`npm run build`, `npm run test`) and never inlines what they expand to.

---

## 7. Findings

Severity is assigned from the user-visible consequence, not from how hard it
would be to fix. Nothing here was fixed; this task does not change code.

1. **Major — the `credentials-in-doc` heuristic buries its own signal on a real
   codebase.** `api-oxen-com-sg` produced 67 exposures, of which 66 are
   `credentials-in-doc`. Reproducing detect's own `DB_CRED` regex and its
   placeholder filter over those 66 files and classifying each match by whether
   the matched value is a quoted string literal or a code reference:

   ```
   credentials-in-doc hits: 66
     value is a QUOTED string literal (plausible real finding): 4
     value is a code reference / env lookup (false positive): 62
     files with a quoted literal:
       src/config/ecm_data_db_config.ts
       src/config/ost_db_config.ts
       src/config/slm_data_db_config.ts
       src/model/device/VMS/vms/optraffic.service.spec.ts
   ```

   62 of 66 match a credential-key assignment whose value is an identifier,
   member expression or environment lookup — ordinary NestJS/TypeORM code, not a
   secret. The four genuine-looking hits and the one `high` severity
   `token-in-remote-url` are printed in the same undifferentiated list beneath
   them, twice (once under `P0.security`, once under `Exposures`), and
   `P0.security` reports `failing` on that basis. No credential value is
   disclosed, so this is a signal-quality defect, not a disclosure defect — but
   a 94% false-positive rate on the first real TypeScript codebase the tool has
   met is the difference between a check a user acts on and a check a user
   learns to scroll past.

2. **Minor — `apply`'s proposal rationale contradicts itself, and contradicts
   `detect`, about an existing hook.** On `cashmigo`, which has a real
   `SessionStart` hook of the user's own, `apply` printed:

   ```
   --- .claude/settings.json (hook: SessionStart)  [P4.sessionbrief]
       no SessionStart hook registered in .claude/settings.json
   ```

   and then, two lines after the diff:

   ```
   (appended after 1 existing hooks.SessionStart entry, which are left unchanged and not shown)
   ```

   The two statements cannot both be true. `detect` gets the same fact right for
   the same repository: `SessionStart hook already registered, but not ours:
   docs/agent-context/inject.js`. The *behaviour* is correct — the user's hook
   was preserved exactly — so this is wording, but it is wording that tells a
   user their settings file is empty of hooks immediately before modifying it.

3. **Minor — `apply`'s own first run makes its second run refuse.** On any
   repository with a tracked `.claude/settings.json`, the first `apply --yes`
   modifies that tracked file, so the next `apply` exits 3:

   ```
   kh-harness: refusing to apply with uncommitted changes to tracked files. Commit or stash first so you can `git diff` what this tool did, or re-run with --allow-dirty.
   ```

   The gate exists so that a user can `git diff` exactly what the tool did.
   Having run the tool once, the only way to run it again is `--allow-dirty`,
   which waives the gate for every other uncommitted change too — so the
   mechanism that protects the legibility of the tool's diff is the thing that
   forces its own waiver. The message is accurate and actionable, and the
   behaviour is defensible; it is recorded because it is the one place in the
   cycle where the tool obstructs itself. (`api-oxen-com-sg`, which had no
   tracked `.claude/settings.json`, did not hit this — its second apply ran
   straight through.)

4. **Minor — uninstall leaves behind the containers it created.** After a
   complete uninstall of `api-oxen-com-sg`, a repository that had no `.claude/`
   directory at all beforehand, the following remained: `.claude/settings.json`
   containing `{}`, and the empty directories `.claude/scripts/`, `.claude/` and
   `scripts/`. `docs/harness/detect.json` also remained, which is arguably
   correct — it is a report, never recorded in the manifest, and removing it
   would mean uninstall deleting a file no install created. "Always leaves
   cleanly" holds for content; it does not hold for the directory and the empty
   settings file the tool itself brought into being.

5. **Minor — a complete uninstall does not return `git status` to clean.** On
   `cashmigo`, after uninstall, `.claude/settings.json` is structurally
   identical to the original (deep-equal, key order preserved,
   [§6.3](#63-check-3--settingsjson-round-trip)) yet `git status` still reports:

   ```
    M .claude/settings.json
   ```

   because the tool added a trailing newline the original lacked:

   ```diff
   @@ -12,4 +12,4 @@
    }
   -}
   \ No newline at end of file
   +}
   ```

   The *cause* is the disclosed whitespace reformat, and is not a finding. The
   *consequence* — that uninstall cannot restore a clean tree, so a user cannot
   confirm removal by `git status` alone — is not disclosed anywhere, and is.

6. **Minor — `detect.json`'s `harness.claudeDir.settings` states a falsehood
   under a gitignored `.claude/`.** In the constructed check-2 run, with
   `.claude/settings.json` present on disk and carrying four of our patches,
   `detect.json` recorded:

   ```json
   "claudeDir": {"settings":false,"localSettings":false,"denyRules":2,"denyRuleList":["Edit(*-lock.json)","Edit(**/migrations/**)"],"hooks":[],"hookEvents":{"PostToolUse":[null],"Stop":[null],"SessionStart":[null]}, ...}
   ```

   `settings: false` while `denyRules: 2` and `denyRuleList` in the same object
   were populated by reading that very file. The human-readable summary handles
   this case correctly and explicitly ("not visible to the file scan — `.claude/`
   may be gitignored; confirmed via the install record and the file on disk"),
   but a consumer reading `detect.json` programmatically would conclude no
   settings file exists. The boolean is derived from the file scan while its
   siblings are derived from disk.

7. **Surprising, not a defect — "proposals" counts two different things in one
   cycle.** For the same unchanged repository, `detect` reported
   `7 proposals` and `apply` reported `10 proposals`. Both are internally
   consistent: `detect` counts capability gaps that have an actionable next step
   (confirmed — 9 checks were `absent`, and the 2 whose disposition is advice or
   a question are excluded, in both the first run, 9−2=7, and the re-run,
   3−2=1), while `apply` counts the file writes and settings patches needed to
   close them. Nothing is wrong; the shared noun across two CLIs in one workflow
   invites a reader to diff two numbers that are not comparable.

8. **Surprising, not a defect — `P1.pathrules` is answered and asked in the same
   run.** detect reports it `absent` with a definitive reason — "this repository
   is not detected as a multi-package workspace … there is no cross-package
   split to scope a rule to" — and then raises it again under "Could not
   derive", asking which subdirectories should each get their own rules file.
   Both are defensible and together they are coherent (the statement explains
   why no glob can be *derived*; the question asks a human to *supply* one), but
   read in sequence the run both closes and opens the same item.

9. **Recon discrepancy in the brief, not a product defect — and it left one
   capability untested.** The brief states that `cashmigo` "carries an Obsidian
   bearer token in `.claude/settings.local.json`". No such file exists at
   `cashmigo`'s repository root; the only root-level `.claude/` contents are
   `settings.json` (tracked) and `worktrees/` (gitignored). A file of that name
   does exist at `backend-old/.claude/settings.local.json`, and `backend-old/`
   is both gitignored and a nested repository, so it is absent from any clone and
   out of scope for a root-level scan. The consequence is a gap in coverage, not
   a defect: `.claude/settings.local.json` is on the tool's always-probed list,
   and **that branch of the exposure check was never exercised by this
   validation.**

### Things that were checked and were right

Recorded because a validation that lists only problems is not auditable.

- An existing `CLAUDE.md` was never proposed, never written, and never deleted —
  on **two** independent real repositories (`cashmigo`, 28 lines; and
  `api-oxen-com-sg`, 1025 lines, which the brief did not anticipate), and in the
  presence of a forged manifest entry carrying its true hash.
- An existing user hook with a `matcher` survived an append-and-revert cycle with
  its key order intact.
- Both `apply` runs were byte-for-byte idempotent, verified by whole-tree
  sha256 rather than by the tool's own say-so.
- A hand-edited generated file was kept, with a reason, on both targets.
- The credential-bearing remote was detected on a real credential and recorded
  as a boolean.
- Zero of 35 script bodies appeared in any of eight artefacts.
- `detect` wrote exactly one file, as it claims, and the dry run wrote nothing
  at all — both verified on disk, not from the summary text.
- Where the tool cannot know something, it says so in the summary rather than
  guessing: the `generic` profile raised five questions and made zero
  stack-specific proposals, and `P2.protected`'s `n/a` reason volunteers its own
  blind spot.

---

## 8. Secret-handling attestation

- **No credential value appeared in any tool output.** Every captured stdout,
  stderr, `detect.json` and generated file was swept.
- Three captured output files did contain three of the four needle patterns
  (the first three; the userinfo-in-URL pattern matched nothing anywhere). In
  all three files the matches fall on the same three lines — 629, 634 and 636 of
  the apply/dry-run stdout — and all three are **regex literals in the source of
  the generated `.claude/scripts/harness-redact.mjs`**, printed as part of the
  proposal diff for `P2.sensor`. They are patterns that *find* secrets, not
  secrets. The authoritative source is `assets/scripts/harness-redact.mjs`
  lines 75, 80 and 82; the same three shapes appear in
  `scripts/lib/detect-exposure.mjs` at lines 20, 25 and 31.
- **This document deliberately does not reproduce those three lines verbatim.**
  That is the single exception to the "paste verbatim output" rule in this
  report, and it is made so that the required grep below remains a meaningful
  check rather than a self-fulfilling failure. The lines are identified by file
  and line number instead.
- **Required grep, run against this document before committing.** The four
  needles from the brief are, named here so as not to spell them: (i) the
  GitLab personal-access-token prefix `glpat` followed by a hyphen; (ii) the
  HTTP authorization scheme keyword, capitalised; (iii) the eight-letter English
  word for a secret used as a credential key; (iv) a URL carrying userinfo
  credentials ahead of an at-sign. **All four return zero matches in this
  document.** The grep was run; the result is stated in
  [§10](#10-closing-state).
- Where a credential-bearing URL had to be shown, it was passed through a
  redacting `sed` before display, and the redaction is this document's own, not
  the tool's.
- No credential was rotated, moved, or written anywhere by this validation.

---

## 9. What this validation did **not** cover

An honest boundary matters more than a long list of passes.

**Capabilities never exercised**

- `P0.recon`, `P1.instructions` and `P1.architecture` as *generators*. All three
  are prompt-gated and have no templated path; they are Plan 4 work. Both
  targets already satisfied `P1.instructions` and `P1.architecture`, so the
  "absent instruction file" path was never reached on a real repository.
- `P1.pathrules` delivery. Neither target is a multi-package workspace, so no
  `.claude/rules/<slug>.md` file was ever generated. The uninstall guard's
  `GENERATOR_PRODUCIBLE_PREFIXES` branch — the one that covers dynamically
  derived rule paths — is therefore untested against a real repository.
- `P2.langserver`. `n/a` on both targets.
- The `python` profile. No Python target was run; only `typescript-single` and
  `generic`.
- `.claude/settings.local.json` exposure detection — see
  [finding 9](#7-findings).

**Behaviour never exercised**

- **No installed hook was ever executed.** `lint-touched.mjs`,
  `verify-touched.mjs`, `session-brief.mjs` and `harness-redact.mjs` were
  written, registered, and removed. None was run, and no Claude Code session was
  started against either clone. This validation proves the capabilities are
  *installed*, not that they *work*.
- **The generated `scripts/bootstrap.sh` was never executed.** `npm ci`,
  `npm run build` and `npm run test` were not run, so whether that script
  actually bootstraps `api-oxen-com-sg` from a clean checkout is unverified —
  the script itself says as much in its own trailing comment.
- `detect --verify` and `detect --json` were not run.
- The default-branch refusal. Both clones were on feature branches, so
  `--allow-default-branch` and its exit 3 were never triggered.
- The corrupt-manifest refusal, and the junction/symlink containment escape
  (`escapes-repository`). Both are covered by the unit suite; neither was
  reproduced on a real repository here.
- Repositories carrying an `AGENTS.md` or other editor configuration.

**Scope**

- `cashmigo`'s `app` submodule contents, entirely — by design.
- `oxen/2026` itself was never a target; only the nested
  `api-oxen-com-sg` inside it. Its 155 uncommitted files and its absence of any
  remote were reasons to leave it alone, not to test against it.
- Windows only. No POSIX run; no test of the line-ending behaviour described in
  [§6.3](#63-check-3--settingsjson-round-trip) on a platform that checks out LF.
- The gitignored-`.claude/` case ([§6.2](#62-check-2--a-repository-that-gitignores-claude))
  was **constructed** by adding one line to a clone's `.gitignore`. Neither
  target gitignores `.claude/` as found, so that result does not establish the
  as-found real-world case the check asked for.
- A single run of each stage. Nothing here speaks to flakiness.

---

## 10. Closing state

- Both clones removed; the temp directory no longer exists.
- All three source repositories verified identical to their pre-run state on
  branch, HEAD, dirty-file count, remote count and absence of
  `.git/worktrees/` ([§2](#2-source-repository-state-before-and-after)).
- `cashmigo`'s `app` submodule still uninitialised at source.
- `api-oxen-com-sg`'s `origin` URL intact at source.
- `kh-harness` at `7bf0f00` with a clean working tree and
  `tests 615 / pass 614 / fail 0 / skipped 1` before this document was written;
  no product code was changed by this task.
- This document was grepped for all four credential needles named in
  [§8](#8-secret-handling-attestation): **zero matches for each.**

**Overall: PASS on both targets.** Every stage completed; no stage was BLOCKED;
no prediction in the brief failed; all four post-brief checks passed. Six
findings are recorded, the most serious being Major, and none of them is a
disclosure of a credential or a loss of a user's file.
