# Changelog

All notable changes to kh-harness are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 - 2026-11-19

### Added

- The session log. A hook, `session-log.mjs`, registered on 16 Claude Code
  events (runbook step 31, `P5.sessionlog`). It records nothing until
  `log enable` is run for the repository on that machine; then it records
  each event, tool input and output included, in the per-machine data
  directory `~/.claude/kh-harness/<key>/` (or under `KH_DATA_DIR`), outside
  the repository, after a best-effort credential scrub. Sessions are sealed
  and compressed after 10 minutes idle and chained in an unkeyed index.
  While the log is enabled, a sealed session's content is removed after
  90 days by default; after `log disable` nothing expires until
  `log purge --yes`. Structure is kept until purged.
- The `log` command: `enable`, `disable`, `status`, `report`, `maintain`
  and `purge`.
- Recurrence detection: the same tool, input hash and normalised first
  error line in two or more sessions under the same kit hooks and model,
  reported by `log report`.
- The failure taxonomy, `docs/harness/FAILURES.md` (runbook step 29,
  `P5.failures`), scaffolded empty for the owner to label recurrences.
- The learning ledger, `ledger.jsonl` in the data directory: one
  hash-chained line per step of every learning, and per policy change.
- The gate hook, `tool-gate.mjs` (runbook step 30, `P5.toolgate`), which
  applies learned gates before every tool call: `observe` records a
  firing, `warn` adds a message after the call, `block` denies it. A gate
  is data in a declarative, linear-time language (`literal`, `token`,
  `glob` with `*` only), read from the committed
  `.claude/kh-harness/gates.json` and the machine's own `gates.local.json`.
- The `learn` command: `candidates`, `evidence`, `draft`, `replay`, `list`,
  `show`, `approve`, `wrong`, `demote`, `retire`, `tick`, `land`, `revert`,
  `policy show`, `policy set` and `policy clear`. A drafted gate is replayed
  against the log before it can act, tried at `observe`, and promoted to
  `warn` or `block` only by the owner's approval of its hash at a terminal
  or by a policy whose hash the owner recorded in the ledger at a terminal.
- `learn show <id>` lists a learning's latest ten firings, each as the
  `session:line` reference `learn wrong` takes, and how many more there
  are; `--firings` lists every one, and `--json` gives them as
  `listedFirings`.
- `learn evidence <signature>`: up to three recorded failures of one
  recurrence, the first in each session, with the next successful call's
  input, printed as escaped JSON between nonce-marked lines that say it is
  recorded data. A tool's output is never printed.
- `learn draft --redraft`: a recurrence whose learning the replay rejected,
  or another labelled with the same failure kind in `FAILURES.md`, is
  drafted again only with this flag, and the ledger records the redraft.
  The `harness-learn` skill passes it only when the owner asks.
- `learn land` and `learn revert`: a learning promoted on this machine goes
  into `docs/harness/LEARNED.md` and `.claude/kh-harness/gates.json`
  through `apply`'s write path and refusals, and comes out again. The dry
  run needs no terminal and writes nothing; the write (`--yes`) needs a
  person at a terminal and is left uncommitted for the owner. A revert
  proceeds from whatever trace of the learning remains, reads the commit
  when the working tree's gate file has lost the gate, and returns a landed
  learning to this machine or retires a suspended one. An interrupted land
  or revert, including one killed between a file write and the manifest
  write, is finished by running the same command again. `retire` refuses a
  learning whose gate is still committed and names the revert.
- `docs/harness/LEARNED.md`, the kit-owned registry of landed learnings,
  which the rules brief and `detect` read beside `RULES.md`.
- The `harness-learn` skill, which reviews the log, drafts one gate per
  owner-labelled recurrence and reports what the commands counted. It
  never runs the terminal-only subcommands.
- The loop warning, `loop-watch.mjs` (runbook step 13, `P2.loopwatch`): one
  fixed sentence when the same call fails the same way three times in a
  row. It counts without a lock: each failure appends one record and reads
  back only a capped tail, so no count is dropped when several failures
  arrive at once.
- `P5.integrity` (runbook step 32): kit hook scripts against the manifest,
  and each committed gate against its approval in `LEARNED.md`.
