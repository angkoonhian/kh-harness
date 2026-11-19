# Changelog

All notable changes to kh-harness are recorded here, one section per
release headed by its version and date, with Added, Changed and Fixed
lists in the manner of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The headings are plain, without links, since no release is tagged yet. The
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 - 2026-11-19

### Added

- The session log. A hook, `session-log.mjs`, registered on 16 Claude Code
  events (runbook step 31, `P5.sessionlog`). It records nothing until
  `log enable` is run for the repository on that machine; then it records
  each event, tool input and output included, in the per-machine data
  directory `~/.claude/kh-harness/<key>/` (or under `KH_DATA_DIR`, when it
  holds an absolute path; a relative value is ignored), outside the
  repository, after a best-effort credential scrub. Sessions are sealed
  and compressed after 10 minutes idle and chained in an unkeyed index.
  Content is removed once a session's last event is 90 days old by
  default, but only from a session that is sealed and still matches the
  index, and only when a session starts while the log is enabled or
  `log maintain` is run. Structure is kept until purged.
- The `log` command: `enable`, `disable`, `status`, `report`, `maintain`
  and `purge`. `maintain` runs on a disabled log too, and exits 2 when a
  step did not run. `purge --yes` deletes the ledger, the learnings, the
  policy and this machine's gate file with the log, so it runs only when
  standard input and output are terminals and `CLAUDECODE` is unset (exit
  3 otherwise) and takes the data directory's locks; its dry run needs no
  terminal. `status` counts the sessions holding content past the
  retention period, with the reason.
- Recurrence detection: the same tool, input hash and normalised first
  error line in two or more sessions under the same kit hooks and model,
  reported by `log report`. A failure records the project root, so its
  signature does not depend on the directory or worktree the report is run
  from. A call interrupted while its tool ran is not a failure. A failure
  left out of every recurrence is counted, by reason. The recorded lines
  are printed inside a nonce-marked block that says they are data.
- Bounded reads: a session file, the seal index and the ledger up to
  256 MiB, `FAILURES.md` and the other repository documents `detect` reads
  up to 1 MiB, a transcript line up to 64 MiB. A file over its bound is
  reported as not read or unreadable, never as empty. A session start
  seals and expires only sessions up to 2 MiB on disk and leaves larger
  ones for `log maintain`.
- Nothing in the data directory is written or removed through a link, and
  the blob sweep removes only files named as a blob or a blob's temporary
  file. An unfinished last line in the seal index or the ledger, as an
  interrupted append leaves, is not a break and is dropped before the next
  append.
- The failure taxonomy, `docs/harness/FAILURES.md` (runbook step 29,
  `P5.failures`), scaffolded empty for the owner to label recurrences.
- The learning ledger, `ledger.jsonl` in the data directory: one
  hash-chained line per step of every learning, and per policy change.
- The gate hook, `tool-gate.mjs` (runbook step 30, `P5.toolgate`), which
  applies learned gates before every tool call: `observe` records a
  firing, `warn` adds a message after the call, `block` denies it. Every
  gate is tried: a call is denied when any matching gate blocks, the text
  names each matching gate above `observe`, blocks first, up to 4,000
  characters, and each match records its own firing. A gate
  is data in a declarative, linear-time language (`literal`, `token`,
  `glob` with `*` only), read from the committed
  `.claude/kh-harness/gates.json` and the machine's own `gates.local.json`.
  A gate message the credential mask would change is rejected. The hook
  enforces what the two files hold and checks no approval.
- The `learn` command: `candidates`, `evidence`, `draft`, `replay`, `list`,
  `show`, `approve`, `wrong`, `demote`, `retire`, `tick`, `land`, `revert`,
  `policy show`, `policy set` and `policy clear`. A drafted gate is replayed
  against the log before it can act, tried at `observe`, and promoted to
  `warn` or `block` by a `learn` command only through `learn approve` with
  its hash, run at an interactive terminal outside Claude Code, or through
  `tick` under a policy whose hash the ledger records (set with
  `learn policy set`, which needs the same terminal). A process running as
  the user can forge a terminal or a ledger line.
