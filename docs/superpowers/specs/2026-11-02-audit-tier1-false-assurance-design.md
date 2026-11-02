# Audit fixes, Tier 1 — false assurance (design)

- **Date:** 2026-11-02
- **Source:** `docs/2026-11-02-audit-findings.md`, Tier 1 (findings 1–4) plus
  finding 5, which lives in the same gate code as finding 3.
- **Branch:** `fix/audit-findings`, stacked on `feat/intent-and-rules`.

## Intent

Four places where kh-harness currently says something untrue: the credential
sweep reports `verified` over live-shaped secrets; the per-edit lint sensor
drops every diagnostic for common lint-script shapes and reports nothing; the
two `apply` safety gates can be bypassed by a repository with no commits, a
non-`main` default branch or any git error; and on a Windows checkout the
kit's own files classify as user-modified, which disables update and clean
uninstall. Each fix turns a false statement into a true one. None adds a
flag, an ignore list or a score.

## Goals

1. A tree holding any of today's common token shapes (`sk-proj-`, `sk-ant-`,
   `npm_`, `github_pat_`, `AIza`) is `failing`, and a placeholder
   (`Bearer YOUR_TOKEN_HERE`) is not.
2. A literal credential on line 2 is found even when line 1 holds a
   placeholder; a JSON-quoted key (`"password": "…"`) is found; an `.npmrc`
   `_authToken=${NPM_TOKEN}` is a reference, not a literal.
3. A fixture password under `tests/` is *listed* at severity `low` and does
   not by itself make `P0.security` `failing`. A provider token under
   `tests/` stays `high`: a live key is live wherever it sits.
4. Lint and typecheck diagnostics that name a directory of the edited file
   or a config file survive layer-1 redaction; a `--token=…` fragment still
   drops.
5. `apply --yes` refuses on an unborn `main`, on the branch named by
   `init.defaultBranch` or `origin/HEAD`, and when git cannot answer (not
   installed, dubious ownership) — the last with both waivers named. A dry
   run is never refused; it notes what `--yes` would refuse.
6. A kit file rewritten to CRLF by the checkout is `ours-unmodified`; a CRLF
   file with a real edit stays `ours-modified`.

## Non-goals

- No path-based *exclusion*: a path role lowers severity, never visibility.
  Findings in test paths are still listed and still in `detect.json`.
- No change to what `detect` prints for tokens: location, kind, severity and
  now a line number. Never a value.
- No format-preserving JSON editing (settings indentation is Tier 3).
- No new flags.

## Decisions

### D1. Credential sweep (`scripts/lib/detect-exposure.mjs`)

- Every `TOKEN_PATTERNS` entry is global and word-bounded (`\b`): the old
  `/sk-[A-Za-z0-9]{20,}/` matched inside `desk-…`. The `sk-` rule accepts `_`
  and `-` in the body so `sk-proj-…` and `sk-ant-api03-…` match.
- Added shapes: `npm_[A-Za-z0-9]{36}`, `github_pat_[A-Za-z0-9_]{22,}`,
  `AIza[0-9A-Za-z_-]{35}`.
- A token match whose text (after a `Bearer ` scheme) matches `PLACEHOLDER`
  is skipped. A file is a token finding iff at least one match survives.
