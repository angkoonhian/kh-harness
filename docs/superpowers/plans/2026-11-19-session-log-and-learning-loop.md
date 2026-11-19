# Session Log and Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make kh-harness record every agent session locally, find failures that recur, and turn each into one validated, reversible, mechanically enforced learning — after first fixing the audit findings that make its signals untrue.

**Architecture:** Installed hooks append scrubbed events to a per-machine log outside the repository. Kit-side scripts compute recurrences from that log, replay model-drafted declarative gates against it, trial them silently, and promote them only on a terminal-typed approval or an owner-written policy. Running unattended, the loop writes only to the user data directory; anything entering the repository goes through the same gated, dry-run-first path as `apply`.

**Tech Stack:** Node 22+, ES modules, `node:test`, no runtime dependencies. Standard library only (`node:fs`, `node:crypto`, `node:zlib`, `node:tty`).

**Spec:** `docs/superpowers/specs/2026-11-19-session-log-and-learning-loop-design.md`. Findings referenced by ID are in `docs/2026-11-18-audit-findings.md`. Hook payload facts are in `research_notes/Trace foundations for self improving harnesses/trace_driven_improvement_practice.md`.

## Global Constraints

- Zero runtime dependencies. Node 22 and 24, Windows and POSIX. No shell required by any hook.
- Exit codes are 0, 2 and 3 only, as `scripts/lib/cli.mjs` `EXIT_CODES` defines them.
- `apply`-style commands are a dry run unless `--yes`. No `--force`. No ignore list.
- Every write into a repository passes `assertAllowed` and `assertContained` (`scripts/lib/apply-lib.mjs`).
- Every generated file carries `STAMP_MARKER` (`scripts/lib/render.mjs`).
- Installed hook scripts import only Node built-ins and sibling files in `.claude/scripts/`. Kit-side code may import from `assets/scripts/`, never the reverse.
- A hook never prints or stores a credential value it can recognise; the scrub is described to the user as best-effort.
- A check never reports `verified` without execution and never claims more than it read.
- No learned enforcer is code. Gates are data interpreted by `tool-gate.mjs`.
- Commit after every task on the current branch. Never push. End each commit message with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- No dead code, no speculative options, no comment that narrates history; a comment states a constraint the code cannot.
- Before writing code that depends on a Claude Code hook event name, payload field, output shape or permission-rule syntax, read the current reference at `https://code.claude.com/docs/en/hooks` or `/permissions` and pin what was read in a test.

**Every task follows the same cycle,** written once here and ticked per task:

1. Write the failing tests named in the task.
2. Run them and confirm they fail for the stated reason.
3. Implement.
4. Run the task's tests, then `npm test`; both pass.
5. Commit.

## Review Focus

Inputs the spec implies and that are most likely to bite a user; each is pinned by a test in the task named.

1. **Concurrent appends.** Parallel tool calls and sub-agents fire hooks at the same time in one session; no event may be lost or interleaved mid-line. (Task 14)
2. **The log cannot be written.** Data directory missing, read-only or full: the hook exits 0 fast, blocks nothing, and `log status` reports the gap. (Tasks 15, 18)
3. **A secret that the scrub must not miss by construction:** split across the 64 KB cap, wrapped in ANSI colour, or inside a blob. (Tasks 2, 14)
4. **A malformed or hostile `gates.json`:** bad JSON, an unknown pattern kind, a pattern of 10,000 characters. The gate hook fails open with a visible notice and never blocks every tool. (Tasks 25, 26)
5. **Worktrees and Windows paths.** Two worktrees of one repository share one log; a path differing only in case or separator maps to the same key. (Task 12)

---

## Stage A — make every signal true

### Task 1: A failed directory walk is reported, never swallowed (C1)

**Files:** Modify `scripts/lib/scan.mjs`, `scripts/lib/detect-exposure.mjs`. Test `scripts/lib/scan.test.mjs`, `scripts/lib/detect-exposure.test.mjs`.

**Interfaces — Produces:** `walkFiles(root): { files: string[], unreadableDirs: string[] }`; `listFiles(root)` gains `unreadableDirs: string[]` in its result. `detectExposures` emits one `UNREADABLE_KIND` finding per unreadable directory.

