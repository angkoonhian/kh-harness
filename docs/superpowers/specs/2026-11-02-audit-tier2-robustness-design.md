# Audit fixes, Tier 2 — robustness (design)

- **Date:** 2026-11-02
- **Source:** `docs/2026-11-02-audit-findings.md`, Tier 2 findings 6, 7, 8, 9,
  13, 14, 15, 16. (Findings 10–12 are the performance plan; finding 5 was
  folded into Tier 1.)
- **Branch:** `fix/audit-findings`, continuing after the Tier 1 commits.

## Intent

Eight places where the tool does something other than what it says, or
falls over where a reasonable user would expect it to cope: a path with a
space is truncated; a malformed `hooks` block crashes `--yes` after the dry
run promised success; a mid-run kill orphans every written file; `--verify`
writes build output into the tree it is verifying; a user's own deny rule
that protects the lockfile is reported as unrelated; a non-git checkout
spends seconds enumerating `node_modules`; `uninstall` exits 0 with a hook
still registered; `detect` can crash with exit 1. Each fix is small and
local; none changes a documented contract except to make it true.

## Goals

1. `git ls-files -s` records are split at the first tab, so a gitlink at
   `my sub dir` is recorded as `my sub dir`.
2. `.claude/settings.json` with a `hooks` block that is not
   `{event: [{matcher?, hooks: [...]}]}` is refused the same way a malformed
   `permissions` block is — by the dry run and by `--yes` alike — and
   `hasEquivalentHook` treats the same command under a different matcher as
   a different hook.
3. The manifest is written atomically (temp file in the same directory, then
   rename) and records the kit version that last wrote it.
4. `--verify` never runs `build`; a timed-out command is recorded as
   `timedOut: true` with its exit code; commands run with `CI=1`.
5. `P2.protected` credits a user's `Edit(...)` deny rule that covers every
   file one of our candidate globs matches, and names the rule that does.
6. The fallback walk prunes excluded directories before descending.
7. `uninstall` exits 2 when a patch it recorded could not be reverted.
8. `detect` exits 2 with one stderr line when it cannot write
   `docs/harness/detect.json`.

## Non-goals

- Capturing `--verify` command output into `detect.json`: a verify command's
  output is the user's and can carry anything; the report keeps exit code,
  duration and the timeout flag only.
- Removing the `why` field uninstall persists on a kept settings patch. The
  audit called it a leak; the existing tests pin it as the durable record of
  why a patch was left registered ("the record is the half that survives
  the process"). It stands.
- Re-implementing Claude Code's permission-glob semantics. Our matcher
  (`globToRegExp`) is narrower on `**/` than Claude Code's; the fix uses it
  as is, so the failure direction is a redundant proposal, never a missed
  one.

## Decisions

### D1. `ls-files -s` parsing (`scripts/lib/scan.mjs`)

Each record is `<mode> <object> <stage>\t<path>`. Split once at the first
tab; the path is everything after it. The mode is the first
whitespace-delimited token before the tab.

### D2. Settings shape (`scripts/lib/apply-lib.mjs`, `scripts/lib/settings-merge.mjs`)

- `readSettingsResult` refuses (`ok: false`) when `hooks` is present and is
  not a plain object, when any event's value is not an array, when any
  matcher entry is not a plain object, or when a matcher entry's `hooks`
  key is present and not an array. One shared predicate,
  `isWellFormedHooks(hooks)`, exported for its test. `renderDiff` and
  `applyProposals` already route an `ok: false` result to the existing
  "could not be parsed" / `unparseable` paths, so the dry run and `--yes`
  agree.
- `hasEquivalentHook(settings, event, command, matcher)` is true only when
  an entry with that command sits under a matcher entry whose `matcher`
  equals the given one (`undefined` equals an absent key). The one caller
  passes `proposal.matcher`.

### D3. Manifest write (`scripts/lib/manifest.mjs`, `scripts/lib/apply-lib.mjs`)

- `writeManifest` writes `<MANIFEST_PATH>.tmp-<pid>` beside the target and
  `renameSync`s it over the target; on any failure it removes the temp file
  and rethrows, so a partial manifest is never left under either name.
- `applyProposals` sets `nextManifest.kitVersion = kitVersion` whenever it
  wrote or patched anything. A run that changed nothing leaves the recorded
  version alone.

### D4. `--verify` (`scripts/lib/verify.mjs`, `scripts/lib/cli.mjs`, `README.md`)

- `KINDS = ['test', 'lint', 'typecheck']`. `build` is dropped for the same
  reason `install` always was: it writes into the tree. The usage text and
  README say "test, lint and typecheck … `install` and `build` are never
  run, because they mutate the tree".
- `defaultRun` returns `{ exitCode, durationMs, timedOut }`; a kill by the
  10-minute timeout sets `timedOut: true` (exit code stays whatever
  `execSync` reported, or `null`). `env` adds `CI=1`. Every verification
  record carries `timedOut`.

### D5. `P2.protected` coverage (`scripts/lib/gap-model.mjs`, `scripts/lib/protected-evidence.mjs`)

- New `denyRuleCoverage({ candidates, denyRuleList, files })` in
  `protected-evidence.mjs` → `{ covered: [{ glob, by }], uncovered: [glob],
  unrelated: [rule] }`. A candidate is covered when its exact `Edit(glob)`
  is present (today's rule), or when every file in `files` the candidate
  matches is matched by at least one user `Edit(...)` rule (a leading `/`
  on the user's pattern is stripped; other tools' rules never count). A
  rule is unrelated when it covers no file any candidate matches.
- `P2.protected` is `declared` when `uncovered` is empty, with evidence
  naming each covering rule; otherwise `absent` with the existing
  already-present / unrelated evidence lines, and the proposal narrowed to
  the uncovered candidates is left to `addDenyRules`' existing dedupe (the
  generator is unchanged — a redundant rule is the accepted failure
  direction, per Non-goals).

### D6. Fallback walk (`scripts/lib/scan.mjs`)

A recursive walk with `readdirSync(dir, { withFileTypes: true })` that
skips an `EXCLUDE_DIRS` directory without entering it and never follows
symlinks; regular files only, POSIX-relative. Same results as today on a
tree without excluded directories.

### D7. `uninstall` exit code (`scripts/uninstall.mjs`)

`result.patchesNotReverted.length > 0` joins the exit-2 condition. The
"nothing was left behind" line already excludes it.

### D8. `detect` write failure (`scripts/detect.mjs`)

`mkdirSync` + `writeFileSync` wrapped once; on failure one stderr line
naming the path and the error code, exit 2. The README exit-code table's
`2` row gains "could not write detect.json".

## Left to the builder

Test names and fixtures are in the plan.