- `DB_CRED` becomes global, accepts an optional closing quote after the key,
  and widens the key alternation to
  `password|passwd|pwd|api[_-]?key|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token`.
  (`auth[_-]?token` covers `.npmrc`'s `_authToken`.) Bare `secret` and
  `token` are deliberately excluded: a probe over this repository found 48
  `token:` matches, all prose.
- Every `DB_CRED` match is examined. Placeholders are tested on the VALUE
  only (previously on key+value, so `example_password: real` was hidden). The
  file yields one `credentials-in-doc` finding: `valueKind: 'literal'` if any
  surviving match is literal, else `'reference'`.
- `classifyCredentialValue` treats environment interpolation as a reference:
  `$VAR`, `${VAR}`, `%VAR%`, `${{ secrets.X }}`.
- Every finding carries `line` — the 1-based line of the first qualifying
  match. Line numbers are the one thing from a user's file the doctrine
  allows into `detect.json`.
- The kit's own fixtures that the widened keys now match are assembled at
  runtime (the DOGFOOD discipline), and `CREDENTIAL_RULES` in
  `harness-redact.mjs` is restructured so no key sits directly against an
  `=` inside a regex literal.

### D2. Path role (`detect-exposure.mjs`, `gap-model.mjs`, `report.mjs`)

- `pathRole(rel)` returns `'test'` when a directory segment is one of
  `test, tests, __tests__, spec, specs, fixtures, __fixtures__, testdata,
  mocks, __mocks__, e2e` or the basename matches `*.test.*`, `*.spec.*`,
  `test_*.py`, `*_test.py`, `*_test.go`; otherwise `null`.
- Only a `credentials-in-doc` finding with `valueKind: 'literal'` is affected:
  it is recorded with `severity: 'low', pathRole: 'test'`. Tokens, PEM
  blocks and unreadable files are never demoted.
- `P0.security` is `failing` iff an unreadable file exists or a credential
  finding with severity other than `low` exists. When only `low` findings
  exist, the state is `verified` and the evidence is the shared
  `fixtureExposureNote(count)`, which says they are listed under Exposures
  at severity `low` and should still be read.
- The Exposures section prints `kind at location:line` when `line` is set.
- README: the `P0.security` paragraph gains one sentence on test-path
  severity and keeps the "there is no ignore list" statement, which stays
  true.

### D3. Redaction exemptions (`assets/scripts/harness-redact.mjs`)

- New `pathTokenExemptions(command, paths = [])` returns the command tokens
  that are (a) a directory prefix of one of `paths` (`src/components` for
  `src/components/Button.tsx`, with a `./` prefix tolerated) or (b) shaped
  like a config file: ending in `.json|.yaml|.yml|.toml|.js|.cjs|.mjs|.ts|
  .cfg|.ini|.conf` or a dotted `*rc` name such as `.eslintrc`, including
  when attached to a flag (`--config=eslint.config.js`).
- `lint-touched.mjs` adds `pathTokenExemptions(lintScript, [relToOwner])` to
  its exemption set. `verify-touched.mjs` passes
  `pathTokenExemptions(picked.command)`. `dropCommandFragments` is unchanged.

### D4. Gates (`scripts/lib/git-info.mjs`, `scripts/apply.mjs`, `scripts/detect.mjs`)

- `gitInfo(root)` → `{ isRepo, branch, error }`. `isRepo` comes from
  `rev-parse --is-inside-work-tree`; `branch` from
  `symbolic-ref --short -q HEAD` (works on an unborn branch; exit 1 on a
  detached HEAD → `null`). A "not a git repository" failure is
  `isRepo: false, error: null`; any other failure (ENOENT, dubious ownership)
  is `isRepo: false` with `error` set to one line that never includes the
  command.
- New `defaultBranches(root)` → `['main', 'master']` plus
  `init.defaultBranch` and the branch `refs/remotes/origin/HEAD` points at.
  Called by `apply` only, so `detect` gains no spawns.
- `hasTrackedChanges` → `{ dirty, error }`; an error no longer means clean.
- `apply`: both gates run only under `--yes`. Refusals (exit 3): default
  branch unless `--allow-default-branch`; dirty tree unless `--allow-dirty`;
  `git.error` unless BOTH waivers are given; dirty-check error unless
  `--allow-dirty`. A dry run prints, after the diffs, one `note:` line per
  gate `--yes` would trip. README's flag table and dry-run sentence are
  updated to match.
- `detect` writes one stderr warning when `git.error` is set; the report is
  otherwise unchanged (`vcs: null`).

### D5. CRLF-tolerant classification (`scripts/lib/manifest.mjs`)

- `classify` compares the raw hash first; on mismatch, and only when the
  bytes contain a CR, it compares the hash of the content with `\r\n`
  normalised to `\n`. Manifests keep recording LF hashes.
- `uninstall` therefore removes a CRLF-converted scaffold; `apply` updates a
  CRLF-converted asset. README's "bytes on disk still match" and RULES.md R6
  say "identical up to line endings"; `rules-brief.mjs`'s comment no longer
  cites autocrlf as a reason the remedy fails (hand edits remain one).

## Left to the builder

Exact test names and the fixture shapes are in the plan. The DOGFOOD run
decides which of this repository's own files the widened keys hit; each is
fixed by assembling the fixture at runtime or rewording, never by a detector
exception.
