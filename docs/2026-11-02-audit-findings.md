# kh-harness audit — existing functionality, issues and inefficiencies

- **Date:** 2026-11-02, branch `feat/intent-and-rules` @ `d0f2b31` (Phase 3 included)
- **Method:** three parallel read-only audits (detection path; installed hooks; apply/uninstall/CLI/docs/tests), each probing throwaway fixtures, plus my own measurements on local clones of real repositories. Every finding marked **[confirmed]** was reproduced by me directly; the rest were reproduced by an auditor with a probe and cite file:line.
- **Numbers that frame everything:** `detect` on cashmigo (1,422 files) = 2.3 s warm. Of that, ~0.6 s is six `git` spawns and ~0.4 s is the credential sweep reading 1,355 files (10 MB) with two path lookups each. Regexes cost 8 ms. Each installed hook invocation costs ~260 ms of bash wrapper plus ~100 ms of Node before it does anything; a 3-edit turn pays ~2.5–3 s of overhead before a single real lint or typecheck runs.

---

## Tier 1 — false assurance (fix first; each makes the tool say something untrue)

**1. The credential sweep reports `verified` over live-shaped secrets.** [confirmed]
`scripts/lib/detect-exposure.mjs:37-49`. A tree holding `//registry.npmjs.org/:_authToken=npm_…` in `.npmrc` (a file the sweep *always probes*), an `sk-proj-…` OpenAI key and a second literal `password:` after a placeholder yields `P0.security: verified`, `exposures: []`. Causes: `TOKEN_PATTERNS` predate today's shapes (`sk-proj-`, `sk-ant-api03-`, `npm_`, `github_pat_`, `AIza`); the `sk-` rule stops at the first hyphen; `DB_CRED` keys are only password/passwd/pwd (no `_authToken`, `api_key`, `secret`, `client_secret`); only the **first** `DB_CRED` match per file is examined (`:325-333`), so a placeholder on line 1 hides a literal on line 2; `isPlaceholder` is never applied to Bearer tokens, so `Bearer YOUR_TOKEN_HERE` is a permanent `high`. Combined with the earlier finding that the same check is `failing` on every real repo because of test-fixture passwords, the check is currently both noisy and blind.
*Fix:* add the five patterns; widen the key alternation; iterate `matchAll` and report `literal` if any match is literal; apply `isPlaceholder` to token matches; classify by path role (tests/, fixtures/, compose, CI) so fixture hits are reported but do not drive `failing`.
*Status (2026-11-02): fixed on `fix/audit-findings` — all of the above; findings also carry a line number; `$VAR`, `${VAR}`, `%VAR%` values are references. Tests: `finds today's provider token shapes…`, `a literal credential after a placeholder…`, `a literal password under tests/ is reported at severity low…`, `a repository whose only literal credential hits are in test paths is verified…`.*

**2. The per-edit lint sensor silently drops every diagnostic for common lint-script shapes.** [confirmed]
`assets/scripts/harness-redact.mjs:82-106` (`dropCommandFragments`), applied at `lint-touched.mjs:507`. Layer-1 redaction drops any output line containing a command token of 8+ characters. With `eslint src/components`, `ruff check backend/app` or `eslint -c .eslintrc.cjs .`, every diagnostic names that path and is dropped; the hook exits 0 and Claude is told nothing. Only short directory names (`src/ui`) survive. This is the sensor's single purpose failing silently.
*Fix:* exempt command tokens that are path-like prefixes of the edited file or look like config files (`/\.(json|ya?ml|toml|[cm]?js)$/`) from the fragment list.
*Status (2026-11-02): fixed on `fix/audit-findings` — `pathTokenExemptions` in the shared asset, wired into both hooks; a credential-shaped flag is never exempt. Tests: `a lint script that names the edited file's directory still reports its diagnostics`, `a diagnostic naming a config file passed on the command line survives redaction`.*

