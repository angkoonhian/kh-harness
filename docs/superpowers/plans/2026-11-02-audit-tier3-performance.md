# Audit Tier 3 — Performance and Noise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close findings 10, 11, 12, 17, 18, 19 and 24 — the hook mask gaps, the Stop gate's overflow and invisible notices, the lint sensor's append and orphan, the Stop gate's no-change skip, exec-form hook registration, the terse dry run, and the two `detect` hot spots — each with a reproducing test first, and the three timing changes measured before and after in the ledger.

**Architecture:** One shared process runner (`runBounded` + `killTree`) moves into the hook asset and both process hooks use it. One shared hook-entry resolver (`hookScriptOf`) in `settings-merge.mjs` is read by both `detect-harness.mjs` and `hasEquivalentHook`, so a shell-form and an exec-form registration of the same script are one hook everywhere. Everything else is local.

**Tech Stack:** Node 22+, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-02-audit-tier3-performance-design.md`

## Global Constraints

- Zero runtime dependencies; Node `>=22`; `npm test` = `node --test "scripts/lib/**/*.test.mjs"`.
- Hook scripts import only `./harness-redact.mjs` and node builtins; a hook never writes inside the repository; every byte a hook emits passes `boundReport`/`maskCredentials`.
- Credential-shaped fixtures are assembled at runtime (DOGFOOD); the kit passes its own `P0.security`.
- A timing assertion is relative (two measurements in one process) or lives in the ledger, never a fixed wall-clock bound.
- A registered hook of either form is `declared`; the kit never rewrites a user's existing registration.
- Stale comments and README sentences a change falsifies are rewritten in the same task.
- Commit after each task on `fix/audit-findings`; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A diagnostic line holding a JWT or a `https://user:pass@host` URL reaches stderr masked, never raw — Task 1.
2. A `typecheck` whose output exceeds the buffer and then exits non-zero still blocks with what was captured and a cut note; one that exceeds the buffer and exits 0 does not block — Task 2.
3. `scripts.lint` = `eslint . && echo done` runs unmodified (no path appended) and its attributable diagnostics are still reported — Task 3.
4. A Stop with no tree change after a passing verification does not run the command; an edit to a tracked file, or a new untracked file, makes it run again — Task 4.
5. A repository with a user's shell-form `node .claude/scripts/lint-touched.mjs` under `Write|Edit` is `declared`, not re-proposed in exec form — Task 5.

---

### Task 1: Mask rules

**Files:** Modify `assets/scripts/harness-redact.mjs` (`CREDENTIAL_RULES`); Test `scripts/lib/harness-redact.test.mjs`.

- [ ] **Step 1: Failing tests** — one table-driven test `maskCredentials masks today's shapes: npm, GitHub, Stripe-style, Google, JWT, URL userinfo, Basic, key: value forms, PEM, vendor prefixes` where every input is assembled (`['npm', 'A'.repeat(36)].join('_')`, `['eyJhbGciOi', 'x'.repeat(20), 'y'.repeat(20)].join('.')`, `['https://user:hunter2hunter2', 'host/x'].join('@')`, `['Basic', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ=='].join(' ')`, `['"password"', '"hunter2hunter2"'].join(': ')`, `['api_key', 'hunter2hunter2'].join(': ')`, PEM header + body + footer on one and on three lines, `glrt-`, `xapp-`, `hf_`, `dckr_pat_`, `pypi-`) and asserts the secret part is absent from the output and the surrounding text survives (`fetched https://user:***@host/x failed`). Plus `maskCredentials leaves a URL without userinfo and a plain key: alone`.
- [ ] **Step 2: Run** `node --test scripts/lib/harness-redact.test.mjs` — Expected: FAIL (secret present).
- [ ] **Step 3: Implement** the rules per spec D8, replacing the `password|api_key` `=`-only rule; keep the header comment's layer-2 description current.
- [ ] **Step 4: Run, then `npm test`** (DOGFOOD included) — Expected: PASS.
- [ ] **Step 5: Commit** `fix(hooks): the credential mask covers today's token shapes, URLs, JWTs and key: value forms`