- [ ] Tests: `walkFiles keeps the files it read when one directory throws` (inject a `readdir` that throws `EACCES` for `locked`; assert the sibling's files are returned and `unreadableDirs` equals `['locked']`); `a walk that could read nothing makes P0.security failing, not verified`; `an unreadable directory is listed under Not examined with its path`.
- [ ] Run; fail because the walk returns `[]`.
- [ ] Implement: catch per directory inside the walk; thread `unreadableDirs` to the sweep. Inject the directory reader as a parameter with the real one as default.
- [ ] Run task tests and `npm test`.
- [ ] Commit `fix(detect): an unreadable directory is a finding, not an empty walk`.

### Task 2: One credential table for the sweep and the mask (C2, M5)

**Files:** Modify `assets/scripts/harness-redact.mjs`, `scripts/lib/detect-exposure.mjs`. Test `scripts/lib/harness-redact.test.mjs`, `scripts/lib/detect-exposure.test.mjs`.

**Interfaces — Produces** from `harness-redact.mjs`: `CREDENTIAL_SHAPES` (frozen array of `{ id, kind: 'token' | 'keyed', pattern: RegExp, severity: 'high' }`), `stripAnsi(text): string`, `maskCredentials(line): string` (unchanged signature), `maskText(text): string` (multi-line, tracks PEM state). `detect-exposure.mjs` builds its token and keyed lists from `CREDENTIAL_SHAPES` and keeps no list of its own.

- [ ] Tests, all assembling fixtures at runtime so the repository still passes its own sweep: `the sweep and the mask recognise the same shapes` (iterate `CREDENTIAL_SHAPES`; for each, a generated sample is found by `detectExposures` and masked by `maskCredentials`); samples must include URL userinfo, `*_SECRET_ACCESS_KEY`, `*_PASS`, `JWT_SECRET`, `TOKEN=`, `"private_key":`, `Authorization: token`, `hf_`, `ASIA`, SendGrid `SG.`, a Slack webhook URL, a bare JWT; `a credential wrapped in an SGR colour sequence is masked`; `a quoted value containing spaces is masked to its closing quote`; `every body line of a PEM private key is masked by maskText`.
- [ ] Run; fail on the missing shapes.
- [ ] Implement. Boundaries use `(?<![A-Za-z0-9])`, not `\b`. `maskCredentials` strips ANSI first.
- [ ] Run task tests and `npm test` (the DOGFOOD test must stay green).
- [ ] Commit `fix(security): the sweep and the hook mask share one credential table`.

### Task 3: `detect`'s write is contained and atomic (C6)

**Files:** Modify `scripts/detect.mjs`. Test `scripts/lib/detect-cli.test.mjs`.

- [ ] Tests: `detect refuses to write its report through a junction out of the repository` (exit 2; the outside file's bytes unchanged; skip only where the platform cannot create the link); `a killed write never leaves a truncated detect.json` (assert temp-plus-rename by observing no partial file when the write function throws).
- [ ] Run; fail because the outside file is overwritten.
- [ ] Implement: `assertContained(root, DETECT_REPORT_PATH)` before the write; temp file and rename.
- [ ] Run task tests and `npm test`.
- [ ] Commit `fix(detect): the report write is contained and atomic`.

### Task 4: A present but unparseable settings or manifest file is its own state (C7, C10)

**Files:** Create `scripts/lib/read-json.mjs`. Modify `scripts/lib/detect-harness.mjs`, `scripts/lib/apply-lib.mjs`, `scripts/lib/uninstall-lib.mjs`, `scripts/lib/manifest.mjs`, `scripts/apply.mjs`. Test `scripts/lib/read-json.test.mjs`, `scripts/lib/apply-lib.test.mjs`, `scripts/lib/manifest.test.mjs`.

**Interfaces — Produces:** `readJsonFile(path): { state: 'absent' } | { state: 'unreadable', reason: string } | { state: 'ok', value: unknown }` (strips one leading UTF-8 BOM). `readManifestResult` returns `corrupt` unless every `files[]` entry is `{ path: string, sha256: string }`, `settingsPatches` is an array, and `dirsCreated`, when present, is an array of strings.

- [ ] Tests: `a settings.json with a BOM is read`; `settings.json with a syntax error is reported as unreadable by detect, not as missing`; `apply --yes with unreadable settings writes no hook script and exits 2`; table test `a manifest with files:[null] | files:[{path:5}] | dirsCreated:[5] | settingsPatches:{} reads as corrupt`; `apply exits 3 and uninstall refuses on each`.
- [ ] Run; fail with exit 0 and exit 1.
- [ ] Implement; route the three settings readers through `readJsonFile`.
- [ ] Run task tests and `npm test`.
- [ ] Commit `fix: unparseable settings and malformed manifests are states, not absences`.

### Task 5: Settings patches need provenance before `uninstall` reverts them (C5)

**Files:** Modify `scripts/lib/settings-merge.mjs`, `scripts/lib/uninstall-lib.mjs`. Test `scripts/lib/uninstall-lib.test.mjs`.

**Interfaces — Produces:** `revertPatch(settings, patch, { producibleHookScripts: Set<string>, producibleDenyRules: Set<string> })` returns `{ settings, kept: [{ patch, reason }] }`.

- [ ] Tests: `a forged patch naming the user's own deny rules reverts nothing and is reported as kept`; `a forged patch whose hash matches a user's hook is kept because the script is not a generator path`; `a genuine patch is still reverted`.
- [ ] Run; fail because `settings.json` becomes `{}`.
- [ ] Implement: a hook entry is reverted only when `hookScriptOf(entry)` is in the generator path set exported by `propose.mjs`; a deny rule only when a generator can produce it and `entrySha256` matches.
- [ ] Run task tests and `npm test`.
- [ ] Commit `fix(uninstall): a settings patch is reverted only when a generator could have written it`.

### Task 6: Suppression state resets on a clean run (H1, H2, H5)

**Files:** Modify `assets/scripts/verify-touched.mjs`, `assets/scripts/lint-touched.mjs`, `assets/scripts/harness-redact.mjs`. Test `scripts/lib/verify-touched.test.mjs`, `scripts/lib/lint-touched.test.mjs`.

- [ ] Tests (drive the real scripts with synthetic stdin and a sandboxed marker directory): `five distinct failures with a pass between each all block`; `fail, pass, the same failure again blocks again`; `four consecutive failures with no pass block three times and then say the cap was reached`; `a fourth distinct lint diagnostic on one file is reported with a count, never dropped`; `a clean lint run clears that file's history`.
- [ ] Run; fail on the fourth block and on the recurrence.
- [ ] Implement: a passing run resets the count and clears the last signature. The lint cap emits `N further distinct issues in <file>; run the lint script` and exits 2.
- [ ] Run task tests and `npm test`.
- [ ] Commit `fix(hooks): suppression counts since the last clean run`.

### Task 7: Redaction no longer deletes diagnostics (H3, H4)

**Files:** Modify `assets/scripts/harness-redact.mjs`, `assets/scripts/verify-touched.mjs`. Test `scripts/lib/harness-redact.test.mjs`, `scripts/lib/verify-touched.test.mjs`.

- [ ] Tests: `a typecheck script naming -p packages/app still reports its tsc lines`; `"lint": "eslint" reports the full stylish diagnostic`; `"test": "jest" keeps lines containing the word jest`; `a line that is exactly the echoed command is still dropped`.
- [ ] Run; fail with only the redaction notice.
- [ ] Implement: the whole-command rule matches a full-line echo only; a command token that resolves to an existing path under the root is exempt.
- [ ] Run task tests and `npm test`.
- [ ] Commit `fix(hooks): command redaction matches an echo, not a substring`.

### Task 8: "Could not check" is not "clean" (H7)

**Files:** Modify `assets/scripts/lint-touched.mjs`. Test `scripts/lib/lint-touched.test.mjs`.

- [ ] Tests: `a lint script whose binary is missing says once per session that the file could not be checked, with the exit code`; `a linter that exits non-zero without naming the file says the same`; `a timeout says it timed out`; `the second occurrence in the same session is silent`.
- [ ] Run; fail on silent exit 0.
- [ ] Implement with a `systemMessage` on exit 0, deduplicated through the existing marker.
- [ ] Run task tests and `npm test`.
- [ ] Commit `fix(hooks): the lint sensor says when it could not check`.

### Task 9: Briefs sanitise what they inject (M6, M7)

**Files:** Modify `assets/scripts/harness-redact.mjs`, `assets/scripts/session-brief.mjs`, `assets/scripts/rules-brief.mjs`. Test `scripts/lib/session-brief.test.mjs`, `scripts/lib/rules-brief.test.mjs`.

**Interfaces — Produces** from `harness-redact.mjs`: `stripUnsafe(text): string` (removes C0/C1 controls except tab and newline, `\p{Cf}`, and the Unicode tag block, with the `u` flag) and `escapeDelimiters(text): string` (`<` to `&lt;`, `>` to `&gt;`).

- [ ] Tests: `a handoff containing an escape sequence, U+202E and a closing system-reminder tag is emitted without any of them`; `a handoff line with a bearer token is masked`; `a rule heading containing </project-rules> cannot close the block`; `tag characters in rule text are removed`; `the brief is wrapped in a named delimiter`.
- [ ] Run; fail on verbatim emission.
- [ ] Implement; both briefs call `stripUnsafe`, `escapeDelimiters` and `maskText`.
- [ ] Run task tests and `npm test`.
- [ ] Commit `fix(hooks): injected briefs are stripped, escaped and masked`.

### Task 10: Summaries say what is true (D1, D2)

**Files:** Modify `scripts/lib/gap-model.mjs`, `scripts/lib/report.mjs`, `scripts/apply.mjs`. Test `scripts/lib/gap-model.test.mjs`, `scripts/lib/report.test.mjs`, `scripts/lib/lifecycle.test.mjs`.

**Interfaces — Produces:** every proposal on a check has `kind: 'apply' | 'skill' | 'human'`; `countProposals(checks): { apply: number, skill: number, human: number }`.

- [ ] Tests: `a check with a proposal and no registered generator is never kind apply` (iterate real checks against `GENERATORS`); `apply with nothing to write names how many checks are still absent and how many questions are open`; `the action count equals the number of gaps those actions close`.
- [ ] Run; fail on the "already satisfies every applicable step" sentence.
- [ ] Implement.
- [ ] Run task tests and `npm test`.
- [ ] Commit `fix(report): proposals are typed and the no-actions line is honest`.

### Task 11: An installed harness can be upgraded (P1)

**Files:** Modify `scripts/lib/propose.mjs`, `scripts/lib/gap-model.mjs`. Test `scripts/lib/propose.test.mjs`, `scripts/lib/lifecycle.test.mjs`.

**Interfaces — Produces:** check `P0.kitskew` with evidence listing each kit-owned file whose generated content differs from the manifest's record; `buildProposals` emits update proposals for those files when `classify` is `ours-unmodified` and the on-disk file carries the stamp, whatever the owning check's state.

- [ ] Tests: `a changed hook asset is offered as an update when its check is declared`; `a file the user edited is reported as kept and never updated`; `detect names the installed kit version and the current one when they differ`; `a second apply after the update proposes nothing`.
- [ ] Run; fail with "no actions".
- [ ] Implement by iterating the manifest's files against every generator's output, reusing the existing upgrade branch.
- [ ] Run task tests and `npm test`.
- [ ] Commit `feat(apply): unmodified kit files are updated when the kit changes`.

---

## Stage B — the session log

### Task 12: Log library — location, enablement, configuration

**Files:** Create `assets/scripts/harness-log.mjs`. Test `scripts/lib/harness-log.test.mjs`.

**Interfaces — Produces:**
- `dataRoot(): string` — `process.env.KH_DATA_DIR` if set, else `<home>/.claude/kh-harness`.
- `repoKey(root: string): string` — first 16 hex of SHA-256 over the normalised absolute path of the repository's git common directory, found with `node:fs` only (a `.git` directory is its own common directory; a `.git` file is followed through `gitdir:` and `commondir`); for a non-git directory, over the root path. Normalisation: resolve, forward slashes, lower-case on win32.
- `repoDataDir(root): string` — `<dataRoot>/<repoKey>`.
- `isEnabled(root): boolean`, `setEnabled(root, enabled: boolean): void` — an `enabled.json` in the repo data directory.
- `readConfig(root): { contentRetentionDays: number, inlineCapBytes: number, autodraft: boolean }` with defaults `90`, `65536`, `false`; unreadable config yields defaults plus `configUnreadable: true`.

- [ ] Tests: `two worktrees of one repository map to one key` (build with `git worktree add`); `a path differing only in case or separator maps to the same key on win32`; `a non-git directory gets a key`; `nothing is enabled by default`; `KH_DATA_DIR overrides the location`.
- [ ] Run; fail on the missing module.
- [ ] Implement.
- [ ] Run task tests and `npm test`.
- [ ] Commit `feat(log): per-repository data directory and enablement`.

### Task 13: Harness identity

**Files:** Modify `assets/scripts/harness-log.mjs`. Test `scripts/lib/harness-log.test.mjs`.

**Interfaces — Consumes:** Task 12. **Produces:** `harnessIdentity(root): { base: string, learned: string, kitVersion: string | null }`. `base` is SHA-256 over, in sorted path order, each manifest-recorded file's path and the SHA-256 of its LF-normalised bytes on disk (`missing` when absent), then the manifest's `settingsPatches` as canonical JSON; learned gate files are excluded. `learned` is SHA-256 over the sorted `id:sha256` pairs of every gate in `.claude/kh-harness/gates.json` and `<repoDataDir>/gates.local.json`. No manifest yields `base: 'none'`.

- [ ] Tests: `editing an installed hook changes base`; `a CRLF checkout does not change base`; `adding a local trial gate changes learned and not base`; `editing docs/harness/RULES.md changes neither`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(log): base and learned-set harness hashes`.

### Task 14: Writing an event

**Files:** Modify `assets/scripts/harness-log.mjs`. Test `scripts/lib/harness-log.test.mjs`.

**Interfaces — Consumes:** `maskText`, `stripAnsi` (Task 2); Task 12. **Produces:**
- `LOG_SCHEMA = 1`.
- `scrubValue(value: unknown): unknown` — deep copy with `maskText` applied to every string leaf.
- `storeBlob(root, text: string): { sha256: string, bytes: number }` — gzip to `<repoDataDir>/blobs/<sha256>.gz`, written once.
- `appendEvent(root, sessionId, event: object): void` — adds `schema`, `ts`, `pid`; serialises to one line; appends with a single `appendFileSync` call in append mode to `<repoDataDir>/sessions/<safeSessionId>.jsonl`. A string leaf over `inlineCapBytes` after scrubbing is replaced by `{ blob: sha256, bytes, truncated: true }`.
- `readEvents(root, sessionId): Iterable<object>` — reads `.jsonl` or `.jsonl.gz`, skipping and counting unparseable lines.

- [ ] Tests: `fifty processes appending at once lose and interleave no line` (spawn 50 children each appending 20 events; parse all 1000 lines); `a credential is masked before the cap is applied, so it cannot straddle the boundary`; `a 200 KB output becomes a blob reference and the blob holds the scrubbed text`; `an ANSI-coloured token is masked in the stored event`; `the same blob is written once`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(log): scrubbed, capped, append-only events`.

### Task 15: The logging hook

**Files:** Create `assets/scripts/session-log.mjs`. Test `scripts/lib/session-log.test.mjs`.

**Interfaces — Consumes:** Tasks 12–14; `projectRoot`, `safeSessionId` from `harness-redact.mjs`. **Produces:** exported `LOGGED_EVENTS` (the frozen list of hook event names the script handles) and `toLogEvent(payload): object | null`.

Event mapping, each to one log line with `type` equal to the hook event name and the identity fields the payload carries (`session_id`, `prompt_id`, `tool_use_id`, `agent_id`, `cwd`):
- Session start: also writes a `harness` line from `harnessIdentity`, with `model` and the Claude Code version if the payload carries them.
- Tool use, before: tool name, `inputHash` (SHA-256 of canonical JSON of the tool input), input size.
- Tool use, after and on failure: tool name, `inputHash`, status, first error line, duration if given, sizes, and scrubbed `input` and `output`.
- Prompt submission: scrubbed prompt text.
- Instruction-file loading: the paths loaded and the reason.
- A tool whose name is `WebFetch`, `WebSearch` or starts with `mcp__` also writes `{ type: 'external_content' }` once per session.
- Session end: one marker line and nothing else.

- [ ] Tests: `LOGGED_EVENTS equals the pinned list` (the list read from the hooks reference at implementation, recorded in the test with the date read); `with the log disabled the hook writes nothing and exits 0`; `an unwritable data directory exits 0 with no output`; `an unknown event name exits 0 and writes nothing`; `a tool failure records the first error line and status`; `an MCP tool marks the session external once`; `the hook never spawns a child process` (run under a `--require` preload that throws on `child_process` use); `median wall time over 20 runs is under the budget recorded in the test`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(log): one hook records every documented session event`.

### Task 16: Sealing, compression, retention

**Files:** Modify `assets/scripts/harness-log.mjs`, `assets/scripts/session-log.mjs`. Test `scripts/lib/harness-log.test.mjs`.

**Interfaces — Produces:**
- `sealClosedSessions(root, { now, currentSessionId }): { sealed: string[] }` — for each session file not current and not yet in the index: gzip it, compute SHA-256 of the uncompressed bytes, append `{ sessionId, sha256, events, firstTs, lastTs, external, prev }` to `<repoDataDir>/index.jsonl`, where `prev` is the SHA-256 of the previous index line. Guarded by an exclusive lock file; a held lock means skip.
- `verifyIndex(root): { intact: boolean, brokenAt: number | null, sessionsMissing: string[], sessionsAltered: string[] }`.
- `applyRetention(root, { now }): { contentRemoved: number }` — in sessions older than `contentRetentionDays`, rewrite events without `input`, `output` and prompt text, set `contentExpired: true`, delete unreferenced blobs, and append a new index line recording the rewrite.

The session-start handler calls `sealClosedSessions` then `applyRetention`, inside a wall-clock budget; on overrun it stops and resumes next time.

- [ ] Tests: `a closed session is compressed and indexed`; `editing a sealed session is reported as altered`; `deleting an index line is reported as a break at that position`; `two simultaneous sealers index each session once`; `content older than the retention period is removed and structure kept`; `a retention rewrite is itself recorded so the index stays intact`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(log): sealed, compressed, retention-bounded sessions`.

### Task 17: `detect` and `apply` install the logging hook

**Files:** Modify `scripts/lib/gap-model.mjs`, `scripts/lib/propose.mjs`, `scripts/lib/cli.mjs`, `scripts/lib/uninstall-lib.mjs`. Test `scripts/lib/gap-model.test.mjs`, `scripts/lib/propose.test.mjs`, `scripts/lib/lifecycle.test.mjs`.

**Interfaces — Produces:** check `P5.sessionlog`; generator proposing `.claude/scripts/session-log.mjs`, `.claude/scripts/harness-log.mjs`, the shared redaction asset, and one `settings-hook` proposal per name in `LOGGED_EVENTS`, each with `requiresFiles`. Exported path constants `SESSION_LOG_PATH`, `HARNESS_LOG_PATH`.

- [ ] Tests: `a repository with no logging hook is proposed one registration per logged event`; `a second apply proposes nothing`; `the dry run states that the hook records tool input and output on this machine once enabled, and that it is inert until then` (text added to `EXECUTION_DISCLOSURE`, printed in the dry run whenever a hook proposal is present); `apply then uninstall leaves git status clean`; `uninstall prints the log's location and size and does not remove it`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(apply): the session log hook is detected, proposed and removable`.

### Task 18: `log` command — enable, disable, status, purge

**Files:** Create `scripts/log.mjs`, `scripts/lib/log-lib.mjs`. Modify `scripts/lib/cli.mjs`, `package.json`. Test `scripts/lib/log-cli.test.mjs`.

**Interfaces — Produces:** `node scripts/log.mjs <path> <enable|disable|status|purge> [--yes] [--json]`. `logStatus(root): { enabled, location, bytes, sessions, firstTs, lastTs, index: ReturnType<verifyIndex>, unparseableLines, hookRegistered, blindSpots: string[] }`. `LOG_USAGE` in `cli.mjs`.

- [ ] Tests: `status on a repository with no log says so and exits 0`; `enable says the scrub is best-effort and names the retention period`; `status reports an altered session`; `status names what hooks cannot see` (interrupts, cancelled tools, permission denials outside auto mode); `purge without --yes removes nothing`; `purge --yes removes the repository's data directory and nothing else`; `an unknown subcommand exits 2`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(log): enable, status and purge`.

### Task 19: Transcript reader for what hooks cannot see

**Files:** Create `scripts/lib/transcript-reader.mjs`. Modify `scripts/lib/log-lib.mjs`. Test `scripts/lib/transcript-reader.test.mjs`.

**Interfaces — Produces:** `readTranscript(path): { status: 'ok' | 'not-checked', reason?: string, claudeCodeVersion: string | null, interrupts: { ts: string }[], unknownLineTypes: string[] }`. The known line types are a frozen list built from transcripts observed on the development machine at implementation time; fixtures are synthetic lines of those shapes with no real content.

- [ ] Tests: `a transcript of known line types yields its interrupts`; `one unknown line type makes the whole session not-checked and names the type`; `an unreadable file is not-checked`; `status reports how many sessions were checked and how many were not`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(log): version-checked transcript reader for interrupts`.

---

## Stage C — recurrence, taxonomy, ledger

### Task 20: Recurrence detection

**Files:** Create `scripts/lib/recurrence.mjs`. Test `scripts/lib/recurrence.test.mjs`.

**Interfaces — Consumes:** `readEvents`, the index. **Produces:**
- `normaliseError(line: string): string` — strips ANSI, digits runs to `#`, absolute paths to their repository-relative form, hex of 8+ characters to `…`.
- `signatureOf(event): string | null` — 16 hex of SHA-256 over tool name, `inputHash` and `normaliseError(firstErrorLine)`; null for a non-failure.
- `findRecurrences(root, { minSessions = 2 }): Recurrence[]`, where `Recurrence = { signature, tool, errorLine, sessions: string[], count, base, model, external: boolean, firstTs, lastTs, exampleEventRefs: { sessionId, line }[] }`. Sessions are grouped by `base` and `model`; a signature recurs when it appears in at least `minSessions` distinct sessions of one group.

- [ ] Tests: `the same failure in two sessions under one harness recurs`; `the same failure twice in one session does not`; `the same failure under two base hashes does not`; `a different model does not combine`; `a recurrence with any external session is marked external`; `line numbers in the error do not split a signature`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): deterministic cross-session recurrence`.

### Task 21: `log report`

**Files:** Modify `scripts/log.mjs`, `scripts/lib/log-lib.mjs`, `scripts/lib/cli.mjs`. Test `scripts/lib/log-cli.test.mjs`.

**Interfaces — Produces:** subcommand `report [--json]`; `buildLogReport(root): { sessions, base, model, recurrences: Recurrence[], gateFirings: { gateId, action, fired, rerouted, markedWrong }[], notChecked: number }`.

- [ ] Tests: `the report states how many sessions it read and under which harness and model`; `it lists each recurrence with its session count`; `it never prints tool input or output`; `with no log it says nothing was read`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(log): recurrence report`.

### Task 22: Failure taxonomy scaffold

**Files:** Create `assets/templates/FAILURES.md.tmpl`, `scripts/lib/failures-evidence.mjs`. Modify `scripts/lib/gap-model.mjs`, `scripts/lib/propose.mjs`. Test `scripts/lib/failures-evidence.test.mjs`, `scripts/lib/propose.test.mjs`.

**Interfaces — Produces:** `FAILURES_PATH = 'docs/harness/FAILURES.md'`; `parseFailures(text): { id: string, title: string, signatures: string[] }[]` reading `## F<n> — <title>` headings with a `- signatures:` line of comma-separated signature ids; check `P5.failures`; a generator scaffolding the file with every example inside one static HTML comment.

- [ ] Tests: `the scaffold parses to zero failure kinds`; `markdownRemainder of the scaffold is empty`; `a heading with two signatures parses`; `detect reports how many recurrences are unlabelled, by count only`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): human-written failure taxonomy`.

### Task 23: Ledger

**Files:** Create `scripts/lib/ledger.mjs`. Test `scripts/lib/ledger.test.mjs`.

**Interfaces — Produces:** `LEDGER_KINDS = ['proposed','replayed','rejected','trial','promoted','demoted','suspended','retired','landed','reverted','wrong']`; `appendLedger(root, entry: { kind, learningId, contentSha256, evidence: { signature, sessions: number, firstTs, lastTs, external: boolean }, base, learned, approvedBy: 'owner' | `policy:${string}` | null, detail?: string }): void` (adds `ts` and `prev`, the SHA-256 of the previous line; refuses an unknown kind); `readLedger(root): object[]`; `verifyLedger(root): { intact: boolean, brokenAt: number | null }`. `logStatus` gains `ledger: ReturnType<verifyLedger>`.

- [ ] Tests: `an appended entry chains to the previous one`; `an edited line breaks the chain at that line`; `an unknown kind is refused`; `evidence carries counts and never content` (schema rejects any other key).
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): hash-chained change ledger`.

