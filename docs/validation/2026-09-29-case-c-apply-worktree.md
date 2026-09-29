# Case C — cashmigo (throwaway apply/uninstall worktree)

Validated 2026-09-29 against harness-kit HEAD `343a7071e3b21a3eba3aa1f1abedae37c0e103c7`
(branch `feat/apply-engine`, 247/247 tests passing at time of run, confirmed with
`node --test "scripts/lib/**/*.test.mjs"` immediately before this record).

This is the first apply/uninstall lifecycle test against a real, uncontrolled
repository (Cases A and B, both detect-only, ran against Plan 1 at HEAD
`ff2ef61`). All work happened in a throwaway `git worktree` of cashmigo — the
working copy at `C:\Users\Dreambuilds\desktop\cashmigo` was never modified.

## Setup

```
git -C /c/Users/Dreambuilds/desktop/cashmigo worktree add /tmp/hk-case-c -b hk-validation
```

Output:

```
Preparing worktree (new branch 'hk-validation')
HEAD is now at e6d81bb docs: wiki and state describe CAP-111 as converting to the user's home currency
```

Windows path for the CLIs (Git Bash's `/tmp` resolves to a short-name path
under `AppData\Local\Temp`; obtained with `pwd -W` from inside the worktree,
per the brief's instruction that the CLIs need a filesystem path Node can
resolve):

```
C:\Users\DREAMB~1\AppData\Local\Temp\hk-case-c
```

**Pre-existing state in the cashmigo working copy**, present before this task
started and unrelated to it (confirmed with `git -C cashmigo status
--porcelain` before touching anything): `M app` (the `app` submodule pointer
was already dirty) and `?? docs/harness/` (an untracked `detect.json` from an
earlier, unrelated run directly in the working copy). Both remained
byte-for-byte unchanged throughout this task — see "Final `git status`" below.

