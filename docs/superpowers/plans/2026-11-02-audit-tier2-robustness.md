# Audit Tier 2 — Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eight Tier 2 robustness findings (6, 7, 8, 9, 13, 14, 15, 16) with a reproducing test first for each.

**Architecture:** Eight local fixes. One new shared predicate (`isWellFormedHooks`), one new evidence function (`denyRuleCoverage`), one new field on verification records (`timedOut`), one changed signature (`hasEquivalentHook` gains `matcher`). No new files other than tests.

**Tech Stack:** Node 22+, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-02-audit-tier2-robustness-design.md`

## Global Constraints

- Zero runtime dependencies; Node `>=22`; `npm test` = `node --test "scripts/lib/**/*.test.mjs"`.
- No flag, ignore list, score or `--force` is added.
- Nothing from a user's file or a command's output is written into `detect.json` beyond what is already there (paths, counts, line numbers, exit codes).
- The CLI contract stays exit 0 / 2 / 3.
- Credential-shaped test fixtures are assembled at runtime (DOGFOOD).
- Stale comments a fix falsifies are rewritten in the same task.
- Commit after each task on `fix/audit-findings`; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A `settings.json` whose `hooks.Stop` is an object (not an array) must be refused by the dry run's `renderDiff` with the same sentence `--yes` prints — Task 2.
2. `writeManifest` interrupted after the temp write must leave the previous manifest intact; a leftover `.tmp-*` from a crashed run must not be read as the manifest — Task 3.
3. A user rule `Edit(/package-lock.json)` (leading slash) must cover our `*-lock.json` candidate — Task 5.
4. A symlinked directory on the fallback walk must not be followed — Task 6.
5. `uninstall --yes` with one hook the user edited must exit 2 and say which patch — Task 7.

---

### Task 1: `ls-files -s` records split at the first tab

**Files:** Modify `scripts/lib/scan.mjs` (`detectNestedRepositories`); Test `scripts/lib/scan.test.mjs`.

- [ ] **Step 1: Failing test** — `test('a submodule whose path holds a space is recorded under its full path', …)`: fixture repo with a submodule added at `my sub dir` (create a second repo, `git -c protocol.file.allow=always submodule add <path> "my sub dir"`), then `listFiles(d).nested` contains `{ path: 'my sub dir', kind: 'submodule' }`.
- [ ] **Step 2: Run** `node --test scripts/lib/scan.test.mjs` — Expected: FAIL (recorded as `my`).
- [ ] **Step 3: Implement**: `const tab = line.indexOf('\t'); const mode = line.slice(0, tab).split(' ')[0]; const path = line.slice(tab + 1);` with a comment naming the record format.
- [ ] **Step 4: Run** — Expected: PASS. Then `npm test`.
- [ ] **Step 5: Commit** `fix(scan): a submodule path with a space is recorded whole`

### Task 2: `hooks` shape validated; matcher compared

**Files:** Modify `scripts/lib/apply-lib.mjs` (`readSettingsResult`, export `isWellFormedHooks`), `scripts/lib/settings-merge.mjs` (`hasEquivalentHook`); Test `apply-lib.test.mjs`, `settings-merge.test.mjs`.

- [ ] **Step 1: Failing tests**
  - apply-lib: `test('a settings.json whose hooks block is malformed is refused like unparseable JSON, by renderDiff and applyProposals alike', …)` over the shapes `{hooks: []}`, `{hooks: {Stop: {}}}`, `{hooks: {Stop: ['x']}}`, `{hooks: {Stop: [{hooks: {}}]}}`; each: `renderDiff` text matches `/could not be parsed as a JSON object/`, `applyProposals` skips with `why: 'unparseable'`, file unchanged.
  - apply-lib: `test('isWellFormedHooks accepts the shapes Claude Code documents', …)` — `{}`, `{Stop: []}`, `{Stop: [{hooks: [{type:'command', command:'x'}]}]}`, `{PostToolUse: [{matcher: 'Edit', hooks: []}]}`.
  - settings-merge: `test('hasEquivalentHook distinguishes the same command under a different matcher', …)`: settings with the command under `matcher: 'Bash'`; `hasEquivalentHook(s, 'PostToolUse', cmd, 'Write|Edit')` is false; with `'Bash'` true; with no matcher on either side true.
- [ ] **Step 2: Run both files** — Expected: FAIL (TypeError / `isWellFormedHooks` not exported / true).
- [ ] **Step 3: Implement** per spec D2. Pass `proposal.matcher` at `apply-lib.mjs:615`.
- [ ] **Step 4: Run both, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(apply): a malformed hooks block is refused before any write; a matcher is part of a hook's identity`

### Task 3: Atomic manifest write; version recorded

**Files:** Modify `scripts/lib/manifest.mjs` (`writeManifest`), `scripts/lib/apply-lib.mjs` (`applyProposals`); Test `manifest.test.mjs`, `apply-lib.test.mjs`.