### Task 2: Stop gate — overflow keeps what it captured; notices are visible

**Files:** Modify `assets/scripts/verify-touched.mjs` (`runVerification` → uses `runBounded`), `assets/scripts/harness-redact.mjs` (add `runBounded`, `killTree`); Test `scripts/lib/verify-touched.test.mjs`, `scripts/lib/harness-redact.test.mjs`.

**Interfaces:** Produces `export function runBounded(command, { cwd, env, timeoutMs, maxBuffer }) → Promise<{ status, signal, error, stdout, stderr, timedOut, overflowed }>` and `export function killTree(child)` in the shared asset; `overflowed` no longer kills.

- [ ] **Step 1: Failing tests** (verify-touched): `a typecheck whose output exceeds the buffer and then fails still blocks with what was captured and a cut note` (fixture prints 200 KB then exits 3; `HK_VERIFY_MAX_BUFFER=65536`; code 2; stderr matches `/output cut at 64 KB/` and contains the first line printed); `a typecheck whose output exceeds the buffer and then passes does not block`; `the "same failure already reported" notice is a systemMessage on stdout, not a stderr line` (second identical failure: code 0, `JSON.parse(stdout).systemMessage` matches `/already reported/`, stderr empty); same for the block-cap notice. (harness-redact): `runBounded resolves with overflowed and the command's own exit code`.
- [ ] **Step 2: Run** — Expected: FAIL (code 2 on the passing overflow; stderr notices; `runBounded` not exported).
- [ ] **Step 3: Implement** per spec D4: move the runner and `killTree` into the asset (verify-touched imports them), stop appending at `maxBuffer` without killing, append the cut line `(output cut at ${Math.round(maxBuffer/1024)} KB; run \`npm run ${kind}\` for the rest)`, write the two exit-0 notices as `{"systemMessage": …}` on stdout. Update verify-touched's header comment (it describes the overflow kill) and the `isOverflow` block.
- [ ] **Step 4: Run both files, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(hooks): the Stop gate keeps what it captured on overflow and says its notices where they are seen`

### Task 3: Lint sensor — plain-command append, shared runner

**Files:** Modify `assets/scripts/lint-touched.mjs`; Test `scripts/lib/lint-touched.test.mjs`.

**Interfaces:** Consumes `runBounded` from Task 2.

- [ ] **Step 1: Failing tests** — fixture `lint.cjs` prints `src/a.ts:1 argv=${process.argv.slice(2).join(',')}` and exits 1. `a trailing bare "." target is replaced by the edited file` (script `node lint.cjs .` → stderr has `argv=src/a.ts`, not `argv=.,src/a.ts`); `a lint script with a pipeline or chain runs unmodified` (`node lint.cjs && node -e ""` → `argv=` empty); `a lint script with a command substitution runs unmodified`; `a timed-out lint run kills the whole process tree` (script spawns a grandchild that writes a marker after 3 s; `HK_LINT_TIMEOUT_MS=300`; after the hook returns, wait 3.5 s and assert the marker was never written — mirror verify-touched.test.mjs's orphan test if one exists, else this shape).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `appendTarget(lintScript, quotedPath)` per spec D3; replace `spawnSync` with `await runBounded(...)` (main is already async); update the `fullCommand` comment block and `SAFE_RELATIVE_PATH`'s note that "`eslint .` ignores an appended path anyway" (no longer the mechanism).
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(hooks): the lint sensor appends only to a plain command and never orphans the linter`

### Task 4: Stop gate — skip an unchanged tree

**Files:** Modify `assets/scripts/verify-touched.mjs`; Test `scripts/lib/verify-touched.test.mjs`.

