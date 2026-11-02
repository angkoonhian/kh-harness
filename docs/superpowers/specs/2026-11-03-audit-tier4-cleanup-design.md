# Audit fixes, Tier 4 — cleanup, docs, CI and tests (design)

- **Date:** 2026-11-03
- **Source:** `docs/2026-11-02-audit-findings.md`, findings 20, 21, 22, 23,
  25, 26, 27 and the Tier 4 list.
- **Branch:** `fix/audit-findings`, after the Tier 3 commits.

## Intent

What is left after Tiers 1–3 is noise and untruth of the small kind: three
questions `detect` asks on every run that no answer can silence; a
committed report that changes on every run and refuses the next `apply`;
a settings file re-indented by a tool that promised to leave the rest
alone; a machine username in a committed file; a re-injection hook that
would pass a bidi override through to the model; a marker directory that a
pre-created symlink can redirect; dead code documented as live; a README
that counts three hooks where the table has four; a CI job that never
exercises the Node version the kit says it supports; a 1,458-line test
file that bounds the suite's wall time. None changes what the kit does for
a repository that is already correct; each makes one sentence true.

## Goals

1. A question `detect` asks is one the user can make go away by answering
   it: the instruction-file question stops once a rules registry exists;
   a single-package repository's path-rules check is `n/a`, not a
   question; an intent pointer in the instruction file is honoured; and
   `apply` prints the questions it holds instead of sending the user to
   `detect`.
2. A committed `docs/harness/detect.json` does not make the next `apply`
   refuse.
3. `.claude/settings.json` is written with the indentation it had.
4. `detect.json` carries the repository's name, not its absolute path, and
   at most 25 documentation-shaped paths plus the total count.
5. The re-injection hook strips control and bidirectional-format characters
   from every rule it emits and wraps the block in a delimiter naming its
   source.
6. The hook marker directory is not followed through a symlink and not
   shared with another user on POSIX.
7. The dead `apply`-side CLAUDE.md redirect is removed; the skill's
   `CLAUDE.proposed.md` workflow (a prompt, not `apply`) stays and is what
   the docs describe. A `pnpm-workspace.yaml` `catalog:` entry is not a
   workspace glob. A dangling symlink the scan lists is a silent skip, not
   a permanent `high` finding. `apply` on Windows prints the
   `git update-index --chmod=+x` hint for an executable it wrote. Advice
   lists at most 10 line numbers.
8. README, the usage text, `SKILL.md` and `ci.yml` say what is true: four
   hooks; `uninstall` reverts the hooks it installed; the eval job runs on
   `workflow_dispatch` with either credential; Phase 2 is steps 8–12; CI
   runs Node 22 and 24 and installs the CLI before `npm test` on Linux; a
   test ties `plugin.json`'s version to `package.json`'s.
9. The lifecycle suite is three files on a shared fixture module, and the
   Stop gate's "skips re-running" test asserts that the command did not run
   rather than that it took under 300 ms.

## Non-goals

- Changing any check's state for a repository that is already correct
  (the LOAD-BEARING zero-proposal fixtures stay zero).
- A format-preserving JSON editor: indentation and the trailing newline are
  matched; key order and inline spacing are not.
- Removing the skill's CLAUDE.proposed.md step.

## Decisions

### D1. Questions (`report.mjs`, `gap-model.mjs`, `apply.mjs`)

- `deriveCouldNotDerive` emits the "which of its rules cannot be re-derived"
  question only while no `P3.rules` registry exists (`P3.rules` state
  `absent`). Once a registry exists the question has a home, and
  `P3.rules`' advice already names the rule-shaped lines.
- `P1.pathrules` on a non-workspace with no rule files returns
  `{ state: 'n/a', evidence: ['single-package repository — no sub-directory split to scaffold a rule file for'] }`
  and no question.
- `P3.intent`, after the canonical file and before the documentation-shaped
  question, honours `harness.docPointers` whose basename matches
  `/intent|purpose|vision|product|prd/i` as `declared`, with the same
  evidence shape `P1.architecture` uses.
- `apply.mjs` prints the questions inline under
  `kh-harness: N question(s) this run could not answer:` instead of
  pointing at `detect`.

### D2. The report is the kit's own write (`apply.mjs`, `detect.mjs`, `report.mjs`)