### Task 24: Loop warning as a shipped default

**Files:** Create `assets/scripts/loop-watch.mjs`. Modify `scripts/lib/gap-model.mjs`, `scripts/lib/propose.mjs`. Test `scripts/lib/loop-watch.test.mjs`, `scripts/lib/propose.test.mjs`.

**Interfaces — Produces:** a hook on the tool-failure event that keeps, per session, the last failure signature and a count in a marker; on the third consecutive identical failure it emits one fixed line of additional context: `The same call has failed 3 times in a row with the same error. Stop repeating it and change approach.` It resets on any different event. Check `P2.loopwatch` and its generator.

- [ ] Tests: `three identical consecutive failures warn once`; `a different failure between them resets the count`; `the fourth identical failure does not warn again`; `the warning text contains nothing from the tool output`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(hooks): warn when one call fails the same way three times`.

---

## Stage D — the loop

### Task 25: Gate language and matcher

**Files:** Create `assets/scripts/harness-gates.mjs`. Test `scripts/lib/harness-gates.test.mjs`.

*Superseded in review: the contract below is the one built; the plan's first text (`gatesMax: 200`, ids `^L[0-9]+$`, `?` as a glob wildcard, no input cap, `parseGates` without suspensions) was replaced before Task 25 was accepted.*

**Interfaces — Produces:**
- `Gate = { id: string, tool: string, field: string, match: { kind: 'literal' | 'token' | 'glob', value: string }, action: 'observe' | 'warn' | 'block', message: string, cites?: string[] }`.
- `GATE_LIMITS = { valueMax: 200, messageMax: 300, gatesMax: 100, inputMax: 65536 }`; a gate inspects only the first `inputMax` characters of its field.
- `validateGate(gate): { ok: true } | { ok: false, reason: string }` — `id` matches `^L[1-9][0-9]{0,8}$`; `field` is a dotted path of identifier segments, none of them `__proto__`, `constructor` or `prototype`; `match.value` has at least 3 characters that are neither `*` nor whitespace; `message` is one line, passes `stripUnsafe` unchanged and contains no `<` or `>`; a reason never repeats a key or value from the file.
- `gateSha256(gate): string` — SHA-256 of the canonical JSON of the gate without `action`.
- `matchGate(gate, toolName, toolInput): boolean` — `literal` is substring; `token` is the value bounded by non-word characters or string ends, found in one linear pass; `glob` matches the whole field with `*` as its only wildcard (`?` is literal), by `indexOf` over the literal segments. No `RegExp` is constructed from gate data.
- `parseGates(text): { gates: Gate[], suspended: string[], rejected: { index: number, reason: string }[] }` — a suspension entry is exactly `{ id, suspended: true }`; a whole-file rejection has index -1; entries beyond `gatesMax` are rejected.

- [ ] Tests: `a literal matches a substring of the named field`; `a token does not match inside a longer word`; `a glob matches the whole field, with * as its only wildcard`; `a gate inspects only the first inputMax characters of its field`; `a value over the limit is rejected`; `a value that would match everything or nearly everything is rejected, whatever the kind`; `a message containing an angle bracket or an invisible character is rejected`; `malformed JSON yields no gates and one rejection`; `the hash ignores the action`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): declarative, linear-time gate language`.