- [ ] **Step 1: Failing tests** — fixture is a git repository (`git init`, commit `package.json` + `src/a.ts`) whose `typecheck` is `node count.cjs` appending one byte to `runs.txt` OUTSIDE the repo (temp dir passed via env) and exiting 0. `a Stop with no tree change after a passing verification does not run the command again` (two Stops → 1 run); `an edit to a tracked file makes the next Stop run again` (edit `src/a.ts` → 2 runs); `a new untracked file makes the next Stop run again`; `a failing verification clears the fingerprint, so the next Stop runs again even with no change` (count.cjs exits 1 once via a flag file); `outside a git repository every Stop runs` (non-git fixture → 2 runs).
- [ ] **Step 2: Run** — Expected: FAIL (2 runs where 1 expected).
- [ ] **Step 3: Implement** `treeFingerprint(root)` per spec D2 (`git rev-parse HEAD` tolerant of unborn; `git status --porcelain -z --untracked-files=all`; `statSync` size+mtimeMs per listed path; sha256); marker field `verifiedFingerprint`; early exit 0 when equal. Document in the header comment that the skip costs one `git status` and that a failing run clears it.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `perf(hooks): the Stop gate skips a turn whose tree it already verified`

### Task 5: Exec-form hook registration, both forms recognised

**Files:** Modify `scripts/lib/settings-merge.mjs` (`hookScriptOf`, `hasEquivalentHook(settings, event, entry, matcher)`), `scripts/lib/detect-harness.mjs` (`commandScript` → `hookScriptOf` + files check), `scripts/lib/propose.mjs` (four entries), `scripts/lib/apply-lib.mjs` (`hasEquivalentHook` call; `renderSettingsHookDiff` unchanged — it prints the entry), `scripts/lib/cli.mjs` (`EXECUTION_DISCLOSURE`: hooks run without a shell, from any working directory), `README.md` (hook table intro); Test `settings-merge.test.mjs`, `detect-harness.test.mjs`, `propose.test.mjs`, `lifecycle.test.mjs`, `apply-lib.test.mjs` (the three `node .claude/scripts/lint-touched.mjs` fixtures at :213/:230/:388 stay as SHELL-form user registrations and must still dedupe).

**Interfaces:** Produces `export function hookScriptOf(entry) → string|null` (the script path an entry runs: for shell form the first token that is a path after `node`/`bun`/`deno run`; for exec form `args[0]`; strips `${CLAUDE_PROJECT_DIR}/`, `$CLAUDE_PROJECT_DIR/`, `"`, `./`, backslashes). `hasEquivalentHook(settings, event, entry, matcher)` — entries equivalent when `hookScriptOf` agrees (or, when both resolve to null, the command strings are equal) under the same normalised matcher.

- [ ] **Step 1: Failing tests** — settings-merge: `hookScriptOf resolves shell form, exec form with ${CLAUDE_PROJECT_DIR}, quoted and ./-prefixed paths`; `hasEquivalentHook treats a shell-form and an exec-form registration of the same script under the same matcher as one hook`. detect-harness: `hookEvents resolves an exec-form entry's script from args`. propose: `every settings-hook proposal is exec form with a ${CLAUDE_PROJECT_DIR}-rooted path` (iterate `GENERATORS` over the full fixture; entry.command === 'node', args[0] matches `^\$\{CLAUDE_PROJECT_DIR\}/\.claude/scripts/`). lifecycle: `after apply --yes every registered hook is exec form, and detect reports it declared`; `a user's shell-form registration of our script is declared and not re-proposed` (pre-register `node .claude/scripts/verify-touched.mjs` with the script present → `apply` proposes no Stop hook).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D1. `missingDependencies`/`requiresFiles` unchanged. Update `commandScript`'s comment (it explains why commands are never recorded — still true).
- [ ] **Step 4: Run the five files, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Docs** — `EXECUTION_DISCLOSURE` and README: hooks are registered as `node` + the script's absolute path via `${CLAUDE_PROJECT_DIR}`, run without a shell and from any working directory; an existing shell-form registration is recognised and left alone.
- [ ] **Step 6: Measure** — in a temp clone with the hooks installed, time 20 invocations of the lint hook through `bash -c "node .claude/scripts/lint-touched.mjs"` vs `node .claude/scripts/lint-touched.mjs` directly (payload on stdin); record both medians in the ledger.
- [ ] **Step 7: Commit** `perf(apply): hooks are registered in exec form with ${CLAUDE_PROJECT_DIR}; both forms are one hook`