- `DETECT_REPORT_PATH = 'docs/harness/detect.json'` is exported from
  `report.mjs` and used by `detect.mjs`'s write and by `apply.mjs`'s
  `ownedByUs`, so a tracked, re-generated report never trips the dirty
  gate. README's `detect` section says so.

### D3. Settings indentation (`apply-lib.mjs`, `uninstall-lib.mjs`)

- `detectIndent(raw)` → `'\t'` or a run of spaces, from the first line of
  `raw` that starts with whitespace; `2` spaces when none. Both writers
  stringify with it; `isCanonicalJson(raw)` compares against the same.

### D4. The report's shape (`report.mjs`, `detect-harness.mjs`)

- `repo.name: basename(root)` replaces `repo.root`. `renderSummary`'s header
  prints the name. `harness.projectDocs` holds at most 25 paths;
  `harness.projectDocCount` holds the total; the two checks that read it
  use the count in their sentence.

### D5. Re-injection hygiene (`rules-brief.mjs`)

- Each emitted line passes `stripUnsafe` (removes U+0000–U+0008, U+000B,
  U+000C, U+000E–U+001F, U+007F–U+009F, U+200B–U+200F, U+202A–U+202E,
  U+2066–U+2069, U+FEFF) before `maskCredentials`. The block is
  `<project-rules source="docs/harness/RULES.md">` … `</project-rules>`.

### D6. Marker directory (`harness-redact.mjs`)

- On POSIX, `markerDir` and `markerPath` refuse a directory that `lstat`
  reports as a symlink or whose `uid` is not the process's; refusal means
  the callers' existing fail-open paths (`readJSONMarker` → fallback,
  `writeJSONMarker` → `false`). `writeJSONMarker` opens with `O_NOFOLLOW`
  where the platform defines it.

### D7. Small truths

- `resolveFileTarget`, `CLAUDE_REDIRECT_PATH`, the `redirected` result and
  `apply.mjs`'s `redirected` line go; `CLAUDE.md` leaves `ALLOWED_EXACT`, so
  a future generator cannot write it without a deliberate change. README
  and the usage text say "`apply` never writes `CLAUDE.md`; the skill
  drafts `docs/harness/CLAUDE.proposed.md` for you to merge".
  `uninstall-lib`'s producible list drops the redirect path (nothing of
  `apply`'s ever lands there).
- `workspacePatterns` reads only the `packages:` list of
  `pnpm-workspace.yaml`.
- `openAndRead`: an `ENOENT` on a path that `lstat` reports as a symlink is
  a silent skip (a dangling link holds no bytes to examine).
- `apply.mjs` prints, after `wrote scripts/bootstrap.sh` on `win32`, one
  line: `note: Windows cannot record the execute bit — run \`git update-index --chmod=+x scripts/bootstrap.sh\` before committing`.
- The `scan.mjs` "known blind spot" comment and its test are checked
  against the current detector; whichever is wrong is corrected.
- `P3.rules` advice lists the first 10 line numbers and `… and N more`.

### D8. Docs and CI

- README: "four Claude Code hooks"; "`uninstall` reverts the hooks it
  installed and removes their scripts"; the CI paragraph describes
  `workflow_dispatch`, the two credentials and the skip; `cli.mjs:76` the
  same for "both hooks".
- `SKILL.md` Phase 2 row: `8, 9, 10, 11, 12` with kinds
  `advise, script, script, script, advise`.
- `ci.yml`: `node-version: ['22', '24']`; the CLI install step runs before
  `npm test` on Linux so the LOAD-BEARING plugin-manifest test executes in
  the suite there.
- New test `plugin.json and package.json carry the same version`.

### D9. Tests

- `lifecycle-fixtures.mjs` exports `fixture`, `workspaceFixture`,
  `freshFixtureNoClaudeDir`, `git`, `run`, `settings`, `manifestOf`,
  `linesAfter`, the three CLI paths. `lifecycle.test.mjs` keeps the
  install/uninstall cycles; `lifecycle-gates.test.mjs` takes the gate,
  drift, dry-run and exit-code tests; `lifecycle-regressions.test.mjs`
  takes the review-finding regressions and Phase 3.
- `TIMEOUT: a second Stop … SKIPS re-running` uses a counting fixture and
  asserts the run count, not elapsed time.

## Left to the builder

Test names and exact fixtures are in the plan; the split is by the section
headers the file already has.
