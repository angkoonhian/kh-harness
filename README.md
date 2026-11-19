# kh-harness

Inventories an existing repository against the harness runbook, proposes only
what is missing, and — if you say so — writes it. Additive by design: it never
overwrites, never deletes a file you authored, and never rewrites one it did
not write itself.

Once installed, the harness can also keep a log of every Claude Code session
on your machine, find the tool failures that recur across sessions, and turn
one into a small tool-call gate that you approve. The log and everything the
loop keeps live outside the repository.

Two rules it holds itself to, and which the rest of this document is mostly
about keeping honest:

- **Write only what detection proved.** A bootstrap script with guessed steps
  is worse than none, because it will be run and trusted.
- **Report only what is true.** Every state it prints says what was *looked
  for*, not what *is*. A check that could not decide asks a question instead
  of proposing something.

Zero runtime dependencies. Node 22+. Nothing is sent anywhere.

## Installing as a plugin

The primary way to use this is as a Claude Code plugin, from the repository
root:

    claude plugin marketplace add ./
    claude plugin install kh-harness@kh-harness-local

Then, in the repository you want harnessed, invoke `/harness-init`. The skill
drives the same `detect` / `apply` / `uninstall` CLIs documented below — it is
a guided front end for them, not a second tool with its own logic.

**`claude plugin marketplace add .` is rejected.** Claude Code reports
`Invalid marketplace source format. Try: owner/repo, https://..., or ./path`.
Only `./` — the leading `./` — works. This is a trap worth knowing about
before you hit it.

**Before you run `apply --yes` anywhere: it can install hooks that execute
this repository's own `lint`, `typecheck` or `test` scripts automatically**,
on every edit or every turn end. Read "What installing the hooks means"
below first. The plugin itself installs none of this — it ships skills
only, and the hooks are something `apply` writes into *your* target
repository when you ask it to, never something the plugin declares.

The plugin ships two skills and declares no hooks:

- `harness-init` sets up the harness. It is never invoked by the model on
  its own (`disable-model-invocation: true`); you start it.
- `harness-learn` reviews the session log, drafts learnings and reports what
  the commands counted. The model can invoke it, so its description is in
  every session's context.

`claude plugin details kh-harness` reports the inventory and the projected
token cost. It has not been re-measured for this release; run it yourself.
Its `Hooks (0)` line is the platform's own confirmation that nothing about
the plugin itself runs code in your repository automatically.

A folder marketplace tracks the working tree, not a snapshot of it:
`claude plugin list` shows `Read from: <path to this repository>`. Installing
from `./` is therefore not a copy — the installed plugin reads out of this
working directory. Convenient while developing it; surprising if you expected
an "installed" thing to stay put. Whether an edit is picked up without
restarting your session is Claude Code's behaviour rather than this
repository's, and is not something we have measured — restart if it matters.

## The five commands

    node scripts/detect.mjs    <path-to-repo> [--verify] [--json]
    node scripts/apply.mjs     <path-to-repo> [--yes] [--allow-dirty] [--allow-default-branch]
    node scripts/uninstall.mjs <path-to-repo> [--yes]
    node scripts/log.mjs       <path-to-repo> <subcommand> [--yes] [--json]
    node scripts/learn.mjs     <path-to-repo> <subcommand> [arguments] [--json]

Each takes `--help` for its full contract; `learn <subcommand> --help` gives
one subcommand's. `apply` and `uninstall` **default to a dry run**: without
`--yes` they print exactly what they would do, and do nothing. A dry run is
never refused; when `--yes` would be, it says so in a `note:` line after the
diffs.

A normal first pass:

    node scripts/detect.mjs .        # read the report
    node scripts/apply.mjs .         # read the diffs — nothing is written
    node scripts/apply.mjs . --yes   # write them (names each action; the diffs were the dry run's)
    git diff                         # this is the point of the branch gates below

### `detect`

Reports every capability as one of `verified` / `declared` / `absent` /
`failing` / `n/a`, with the evidence it read. Writes exactly one file into the
target repository, `docs/harness/detect.json`, and changes nothing else. Commit
that file or ignore it as you prefer: `apply`'s dirty-tree gate treats it as the
kit's own write, so a re-generated report never blocks the next `apply`.
`detect` never reads the session log.