### Task 6: Terse dry run

**Files:** Modify `scripts/lib/propose.mjs` (`assetSource` on the four script proposals and `redactAssetProposal`), `scripts/lib/apply-lib.mjs` (`renderDiff`), `scripts/apply.mjs` (no diffs under `--yes`), `README.md`; Test `apply-lib.test.mjs`, `propose.test.mjs`, `lifecycle.test.mjs`.

- [ ] **Step 1: Failing tests** — propose: `every shipped-script proposal names its assetSource`. apply-lib: `renderDiff summarises a new file that is a verbatim copy of a shipped asset in one line` (matches `/^\+\d+ lines — a verbatim copy of assets\/scripts\/lint-touched\.mjs/`); `renderDiff shows the full diff for an UPDATE of a shipped asset` (file exists with other content → `--- a/` present); `renderDiff shows the full diff for a new file that is NOT an asset copy` (HANDOFF.md). lifecycle: `apply --yes prints labels and reasons but no diff bodies` (stdout has `--- .claude/scripts/lint-touched.mjs  [P2.sensor]` and no `+++ b/`); `the dry run still shows the diffs` (`+++ b/HANDOFF.md` present; the asset lines are one-liners).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D7.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(apply): a dry run summarises verbatim asset copies; --yes prints no diffs`

### Task 7: One fewer git spawn

**Files:** Modify `scripts/lib/scan.mjs`; Test `scan.test.mjs`.

- [ ] **Step 1: Guard test** — `the file list equals git's own ls-files -co --exclude-standard on a repository with tracked, staged, untracked, ignored and gitlink entries` (compute the ground truth in the test with `execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'])`, filtered the same way). This passes before the change; it is the equivalence contract the change must keep.
- [ ] **Step 2: Implement** per spec D5 (`detectNestedRepositories` returns `{ nested, staged }`; `listFiles` derives tracked from `staged` + the `-o` list).
- [ ] **Step 3: Run, then `npm test`** — Expected: PASS. **Measure** `detect` wall time on a 1,000+ file clone before/after (10 runs, median) and record in the ledger.
- [ ] **Step 4: Commit** `perf(scan): derive tracked paths from ls-files -s instead of a fourth spawn`

### Task 8: Single-open credential sweep

**Files:** Modify `scripts/lib/detect-exposure.mjs`; Test `detect-exposure.test.mjs`.

- [ ] **Step 1: Guard tests** — the existing unreadable-file tests (`F1: …`) keep their `reason` wording: check which strings they pin (`could not be stat()ed`, `could not be read`) and keep those strings. Add `an always-probed path that does not exist is silent; one that is a directory is silent; one that cannot be opened is reported`.
- [ ] **Step 2: Implement** per spec D6 (`openAndRead`), removing `probe`'s `statSync` and `readTextIfPresent`'s separate `readFileSync`; keep the SKIP_DIRS/extension checks before the open.
- [ ] **Step 3: Run, then `npm test`** — Expected: PASS. **Measure** the sweep (`detectExposures` alone, 10 runs) on the same clone before/after; ledger.
- [ ] **Step 4: Commit** `perf(detect): the credential sweep opens each file once`

### Task 9: Record what changed

- [ ] Status lines under findings 10, 11, 12, 17, 18, 19, 24 with the measured numbers. `npm test`. Commit `docs: Tier 3 audit fixes — status and measurements in the findings report`.
