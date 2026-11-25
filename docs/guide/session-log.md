# The session log

A record of each Claude Code session in one repository, kept on your
machine, outside the repository. It is what the learning loop reads. This
page says what it stores, where, what it never stores, what the credential
scrub misses, how long content is kept, and what it costs.

[Back to the README](../../README.md) ·
[How it works](how-it-works.md) ·
[Command reference](commands.md#log) ·
[Learning loop](learning-loop.md) ·
[Troubleshooting](troubleshooting.md)

## Turning it on

`apply` installs the hook, `session-log.mjs`, registered on 16 Claude Code
events (runbook step 31). It records nothing until you enable the log for
the repository on this machine:

    node <kh-harness>/scripts/log.mjs . enable

A teammate or a CI run with the same hook records nothing until they enable
it themselves. `log disable` turns it off and keeps what it holds.

> [!WARNING]
> Once enabled, the log records **tool input and output in full**, and every
> prompt you type, after a best-effort credential scrub. Treat it as able to
> hold a secret.

## What it stores

The 16 events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PermissionDenied`, `PostToolUse`,
`PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`,
`StopFailure`, `InstructionsLoaded`, `PreCompact`, `PostCompact`,
`PostModelSwitch` and `SessionEnd`. Each becomes one JSON line:

| Group | Fields |
|---|---|
| Envelope | schema version, time, process id |
| Identity | session id, prompt id, tool-use id, agent id, working directory |
| Tool call | tool name, input hash and size, status (`ok`, `error`, or `interrupted` for a failure that carries `is_interrupt`), duration, output size, first error line (masked, then cut to 300 characters); on a failure, `root`, the project root the hook ran under |
| Content | the prompt; a tool's input and output, stored with its result; a permission denial's reason; a stop failure's error |
| Harness | a hash of the kit's installed hook scripts and their settings patches (`base`), a hash of the learned gates in force (`learned`), the kit version and the model |
| Flags | `external_content` when a session used `WebFetch`, `WebSearch` or an MCP tool (a download made through Bash is not seen); `gate_firing` for each learned gate that matched, with its action and the agent that made the call |

The harness line is written at session start, on a model switch, and on a
prompt whose identity or model has moved since the last one. A change to a
file the kit did not write, such as your own rules, changes neither hash.
`base` changes when an install is moved to the entry scripts, as it does
with any kit update, and not on an `apply` that has nothing to do.

The `root` on a failure is what lets a reader in another worktree make the
error line's paths relative to the root they were printed under, so a
failure's signature does not depend on where the report is run. A failure
recorded without it is read against the work tree the data directory is
keyed by. The remaining limit: such a failure, in a repository whose
common directory is not a `.git` directory (a bare repository with
worktrees, a submodule), is read against the directory the command was
pointed at.

The cap applies to each string value in an event, not to the event as a
whole: a string longer than 64 KiB (the `inlineCapBytes` setting) is stored
once, compressed, under `blobs/`, named by its hash, and the event holds a
reference to it.

## Where it lives

    ~/.claude/kh-harness/<key>/        or    $KH_DATA_DIR/<key>/

`KH_DATA_DIR` is used only when it holds an absolute path; a relative value
is ignored and the default is used. `<key>` is the first 16 hex characters of a SHA-256 of the repository's git
common directory, so every worktree of one repository shares one log. The
directory holds:

| Path | What |
|---|---|
| `enabled.json` | whether the log is on |
| `config.json` | optional settings: `contentRetentionDays` (90), `inlineCapBytes` (65536), `autodraft` (false) |
| `sessions/` | one file per session: `.jsonl` while open, `.jsonl.gz` once sealed; a claimed or temporary file while a seal is under way |
| `blobs/` | payloads over the inline cap |
| `index.jsonl` | one line per sealed session, chained |
| `ledger.jsonl`, `learnings/`, `learning-ids.json`, `policy.json`, `gates.local.json`, `last-tick.json` | the learning loop's state; see [The learning loop](learning-loop.md) |

Nothing here can be committed by accident, and the kit never edits your
`.gitignore`. `uninstall` names this directory and its size, and leaves it.

Nothing is written through a link: the hooks do not append to a data
directory, sessions directory, blob store or session file that is a link,
and `log` and the writing `learn` steps refuse such a data directory with
exit 3. The `enabled.json` record is replaced whole, by a temporary file
and a rename.

Reads are bounded. A session file, on disk or decompressed, and the seal
index are read up to 256 MiB; `config.json` and the other small files up
to 1 MiB. A file over its bound is counted as unreadable and named, never
read as empty: `log status` and `log report` list such sessions, and a
session over the bound is not sealed or expired.

## What it never stores

- The agent's own account of its work: its last message at a stop, and a
  compaction summary. They are claims, not observations (rule R12).
- The input of a `PreToolUse` or `PermissionRequest` event: only its hash
  and size.
- A transcript's contents. The session-start line records its path. `log
  status` reads it to count user interrupts, and prints only counts. A
  transcript holding a line over 64 MiB is reported as not checked.
- Anything while the log is disabled. The hook then reads only the event
  name and the session id.

## The credential scrub, and what it misses

Before a line is written, every string and every object key is masked with
the same credential table that `detect`'s `P0.security` sweep uses. A value
under a credential-named key (`password`, `token`, …) is replaced whole,
and so is everything beneath such a key, through arrays and objects. A
value after a credential flag or header (`--password`, `Authorization:`)
is replaced. A run of string elements in an array is masked as one joined
text, so a private key held one line per element is hidden whole. The
first error line is masked before it is cut to 300 characters, so the cut
does not leave the start of a credential the mask would have hidden. A
payload moved to a blob is masked the same way.

The scrub is **best-effort**:

- A credential in a shape the table does not know, or shorter than the
  length a shape requires, is stored as written.
- A key or flag the table does not name is not treated as a credential.
  A value after a key named `secret` or `apiToken`, after `curl -u`, or
  after a bare `-p`, is stored as written.
- The input hash is computed over the raw input, before the scrub. A short
  secret can be found from its hash by trying candidates.
- Anything you paste into a prompt is stored, after the same mask.

## Retention

Content — prompts, tool input and output, denial reasons, stop-failure
errors — is removed from a **sealed** session once its last event is older
than 90 days, or `contentRetentionDays`. Structure is kept until you purge:
ids, tools, hashes, sizes, statuses, first error lines, times and harness
lines. That is what recurrence detection needs.

> [!WARNING]
> Content is removed only under these conditions, all of them:
>
> - the session has been sealed and still matches the index;
> - its last event is older than the period. A session resumed later keeps
>   its earlier content until the period after its last event, and a
>   session whose events carry no time never expires;
> - a session starts while the log is enabled, or `log maintain` is run. A
>   session start spends at most 150 ms on this and touches no session over
>   2 MiB on disk; `log maintain` does the rest.
>
> After `log disable` no session start expires anything. `log maintain`
> still does, since it runs on a disabled log. Without it, every prompt and
> every tool input and output already recorded stays on disk until
> `log purge --yes`.

`log status` counts the sessions holding content past the period, sealed or
not, with the reason, on a disabled log too. Sealed content past the period
that cannot be verified against the index is kept and counted there. A
session over 256 MiB is not read, sealed or expired, and `status` names it.

Content that was moved to a blob is expired by the blob sweep, which
removes only files named as a blob or a blob's temporary file, inside a
real directory. It runs whenever every sealed file matches its latest
index line; when one does not, `log status` says the sweep is blocked and
why.

## Sealing

A session idle for 10 minutes is sealed at the next session start, or by
`log maintain`: its events are compressed, the file is hashed whole, and
the hash is appended to `index.jsonl`, each line carrying the hash of the
line before. `log status` checks that chain and every sealed file. It shows
accidental damage and an edit that breaks the chain. The chain has no key:
a process running as you can rewrite the index and the sealed files with a
new valid chain, and nothing then shows it. Events not yet sealed are
checked by nothing.

An unfinished last line in the index, as an append that stopped partway
leaves, is not a break: it is dropped, under the lock, before the next
append. A seal interrupted partway leaves the session's events in a
claimed or temporary file. Every report counts such a session and does not
read its events until a maintenance run finishes the seal.

## maintain

The session-start hook gives sealing and retention 150 ms, touches no
session over 2 MiB, and leaves the rest for later. `log maintain` runs the
same work with up to five minutes for each step and for every session, for
a log that has outgrown that. It runs on a disabled log too, which no
session start maintains. It exits 2 and names the reason when a step did
not run or stopped early for a reason other than the time limit. See
[log maintain](commands.md#log-maintain).

## purge

`log purge` lists what it would remove. `log purge --yes` removes the whole
data directory for this repository — **the ledger, the learnings, the
policy and this machine's gates as well as the log** — and so disables the
log. Every gate promoted on this machine stops acting, and every committed
gate suspended here acts again; gates landed in the repository stay.
`log purge --yes` therefore runs only when standard input and output are
both terminals and `CLAUDECODE` is unset (exit 3 otherwise), and `apply`'s
deny rules make Claude Code decline it. The dry run needs no terminal and
is not denied. It takes the data directory's locks, and exits 2 while
another process holds one. See [log purge](commands.md#log-purge).

## Cost

The size figures are the design's (its "Cost" paragraph), measured on the
owner's own transcripts from one project, 7,134 tool calls in 16 days:

| What | Size |
|---|---|
| full content | about 48 MB, roughly 90 MB a month at that pace, before compression |
| structure alone | about 13 MB a month, assuming 1 KB per call |

Time per hook run, on the development machine (Windows, Node 24):

| Hook | Added over a bare `node` start |
|---|---|
| session log | about 30 ms (median about 85 ms against about 58 ms) |
| gate hook, 100 gates and a 64 KiB input | 38 to 45 ms |

These two figures are the measurements recorded in the comments of
`scripts/lib/session-log.test.mjs` and `scripts/lib/tool-gate.test.mjs`. The
test suite fails either hook when its median adds more than 100 ms. Neither
spawns a child process.

A tool call runs more than one hook. The gate hook runs once, on
`PreToolUse`. The session-log hook runs on `PreToolUse` and again on
`PostToolUse` or `PostToolUseFailure`, and on `PermissionRequest` too when a
permission prompt is shown. The loop warning runs on each failed call, and
the lint sensor after each `Write` or `Edit`. The design records a minimal
Node append at about 55 ms on the owner's machine, and about 0.1 seconds
each time for its two hooks per tool call on Windows. Neither figure was
re-measured for this page.

## What hooks cannot see

An interrupt while a tool runs is recorded: the failed call carries the
status `interrupted`, and recurrence detection does not count it as a
failure. Hooks do not observe an interrupt between tool calls, a cancelled
tool, or a permission denial outside auto mode. The transcript reader
counts interrupts of both kinds and nothing else listed here, and only for
transcripts whose every line type it knows; any other session is reported
as not checked.