**3. Both safety gates can be bypassed without anyone asking.** [confirmed]
`scripts/lib/git-info.mjs:6` uses `rev-parse --abbrev-ref HEAD`, which fails on a repository with no commits → `isRepo:false` → `apply --yes` on an unborn `main` writes everything with no gate (reproduced). `apply.mjs:23` knows only `main`/`master` (a `trunk` repo is ungated). `hasTrackedChanges` and `gitInfo` return false on **any** git error (e.g. `safe.directory` "dubious ownership"), waiving both gates.
*Fix:* `git symbolic-ref --short -q HEAD` for the branch, `rev-parse --is-inside-work-tree` for `isRepo`, compare against `init.defaultBranch`; treat a non-zero `git status` as a refusal.
*Status (2026-11-02): fixed on `fix/audit-findings` — as described, plus `origin/HEAD`; a git that cannot answer refuses unless both waivers are given. Tests: `scripts/lib/git-info.test.mjs`, `scripts/lib/apply-gates.test.mjs`.*

**4. On Windows the kit's own files look user-modified, so nothing can be updated or uninstalled.** [confirmed on cashmigo]
`scripts/lib/manifest.mjs` `classify` hashes raw bytes; with `core.autocrlf=true` a checkout, `stash pop` or renormalise rewrites every installed file to CRLF. Measured: `harness-redact.mjs` on disk hashes `c9dc2000…`, manifest records `f0a1c1de…`. Result: `apply` says `kept (modified)` for all eight files, `uninstall` keeps all eight, and the new upgrade path never fires.
*Fix:* on hash mismatch, retry once against `toString('utf8').replace(/\r\n/g,'\n')`; keep recording LF hashes.
*Status (2026-11-02): fixed on `fix/audit-findings` — as described, one way only. Tests: `classify: a file we wrote that a CRLF checkout rewrote is still ours-unmodified`, `a scaffold the checkout converted to CRLF is still removed`, `apply after a CRLF conversion of the kit's own files reports no "kept (modified)"`.*

---

## Tier 2 — correctness and robustness

**5. A dry run on the default branch is refused before it shows anything.** [confirmed] `apply.mjs:45,141` apply both gates regardless of `--yes`; README says "read the diffs — nothing is written". *Fix:* gate only when `--yes`.
*Status (2026-11-02): fixed on `fix/audit-findings` — gates run under `--yes` only; a dry run prints a `note:` per gate `--yes` would trip. Test: `a dry run on the default branch is not refused and notes what --yes would do`.*

**6. `ls-files -s` is split on whitespace, truncating paths with spaces.** `scan.mjs:102-104`. A gitlink at `my sub dir` is recorded as `my`. *Fix:* split at the first tab.

**7. `settings.json` `hooks` shape is unvalidated; identical commands under different matchers are treated as equal.** `apply-lib.mjs:264-271` validates `permissions` only; `{"hooks":{"Stop":{…}}}` → TypeError → exit 2 after the dry run promised success. `settings-merge.mjs:49-53` `hasEquivalentHook` ignores the matcher, so a user's same command under `Bash` suppresses our `Write|Edit` entry. *Fix:* validate hooks like permissions; compare matcher too.

**8. The manifest is written once, non-atomically, at the end, and never records the upgrading version.** `manifest.mjs:222-226`, `apply.mjs:350`, `apply-lib.mjs:733`. A kill mid-batch orphans every written file as `theirs` forever; `kitVersion` stays 0.1.0 after 0.2.0 files land. *Fix:* write `.tmp` + `renameSync`; set `nextManifest.kitVersion = kitVersion`.

**9. `--verify` mutates the tree it verifies and hides what failed.** `verify.mjs:4,9`. `build` runs (wrote 1,350 `.js` files into `src/` on a fixture), output is `stdio:'ignore'`, a timeout is recorded as `exitCode:1`. *Fix:* drop `build` or warn; record `timedOut`; capture bounded output; set `CI=1`.