An `absent` capability carries either a `→` **proposal** (the step that closes
it) or a **question** (detection could not decide, so it asks rather than
guesses). A proposal names who closes it: `apply` writes most of them; the
`harness-init` skill drafts the recon, the instruction file, the architecture
document and the intent document; adding a git remote is left to you. The
summary counts the three apart, and `apply` says when nothing is left that it
can write, with how many checks are still absent, how many are failing, and
how many questions are open. **Advice** is a third thing: a gap that is fully
known but that this tool will never write, because closing it means editing
your package manifest — the file most likely to be hand-tuned, and the one
this tool must not touch.

| Flag | What it does |
|---|---|
| `--verify` | Runs the test, lint and typecheck commands it discovered, to turn claims into evidence. **This executes this repository's own commands.** There is no confirmation prompt: the flag is the consent. `install` and `build` are never run, because they mutate the tree. Each record carries the exit code (`null` for a command the bound stopped), the duration and whether the 10-minute bound stopped it (`timedOut`); commands run with `CI=1`, so a test runner's watch mode is off and snapshots are not written; output is never captured. |
| `--json` | Prints the full report to stdout instead of the human summary. Warnings go to stderr, so stdout stays parseable. |

`P0.security` scans tracked files, git remote URLs and the two `.claude`
settings files for credential shapes. It never prints a value, only a location
and a line number. A file it could **not read** is reported as a finding of its
own and the check cannot say `verified` while one exists — a sweep that
skipped a file in silence is the one failure this check must never have.

A literal password-shaped value in a **test or fixture path** (`tests/`,
`__tests__/`, `fixtures/`, `*.test.*`, …) is listed at severity `low` and
does not by itself make the check `failing`; a provider token is `high`
wherever it sits, because a live key in a test file is still a live key. The
role lowers severity, never visibility — every finding is still listed and
still in `detect.json`.

**This repository passes its own check.** `node scripts/detect.mjs .` reports
`P0.security verified` on kh-harness itself, and a test (`DOGFOOD:
kh-harness passes its own P0.security check`) fails if that ever stops being
true. It is worth stating because it was not always so: the detector's own
test fixtures used to be committed as credential-shaped literals, so the tool
failed on itself, and "it always says failing here" is exactly how a real
finding gets normalised into noise. The fix was to assemble those fixtures at
runtime, not to add a suppression mechanism — there is no ignore list, and
there will not be one, because an exclusion that silences the check on this
repository silences it on yours too.

`P5.integrity` reports `failing` when a hook script the manifest records has
been edited or deleted, when a committed gate has no approval in
`docs/harness/LEARNED.md`, or when a landed learning has no gate behind it.
It reads only the repository and proposes nothing.

### `apply`

Writes the files and settings patches `detect` proposed. Nothing else, ever:

- A **write allowlist in code** (not a permission rule in `settings.json`,
  which would appear to work and silently would not) bounds every path.
- **Filesystem containment** is checked before any write, so a symlink or
  junction cannot route a write out of the repository.
- A file this tool did not write is **never overwritten**. `CLAUDE.md` is
  never written by `apply` at all — it is not on the allowlist; the skill
  drafts `docs/harness/CLAUDE.proposed.md` for you to merge by hand.
- A file you have since **edited** is left alone and reported as `kept`.
- A kit file you have **not** edited is updated when the kit's version of it
  has changed (`P0.kitskew`). A hook script and the module it imports are
  updated together or not at all, so an update held back by an edited file
  is named with its cause.
- There is **no `--force`**. Not a flag, not an option, not a code path. git is
  the escape hatch, which is what the two refusals below exist to protect.

| Flag | What it waives |
|---|---|
| `--yes` | Nothing — this is what makes it write at all. Without it you get proposals and diffs. |
| `--allow-dirty` | The refusal to run with uncommitted changes to tracked files. That gate exists so you can `git diff` exactly what this tool did. This tool's own prior writes are already excused from it, via the manifest, so re-running should not need this. |
| `--allow-default-branch` | The refusal to run on `main`, `master`, the branch `init.defaultBranch` names, or the one `origin/HEAD` points at — a repository with no commits yet included — for the same reason. |

Both gates apply only to `--yes`. When git cannot be consulted at all (not
installed, or it refuses to read the directory), neither gate can run, and
`--yes` refuses unless both flags are given.

### `uninstall`