### Task 26: The gate hook

**Files:** Create `assets/scripts/tool-gate.mjs`. Modify `scripts/lib/gap-model.mjs`, `scripts/lib/propose.mjs`. Test `scripts/lib/tool-gate.test.mjs`, `scripts/lib/propose.test.mjs`.

**Interfaces — Consumes:** Tasks 14 and 25. **Produces:** exported `GATES_PATH = '.claude/kh-harness/gates.json'` and `LOCAL_GATES_FILE = 'gates.local.json'`. The hook, on tool use before execution, loads both gate sets (a local gate with the same id as a committed one wins; a local `{ id, suspended: true }` disables the committed one), and for the first matching gate: appends `{ type: 'gate_firing', gateId, gateSha256, action, tool_use_id }`; for `observe` exits 0 silently; for `warn` allows with the gate's message as additional context; for `block` denies with the message. The message is prefixed with the fixed text `kh-harness gate <id>: `. Check `P5.toolgate` and its generator, which also proposes deny rules for the protected surface: `.claude/scripts/**`, `.claude/kh-harness/**`, `.claude/kh-harness.manifest.json`, `docs/harness/LEARNED.md`.

- [ ] Tests: `an observe gate records a firing and prints nothing`; `a block gate denies with its message` (output shape pinned from the hooks reference); `a warn gate allows and adds the message`; `a local suspension disables a committed gate`; `an unreadable or malformed gate file allows the call and emits one notice per session`; `a rejected gate is skipped and the rest still apply`; `the deny rules are anchored to the project root` (syntax pinned from the permissions reference).
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): one hook interprets learned gates`.

### Task 27: Terminal-only commands and the promotion policy

**Files:** Create `scripts/lib/tty.mjs`, `scripts/lib/policy.mjs`. Test `scripts/lib/tty.test.mjs`, `scripts/lib/policy.test.mjs`.

**Interfaces — Produces:**
- `requireInteractive({ stdin = process.stdin, stdout = process.stdout, env = process.env }): { ok: true } | { ok: false, reason: string }` — false unless both streams are TTYs and `env.CLAUDECODE` is unset.
- `Policy = { minTrialFirings: number, minTrialSessions: number, maxAction: 'warn' | 'block' }`; `readPolicy(root): { state: 'absent' } | { state: 'unreadable', reason } | { state: 'ok', policy, sha256 }` from `<repoDataDir>/policy.json`; `writePolicy(root, policy): string`; `policyAllows(policy, { firings, sessions, wrong, external }): boolean` — false whenever `wrong > 0` or `external`.

- [ ] Tests: `a piped stdin is not interactive`; `a TTY inside a Claude Code session is not interactive`; `no policy file means nothing is allowed`; `one wrong mark blocks promotion`; `external evidence blocks promotion`; `the thresholds are inclusive`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): terminal-only approval and owner policy`.