**10. Stop gate and lint sensor do far more work than the edit warrants.** `verify-touched.mjs:277-304` runs the whole typecheck/test on turns that changed nothing (read-only Q&A turns included). `lint-touched.mjs:453` appends the file to `eslint .`, which still lints the whole project; appended to a pipeline (`a | b`, `a && b`) the path lands on the last stage (a `tee` tail overwrote the edited file in a probe). The lint timeout kills only the shell and orphans the linter (`:463-471`), the bug `verify-touched` already fixed for itself. *Fix:* fingerprint HEAD + `status --porcelain` and skip an unchanged tree; strip a trailing `.` target before appending; never append to a command containing `|&;` or `$(`; share `killTree`.

**11. Hooks are registered cwd-relative in shell form.** `propose.mjs:178,243,532,562` (`node .claude/scripts/…`). The Claude Code reference recommends absolute paths / exec form with `${CLAUDE_PROJECT_DIR}`; when cwd ≠ root the launcher cannot find the script, and the bash wrapper costs ~260 ms per invocation (~1.1–1.5 s per 3-edit turn). *Fix:* exec form `{command:"node", args:["${CLAUDE_PROJECT_DIR}/.claude/scripts/…"]}`; `hasEquivalentHook` must then compare `args`.

**12. `verify-touched` misreports on overflow and writes invisible messages.** `:223-232` discards the whole chunk that crosses `maxBuffer` and kills, so a passing verbose command exits 2 "blaming redaction"; `:346-357` write stderr with exit 0, which Claude Code never shows. *Fix:* slice the chunk, let the command finish; use `{"systemMessage": …}` on stdout.

**13. `P2.protected` compares deny rules by exact string.** `gap-model.mjs:875,885`. A user's `Edit(package-lock.json)` is reported as "unrelated" and `Edit(*-lock.json)` is proposed on top. *Fix:* compare by what the globs match in `files` (both helpers exist in `glob.mjs`).

**14. The fallback walk enumerates `node_modules` before filtering.** `scan.mjs:219-228`. A non-git checkout with 20,000 files under `node_modules`: 2,633 ms vs 11 ms with directory-level pruning. *Fix:* a ten-line recursive walk that skips `EXCLUDE_DIRS` at the directory.

**15. `uninstall` exits 0 with a hook still registered, and leaks `why` into the manifest.** `uninstall.mjs:220`, `uninstall-lib.mjs:831,938`. *Fix:* count `patchesNotReverted` in the exit-2 condition; strip `why` before persisting.

**16. `detect` can crash with exit 1.** `detect.mjs:66-68` unguarded `mkdirSync`/`writeFileSync` (`docs` is a file, EACCES). README says a crash is a bug. *Fix:* try/catch → exit 2.

---

## Tier 3 — inefficiencies and noise (each small; several compound)

**17. Six `git` spawns per `detect`, four of them `ls-files` variants, one fully derivable.** [confirmed] `scan.mjs:98,101,122,203`: `-co` equals the paths of `-s` plus `-o`. ~80 ms per spawn on Windows. *Fix:* derive tracked paths from `-s`; drop the fourth spawn.

**18. Two path lookups per swept file.** `detect-exposure.mjs:228,269` (`statSync` then `readFileSync`); ~48 % of a `detect` run on 1,400 files. *Fix:* `openSync` → `fstatSync` → `readSync` once.

**19. First-run dry run prints 1,833 lines / 88 KB, then `--yes` prints it all again.** 1,570 of those lines are verbatim copies of the kit's own shipped hook scripts. *Fix:* for a new file whose contents equal a shipped asset print `+N lines (verbatim copy of assets/scripts/X)`; skip diffs under `--yes`.

**20. Three questions recur on every run with no way to answer them.** `report.mjs:39-41` ("which CLAUDE.md rules cannot be re-derived" — forever), `gap-model.mjs:577-581` (path rules on every non-workspace — a state, not a gap; should be `n/a`), the architecture/intent "is one of these N docs the document?" (P1.architecture honours a CLAUDE.md pointer; P3.intent does not). On this repository 4 of 5 `couldNotDerive` lines are of this kind. `apply.mjs:199-203` then tells the user to run `detect` to read a sentence `apply` already holds. *Fix:* one-time note; `n/a`; accept `docPointers` in P3.intent; print questions inline.