- [ ] **Step 1: Failing tests**
  - manifest: `test('writeManifest leaves no temporary file behind and the manifest reads back whole', …)`; `test('writeManifest that cannot rename leaves the previous manifest intact', …)` — make the target a directory so `renameSync` fails; assert throws, the directory is untouched, and no `.tmp-*` sibling remains.
  - apply-lib: `test('applyProposals records the kit version that wrote', …)` — manifest from `emptyManifest('0.1.0')`, `kitVersion: '0.2.0'`, one file proposal → `r.manifest.kitVersion === '0.2.0'`; `test('a run that writes nothing leaves the recorded kit version alone', …)` — proposals `[]` → stays `'0.1.0'`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D3.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(manifest): write atomically; record the version that wrote`

### Task 4: `--verify` never builds; timeouts are recorded

**Files:** Modify `scripts/lib/verify.mjs`, `scripts/lib/cli.mjs:116`, `README.md:97`; Test `verify.test.mjs`.

- [ ] **Step 1: Failing tests** — `test('never runs build — it writes into the tree', …)` (the existing fixture declares `build`; `seen` must not include `npm run build`); `test('defaultRun marks a command killed by the timeout as timedOut', …)` (a `node -e "setTimeout(()=>{},5000)"` with a short timeout — add an optional `timeoutMs` third parameter to `defaultRun` for the test; production passes none); `test('defaultRun runs with CI=1 in the environment', …)` (`node -e "process.exit(process.env.CI==='1'?0:7)"`); `test('every verification record carries timedOut', …)`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D4; update the existing `runs only the commands that exist` test's expectation (`['npm run test']`).
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Docs** — cli.mjs usage and README `--verify` row: "test, lint and typecheck … `install` and `build` are never run, because they mutate the tree"; mention `timedOut` in the row.
- [ ] **Step 6: Commit** `fix(detect): --verify never runs build; a timeout is recorded as one`

### Task 5: `P2.protected` credits a covering rule

**Files:** Modify `scripts/lib/protected-evidence.mjs` (export `denyRuleCoverage`), `scripts/lib/gap-model.mjs` (`P2.protected`); Test `gap-model.test.mjs` (and a unit test for `denyRuleCoverage` in a new `scripts/lib/protected-evidence.test.mjs` if none exists — check first).

- [ ] **Step 1: Failing tests**
  - `test('denyRuleCoverage: a user rule naming the lockfile covers the *-lock.json candidate', …)` — files `['package.json','package-lock.json','dist/index.js']`, candidates `['*-lock.json','dist/**']`, denyRuleList `['Edit(package-lock.json)']` → covered `[{glob:'*-lock.json', by:['Edit(package-lock.json)']}]`, uncovered `['dist/**']`, unrelated `[]`.
  - `test('denyRuleCoverage: a leading slash on the user rule is project-relative', …)` — `Edit(/package-lock.json)` covers.
  - `test('denyRuleCoverage: a Read(...) rule never covers an edit', …)`; `test('denyRuleCoverage: a rule covering none of our files is unrelated', …)` (`Edit(secrets/**)`).
  - gap-model: `test('P2.protected is declared when the user\'s own rules cover every protected file, and names them', …)` (`typescriptFullFixture`, denyRuleList `['Edit(package-lock.json)', 'Edit(dist/**)']` → `declared`, evidence mentions both rules); the existing `not satisfied by an unrelated deny rule` test must still pass.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D5; rewrite the check's comment block (it currently says "the comparison below is exact").
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(detect): a deny rule that protects the files counts, whatever its spelling`

### Task 6: Fallback walk prunes at the directory

**Files:** Modify `scripts/lib/scan.mjs` (`listFiles` fallback); Test `scan.test.mjs`.

- [ ] **Step 1: Failing tests** — `test('the fallback walk never enters an excluded directory', …)`: a non-git dir with `node_modules/<pkg>/` holding 2,000 files; assert `listFiles(d).files` excludes them AND measure: wrap `readdirSync` via a counter? Simpler and honest: time the call and assert under 500 ms, with the file count assertion as the primary check (the existing walk is ~2.6 s at 20k files; at 2k it is ~260 ms vs ~5 ms — assert `< 150 ms` after a warm-up call). `test('the fallback walk does not follow a symlinked directory', …)` (skip on Windows when `symlinkSync` throws EPERM, as scan.test.mjs's F1 test does for its own platform guard).
- [ ] **Step 2: Run** — Expected: FAIL (slow / followed).
- [ ] **Step 3: Implement** per spec D6; rewrite the "Fallback: recursive directory walk" comment.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `perf(scan): the fallback walk prunes excluded directories instead of enumerating them`

### Task 7: `uninstall` exit code

**Files:** Modify `scripts/uninstall.mjs`; Test `lifecycle.test.mjs` (or `uninstall-cli.test.mjs` if lifecycle is being split — it is not yet).

- [ ] **Step 1: Failing test** — `test('uninstall --yes exits 2 when a recorded hook could not be reverted, and says which', …)`: `fixture()`, `apply --yes`, hand-edit the installed Stop hook's command in settings.json, `uninstall --yes` → exit 2, stdout matches `/Could not revert:/` and `/hooks\/Stop/`.
- [ ] **Step 2: Run** — Expected: FAIL (exit 0).
- [ ] **Step 3: Implement** per spec D7.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(uninstall): a hook left registered is a non-zero exit`

### Task 8: `detect` write failure is exit 2

**Files:** Modify `scripts/detect.mjs`, `README.md` (exit-code table); Test `detect-cli.test.mjs`.

- [ ] **Step 1: Failing test** — `test('detect exits 2 with one stderr line when docs/harness/detect.json cannot be written', …)`: `bare()` fixture with `docs` created as a FILE; `cli` throws with status 2, stderr matches `/detect\.json/` and `/could not write/i`, stdout empty.
- [ ] **Step 2: Run** — Expected: FAIL (status 1, stack trace).
- [ ] **Step 3: Implement** per spec D8.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(detect): a report that cannot be written is exit 2, not a crash`

### Task 9: Record what changed

- [ ] Status lines under findings 6, 7, 8, 9, 13, 14, 15, 16 in `docs/2026-11-02-audit-findings.md`; under 15 note the `why` ruling. `npm test`. Commit `docs: Tier 2 audit fixes — status in the findings report`.