Removes what `apply` installed, and nothing else. A path is removed only when
the manifest records it, the content on disk still matches what was written
(line endings aside — a CRLF checkout does not count as an edit), **and**
the content still carries the `Generated by kh-harness` marker. Anything else
is kept, and said to be kept, with the reason.

Settings patches are reverted by content hash, never by position, so a hook of
your own added above ours is never the one removed. A patch is reverted only
when one of the kit's generators could have written it, so a forged manifest
entry cannot strip your own hooks or deny rules. Empty directories this tool
itself created are removed; a directory that existed beforehand never is.

`docs/harness/LEARNED.md` and `.claude/kh-harness/gates.json` are removed
only together, and only while each is untouched and holds nothing but
learnings the manifest records. The session log is data, not installation:
`uninstall` names its directory and size and never removes it.

| Flag | What it does |
|---|---|
| `--yes` | Actually remove. Without it, nothing is removed. |

### `log`

    node scripts/log.mjs <path-to-repo> enable
    node scripts/log.mjs <path-to-repo> disable
    node scripts/log.mjs <path-to-repo> status [--json]
    node scripts/log.mjs <path-to-repo> report [--json]
    node scripts/log.mjs <path-to-repo> maintain
    node scripts/log.mjs <path-to-repo> purge [--yes]

`enable` and `disable` turn the log on and off for this repository on this
machine. `status` says what the log holds and whether it can be trusted: the
sealed-session index, the ledger's chain, what could not be read, retention,
transcript coverage and what hooks cannot see. `report` lists the failures
that recur and how each learned gate fired. `maintain` seals and expires
what the session-start hook did not reach. `purge` lists what it would
remove; with `--yes` it removes this repository's data directory. `--json`
applies to `status` and `report` only. The sections below say what each of
these touches.

### `learn`

    node scripts/learn.mjs <path-to-repo> candidates [--json]
    node scripts/learn.mjs <path-to-repo> evidence <signature> [--json]
    node scripts/learn.mjs <path-to-repo> draft --from <file> [--redraft]
    node scripts/learn.mjs <path-to-repo> replay <id>
    node scripts/learn.mjs <path-to-repo> list [--json]
    node scripts/learn.mjs <path-to-repo> show <id> [--json]
    node scripts/learn.mjs <path-to-repo> approve <id> --sha256 <hash> --action <warn|block>
    node scripts/learn.mjs <path-to-repo> wrong <session>:<line>
    node scripts/learn.mjs <path-to-repo> demote <id>
    node scripts/learn.mjs <path-to-repo> retire <id>
    node scripts/learn.mjs <path-to-repo> tick [--json]
    node scripts/learn.mjs <path-to-repo> land <id> [--yes] [--allow-dirty] [--allow-default-branch]
    node scripts/learn.mjs <path-to-repo> revert <id> [--yes]
    node scripts/learn.mjs <path-to-repo> policy show [--json]
    node scripts/learn.mjs <path-to-repo> policy set --min-firings <n> --min-sessions <n> --max-action <warn|block>
    node scripts/learn.mjs <path-to-repo> policy clear

`land` and `revert` are built in `scripts/lib/learn-land.mjs`; until their
command-line wiring lands, `learn` rejects them as unknown subcommands (exit
2). "How a recurrence becomes a learning" below says what each subcommand
does and who runs it.

## What installing the hooks means — read this before `apply`

`apply` can install seven Claude Code hooks. Two of them cause **this
repository's own scripts to be executed automatically**, by Claude Code,
without being asked each time:

| Hook | When | What it runs |
|---|---|---|
| `PostToolUse` | after each `Write`/`Edit` | the **owning package's `lint` script**, on the one file just edited, bounded at 30s |
| `Stop` | at the end of each turn | the **root package's `typecheck` script**, or `test` if there is no `typecheck`, over the **whole repository**, bounded at 120s |
| `SessionStart` | at session start | nothing — it reads `HANDOFF.md` (or `docs/HANDOFF.md`) and prints the top of it |
| `UserPromptSubmit` | on every prompt | nothing — it reads `docs/harness/RULES.md` and `docs/harness/LEARNED.md` and adds up to 1500 bytes of their rules to the prompt's context, the owner's high-priority rules first (installed only once the registry holds a rule) |
| `PostToolUseFailure` | after each failed tool call | nothing — at the third identical failure in a row it tells Claude, in one fixed sentence, to change approach |
| `PreToolUse` | before every tool call | nothing — it compares the call with the learned gates and can **block** it; no gate exists until one is learned and promoted |
| the session log | on each of 16 events | nothing — once the log is enabled on this machine it records each event, **tool input and output included**, outside the repository |