### Task 28: Learned registry

**Files:** Create `assets/templates/LEARNED.md.tmpl`, `scripts/lib/learned-registry.mjs`. Modify `assets/scripts/harness-redact.mjs`, `assets/scripts/rules-brief.mjs`, `scripts/lib/rules-evidence.mjs`, `scripts/lib/gap-model.mjs`. Test `scripts/lib/learned-registry.test.mjs`, `scripts/lib/rules-evidence.test.mjs`, `scripts/lib/rules-brief.test.mjs`.

**Interfaces — Produces:** `LEARNED_PATH = 'docs/harness/LEARNED.md'` (exported from `harness-redact.mjs` beside `RULES_PATH`); `renderLearnedEntry({ id, title, why, enforcedBy: 'hook', pointer: GATES_PATH, evidenceSummary, approvedSha256 }): string` producing a `## <id> — <title>` section with keys `why`, `enforced-by`, `pointer`, `origin: learned`, `status: active`, `evidence`, `approved-sha256`; `upsertLearnedEntry(text, entry): string`; `removeLearnedEntry(text, id): string`. `parseRules` accepts the three new keys. `rulesRegistryEvidence` and the rules brief read both files; the brief lists a learned rule only when its `enforced-by` is not `hook`.

- [ ] Tests: `an entry round-trips through render and parseRules`; `removing one entry leaves the others byte-identical`; `title and why are stripped and escaped`; `detect counts learned rules separately from the owner's`; `a gate-enforced learned rule is not re-injected into prompts`; `docs/harness/RULES.md is never written by any function in this module` (assert by running each against a fixture and comparing its bytes).
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): learned rules live in their own kit-owned file`.

### Task 29: Replay

**Files:** Create `scripts/lib/replay.mjs`. Test `scripts/lib/replay.test.mjs`.

**Interfaces — Consumes:** `matchGate`, `findRecurrences`, `readEvents`. **Produces:** `replayGate(root, gate, recurrence): { differential: { firedOnMistakes: number, mistakes: number, firedOnSuccessors: number }, falsePositives: { fired: number, callsChecked: number, sessionsChecked: number }, contentMissing: number, verdict: 'pass' | 'fail' | 'not-checkable', reason: string }`. Mistakes are the failing calls bearing the recurrence's signature. A successor is the next call of the same tool in that session that succeeded. Pass requires the gate to fire on every mistake, on no successor, and on no call in any session that has no failure of that signature. Events whose content has expired cannot be replayed: they are counted in `contentMissing`, and if no mistake is replayable the verdict is `not-checkable`.

- [ ] Tests: `a gate matching the mistakes and not the fixes passes`; `a gate that also matches the fix fails and says so`; `a gate that fires in an unrelated clean session fails with the count`; `a gate that misses one mistake fails`; `expired content yields not-checkable, never pass`; `the result states how many calls and sessions were checked`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): differential and false-positive replay`.