**21. `detect` modifies a tracked `docs/harness/detect.json`, so the next `apply` refuses.** [confirmed on cashmigo] `generatedAt` changes every run; the path is not in `apply`'s own-writes set. *Fix:* add it to `ownedByUs`; README to say gitignore it.

**22. `settings.json` indentation churn** (4-space file rewritten as 2-space). *Fix:* detect indent from the raw text.

**23. `detect.json` writes the absolute root path (machine username) into a committed file** and lists every doc-shaped path. *Fix:* basename; cap `projectDocs`.

**24. Hook credential mask gaps** (`harness-redact.mjs:109-119`): `npm_`, `gh[ousr]_`, `sk_live_`, `AIza`, JWTs, URL userinfo, `Basic …`, `"password": "x"`, private-key blocks, `glrt-`, `xapp-`, `hf_`, `dckr_pat_`, `pypi-`. Ruff/biome print source snippets, so a secret in a linted file reaches stderr unless a rule matches. *Fix:* ~8 rules (the auditor's list is in the hooks report).

**25. Re-injection hook: no control/bidi stripping, no delimiter.** `rules-brief.mjs:103`. *Fix:* strip `​-‏‪-‮⁦-⁩` and control chars; wrap in `<project-rules source=…>`.

**26. Marker directory on POSIX is predictable and `mkdirSync` accepts a foreign pre-created dir; `writeFileSync` follows a planted symlink.** `harness-redact.mjs:518-607`. *Fix:* `lstat` + owner check; `O_NOFOLLOW`.

**27. Small things:** `pnpm-workspace.yaml` parser takes every `- item` (`catalog:` becomes a glob); a dangling tracked symlink is a permanent `high` finding; `chmod 0o755` is a no-op on Windows (print the `git update-index --chmod=+x` hint); the `CLAUDE.md` redirect in `apply` is dead code but documented as live; the "separate-git-dir blind spot" comment and test describe a case that is actually detected; `Bearer` placeholders; advice lines listing 41 line numbers (cap at 10).

---

## Tier 4 — docs, CI, tests

- README: "three hooks" (table has four); "reverts both hooks"; CI section says `ANTHROPIC_API_KEY` and "skips with a notice" (now `workflow_dispatch`-only, prefers the OAuth token); "3 runs per case" (`runs: 1`).
- `SKILL.md:29` Phase 2 row omits step 12, which its reference and a test cover.
- `ci.yml`: Node 24 only while `engines` says `>=22` (never exercised); `npm test` runs before the CLI is installed, so the LOAD-BEARING plugin-manifest test always skips inside `npm test`; no test ties `plugin.json` version to `package.json`.
- Tests: wall time is bounded by `lifecycle.test.mjs` (72 s, 95 CLI spawns) — split into three files; `verify-touched.test.mjs:255-259` asserts a full Node spawn under 300 ms (310 ms measured here — the flake seen in this session); two platform skips (mode bits, junctions) never run anywhere but Linux CI.

---

## Suggested order

1. Tier 1 as one plan (four fixes, each with a reproducing test first). All four turn a false statement into a true one.
2. Tier 2 items 5–9 and 13–16 (gates, parsing, manifest atomicity, `--verify`, exit codes) — the robustness plan.
3. Tier 2 items 10–12 and Tier 3 items 17–19, 24 — the performance plan: exec-form hooks, no-change skip on the Stop gate, single-lookup sweep, derived `ls-files`, terse dry run. Expected effect: `detect` ~2.3 s → ~1.4 s on 1,400 files; a 3-edit turn's hook overhead roughly halved.
4. Tier 3 items 20–23, 25–27 and Tier 4 as a cleanup plan.