Each hook is registered in Claude Code's exec form — `node` plus the script's
path rooted at `${CLAUDE_PROJECT_DIR}` — so it runs with no shell and from any
working directory. A registration you already have in shell form
(`node .claude/scripts/…`) is recognised as the same hook and left alone.

A repository's own lint or test script is arbitrary code in every project; that
is not new. What changes is **automation**: you stop typing it, and a `git pull`
that edits `scripts.lint` therefore changes what now runs by itself.

The `Stop` gate's cost scales with the size of the **repository**, not the size
of the edit. On a large codebase expect 10–30s added per turn. If that is the
wrong trade for you, do not install it — or `uninstall` it, which reverts the
hooks it installed and removes their scripts.

Neither process hook is installed unless its check reported `absent` **and**
you ran `apply --yes`. Both hooks' output is bounded and passes a two-layer
credential filter before any of it reaches the model.

The gate hook is installed with deny rules. They stop Claude Code's file
tools from editing the whole `.claude/scripts/` directory (including any
script of yours kept there), `.claude/kh-harness/`, the manifest,
`docs/harness/LEARNED.md` and `~/.claude/kh-harness/`, and they decline
the `learn` subcommands that approve or weaken a gate. An install made
before these rules existed is proposed the ones it lacks.

## The session log

### What it stores, and where

The session-log hook is registered on 16 events: `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`,
`PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`,
`Stop`, `StopFailure`, `InstructionsLoaded`, `PreCompact`, `PostCompact`,
`PostModelSwitch` and `SessionEnd`. It records nothing until you run
`log enable` for this repository on this machine. A teammate or a CI run
with the same hook records nothing until they enable it themselves.

Once enabled, each event is one JSON line:

- identity: the session, prompt, tool-use and agent ids, and the working
  directory;
- for a tool call: the tool, a hash and the size of its input, the status,
  the duration, the size of the output, and the first line of an error;