### Task 30: Candidate lifecycle — draft, replay, trial

**Files:** Create `scripts/lib/learn-lib.mjs`. Test `scripts/lib/learn-lib.test.mjs`.

**Interfaces — Consumes:** Tasks 20, 23, 25, 26, 29. **Produces:**
- `Learning = { id, signature, failureId: string | null, title, why, gate: Gate, sha256, status: 'candidate' | 'rejected' | 'trial' | 'active-local' | 'landed' | 'suspended' | 'retired', external: boolean }`, stored as `<repoDataDir>/learnings/<id>.json`.
- `draftLearning(root, draft: { signature, title, why, gate: Omit<Gate,'id'|'action'> }): { learning } | { error: string }` — validates, refuses a signature that is not a current recurrence, assigns the next `L<n>`, records `proposed`.
- `runTrial(root, id): { replay, status }` — runs `replayGate`; on `pass` writes the gate with `action: 'observe'` into `gates.local.json` and records `replayed` then `trial`; otherwise records `replayed` and `rejected`.
- `listLearnings(root): Learning[]`; `learningStats(root, id): { firings, sessions, rerouted, wrong }` computed from the log.

- [ ] Tests: `a draft for an unknown signature is refused`; `a passing draft becomes an observe gate in the local set and nothing in the repository changes` (compare `git status` before and after); `a failing draft is recorded as rejected and writes no gate`; `ids are never reused after a rejection`; `stats count firings across sessions`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): draft, replay and silent trial`.

### Task 31: Promotion, wrong marks, demotion, retirement, tick

**Files:** Modify `scripts/lib/learn-lib.mjs`. Test `scripts/lib/learn-lib.test.mjs`.

**Interfaces — Consumes:** Task 27. **Produces:**
- `approveLearning(root, id, { sha256, action: 'warn' | 'block', interactive }): { ok } | { error }` — refuses unless `interactive.ok`, the hash equals the learning's, and the status is `trial`; sets the local gate's action; records `promoted` with `approvedBy: 'owner'`.
- `markWrong(root, firingRef: { sessionId, line }, { interactive })`; two wrong marks on one learning return its local gate to `observe` and record `demoted`.
- `tick(root, { now }): { promoted: string[], demoted: string[], retired: string[], suspended: string[] }` — under an `ok` policy promotes each `trial` learning that `policyAllows`, up to `maxAction`, recording `approvedBy: 'policy:<sha256>'`; retires a learning every one of whose `cites` paths no longer exists; for a committed gate that meets the demotion rule writes a local suspension and records `suspended`. It never touches a registry entry lacking `origin: learned`.
- `demoteLearning`, `retireLearning` for explicit use.

- [ ] Tests: `approval is refused without an interactive terminal`; `approval with a stale hash is refused`; `with no policy, tick promotes nothing`; `under a policy, a qualifying trial is promoted and the ledger names the policy hash`; `a learning with external evidence is never promoted by policy`; `two wrong marks demote`; `a learning whose cited path is gone is retired`; `tick writes nothing inside the repository`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): approval, policy promotion, demotion and retirement`.

