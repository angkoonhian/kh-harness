# Audit fixes, Tier 3 — performance and noise (design)

- **Date:** 2026-11-02
- **Source:** `docs/2026-11-02-audit-findings.md`, findings 10, 11, 12, 17,
  18, 19 and 24.
- **Branch:** `fix/audit-findings`, after the Tier 2 commits.
- **Facts checked against the Claude Code hooks reference on 2026-11-02**
  (`code.claude.com/docs/en/hooks`): a command hook may be written in exec
  form — `"command": "node", "args": [...]` — which "is resolved as an
  executable and spawned directly with `args` as the argument vector, with
  no shell involved"; `${CLAUDE_PROJECT_DIR}` is "the project root where the
  session started" and the docs say to "prefer exec form for any hook that
  references a path placeholder"; handlers "run in the current directory",
  which changes after `cd` or entering a worktree; `systemMessage` is a
  universal output field ("warning message shown to the user") that some
  events discard — the Stop section does not say it does; an omitted
  PostToolUse matcher matches every tool and `Write|Edit` is an unanchored
  regex; the command-hook timeout defaults to 600 s (30 s on
  UserPromptSubmit).

## Intent

Measured on a 1,422-file repository: `detect` takes 2.3 s, of which six
`git` spawns are ~0.6 s and the credential sweep's two path lookups per
file are ~0.4 s. Each installed hook pays ~260 ms of shell wrapper before
Node starts; a three-edit turn carries 2.5–3 s of hook overhead before any
real lint runs. The Stop gate re-runs the whole typecheck on turns that
changed nothing. A first-run dry run prints 1,833 lines, 1,570 of them the
kit's own hook scripts, then prints them all again under `--yes`. And the
hook mask misses most of today's credential shapes. Seven changes, each
measured before and after.

## Goals

1. Installed hooks are registered in exec form with
   `${CLAUDE_PROJECT_DIR}`-rooted paths, so they run from any working
   directory and without a shell. Existing shell-form registrations remain
   recognised as ours.
2. The Stop gate skips a turn whose tree fingerprint (HEAD, status, mtime
   and size of every changed or untracked file) equals the last verified
   one.
3. The lint sensor appends the edited file only to a plain command: a
   trailing bare `.` target is dropped first, and a command holding `|`,
   `&&`, `||`, `;`, `$(` or a backtick is run unmodified. A timed-out lint
   run kills the whole process tree.
4. The Stop gate no longer kills a command whose output exceeds the buffer:
   it keeps the first `maxBuffer` bytes, lets the command finish, and says
   the output was cut. Its exit-0 notices go out as `systemMessage` JSON on
   stdout rather than stderr.
5. `detect` asks git five times, not six: tracked paths come from
   `ls-files -s`, already requested.
6. The credential sweep opens each file once (`open` → `fstat` → `read`).
7. A dry run prints `+N lines — verbatim copy of assets/scripts/X` for a new
   file that is a shipped asset, and `--yes` prints labels and reasons but
   no diffs.
8. The hook mask covers npm, all GitHub token prefixes, Stripe-style
   `sk_live_`, Google `AIza`, JWTs, URL userinfo, `Basic` auth, JSON/YAML
   `password:` and `api_key:` forms, PEM blocks, and the common vendor
   prefixes the audit listed.

## Non-goals

- Re-registering a repository's existing shell-form hooks in exec form. A
  registered hook is `declared`; the migration applies to new installs. A
  later `apply --upgrade` (roadmap) may offer the rewrite.
- Any change to what the hooks report, beyond the overflow note.
- Parallelising `detect`'s git spawns.

## Decisions

### D1. Exec-form hooks (`propose.mjs`, `settings-merge.mjs`, `detect-harness.mjs`, `apply-lib.mjs`, `cli.mjs`, README)

- Every generated hook entry is
  `{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/<script path>'] }`.
- `hasEquivalentHook(settings, event, entry, matcher)` takes the whole entry
  and treats two entries as equivalent when they resolve to the same script
  path under the same matcher — `node .claude/scripts/x.mjs` (shell form)
  and `node` + `['${CLAUDE_PROJECT_DIR}/.claude/scripts/x.mjs']` (exec form)
  are the same hook. One shared resolver, `hookScriptOf(entry)`, lives in
  `settings-merge.mjs` and is what `detect-harness.mjs`'s `commandScript`
  calls too, so detection and dedupe cannot disagree; it strips a leading
  `${CLAUDE_PROJECT_DIR}/`, `$CLAUDE_PROJECT_DIR/` or `./`.
- `renderSettingsHookDiff` and the execution disclosure in `cli.mjs` show
  the exec form. README's hook table says the hooks run without a shell
  and from any working directory.
