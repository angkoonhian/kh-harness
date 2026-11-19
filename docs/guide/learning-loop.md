# The learning loop

How a tool failure that recurs across sessions becomes one small gate on
tool calls, and how that gate is promoted, landed, suspended, reverted or
retired. Plain code does every check. A model drafts, and only you approve.

[Back to the README](../../README.md) ·
[Command reference](commands.md#learn) ·
[Session log](session-log.md) ·
[Troubleshooting](troubleshooting.md)

## What a learning is

A learning is one gate plus a short title and reason, drafted by a model for
one recurrence. A gate is data, not code (rule R11):

| Key | Meaning |
|---|---|
| `tool` | the tool name the gate applies to, such as `Bash` |
| `field` | a dotted path to one string field of the tool's input, such as `command` |
| `match` | `{ "kind": "literal" \| "token" \| "glob", "value": "…" }` |
| `message` | one fixed line shown when the gate warns or blocks |
| `cites` | optional: up to ten repository paths the gate is about |
| `id`, `action` | assigned by the kit, never by the draft |

- `literal` matches a substring.
- `token` matches the value with a non-word character or the string's end on
  each side.
- `glob` matches the whole field, with `*` as its only wildcard; `?` is a
  literal character.

A value needs at least 3 characters that are neither `*` nor whitespace. A
gate inspects only the first 65536 characters of its field. A gate file
holds at most 100 gates. One hook, `tool-gate.mjs`, reads the committed
`.claude/kh-harness/gates.json` and this machine's `gates.local.json`
before every tool call. It builds no regular expression from gate data and
spawns nothing. Gates are tried in order of their number, and the first
that matches acts:

| Action | Effect |
|---|---|
| `observe` | records a firing in the session log; changes nothing |
| `warn` | the message reaches Claude alongside the tool's result, after the call has run |
| `block` | the call is denied, with the message as the reason |

## The steps, and who takes each

```mermaid
flowchart LR
    A[Hooks record sessions] --> B[Script finds a recurrence]
    B --> C[Owner names it in FAILURES.md]
    C --> D[Skill drafts one gate]
    D --> E[Script replays it]
    E -->|pass| F[Silent trial at observe]
    E -->|fail| X[Rejected]
    F --> G[Owner approves at a terminal]
    G --> H[Owner lands it in the repository]
```

1. **The hooks** record each session, once you have run `log enable`.
2. **The script** finds recurrences: the same tool, input hash and
   normalised first error line in two or more sessions under the same kit
   hooks and model. `log report` and `learn candidates` list them.
3. **You** name the failure in `docs/harness/FAILURES.md`: a heading
   `## F<n> — <kind of failure>` and a line `- signatures: <signature>`.
4. **The `harness-learn` skill** reads `learn evidence`, writes one draft
   and runs `learn draft`. It drafts only for a recurrence you labelled.
5. **The script** replays the gate against the log (below).
6. **The gate hook** runs a passing gate at `observe`, which records each
   firing and blocks nothing.
7. **You**, at a terminal, approve its hash for `warn` or `block` on this
   machine — or **`tick`** promotes it under the policy you recorded.
8. **You**, at a terminal, land it in the repository and commit it.

## States and transitions

```mermaid
stateDiagram-v2
    state "active-local" as active_local
    [*] --> candidate: draft
    candidate --> candidate: not checkable
    candidate --> trial: replay passes
    candidate --> rejected: replay fails
    trial --> active_local: approve or policy
    trial --> retired: cited paths gone
    active_local --> trial: demote or two wrong marks
    active_local --> landed: land
    landed --> active_local: revert
    landed --> suspended: demote or two wrong marks
    suspended --> retired: revert
    rejected --> [*]
    retired --> [*]
```

`retire` also leads from `candidate`, `trial`, `active-local`, `landed` and
`suspended` to `retired`. It is left out of the diagram for clarity.

| From | To | Caused by | Who |
|---|---|---|---|
| — | `candidate` | `learn draft` | anyone; in practice the skill |
| `candidate` | `trial` | a replay that passes, from `draft` or `replay` | the script |
| `candidate` | `rejected` | a replay that fails | the script |
| `candidate` | `candidate` | a replay that is not checkable | the script |
| `trial` | `active-local` | `learn approve` | you, at a terminal |
| `trial` | `active-local` | `learn tick` under a recorded policy | `tick`, which anyone can run |
| `trial` | `retired` | `learn tick`, when every cited path is gone | `tick` |
| `active-local` | `trial` | `learn demote` | you, at a terminal |
| `active-local` | `trial` | the second wrong mark since its promotion | you mark it (terminal); `tick` finishes a demotion that did not happen |
| `active-local` | `landed` | `learn land --yes` | you, at a terminal |
| `landed` | `active-local` | `learn revert --yes` | you, at a terminal |
| `landed` | `suspended` | `learn demote`, or the second wrong mark since its landing | you, at a terminal; or `tick` |
| `suspended` | `retired` | `learn revert --yes` | you, at a terminal |
| any but `rejected` and `retired` | `retired` | `learn retire` | you, at a terminal |

The ledger, not a learning's own file, decides its status and the action its
gate may carry. Every step that writes first brings this machine's gate file
into line with the ledger. A gate the ledger does not grant is removed; one
it grants is restored while the ledger is intact. `rejected` and `retired`
are final.

## Replay

Two checks, run by the script and never reported by the model:

- **Differential.** The gate fires on every recorded failure with the
  recurrence's signature in its sessions, and on none of the successful
  calls of the same tool that followed them.
- **False positives.** The gate fires on no call of its own tool in any
  session that holds no failure with that signature.

The false-positive check counts only calls whose inspected field is a string
the pattern was tested against. **It needs at least 20 such clean calls
across at least 2 sessions.** With fewer, the verdict is `not-checkable`
and the draft stays a candidate. So a fresh log returns `not-checkable` for
most drafts. Run `learn replay <id>` once the log holds more.

A call whose content retention has expired, or whose content was moved to a
blob, is counted as not replayable and never guessed at. The log is scrubbed
before it is written, so the gate is replayed against scrubbed text.

A replay that fails rejects the learning. That recurrence, and any other
that `FAILURES.md` labels with the same failure kind, is drafted again only
with `learn draft --redraft`, which the ledger records as a redraft. The
skill passes `--redraft` only when you ask it to.

## Approval and the terminal check

> [!IMPORTANT]
> `approve`, `wrong`, `demote`, `retire`, `policy set`, `policy clear`, and
> `land` and `revert` with `--yes` run only for a person at an interactive
> terminal outside Claude Code: standard input and output must both be
> terminals and `CLAUDECODE` must be unset. The built-in terminal of an IDE
> is refused, because the Claude Code extensions set `CLAUDECODE` there too.
> Use a separate terminal window.

To approve, run `learn show <id>`, read the gate, and pass the hash it
prints to `learn approve <id> --sha256 <hash> --action <warn|block>`. Any
change to the gate's content changes the hash and voids the approval.
`apply` also installs deny rules that make Claude Code decline these
subcommands, as a second barrier. Neither barrier is isolation; see
[Limits](../../README.md#limits).

## The policy

    node <kh-harness>/scripts/learn.mjs . policy set --min-firings 5 --min-sessions 3 --max-action warn

With a policy set, `tick` promotes, up to `--max-action`, each learning on
trial that was never demoted and has at least that many firings in at least
that many sessions, none marked wrong, and no evidence from a session that
read outside content. Both counts must be at least 1.

- A policy promotes on this machine only. It never lands a gate in the
  repository.
- `policy set` records the policy's hash in the ledger. A `policy.json` whose
  hash is not the one last recorded promotes nothing, so a file edited any
  other way stops promotion until you set it again.
- `policy clear` records the withdrawal; restoring an old file brings
  nothing back.
- Without a policy, nothing is promoted automatically.

The firings a policy counts come from the session log, which anything
running as you can append to. Your approval of a hash at a terminal is the
only control that does not depend on the log.

## tick

`learn tick` runs the rules that need no person: the repair, retiring
trials whose cited paths are all gone, demoting gates marked wrong twice,
and promoting under the policy. It never retires a gate that warns or
blocks. One promoted on this machine whose cited paths are all gone is
reported in `citationsGone`; a landed one is neither retired nor reported.
It runs when you or the `harness-learn` skill run it, never by itself. It
records when it ran in `last-tick.json`.

With `"autodraft": true` in the log's `config.json`, the start of a new
session (not a resumed or compacted one) tells the model, in one fixed
sentence, how many sessions were sealed since the last `tick`.

## Landing

`learn land <id>` writes a learning promoted on this machine into the
repository:

- its entry in `docs/harness/LEARNED.md`, a kit-owned file in the format of
  `RULES.md`;
- its gate, at the action you approved, in `.claude/kh-harness/gates.json`;
- a record of both in the manifest.

Without `--yes` it shows the diff and needs no terminal. With `--yes`, at a
terminal, it meets `apply`'s refusals: not on the default branch, not on a
dirty tree, unless `--allow-default-branch` or `--allow-dirty` waives one. A
hand-edited `LEARNED.md` or `gates.json` stops it. `RULES.md` is never
written. The ledger records you as the approver of the landing, whoever
promoted the learning here. Commit the change yourself. From then on the
gate binds everyone who has the repository, and `detect`'s `P5.integrity`
checks that every committed gate has an approved entry.

> [!NOTE]
> At this version landing and reverting are built in
> `scripts/lib/learn-land.mjs`, and `learn` still rejects `land` and
> `revert` as unknown subcommands until their command-line wiring lands.

## Reverting

`learn revert <id>` takes exactly that entry, gate and manifest record out
again; `--yes` at a terminal writes it.

- A landed learning returns to `active-local`. Its gate is written back to
  this machine's gate file first, so it never stops acting here.
- A suspended learning ends `retired`.

A revert needs a trace of the learning in this checkout — its gate, its
entry or its manifest record. Without one it is refused, naming a checkout
that would have them.

## Suspending

A landed gate judged wrong is suspended on this machine: by `learn demote`,
or by the second `learn wrong` mark since its landing (`tick` finishes a
demotion that did not happen). The committed gate then stops acting here
and still binds everyone else. The gate hook tells you once per session that
a suspension is in force. Revert it to take it out of the repository.
Retiring a suspended learning instead drops the suspension, so the
committed gate acts here again. `revert` accepts only a landed or suspended
learning, so after that the gate stays committed until you remove it by
hand.

## Recovery from an interrupted land or revert

Each step's writes happen in a fixed order, so a stop at any point leaves a
state that the same command, run again, finishes or reports:

| Step | Order |
|---|---|
| land | `LEARNED.md`, then `gates.json`; the manifest; the ledger's `landed` entry, the learning file, and the removal of the local gate |
| revert | the local gate written back; `gates.json`, then `LEARNED.md`; the manifest; the ledger's `reverted` (and `retired`) entries and the learning file; the manifest record dropped |

- A committed gate never stands without its registry entry. At worst an
  entry approves a gate not yet written, or is left for a gate already
  removed. `P5.integrity` reports either as failing until the step is
  finished.
- A land stopped before its ledger entry finds the files already as it
  would write them, and finishes.
- A revert keeps the manifest record until its ledger entries are written,
  so a trace is always left for the next revert. One stopped between its
  ledger entries is recognised from the ledger and completed.
- A file written but not yet recorded in the manifest no longer matches it.
  The next run names it and asks you to restore it from git. See
  [Troubleshooting](troubleshooting.md#a-file-no-longer-matches-what-kh-harness-last-wrote).
- After a branch switch to a checkout without the committed gate, or once an
  uncommitted land is discarded, a landed learning is enforced nowhere until
  the next `learn` command or `tick` writes its local gate back.