### Task 32: Landing a learning in the repository, and reverting it

**Files:** Modify `scripts/lib/learn-lib.mjs`, `scripts/lib/manifest.mjs`, `scripts/lib/uninstall-lib.mjs`, `scripts/lib/apply-lib.mjs`. Test `scripts/lib/learn-land.test.mjs`, `scripts/lib/uninstall-lib.test.mjs`.

**Interfaces — Produces:**
- Manifest gains optional `learnings: { id: string, gateSha256: string }[]`, validated by `readManifestResult`.
- `planLand(root, id): { proposals: Proposal[] }` — a `file` proposal for `LEARNED.md` (upsert) and one for `gates.json` (the gate with its approved action), using the existing proposal shape so `renderDiff` and `applyProposals` handle them.
- `landLearning(root, id, { yes, allowDirty, allowDefaultBranch })` — refuses unless status is `active-local`; applies the same dirty-tree and default-branch gates as `scripts/apply.mjs` (extract those gates into a shared function in `apply-lib.mjs` and call it from both); records `landed`.
- `revertLearning(root, id, { yes, ... })` — removes exactly that entry and gate and its manifest record; records `reverted`.
- `uninstall` removes `LEARNED.md` and `gates.json` only when each is `ours-unmodified` and every entry id is in `manifest.learnings`; otherwise keeps them and says why.