- Measured before/after: wall time of one `lint-touched` invocation from
  a settings entry, shell form vs exec form (recorded in the plan's ledger).

### D2. Stop-gate fingerprint (`verify-touched.mjs`)

- `treeFingerprint(root)`: sha256 over `git rev-parse HEAD` (or `unborn`),
  the `git status --porcelain -z --untracked-files=all` output, and for each
  listed path its `mtimeMs` and `size` (missing file → `gone`). Returns
  `null` outside a repository or on any git failure — then the gate runs
  as today.
- The marker gains `verifiedFingerprint`; after a PASSING run it is set;
  a FAILING run clears it. At entry, if the fingerprint is non-null and
  equals the marker's, exit 0 with no output. A turn that only read files
  therefore costs one `git status` and a few stats, not a typecheck.

### D3. Lint append and process tree (`lint-touched.mjs`, `harness-redact.mjs`)

- `appendTarget(lintScript, quotedPath)`: returns the script unmodified
  when it contains any of `|`, `&&`, `||`, `;`, `$(`, a backtick, or a
  newline; otherwise drops one trailing bare `.` or `./` token and appends
  the path.
- `runBounded(command, { cwd, env, timeoutMs, maxBuffer })` moves from
  `verify-touched.mjs` (where it is `runVerification`) into
  `harness-redact.mjs` together with `killTree`, and `lint-touched.mjs`
  uses it instead of `spawnSync` — the orphan the Stop gate already fixed
  for itself. Behaviour on timeout/overflow is unchanged for the lint
  sensor (not reported).

### D4. Stop-gate overflow and notices (`verify-touched.mjs`, `harness-redact.mjs`)

- `runBounded` stops APPENDING at `maxBuffer` and sets `overflowed`, but no
  longer kills the child; the exit code is the command's own. The report
  gains one trailing line: `(output cut at N KB; run \`npm run <kind>\` for
  the rest)`.
- The two exit-0 notices ("same failure already reported", "block cap
  reached") are written as `{"systemMessage": "…"}` on stdout. Exit-2
  blocks keep using stderr, which the reference documents as the reason
  Claude receives.

### D5. One fewer git spawn (`scan.mjs`)

- `listFiles` computes `tracked` from the `ls-files -s` records already
  fetched by `detectNestedRepositories` (which now returns them) plus the
  `-o --exclude-standard` list, deduplicated; the `-co` spawn is removed.
  `source: 'git'` requires both lists to be non-null.

### D6. Single-open sweep (`detect-exposure.mjs`)

- `probe` and `readTextIfPresent` merge into `openAndRead(root, rel)`:
  `openSync(path, 'r')` → `fstatSync` → regular-file and size checks →
  `readSync` into a buffer of `size` bytes → `closeSync`. Error codes map
  to the same `reason` strings as today (`could not be opened (ENOENT)`,
  etc.); `ALWAYS_PROBE` paths that fail with `ENOENT` stay silent, so the
  `existsSync` pre-check goes too.

### D7. Terse dry run (`propose.mjs`, `apply-lib.mjs`, `apply.mjs`)

- Asset-copy proposals carry `assetSource: 'scripts/<name>.mjs'`.
  `renderDiff` for a NEW file with `assetSource` whose contents equal the
  stamp line plus the shipped asset returns
  `+<N> lines — a verbatim copy of assets/<assetSource> (stamped on line 1); nothing of yours is changed`.
  An UPDATE of an existing asset still shows the real diff.
- `apply --yes` prints the `--- <path>  [check]` label and reason lines and
  omits `renderDiff`; the final `wrote/patched/skipped` summary is
  unchanged. README's "read the diffs" line says the dry run is where the
  diffs are.

### D8. Mask rules (`harness-redact.mjs`)

Added to `CREDENTIAL_RULES`, each anchored at a word boundary:
`npm_[A-Za-z0-9]{36}`, `gh[opsur]_[A-Za-z0-9]{16,}`,
`(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}`, `AIza[0-9A-Za-z_-]{35}`,
`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` (JWT),
`(://[^/\s:@]+:)[^@\s]+@` → `$1***@` (URL userinfo),
`Basic\s+[A-Za-z0-9+/=]{16,}` → `Basic ***`,
`(["']?(?:password|passwd|pwd|api[_-]?key|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*)["']?[^\s"',;]+` → `$1***`
(replacing today's `password|api_key` `=`-only rule),
`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` and a
single-line `-----BEGIN … PRIVATE KEY-----.*` → `***`,
`glrt-[A-Za-z0-9_-]{16,}`, `xapp-[A-Za-z0-9-]{10,}`, `hf_[A-Za-z0-9]{20,}`,
`dckr_pat_[A-Za-z0-9_-]{16,}`, `pypi-[A-Za-z0-9_-]{16,}`.
The fixtures are assembled at runtime (DOGFOOD).

## Left to the builder

Test names, the timing harness for D1/D5/D6 (a `node --test` file that
records before/after in the ledger, not an asserting benchmark), and the
exact README sentences are in the plan.