- The replay's differential check: the gate must fire on every recorded
  mistake and on none of the successful calls of its tool in the
  recurrence's own sessions; with no such successful call the verdict is
  `not-checkable`, never a pass.
- `learn draft` refuses (exit 3) a signature no failure kind in
  `FAILURES.md` lists, and refuses while that file exists but was not
  read. `learn tick` promotes nothing under a policy while it is not read.
- The ledger records a second hash for each learning, of its title, why
  and evidence, checked wherever the gate's hash is. `learn approve`
  prints the learning before it records the approval, and `learn land
  --yes` prints the diffs it then writes. A learning drafted before the
  second hash existed is named by `list` and `show`, is not promoted by a
  policy, and gains the hash at an approval or a landing.
- A learning file a stopped step left behind the ledger is rolled forward
  from the ledger by the same command run again, by any step that writes,
  or by `tick`; `landed` and `reverted` entries are left to `learn land`
  and `learn revert`, each of which finishes its own stop only when the
  ledger vouches for the file's title, why and evidence. `tick` records as
  retired a learning the ledger names that has no file left, when the
  ledger last records it at `observe` and names no approver for it; any
  other is reported and left, and restoring its file restores it.
- `learn list`, `show` and `tick` report a local learning whose id the
  committed gate file holds for another gate. Ids are per machine and
  nothing renumbers a learning.
- One exit-code rule for every `learn` subcommand: 3 for a refusal (the
  terminal check, a learning in the wrong status, one the ledger does not
  vouch for, a draft not accepted), 2 when the step could not act (a
  malformed argument, an id that names nothing, a read, lock or write
  that failed).
- `learn show <id>` lists a learning's latest ten firings, each as the
  `session:line` reference `learn wrong` takes, and how many more there
  are; `--firings` lists every one, and `--json` gives them as
  `listedFirings`.
- `learn evidence <signature>`: up to three recorded failures of one
  recurrence, the first in each session, with the next successful call's
  input, printed as escaped JSON between nonce-marked lines that say it is
  recorded data. A tool's output is never printed.
- `learn draft --redraft`: a recurrence whose learning the replay rejected,
  or whose learning was retired after a wrong mark, after its gate was
  suspended, or by the owner, or another labelled with the same failure
  kind in `FAILURES.md`, is drafted again only with this flag, and the
  ledger records the redraft. A policy does not promote a trial whose
  recurrence or failure kind an earlier learning was marked wrong for.
  The `harness-learn` skill passes `--redraft` only when the owner asks.
- `learn land` and `learn revert`: a learning promoted on this machine goes
  into `docs/harness/LEARNED.md` and `.claude/kh-harness/gates.json`
  through `apply`'s write path and refusals, and comes out again. The dry
  run needs no terminal and writes nothing; the write (`--yes`) runs only
  at an interactive terminal outside Claude Code and is left uncommitted
  for the owner. A revert
  proceeds from whatever trace of the learning remains, reads the commit
  when the working tree's gate file has lost the gate, and returns a landed
  learning to this machine or retires a suspended one. An interrupted land
  or revert, including one killed between a file write and the manifest
  write, is finished by running the same command again. `retire` refuses a
  learning whose gate is still committed and names the revert.
- `docs/harness/LEARNED.md`, the kit-owned registry of landed learnings,
  which the rules brief and `detect` read beside `RULES.md`. An entry
  records the gate's hash and, on its own line, the action approved
  (`- approved-action:`); `P5.integrity` compares both with the committed
  gate.
- The `harness-learn` skill, which reviews the log, drafts one gate per
  owner-labelled recurrence and reports what the commands counted. It
  never runs the terminal-only subcommands.
- The loop warning, `loop-watch.mjs` (runbook step 13, `P2.loopwatch`): one
  fixed sentence when the same call fails the same way three times with no
  different failure between them. It counts without a lock: each failure appends one record and reads
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
  PowerShell tools, and running `log purge --yes`, with `--yes` before or
  after `purge`; `log purge` without `--yes` is not denied. `apply`
  proposes the missing ones to an install made before they existed.