- content: the prompt you typed, and each tool call's input and output
  (stored with the call's result), the reason for a permission denial, and
  a stop failure's error;
- which harness ran: a hash of the kit's installed hook scripts and their
  settings patches, a hash of the learned gates in force, the kit version
  and the model. It is written at session start, on a model switch, and on
  a prompt whose identity or model has changed;
- a flag on a session in which a tool fetched outside content (`WebFetch`,
  `WebSearch` or any MCP tool), and each firing of a learned gate.

It lives outside the repository, in this machine's data directory:
`~/.claude/kh-harness/<key>/`, or `$KH_DATA_DIR/<key>/`. The key is the first
16 hex characters of a SHA-256 of the repository's git common directory, so
every worktree of one repository shares one log. The kit never edits
`.gitignore`, and nothing there can be committed by accident. A payload
larger than 64 KiB is stored once, compressed, under `blobs/` and referenced
by its hash.

### What is never stored

- The agent's own account of its work: its last message at a stop and a
  compaction summary. These are claims, not observations.
- The input of a `PreToolUse` or `PermissionRequest` event: only its hash
  and size. The input is stored once, with the call's result.
- A transcript's contents. The session-start line records the transcript's
  path; `log status` reads the transcript to count user interrupts and
  prints only counts.
- Anything at all while the log is disabled. The hook then reads only the
  event name and the session id.

### The credential scrub, and what it misses

Every string and every object key is masked with the same credential table
the `P0.security` sweep uses, before anything is written. A value under a
credential-named key or after a credential flag (`--password`, an
`Authorization:` header) is replaced whole. **The scrub is best-effort**, and
the commands say so:

- A credential in a shape the table does not know, or shorter than the
  length a shape requires, is stored as written.
- The input hash is computed over the raw input, before the scrub. A short
  secret can be found from its hash by trying candidates.
- Anything you paste into a prompt is stored, after the same mask.

The lint sensor and the Stop gate filter their output a second way: a line
that repeats a part of the command they ran is dropped. Only parts of 8
characters or more count, so a secret shorter than 8 characters inside a
`sh: <word>: command not found` line is not dropped, and reaches the model
unless the mask recognises it.

### Retention, sealing, `maintain`, `purge`

- **Retention.** Content (prompts, tool input and output, denial reasons,
  stop-failure errors) is removed after 90 days, or the
  `contentRetentionDays` set in `config.json` beside the log. Structure
  (ids, tools, hashes, sizes, statuses, first error lines, times and the
  harness lines) is kept until you purge.
- **Sealing.** A session idle for 10 minutes is sealed at the next session
  start: compressed, hashed whole, and its hash appended to an index whose
  every line carries the hash of the line before. `log status` checks that
  chain and each sealed file. It shows accidental damage and naive edits.
  It does not stop a process running as you, and events not yet sealed are
  checked by nothing.
- **`maintain`.** The session-start hook gives sealing and retention 150 ms
  and leaves the rest for later. `log maintain` runs the same work for
  minutes, for a log that has outgrown that budget. It needs the log
  enabled.
- **`purge`.** Without `--yes` it lists what it would remove. With `--yes`
  it removes this repository's whole data directory, which holds the ledger,
  the learnings, the policy and this machine's gates as well as the log,
  and it disables the log. It removes nothing else.

### What it costs

Measured on the owner's own transcripts from one project, 7,134 tool calls
in 16 days: about 48 MB of full content, roughly 90 MB a month at that pace
before compression, and about 13 MB a month for structure alone (assuming
1 KB per call). A minimal Node append measured about 55 ms on the owner's
machine. The logging hook spawns no child process. On the development
machine it added about 30 ms over a bare Node start, and the gate hook,
with 100 gates and a 64 KiB input, added 38 to 45 ms. The test suite fails
either hook when its median adds more than 100 ms. Counting Node's own
start-up, each of the two hooks that run on every tool call takes about 0.1
seconds on Windows.

## The learning loop

### How a recurrence becomes a learning

| Step | Who | What |
|---|---|---|
| 1. Record | the hooks | Once you enable the log, each session is recorded. |
| 2. Find recurrences | `log report`, `learn candidates` | The same tool, input hash and normalised first error line, in two or more sessions under the same kit hooks and model. Plain code; no model. |
| 3. Name the failure | you | In `docs/harness/FAILURES.md`, a heading `## F<n> — <kind of failure>` and a line `- signatures: <signature>`. The kit never writes a label. |
| 4. Draft | the model, through `harness-learn` | Reads `learn evidence <signature>`, writes one gate as JSON and runs `learn draft --from <file>`. The skill drafts only for a labelled recurrence. |
| 5. Replay | `learn draft`, `learn replay` | The script, not the model, checks that the gate fires on every recorded failure and on none of the successful calls of the same tool that followed, and on no call of that tool in sessions without the failure. |
| 6. Trial | the gate hook | A gate that passes is put in this machine's gate file at `observe`: it records each firing and blocks nothing. |
| 7. Promote | you at a terminal, or your policy through `tick` | `learn show <id>`, then `learn approve <id> --sha256 <hash> --action <warn\|block>`, moves it to `warn` or `block` on this machine only. |
| 8. Count | the gate hook, `log report` | Each firing, per action; how often a warning or block was followed by a successful call of the same tool; how often you marked it wrong. |
| 9. Land | you at a terminal | `learn land <id> --yes` writes it into the repository, for you to commit. |
| 10. Take back | you, or `tick` | `wrong`, `demote`, `retire` and `revert`, below. |

A replay can end three ways. `pass` puts the gate on trial. `fail` rejects
it; that recurrence, and any other labelled with the same failure kind, is
drafted again only with `learn draft --redraft`, which the ledger records as
a redraft. `not-checkable` leaves a candidate: the false-positive check needs
at least 20 clean calls of the gate's tool across at least 2 sessions, so a
fresh log returns `not-checkable` for most drafts. `learn replay <id>` tries
again once the log holds more.

A gate is data, not code: a tool name, one field of the tool's input, a
pattern (`literal`, `token`, or `glob` with `*` as its only wildcard), an
action and a fixed message. One hook interprets it.

`learn tick` runs the steps that need no person: it brings this machine's
gate file into line with the ledger, retires a trial whose cited paths are
all gone, demotes a gate marked wrong twice, and promotes under your policy.
It never retires a gate that warns or blocks; one whose cited paths are gone
is reported in `citationsGone`. It runs when you or the `harness-learn`
skill run it, never by itself. With `autodraft: true` in the log's
`config.json`, the start of a new session tells the model how many sessions
were sealed since the last `tick`, and nothing else.

Every step is a line in the **ledger**, `ledger.jsonl` in the data
directory: each line carries the hash of the one before, and the ledger,
not a learning's own file, decides what a learning's gate may do. `learn
list` shows every learning, the approvals the ledger records, and any gate
the ledger does not vouch for.

### What needs a standalone terminal, and why

`approve`, `wrong`, `demote`, `retire`, `policy set` and `policy clear` run
only for a person at an interactive terminal outside Claude Code: standard
input and output must both be terminals and `CLAUDECODE` must be unset.
`land` and `revert` need the same for the real write (`--yes`); their dry
run needs no terminal. Run by Claude Code, or with either stream
redirected, each refuses with exit 3 and changes nothing. No flag or
variable skips the check.

This is how the agent is kept from approving its own work. Run these in a
separate terminal window. **The built-in terminal of an IDE is refused
too**, because the Claude Code extensions set `CLAUDECODE` there as well.

### The policy

    node scripts/learn.mjs . policy set --min-firings 5 --min-sessions 3 --max-action warn

With a policy set, `tick` promotes, up to `--max-action`, each learning on
trial that was never demoted and has at least that many firings in at least
that many sessions, none marked wrong, and no evidence from a session that
read outside content. Both counts must be at least 1. A policy promotes on this machine
only; it never lands a gate in the repository.

Setting the policy records its hash in the ledger. A `policy.json` whose
hash is not the one last recorded promotes nothing, so a policy file edited
by anything other than `policy set` stops promotion until you set it again.
`policy clear` records the withdrawal, and `policy show` says what is on
disk and what `tick` will therefore do. Without a policy nothing is
promoted automatically.

### Landing, reverting, suspending

- **Land.** `learn land <id>` shows the diff: the learning's entry in
  `docs/harness/LEARNED.md` and its gate, at the action you approved, in
  `.claude/kh-harness/gates.json`, with the manifest recording both. It
  prints a note for what `--yes` would refuse. With `--yes`, at a terminal,
  it writes them under the same refusals as `apply`: not on the default
  branch and not on a dirty tree, unless `--allow-default-branch` or
  `--allow-dirty` waives one. Only a learning promoted on this machine can
  be landed. Once you commit the change, the gate binds everyone who has the
  repository. The ledger records you as the approver of the landing,
  whoever promoted the learning here. `RULES.md` is never written.
- **Revert.** `learn revert <id>` takes exactly that entry and gate out
  again; `--yes` at a terminal writes it. A landed learning returns to
  being promoted on this machine only, with its gate kept here. A revert
  needs a trace of the learning in this checkout and is refused without
  one.
- **Suspend.** `learn wrong <session>:<line>` marks one recorded firing
  wrong. Two marks since a promotion or a landing take a gate back to
  `observe`; for a landed gate, two marks or `learn demote <id>` suspend it
  on this machine instead. The committed gate then stops acting here and
  still binds everyone else, and the gate hook tells you once per session
  that a suspension is in force. Reverting a suspended learning takes its
  gate out of the repository and retires it. Retiring it without a revert
  drops the suspension, so the committed gate acts here again.
- **Retire.** `learn retire <id>` ends a learning: its local gate goes, and
  it no longer stands for its recurrence.

### What the loop may claim

Counts, and the sessions they come from: recurrences, drafts, replays
passed, failed and not checkable, gate firings per action, how often a
warning or block was followed by a successful call of the same tool, and
wrong marks — under which kit hooks and model. `log report` states how many
sessions it read and what it could not read, and says it does not show that
outcomes improved. Neither the commands nor the skill claim that the
harness or the agent improved; nothing here measures that.

## Limits

These controls run on one user account. **They are detection and deny
rules, not isolation**: anything the agent can run as you, it can use to
undo them. Specifically:

- An agent with a shell can append a syntactically valid line to the
  ledger, including a forged approval or forged wrong marks. The hash chain
  makes such a line permanent and visible in `learn list` and `log status`;
  it does not make it impossible.
- One line of junk in the ledger breaks its chain. While it is broken,
  every learned gate in this machine's gate file is removed at the next
  `learn` step that writes, none is restored, and nothing is promoted.
  There is no command that repairs the ledger.
- An agent can write `gates.local.json` directly, and the gate hook enforces
  what it holds. `tick`, or the next `learn` command that writes, removes
  every gate the ledger does not vouch for; until then the forged gate acts.
- The firing counts a policy relies on come from the session log, which the
  same user can append to. Forged firings can satisfy a policy. Your
  approval of a hash at a terminal is the only control that does not depend
  on the log.
- The kit's internal functions can be called from Node with a made-up
  terminal result. The terminal check guards the command line, not the
  library.
- A process running as you can also forge a terminal and clear
  `CLAUDECODE`.
- The deny rules match the text `learn.mjs` followed, after a space, by a
  subcommand word, in the Bash and PowerShell tools. A command that reaches
  the script another way, through a package script or with the subcommand
  quoted, is not caught by them, and only the terminal check stops it. An
  unrelated command that holds that text, such as a commit message, is
  declined too.
- The deny rules on the protected paths stop Claude Code's file tools and
  the shell file commands it recognises. A program the agent runs that
  writes those files itself is not caught. The
  data-directory rule covers `~/.claude/kh-harness/` only; a data directory
  moved with `KH_DATA_DIR` needs a rule you add yourself.
- `log enable`, `log disable`, `log maintain` and `log purge --yes` need no
  terminal and are not denied. `log purge --yes` deletes the ledger, the
  learnings and the policy with the log.
- A fresh log returns `not-checkable` for most drafts until it holds at
  least 20 clean calls of the gate's tool across 2 sessions.
- After a branch switch to a checkout without a committed gate, or once an
  uncommitted land is discarded, a landed learning is enforced nowhere until
  the next `learn` command or `tick`.
- The harness identity is checked once per prompt. Tool events after a
  mid-turn edit to an installed hook are attributed to the previous base
  until the next prompt.
- A `warn` gate's message reaches the model after the call has run; only
  `block` stops a call.
- The credential scrub is best-effort; see "The credential scrub, and what
  it misses". The log will at some point hold a secret.

## Intent and rules

Phase 3 adds the two documents that say what the application is *for* and
which rules follow from that — the layer every other capability here is
mechanics for.

**`docs/INTENT.md`** has seven sections: Purpose, Users, How it works,
Success, Failure, Non-goals, Open questions. The skill drafts it from the
repository (there is no template) and gates on the full content; anything
the repository cannot answer goes under Open questions rather than a guess.
`detect` reports which sections are present — the shape, never the
quality of the prose.

**`docs/harness/RULES.md`** is a registry: one rule per heading, each with
the mechanism that enforces it:

    ## R1 — Every database query is scoped to the current tenant
    - why: a cross-tenant read is a data breach, not a bug
    - enforced-by: critic        # deny | hook | lint | test | critic | ci | review | none
    - pointer: .claude/agents/tenant-scoping.md

A rule with `enforced-by: none` is a claim Claude is merely told; one with
a resolving pointer is held by something. `detect` reports the counts, any
pointer that no longer exists, and (as advice, by line number only) the
rule-shaped sentences still sitting in `CLAUDE.md` outside the registry.
It never reports `verified` here: nothing is executed. `apply` scaffolds
the registry **empty** — every example sits inside an HTML comment — and
never writes a rule; the skill proposes entries, with `enforced-by: none`
unless a real enforcer was found and named. The kit does not write an
enforcer for a told rule.

Landed learnings go in a separate kit-owned file,
**`docs/harness/LEARNED.md`**, in the same format, so the kit never writes
into your `RULES.md`. `detect` counts its rules apart from yours.

Once the registry holds a rule, `apply` proposes the `UserPromptSubmit`
hook above, which re-states the rules on every prompt. Studies in 2026
measured compliance with told rules decaying within a session, and found
that longer instruction files do not help. Re-stating the rules on every
prompt is the kit's response to that decay, which is why it is a hook and
not a longer `CLAUDE.md`. Whether it counters the decay has not been
measured, by those studies or by this kit.

This repository keeps both documents for itself (`docs/INTENT.md`,
`docs/harness/RULES.md`), and a test fails if a section goes missing, a
pointer stops resolving, or a rule is ever recorded as a bare claim.

## The manifest

`.claude/kh-harness.manifest.json` records every file written and every
settings patch applied, with a hash of what was written, and each landed
learning. It is what `uninstall` reads to know what is removable, and what
`apply` reads to know what it must never re-write or overwrite.

Deleting it makes this tool's own work permanently un-uninstallable. Corrupting
it makes `apply` **refuse** (exit 3) rather than silently replace it with an
empty one and lose the record.

The manifest is a file in your repository, forgeable like any other, so
`uninstall` does not trust it alone: a recorded path that no generator could
ever have produced is refused, content that does not carry the generator marker
is refused, and a rule file with a non-empty body is refused because our own
scaffold is empty by construction.

## Exit codes

| | |
|---|---|
| `0` | did what it said |
| `2` | could not act (bad path, unreadable settings, a write or removal failed, `detect` could not write its report) |
| `3` | refused to act (default branch, dirty tree, corrupt manifest, no manifest) |

Nothing else. A crash is a bug, not a contract. `log` and `learn` add their
own cases to 2 and 3 — a terminal-only subcommand run without a person at a
terminal is 3 — and each `--help` lists them.

## What it leaves behind

In your repository:

- `docs/harness/detect.json` — written by every `detect` run, including runs
  pointed at this repository itself. It is **not** removed by `uninstall`
  (it is a report, not an installation), so a `?? docs/harness/` in
  `git status` after exercising the tool is expected.
- Whatever `apply --yes` wrote, each entry listed in the manifest, and
  whatever `learn land --yes` wrote, listed there too.

Outside your repository:

- This machine's data directory for the repository,
  `~/.claude/kh-harness/<key>/` (or under `KH_DATA_DIR`): the session log,
  the ledger, the learnings, the policy and this machine's gates. It is
  created by `log enable` or by a `learn` step that writes. `uninstall`
  leaves it; `log purge --yes` removes it.
- `<temp>/kh-harness-stop-<user>/<repo>/<hook>-<session>` — small marker
  files per repository, per hook, per Claude Code session. They are how each
  hook avoids reporting the same standing failure twice in a session, how it
  bounds how many times it may block, and how the loop warning and the gate
  hook remember what they have said.

  They **accumulate**: nothing deletes them, by design. A hook that removes
  files runs on the hot path of every edit and every turn end, and the one
  thing worse than litter in a temp directory is a hook deleting the wrong
  file mid-turn. They are a few dozen bytes each, they live under the
  directory your OS already cleans, and the per-repository sharding bounds
  how many land in any one directory. `HK_MARKER_DIR` moves them if you want
  them somewhere else. Said here rather than left to be discovered.

## Development

    npm test

**The skill reads its own `references/` only under a real plugin install**
(`claude plugin marketplace add ./` + `claude plugin install
kh-harness@kh-harness-local`), confirmed by running it end to end. If you
load the skill a different way — e.g. `claude --plugin-dir <path>` — and a
reference appears unreadable, that is an artifact of loading from an
arbitrary path, not a defect in the skill. Prefer the real install path
above when checking this.

**The eval suite cannot measure `harness-init`, and its deltas are not
findings about it.** `SKILL.md` sets `disable-model-invocation: true`, which
per the Claude Code docs omits the skill's description from Claude's context
entirely — the model cannot know it exists, so it never calls it. And
`claude plugin eval` passes `prompt.md` to the model verbatim ("Claude
receives the body exactly as you wrote it"), so a literal `/harness-init` in
a prompt is inert text rather than an expanded slash command. A
`tool_used: Skill` grader on this skill therefore cannot pass.

Measured twice on CI, ~$1.31 and ~11 minutes per run: both reported
`meanDelta: 0` with identical scores in both arms, which looks exactly like
"the plugin makes no difference". It is not — the plugin was never engaged.
The `uses-skill` indicator on each case is what reveals this, which is why
every case carries one.

Making the skill measurable this way would mean dropping
`disable-model-invocation`, which is a deliberate product decision: setting
up a harness is a human's call, not something to start unbidden. The scripts
the skill routes to are covered by the unit suite instead. No eval case
exists for `harness-learn`.

Evaluation suites exist under `evals/` and run via `claude plugin eval`. Each
run spawns a full `claude` child process, so locally they use whatever
credential you are already logged in with — no API key needed. In CI the
`eval` job runs only on `workflow_dispatch`, on `CLAUDE_CODE_OAUTH_TOKEN`
(the subscription credential, from `claude setup-token`) or, failing that,
`ANTHROPIC_API_KEY` (API billing); with neither secret set the job shows as
skipped, never as passed. Each invocation runs every case with and without
the plugin.

Changes per release are in `CHANGELOG.md`.
