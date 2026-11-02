# Audit Tier 4 — Cleanup, Docs, CI and Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close findings 20–23, 25–27 and the Tier 4 list with a test first for every behaviour change, a doc change for every sentence that was false, and no dead code left behind.

**Architecture:** Small local changes across the report, the gap model, both settings writers, the re-injection hook, the marker directory and the scan; one removal (the `apply`-side CLAUDE.md redirect); one test-file split onto a shared fixture module; CI matrix and README corrections.

**Tech Stack:** Node 22+, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-03-audit-tier4-cleanup-design.md`

## Global Constraints

- Zero runtime dependencies; Node `>=22`; `npm test` = `node --test "scripts/lib/**/*.test.mjs"`.
- The LOAD-BEARING zero-proposal fixtures (gap-model, detect-cli, lifecycle) stay at zero proposals.
- Nothing from a user's file beyond paths, counts and line numbers enters `detect.json`; no credential value is ever printed.
- Hook output passes the shared chokepoint; a hook never writes inside the repository.
- Stale comments and sentences a change falsifies are rewritten in the same task; removed code takes its tests and docs with it.
- Commit after each task on `fix/audit-findings`; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A repository with `docs/harness/RULES.md` present must not be asked the instruction-file question; one without it still is — Task 1.
2. A `.claude/settings.json` indented with four spaces, patched and then reverted, must come back byte-identical — Task 3.
3. A rule text containing U+202E (right-to-left override) must reach the model without it — Task 5.
4. A `pnpm-workspace.yaml` with `catalog:` entries must yield only the `packages:` globs — Task 7.
5. After the split, every test that was in `lifecycle.test.mjs` still exists under one of the three files (count them) — Task 9.

---

### Task 1: Questions that can be answered

**Files:** Modify `scripts/lib/report.mjs` (`deriveCouldNotDerive`), `scripts/lib/gap-model.mjs` (`P1.pathrules`, `P3.intent`), `scripts/apply.mjs` (`reportWhatDetectionFound`); Test `report.test.mjs`, `gap-model.test.mjs`, `lifecycle.test.mjs` (the apply questions line).

- [ ] **Step 1: Failing tests** — report: `the instruction-file question is asked only while no rules registry exists` (checks with P1.instructions declared and P3.rules absent → asked; P3.rules declared → not asked). gap-model: `P1.pathrules is n/a with no question on a single-package repository without rule files`; `P3.intent is declared when the instruction file points at a document named for intent or purpose` (harness with `docPointers: ['docs/PRODUCT.md']`, no INTENT.md). lifecycle: `apply prints the questions it could not answer inline, not a pointer to detect` (fixture without ARCHITECTURE.md → dry run stdout matches `/could not answer:\n/` and the question text; does not match `/node scripts\/detect\.mjs/`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D1; rewrite the `P1.pathrules` comment paragraph that justifies asking.
- [ ] **Step 4: Run the three files, then `npm test`** — Expected: PASS (the `deriveCouldNotDerive` count tests may need the registry state in their fixtures — adjust only fixtures, never assertions about behaviour).
- [ ] **Step 5: Commit** `fix(detect): a question detect asks can be answered — registry, n/a, intent pointer, inline`

### Task 2: The report is the kit's own write

**Files:** Modify `scripts/lib/report.mjs` (export `DETECT_REPORT_PATH`), `scripts/detect.mjs`, `scripts/apply.mjs` (`ownedByUs`), `README.md` (`detect` section); Test `lifecycle.test.mjs`.

- [ ] **Step 1: Failing test** — `a tracked, re-generated docs/harness/detect.json does not trip the dirty-tree gate` (fixture; `detect`; commit the report; `detect` again (generatedAt changes); `apply --yes` → exit 0).
- [ ] **Step 2: Run** — Expected: FAIL (exit 3).
- [ ] **Step 3: Implement** per spec D2.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(apply): the detect report is the kit's own write and never trips the dirty-tree gate`

### Task 3: Settings indentation

**Files:** Modify `scripts/lib/apply-lib.mjs` (`detectIndent`, `isCanonicalJson`, the write), `scripts/lib/uninstall-lib.mjs` (the write); Test `apply-lib.test.mjs`, `uninstall-lib.test.mjs`, `lifecycle.test.mjs`.

- [ ] **Step 1: Failing tests** — apply-lib: `detectIndent reads two spaces, four spaces and a tab, and defaults to two`; `a four-space settings.json is patched with four spaces`; `isCanonicalJson accepts a four-space file as canonical`. uninstall-lib: `reverting a patch keeps the file's four-space indentation`. lifecycle: `a four-space settings.json round-trips apply --yes then uninstall --yes byte-identical`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D3; update `settingsReformattedNote` and the two comments that say "always rewrites it as JSON.stringify(settings, null, 2)".
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(apply): settings.json keeps its indentation`

### Task 4: The report's shape

**Files:** Modify `scripts/lib/report.mjs` (`repo.name`, header), `scripts/lib/detect-harness.mjs` (`projectDocs` cap + `projectDocCount`), `scripts/lib/gap-model.mjs` (the two sentences); Test `report.test.mjs`, `detect-cli.test.mjs`, `detect-harness.test.mjs`, `gap-model.test.mjs`.

- [ ] **Step 1: Failing tests** — `detect.json names the repository, never its absolute path` (CLI `--json`: `repo.name === basename(d)`, `'root' in repo === false`, `JSON.stringify(report).includes(d) === false`); `projectDocs is capped at 25 with the total beside it` (30 doc-shaped files → 25 listed, `projectDocCount` 30); `the documentation-shaped question states the total, not the listed count`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D4.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(detect): the report names the repository and caps the document list`