**Methodology note on `backend-old`.** `git worktree add` checks out only
*tracked* content. `backend-old/` is untracked and gitignored
(`.gitignore:6`), so it is not copied into a fresh worktree by git itself —
confirmed directly: immediately after `worktree add`, `ls
/tmp/hk-case-c/backend-old` returned "No such file or directory" while `git
submodule status` showed the `app` submodule's placeholder directory present
(tracked, mode `160000`). To exercise the nested-repository disclosure the
brief specifically asks for ("the tool cannot see inside either and should
disclose both"), `backend-old/` (15 MB, its own `.git`) was copied — read-only,
source untouched — from the cashmigo working copy into the worktree with `cp
-r`, and removed again from the worktree during cleanup, before the worktree
itself was removed. This is a property of `git worktree`, not of harness-kit,
and is recorded here rather than silently worked around.

## The cycle

All commands run from `C:\Users\Dreambuilds\desktop\harness-kit` against the
worktree path above.

### 1. `detect` (first run)

```
node scripts/detect.mjs "C:/Users/DREAMB~1/AppData/Local/Temp/hk-case-c"
```

```
harness-kit 0.1.0 — C:\Users\DREAMB~1\AppData\Local\Temp\hk-case-c
profile: generic   branch: hk-validation

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
  [ ] P4.handoff         absent
      → create HANDOFF.md from template
  [~] P4.sessionbrief    declared
        SessionStart hook: docs/agent-context/inject.js

Nested repositories detected (2) — not scanned:
  • app (submodule)
  • backend-old (nested-repo)

Exposures (2) — this repository only; 2 nested repositories not scanned — values are never printed; rotate by hand:
  ! medium credentials-in-doc at docs/audit/2026-09-20/01-backend-security.md
  ! high   token-in-tracked-file at docs/audit/2026-09-20/07-cross-cutting-secrets-infra.md

4 proposals. Nothing has been written except docs/harness/detect.json.

Could not derive — answer these before applying:
  ? 2 nested repositories were detected (app, backend-old). Stack detection and credential scanning covered this repository only; each nested repository must be assessed separately.
  ? Stack detection did not reach a decision (confidence below 0.5). What is this project's primary stack? Stack-specific steps were skipped as a result.
  ? No lockfile found, so the package manager is unknown. Confirm which one this project uses.
  ? An instruction file already exists. Which of its rules are decisions that cannot be re-derived from source? Those must survive any regeneration.
```

**Expectation (per brief):** stack detects as `generic`, stack-specific steps
`n/a`, both `app` (submodule) and `backend-old` (nested-repo) disclosed as not
inspected, exposure scanner reports findings (documentation credentials).

**Observed:** exactly this. Profile `generic`; `P1.bootstrap`, `P2.scripts`,
`P2.sensor`, `P2.stopgate`, `P2.langserver` all `n/a` with reason "not
applicable to profile generic"; both nested repositories named and correctly
typed (`submodule` / `nested-repo`); 2 exposures found, both in
`docs/audit/2026-09-20/`, one `medium` (`credentials-in-doc`) and one `high`
(`token-in-tracked-file`) — both are within cashmigo's own security-audit
documentation, consistent with the brief's "example credentials in
documentation" framing. **No credential value was read, printed, or is
present anywhere in this record — only `kind`/`location`/`severity`, exactly
what the tool itself reports.**

Only write from this step: `docs/harness/detect.json` (the tool's own
documented "one and only write" for `detect`).

**Verdict: PASS.**

### 2. `apply` with no flags (dry run)

```
node scripts/apply.mjs "C:/Users/DREAMB~1/AppData/Local/Temp/hk-case-c"
```

```
harness-kit: 1 proposal for C:\Users\DREAMB~1\AppData\Local\Temp\hk-case-c

--- HANDOFF.md  [P4.handoff]
    no handoff file found
--- a/HANDOFF.md
+++ b/HANDOFF.md
+<!-- Generated by harness-kit 0.1.0 (runbook step 16). Edit freely — harness-kit will report your changes rather than overwrite them. -->
+
+# Handoff
+
+Update this before you stop. The next session — yours or an agent's — starts
+from what is written here, not from what you remember.
+
+## Where I stopped
+
+<!-- One or two sentences. What were you in the middle of? -->
+
+## What works
+
+<!-- What is done and verified. Name the command that proves it. -->
+
+## What didn't work
+
+<!-- The most valuable section. What did you try? What did it do instead? Error text if there was one.
+     Without this the next session repeats the same dead ends. -->
+
+## Next step
+
+<!-- The single next action, specific enough to start without re-deriving it. -->

Dry run — nothing written. Re-run with --yes to apply.
```

`git status --porcelain --untracked-files=all` immediately after:

```
?? docs/harness/detect.json
```

Unchanged from the state right after step 1 — the dry run added nothing.

**Surprising, but resolved, not a defect:** `detect` counted 4 proposals;
`apply` (no flags) shows only 1 (`HANDOFF.md`). Read `scripts/lib/propose.mjs`
directly: `buildProposals()` only emits a proposal for a check id present in
its `GENERATORS` table, and that table currently has exactly two entries —
`P4.handoff` and `P4.sessionbrief` (the latter already `declared` here, so it
generates nothing). The other three absent checks from `detect`
(`P0.recon`, `P1.pathrules`, `P2.protected`) have no generator at all — they
are named verbatim in the task brief's "What Plan 3 will cover" section
(prompt-gated recon, path-rule scaffold; `P2.protected`'s deny-rule writer is
likewise not yet implemented). `detect`'s "4 proposals" count is therefore a
description of gaps, not a promise of what this Plan-2 `apply` can act on —
confirmed from source, not from the tool's own claim.

**Expectation (per brief):** dry run writes nothing.

**Verdict: PASS.**

### 3. `apply --yes`

```
node scripts/apply.mjs "C:/Users/DREAMB~1/AppData/Local/Temp/hk-case-c" --yes
```

```
harness-kit: 1 proposal for C:\Users\DREAMB~1\AppData\Local\Temp\hk-case-c

--- HANDOFF.md  [P4.handoff]
    no handoff file found
--- a/HANDOFF.md
+++ b/HANDOFF.md
+<!-- Generated by harness-kit 0.1.0 (runbook step 16). Edit freely — harness-kit will report your changes rather than overwrite them. -->
+
+# Handoff
+
+Update this before you stop. The next session — yours or an agent's — starts
+from what is written here, not from what you remember.
+
+## Where I stopped
+
+<!-- One or two sentences. What were you in the middle of? -->
+
+## What works
+
+<!-- What is done and verified. Name the command that proves it. -->
+
+## What didn't work
+
+<!-- The most valuable section. What did you try? What did it do instead? Error text if there was one.
+     Without this the next session repeats the same dead ends. -->
+
+## Next step
+
+<!-- The single next action, specific enough to start without re-deriving it. -->

wrote      HANDOFF.md
```

`git status --porcelain --untracked-files=all` after:

```
?? .claude/harness-kit.manifest.json
?? HANDOFF.md
?? docs/harness/detect.json
```

Manifest written (`.claude/harness-kit.manifest.json`):

```json
{
  "schema": 1,
  "kitVersion": "0.1.0",
  "installedAt": "2026-09-29T12:16:59.813Z",
  "files": [
    {
      "path": "HANDOFF.md",
      "sha256": "09f9de2df9325ebc1c2e4d6f964a2d1b27510d38b521fb10c2143dc26992aeb1",
      "step": 16,
      "writtenAt": "2026-09-29T12:16:59.821Z"
    }
  ],
  "settingsPatches": []
}
```

**Expectation (per brief):** apply writes exactly what it proposed, patches
what needs patching, skips the rest.

**Observed:** wrote `HANDOFF.md` exactly as diffed in the dry run; nothing
patched (`.claude/settings.json` was not touched — `P4.sessionbrief` was
already `declared`, so no hook proposal was ever generated); nothing skipped;
manifest recorded correctly.

**Verdict: PASS.**

### 4. `detect` again (the closed loop)

```
node scripts/detect.mjs "C:/Users/DREAMB~1/AppData/Local/Temp/hk-case-c"
```

Full output identical to step 1 except:

```
  [~] P4.handoff         declared
        HANDOFF.md
```

(was `[ ] P4.handoff absent`), and the summary line now reads `3 proposals`
(was 4) — `P0.recon`, `P1.pathrules`, `P2.protected` remain, matching exactly
what `apply` still cannot act on per step 2's finding.

**Expectation (per brief):** the tool must recognize what it just wrote.

**Verdict: PASS.**

### 5. `apply --yes` again (must be a no-op)

```
node scripts/apply.mjs "C:/Users/DREAMB~1/AppData/Local/Temp/hk-case-c" --yes
```

```
harness-kit: no proposals — this repository already satisfies every applicable step.
```

`git status --porcelain --untracked-files=all` unchanged from step 3
(`.claude/harness-kit.manifest.json`, `HANDOFF.md`, `docs/harness/detect.json`
— same three entries, nothing added, nothing modified).

**Verdict: PASS.**

### 6. Hand-edit `HANDOFF.md`, then `apply --yes` again

Before editing, the on-disk file's sha256
(`09f9de2df9325ebc1c2e4d6f964a2d1b27510d38b521fb10c2143dc26992aeb1`) was
confirmed to match the manifest's recorded hash exactly. Appended one line by
hand:

```
<!-- hand-edited by task-9 validation, 2026-09-29T12:17:13Z -->
```

New sha256: `5c42ce4f8884bfcf93591af3277d17ce52e09083b2fdbb19d268f562f6c2a42a`.

```
node scripts/apply.mjs "C:/Users/DREAMB~1/AppData/Local/Temp/hk-case-c" --yes
```

```
harness-kit: no proposals for C:\Users\DREAMB~1\AppData\Local\Temp\hk-case-c.
kept       HANDOFF.md (modified since harness-kit wrote it — left as-is)
```

Post-run checks: the hand-appended line is still present in `HANDOFF.md`
(edit survived, file not overwritten); the manifest still records the
*original* sha256 (`09f9de2d…`), not the drifted one — correct, since the
manifest describes what the tool wrote, not the file's live state; a repeat
`detect` still shows `P4.handoff` as `declared` (a modified-but-present file
is not re-flagged as a gap).

**Expectation (per brief):** the edit survives, drift is reported.

**Verdict: PASS.**

### 7. `uninstall` with no flags (the plan)

```
node scripts/uninstall.mjs "C:/Users/DREAMB~1/AppData/Local/Temp/hk-case-c"
```

```
Will keep (user-modified):
  HANDOFF.md (ours-modified)

Run with --yes to apply.
```

`git status` unchanged after — a plan writes nothing.

**Verdict: PASS.**

### 8. `uninstall --yes`

```
node scripts/uninstall.mjs "C:/Users/DREAMB~1/AppData/Local/Temp/hk-case-c" --yes
```

```
Will keep (user-modified):
  HANDOFF.md (ours-modified)

Kept (user-modified):
  HANDOFF.md
```

`.claude/harness-kit.manifest.json` remains on disk after uninstall, unchanged
in content (still lists `HANDOFF.md` with the original sha256). This is
correct, not a leftover bug: read directly in `scripts/lib/uninstall-lib.mjs`,
`runUninstall()` only deletes the manifest file when nothing is being kept
(`!hasKept && !hasFailures`); here `HANDOFF.md` is kept because it is
user-modified, so the manifest must keep tracking it — deleting the manifest
here would silently orphan a file the tool still needs to recognize on a
future run. `.claude/settings.json` (pre-existing, tracked, holding cashmigo's
own `SessionStart` hook) is untouched — confirmed with `git diff --stat`
showing zero changes to any tracked file.

**Expectation (per brief):** what is removed, what is kept and why.

**Observed:** nothing was removed (the only tracked-by-manifest file was
kept); `HANDOFF.md` kept with reason `ours-modified`, exactly matching what
was hand-edited in step 6.

**Verdict: PASS.**

### 9. `git status` — confirm the worktree

```
git status
```

```
On branch hk-validation
Untracked files:
  (use "git add <file>..." to include in what will be committed)
	.claude/harness-kit.manifest.json
	HANDOFF.md
	docs/harness/

nothing added to commit but untracked files present (use "git add" to track)
```

`git diff --stat` (tracked files): empty — no tracked file was modified by
any step of the cycle.

Three untracked items remain, and each is accounted for, not unexplained
residue:

- `docs/harness/detect.json` — the by-product of running `detect` (its
  documented "one and only write"); not part of the install manifest, so
  neither `apply` nor `uninstall` has any reason to remove it.
- `.claude/harness-kit.manifest.json` and `HANDOFF.md` — both correctly kept
  because of the deliberate hand-edit in step 6, per the drift contract
  verified in steps 6–8.

This matches the brief's "back to its prior state apart from anything you
deliberately edited" exactly: the one file deliberately edited (`HANDOFF.md`)
and its tracking record are the only durable change; everything else is
either the detect report or was never written to begin with.

**Verdict: PASS.**

## Cleanup

```
git -C /c/Users/Dreambuilds/desktop/cashmigo worktree remove /tmp/hk-case-c --force
git -C /c/Users/Dreambuilds/desktop/cashmigo branch -D hk-validation
```

(`backend-old/`, copied into the worktree per the methodology note above, was
removed with `rm -rf` before the worktree removal, since it was never part of
git's own tracked/ignored bookkeeping for the worktree.)

```
Deleted branch hk-validation (was e6d81bb).
```

`git -C /c/Users/Dreambuilds/desktop/cashmigo worktree list` afterward shows
only the primary working copy — the throwaway worktree is gone.

## Final `git status` on the cashmigo working copy

```
git -C /c/Users/Dreambuilds/desktop/cashmigo status --porcelain
```

```
 M app
?? docs/harness/
```

Byte-identical to the baseline recorded before this task began. **Nothing new
was added; the working copy was never touched.**

## Summary

| Step | Verdict |
|---|---|
| 1. `detect` | PASS |
| 2. `apply` (dry run) | PASS |
| 3. `apply --yes` | PASS |
| 4. `detect` (closed loop) | PASS |
| 5. `apply --yes` (no-op) | PASS |
| 6. hand-edit + `apply --yes` (drift) | PASS |
| 7. `uninstall` (plan) | PASS |
| 8. `uninstall --yes` | PASS |
| 9. `git status` (worktree restored apart from deliberate edit) | PASS |
| Parent working copy untouched | PASS |

**No defect found in this run.** Two things were surprising enough to record
in detail above, and both resolved to expected, source-confirmed behavior
rather than tool defects: (1) `apply`'s 1-proposal count vs. `detect`'s
4-proposal count, resolved by `propose.mjs`'s `GENERATORS` table matching
exactly the Plan-3 scope named in the task brief; (2) `git worktree add` does
not check out gitignored/untracked content, so `backend-old/` had to be
copied in by hand to exercise its disclosure — a property of `git worktree`,
not of harness-kit.

**Incidental observation, not part of this task's scope:** Case B (Plan 1,
HEAD `ff2ef61`) recorded two detection defects against this same cashmigo
repository — a `P1.architecture` false-negative (missing `docs/wiki/*`) and a
partial `P4.continuity` false-negative (missing the real `SessionStart` hook
at `docs/agent-context/inject.js`). At this HEAD (`343a707`), `detect` reports
both as `declared` (see step 1: `P1.architecture` lists all seven
`docs/wiki/*` and related pointers; `P4.sessionbrief` names
`docs/agent-context/inject.js` directly) — both appear to have been fixed
between Plan 1 and Plan 2. This is a positive observation carried over from
reading the prior validation record, not a finding produced by this task, and
is noted here only so a human reviewer isn't left wondering whether Case B's
defects still stand.