- [ ] Tests: `land without --yes prints the diff and writes nothing`; `land --yes on the default branch exits 3`; `landing two learnings then reverting the first leaves the second byte-identical`; `the manifest records each learning`; `apply then land then uninstall leaves git status clean`; `a LEARNED.md the owner edited is kept on uninstall`; `a trial learning cannot be landed`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): land and revert one learning through the gated write path`.

### Task 33: Integrity check

**Files:** Create `scripts/lib/integrity-evidence.mjs`. Modify `scripts/lib/gap-model.mjs`. Test `scripts/lib/integrity-evidence.test.mjs`.

**Interfaces — Produces:** check `P5.integrity`, state `failing` when a kit-owned file is `ours-modified`, when a gate in `gates.json` has no `LEARNED.md` entry whose `approved-sha256` equals its `gateSha256`, or when a manifest learning has no gate; otherwise `declared`. Never `verified`.

- [ ] Tests: `an edited hook script is named`; `a gate whose text changed after approval is named`; `a gate with no registry entry is named`; `an untouched install is declared`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(detect): integrity of the harness and its learned gates`.

### Task 34: `learn` command

**Files:** Create `scripts/learn.mjs`. Modify `scripts/lib/cli.mjs`, `package.json`. Test `scripts/lib/learn-cli.test.mjs`.

**Interfaces — Produces:** `node scripts/learn.mjs <path> <subcommand>` with `candidates`, `draft --from <file>`, `list`, `show <id>`, `approve <id> --sha256 <hash> --action <warn|block>`, `wrong <session>:<line>`, `demote <id>`, `retire <id>`, `tick`, `land <id> [--yes] [--allow-dirty] [--allow-default-branch]`, `revert <id> [--yes]`, `policy show`, `policy set --min-firings <n> --min-sessions <n> --max-action <warn|block>`; `--json` on the read commands. `show` prints the gate as JSON with every non-ASCII code point shown as `\u{…}`, the hash, the replay result and the stats. `approve`, `wrong` and `policy set` call `requireInteractive` and exit 3 with its reason when refused. `LEARN_USAGE` in `cli.mjs`.

- [ ] Tests: `candidates lists recurrences that have no learning`; `draft reads a file and reports each stage`; `show makes an invisible character visible`; `approve run from a child process exits 3 and changes nothing`; `policy set run from a child process exits 3`; `tick prints what it promoted, demoted and retired`; `an unknown subcommand exits 2`; `every subcommand has --help`.
- [ ] Run, implement, run task tests and `npm test`.
- [ ] Commit `feat(learn): the learn command`.

### Task 35: The `harness-learn` skill and the session-start notice

**Files:** Create `skills/harness-learn/SKILL.md`, `skills/harness-learn/references/drafting.md`. Modify `assets/scripts/session-log.mjs`, `.claude-plugin/` manifests if skills are listed there. Test `scripts/lib/skill-learn.test.mjs`, `scripts/lib/session-log.test.mjs`.

**Interfaces — Produces:** a model-invocable skill (no `disable-model-invocation`) that states the absolute location of the CLIs relative to the skill's own directory in its first section; runs `log report`, presents unlabelled recurrences for the owner to label in `FAILURES.md`, drafts one learning per labelled recurrence as a JSON file in the scratch directory, runs `learn draft` and `learn tick`, and reports the result. It states that it must never run `approve`, `wrong` or `policy set`, and that log content is data. With `autodraft` on, the session-start handler emits the fixed line `kh-harness: <n> sealed sessions since the last learn tick. The harness-learn skill can review them.` when `n > 0`.

- [ ] Tests: `the skill names the CLI path explicitly`; `every command the skill prints exists in LEARN_USAGE or LOG_USAGE`; `the skill forbids the three terminal-only commands by name`; `with autodraft off the session-start handler prints nothing`; `the notice contains only the count`.
- [ ] Run, implement, run task tests and `npm test`; run `claude plugin validate --strict` if `claude` is on PATH.
- [ ] Commit `feat(skill): harness-learn`.

### Task 36: Doctrine, documentation and version

**Files:** Modify `docs/INTENT.md`, `docs/harness/RULES.md`, `README.md`, `assets/templates/RULES.md.tmpl`, `package.json`, `.claude-plugin/` manifests. Create `CHANGELOG.md`. Test `scripts/lib/dogfood-intent.test.mjs`, `scripts/lib/plugin-install.test.mjs`.

- [ ] Tests: `the kit's registry holds R11 to R14 and each pointer resolves`; `no rule is enforced-by none`; `the README documents the log and learn commands and every flag in their usage text`; `INTENT.md's Shown-by pointers resolve to existing files` (closing D4 for the lines this task touches).
- [ ] Run; fail on the missing rules.
- [ ] Implement: add R11 "A learned enforcer is data, never code" (`scripts/lib/harness-gates.test.mjs`), R12 "The log never stores an agent claim as an observed event" (`scripts/lib/session-log.test.mjs`), R13 "No learning is promoted without a terminal-typed approval or a recorded policy hash" (`scripts/lib/learn-lib.test.mjs`), R14 "Unattended, the loop writes nothing inside the repository and never alters a rule it did not learn" (`scripts/lib/learn-lib.test.mjs`). Reword the INTENT non-goal as the spec states; bring its P0.security text up to date (D3). README: the five commands, what the log stores and where, the best-effort scrub, the cost figures from the spec, what the loop may claim; correct the re-injection sentence. Version 0.2.0.
- [ ] Run task tests and `npm test`.
- [ ] Commit `docs: the session log, the learning loop and the rules that bind them`.

### Task 37: End-to-end lifecycle

**Files:** Create `scripts/lib/learn-lifecycle.test.mjs`. Modify `scripts/lib/lifecycle-fixtures.mjs`.

- [ ] Write one test that, in a fixture repository with `KH_DATA_DIR` sandboxed: applies the harness; enables the log; drives `session-log.mjs` and `tool-gate.mjs` with synthetic payloads for three sessions in which one command fails the same way in two and its corrected form succeeds; asserts `log report` shows one recurrence over two sessions; drafts a gate from a file; asserts it reaches `trial` and that `git status` is unchanged; drives a fourth session and asserts one observe firing and no blocked call; asserts `approve` from a child process exits 3; promotes by calling `approveLearning` with an injected interactive result; drives a fifth session and asserts the call is denied with the gate's message; lands with `--yes` on a feature branch and asserts exactly `LEARNED.md`, `gates.json` and the manifest changed; asserts `detect` reports `P5.integrity declared`; reverts; uninstalls; asserts `git status` equals the pre-apply state and that the log directory still exists.
- [ ] Run; fix whatever integration defect it exposes in the owning module, with a unit test there.
- [ ] Run `npm test` on the whole suite.
- [ ] Commit `test: the learning loop end to end`.