- `P0.kitskew`: unmodified kit files are proposed as updates when the
  kit's version of them changes, so an upgrade reaches existing installs.
- Rules R11 to R14 in the kit's own registry, `CHANGELOG.md`, and an
  as-built section in the session-log design.

### Changed

- Existing installs receive new deny rules. `P5.toolgate` is `declared`
  only when every deny rule the gate hook is installed with is present:
  edits to `.claude/scripts/`, `.claude/kh-harness/`, the manifest,
  `docs/harness/LEARNED.md` and `~/.claude/kh-harness/`, and running the
  eight terminal-only `learn` subcommands (`approve`, `wrong`, `demote`,
  `retire`, `land`, `revert`, `policy set`, `policy clear`), in the Bash and
  PowerShell tools. `apply` proposes the missing ones to an install made
  before they existed.
- Upgrading from 0.1.0: every generated file carries the kit's version in
  its stamp, so on a 0.1.0 install `detect` proposes every unmodified
  kit-owned file as an update (`P0.kitskew`), the `RULES.md` scaffold
  included, whose comment changed. A file you edited is kept and named.
- `stripUnsafe` removes more invisible characters: the variation
  selectors, the Hangul fillers, and U+2028, U+2029 and U+0085.
- `detect`: one credential table serves both the sweep and the hooks'
  mask; proposals carry `via` (`apply`, `skill` or `human`) and the
  no-actions line counts failing checks.
- `apply`: a hook script and the module it imports are updated together
  or not at all; the dry run prints the execution disclosure whenever a
  hook is proposed.
- `uninstall` also removes the two files `learn land` writes, each only
  while it is unmodified and holds nothing but learnings the manifest
  records; `LEARNED.md` stays whenever `gates.json` stays, and `gates.json`
  stays for its partner only when `LEARNED.md` holds an unrecorded
  learning. Removing `gates.json` clears the manifest's landed learnings;
  the ledger is not changed. It reports the session log's directory and
  size and never removes it.
- The rules brief reads `LEARNED.md` after `RULES.md`, and skips a rule
  that does not fit and keeps going.
- The `RULES.md` and `FAILURES.md` templates no longer promise an enforcer
  or a drafting rule the code does not provide.
- The README's claim that per-prompt re-injection counters the decay of
  told rules is withdrawn: the decay is measured, the remedy is not.

### Fixed

- `detect`: a directory the walk cannot list is a finding, not an empty
  walk; an unparseable settings file or a malformed manifest is its own
  state, not an absence; the report is written atomically and only inside
  the repository; a concatenated string literal and a JavaScript arrow
  parameter are no longer reported as credentials, and a quoted value can
  no longer escape the mask.
- `detect` and `apply`: a hook is credited as the kit's only by its own
  registration, never because the logging hook occupies the same event.
- `apply`: `--yes` writes nothing (exit 2) when a batch holds a settings
  patch and `settings.json` cannot be parsed, so no hook script is left
  installed and unregistered; a malformed manifest makes `apply` and
  `uninstall` refuse (exit 3).
- `uninstall`: a settings patch is reverted only when a kit generator could
  have written it, and a hook entry counts as the kit's only in the exact
  shape a generator writes; a patch kept for lack of provenance is listed
  as kept and leaves the exit code at 0.
- The lint sensor and the Stop gate: suppression counts reset on a clean
  run; command redaction drops a line only when it echoes the whole
  command or holds a command token of 8 or more characters, so diagnostics
  that name the tool survive; whole outputs are masked, so a private key's
  body lines are hidden; the lint sensor says when it could not confirm a
  file clean, and walks up past a manifest with no lint script.
- The session brief and the rules brief strip, mask and escape the text
  they inject.

### Limits

On one user account these controls are detection and deny rules, not
isolation: an agent with a shell can forge or rewrite ledger lines and
firing counts, write the local gate file, reach `learn.mjs` past the deny
rules, or call the kit's functions directly, and nothing marks a forged
ledger line as forged. The scrub is best-effort, and recorded content
stops expiring once the log is disabled. The README's "Limits" section
lists each case.