- Upgrading from 0.1.0: every generated file carries the kit's version in
  its stamp, so on a 0.1.0 install `detect` proposes every unmodified
  kit-owned file as an update (`P0.kitskew`), the `RULES.md` scaffold
  included, whose comment changed. A file you edited is kept and named.
  One kit hook script that was edited, or a file at one of the kit's
  script paths that it did not write, holds every hook script at the
  installed version: none is written or updated, the new hooks stay
  unregistered, and `detect` names the file and says to restore it and
  run `apply` again. The stamp on a hook script now says "Do not edit";
  scaffolds keep "Edit freely".
- Every installed hook checks the sibling scripts it loads and, beside an
  older or missing one, exits 0 with at most one notice per session. The
  notice says to run `apply --yes`, and to restore a file `apply` reports
  as kept or gone. The rules brief no longer exits 1 in that case.
- `stripUnsafe` removes more invisible characters: the variation
  selectors, the Hangul fillers, and U+2028, U+2029 and U+0085.
- `detect`: one credential table serves both the sweep and the hooks'
  mask; proposals carry `via` (`apply`, `skill` or `human`) and the
  no-actions line counts failing checks.
- `apply`: the hook scripts, which load one another, are written, updated
  and registered at one kit version or not at all; the dry run prints the
  execution disclosure whenever a hook is proposed, and the disclosure
  names every hook `apply` installs, its events, and what it reads and
  runs. `.claude/settings.json` is replaced once per run, by a temporary
  file and a rename, with the manifest written next; a kill between the
  two leaves entries the manifest does not record.
- `detect`, `apply` and `uninstall` reject a second path (exit 2). A
  dry-run `apply` over a manifest that cannot be read exits 3.
- `uninstall` keeps the two files `learn land` writes while either holds a
  landed learning, prints the count and names `learn revert <id>`; once
  they hold none it removes both. If either is kept, both are. It drops
  the record of a file or settings entry the owner already removed by
  hand, removes a manifest left with no record, and says that it leaves
  `docs/harness/detect.json`. It reports the session log's directory and
  size and never removes it.
- The rules brief reads `LEARNED.md` after `RULES.md`, and skips a rule
  that does not fit and keeps going. A learned rule is re-told unless its
  entry records `approved-action: block`; one that warns, or whose entry
  has no such line, is re-told. The hook reads the entry, not the gate in
  force.
- `detect.json`: `harness.claudeDir.hookEvents` is gone
  (`hookRegistrations` holds the registrations), `harness.remotesError`
  is set when git could not list the remotes, and a deny rule that names a
  path outside the repository is counted and not written into the report.
  Phase 5 is titled "Learning".
- Every git call the kit makes runs with a timeout and without `GIT_DIR`
  and git's other repository variables. A directory that is not a
  repository by its own `.git` while one of them is set is an error, not
  "not a repository".
- A `settings:permissions.deny` rule pointer resolves only on a deny rule
  that is not one of the kit's own.
- `npm test` needs Node 22.1; the commands and the installed hooks run on
  Node 22.0.
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
  no longer escape the mask. A quoted secret is passed over as source code
  only when its opening quote closes a string literal, so one that begins
  with a character such as `.`, `+`, `,`, `)` or `;` is still a finding.
- The session log's scrub: a credential-named key hides everything beneath
  it, through arrays and objects; a run of string elements is masked as
  one text, so a private key held one line per element is hidden; the
  first error line is masked before it is cut.
- `uninstall`: a settings entry the owner gave a `__proto__` key is no
  longer taken for the kit's own.
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
ledger line as forged. The ledger's and the seal index's chains have no
key and show only damage that breaks them. The terminal check is that
standard input and output are terminals and `CLAUDECODE` is unset, not
that a person is present. The scrub is best-effort, and after
`log disable` recorded content expires only when `log maintain` is run.
The README's "Limits" section lists each case.
