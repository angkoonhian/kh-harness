# The session log

A record of each Claude Code session in one repository, kept on your
machine, outside the repository. It is what the learning loop reads. This
page says what it stores, where, what it never stores, what the credential
scrub misses, how long content is kept, and what it costs.

[Back to the README](../../README.md) ·
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
| Tool call | tool name, input hash and size, status, duration, output size, first error line (up to 300 characters) |
| Content | the prompt; a tool's input and output, stored with its result; a permission denial's reason; a stop failure's error |
| Harness | a hash of the kit's installed hook scripts and their settings patches (`base`), a hash of the learned gates in force (`learned`), the kit version and the model |
| Flags | `external_content` when a session used `WebFetch`, `WebSearch` or an MCP tool; `gate_firing` for each learned gate that matched |

The harness line is written at session start, on a model switch, and on a
prompt whose identity or model has moved since the last one. A change to a
file the kit did not write, such as your own rules, changes neither hash.

The cap applies to each string value in an event, not to the event as a
whole: a string longer than 64 KiB (the `inlineCapBytes` setting) is stored
once, compressed, under `blobs/`, named by its hash, and the event holds a
reference to it.

## Where it lives

    ~/.claude/kh-harness/<key>/        or    $KH_DATA_DIR/<key>/

`<key>` is the first 16 hex characters of a SHA-256 of the repository's git
common directory, so every worktree of one repository shares one log. The
directory holds:

| Path | What |
|---|---|
| `enabled.json` | whether the log is on |
| `config.json` | optional settings: `contentRetentionDays` (90), `inlineCapBytes` (65536), `autodraft` (false) |
| `sessions/` | one file per session: `.jsonl` while open, `.jsonl.gz` once sealed |
| `blobs/` | payloads over the inline cap |
| `index.jsonl` | one line per sealed session, chained |
| `ledger.jsonl`, `learnings/`, `learning-ids.json`, `policy.json`, `gates.local.json`, `last-tick.json` | the learning loop's state; see [The learning loop](learning-loop.md) |

Nothing here can be committed by accident, and the kit never edits your
`.gitignore`. `uninstall` names this directory and its size, and leaves it.

## What it never stores

- The agent's own account of its work: its last message at a stop, and a
  compaction summary. They are claims, not observations (rule R12).
- The input of a `PreToolUse` or `PermissionRequest` event: only its hash
  and size.
- A transcript's contents. The session-start line records its path. `log
  status` reads it to count user interrupts, and prints only counts.
- Anything while the log is disabled. The hook then reads only the event
  name and the session id.

## The credential scrub, and what it misses

Before a line is written, every string and every object key is masked with
the same credential table that `detect`'s `P0.security` sweep uses. A value
under a credential-named key (`password`, `token`, …) or after a credential
flag or header (`--password`, `Authorization:`) is replaced whole. A payload
moved to a blob is masked the same way.

The scrub is **best-effort**:

- A credential in a shape the table does not know, or shorter than the
  length a shape requires, is stored as written.
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
> Retention runs only while the log is enabled: at a session start, within
> the 150 ms budget, or from `log maintain`, which refuses a disabled log. A
> session not yet sealed is not expired. After `log disable`, every prompt
> and every tool input and output already recorded stays on disk, with no
> time limit, until `log purge --yes`.

Sealed content past the period that cannot be verified against the index is
kept and counted in `log status`.

## Sealing

A session idle for 10 minutes is sealed at the next session start, or by
`log maintain`: its events are compressed, the file is hashed whole, and
the hash is appended to `index.jsonl`, each line carrying the hash of the
line before. `log status` checks that chain and every sealed file. It shows
accidental damage and an edit that breaks the chain. The chain has no key:
a process running as you can rewrite the index and the sealed files with a
new valid chain, and nothing then shows it. Events not yet sealed are
checked by nothing.

## maintain

The session-start hook gives sealing and retention 150 ms and leaves the
rest for later. `log maintain` runs the same work for minutes, for a log
that has outgrown that budget. It needs the log enabled. See
[log maintain](commands.md#log-maintain).

## purge

`log purge` lists what it would remove. `log purge --yes` removes the whole
data directory for this repository — **the ledger, the learnings, the
policy and this machine's gates as well as the log** — and so disables the
log. Every gate promoted on this machine stops acting, and every committed
gate suspended here acts again. It needs no terminal. See
[log purge](commands.md#log-purge).

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

Hooks do not observe a user interrupt, a cancelled tool, or a permission
denial outside auto mode. The transcript reader fills in interrupts only,
and only for transcripts whose every line type it knows; any other session
is reported as not checked.