### Task 5: Re-injection hygiene

**Files:** Modify `assets/scripts/rules-brief.mjs`; Test `rules-brief.test.mjs`.

- [ ] **Step 1: Failing tests** — `control and bidirectional-format characters never reach the injected context` (a rule text assembled with `‮` and `\u0007` → `additionalContext` holds neither); `the injected block is delimited and names its source` (starts with `<project-rules source="docs/harness/RULES.md">`, ends with `</project-rules>`); the byte bound still holds with the delimiter counted.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D5; update the header comment's "Bounds and redaction" list.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(hooks): the re-injection hook strips control and bidi characters and delimits its block`

### Task 6: Marker directory

**Files:** Modify `assets/scripts/harness-redact.mjs` (`markerDir`, `markerPath`, `writeJSONMarker`); Test `harness-redact.test.mjs`.

- [ ] **Step 1: Failing tests** — `writeJSONMarker refuses to follow a symlink planted at the marker path` (POSIX only: `t.skip` on win32; plant a symlink at the marker path pointing at a file outside; write; the target is unchanged, the call returns false); `markerPath refuses a symlinked repository directory` (same guard). On win32 add `a junction planted at the marker directory is refused` using `symlinkSync(…, 'junction')` and `lstat`.
- [ ] **Step 2: Run** — Expected: FAIL on the platform that runs it.
- [ ] **Step 3: Implement** per spec D6.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(hooks): the marker directory is never a link and never another user's`

### Task 7: Small truths

**Files:** Modify `scripts/lib/apply-lib.mjs` (remove the redirect; `ALLOWED_EXACT`), `scripts/apply.mjs` (remove `redirected`; chmod hint), `scripts/lib/uninstall-lib.mjs` (producible list), `scripts/lib/cli.mjs:146`, `README.md:133`, `scripts/lib/detect-stack.mjs` (`workspacePatterns`), `scripts/lib/detect-exposure.mjs` (dangling symlink), `scripts/lib/gap-model.mjs` (advice cap), `scripts/lib/scan.mjs` + `scan.test.mjs` (blind-spot wording); Test `apply-lib.test.mjs` (delete the two redirect tests, add `a CLAUDE.md proposal is refused by the allowlist`), `detect-stack.test.mjs`, `detect-exposure.test.mjs`, `gap-model.test.mjs`, `lifecycle.test.mjs` (chmod hint on win32).

- [ ] **Step 1: Failing tests** — `assertAllowed refuses CLAUDE.md`; `pnpm-workspace.yaml catalog entries are not workspace globs`; `a dangling symlink in the scan list is skipped silently` (POSIX/junction guard as in Task 6); `advice lists at most ten line numbers and says how many more`; `apply on win32 prints the execute-bit hint after writing bootstrap.sh` (skip elsewhere).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec D7. For the blind-spot item: run the existing `.git-as-file` test's fixture through the current scanner by hand; if it is detected, the comment and test are rewritten to say so; if not, the audit was wrong and the ledger says so.
- [ ] **Step 4: Run, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `chore: remove the dead CLAUDE.md redirect; pnpm catalog, dangling links, chmod hint, advice cap`

### Task 8: Docs and CI

**Files:** Modify `README.md`, `scripts/lib/cli.mjs`, `skills/harness-init/SKILL.md`, `.github/workflows/ci.yml`; Test `skill-phases.test.mjs` (if it pins the row), create `scripts/lib/plugin-version.test.mjs`.

- [ ] **Step 1: Failing test** — `plugin.json and package.json carry the same version`. (Passes only if they do; check and align.)
- [ ] **Step 2: Implement** per spec D8.
- [ ] **Step 3: Run `npm test`** — Expected: PASS.
- [ ] **Step 4: Commit** `docs(ci): four hooks, the eval job as it is, Phase 2 is steps 8–12, Node 22 and 24, the CLI before npm test`

### Task 9: Tests

**Files:** Create `scripts/lib/lifecycle-fixtures.mjs`, `scripts/lib/lifecycle-gates.test.mjs`, `scripts/lib/lifecycle-regressions.test.mjs`; Modify `scripts/lib/lifecycle.test.mjs`, `scripts/lib/verify-touched.test.mjs`.

- [ ] **Step 1:** Count `test(` in `lifecycle.test.mjs` (N). Move the fixtures and helpers into `lifecycle-fixtures.mjs`; move the sections per spec D9. Assert the three files together hold N tests (ledger).
- [ ] **Step 2:** Rewrite `TIMEOUT: a second Stop … SKIPS` on a counting fixture (the command appends to a file outside the repo; assert one run after two Stops). Watch the old assertion go away, not fail.
- [ ] **Step 3: Run `npm test`** — Expected: PASS; record the suite wall time before and after in the ledger.
- [ ] **Step 4: Commit** `test: split the lifecycle suite; the Stop-gate skip test counts runs instead of milliseconds`

### Task 10: Record what changed

- [ ] Status lines under findings 20, 21, 22, 23, 25, 26, 27 and the Tier 4 list. `npm test`. Commit `docs: Tier 4 audit fixes — status in the findings report`.
