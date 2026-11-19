# The learning loop

How a tool failure that recurs across sessions becomes one small gate on
tool calls, and how that gate is promoted, landed, suspended, reverted or
retired. Plain code does every check. A model drafts. The kit's commands
move a gate past `observe` in two ways: `learn approve`, which runs only at
an interactive terminal outside Claude Code, and `tick` under a policy
whose hash the ledger records. A process running as you can forge either,
and a gate that reaches a gate file some other way (a teammate's commit, a
hand edit) acts as soon as it is there; see
[Limits](../../README.md#limits).

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
7. **You** run `learn approve` with its hash, for `warn` or `block` on this
   machine; the command runs only at an interactive terminal outside Claude
   Code. Or **`tick`** promotes it under a policy whose hash the ledger
   records.
8. **You** run `learn land --yes`, which also needs that terminal, and
   commit the change.

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
    active_local --> suspended: demote while its gate is committed
    active_local --> landed: land
    landed --> active_local: revert
    landed --> suspended: demote or two wrong marks
    suspended --> retired: revert
    rejected --> [*]
    retired --> [*]
```

`retire` also leads to `retired` from the other live states, and is left out
of the diagram for clarity; the table below gives its conditions.

| From | To | Caused by | Terminal check |
|---|---|---|---|
| — | `candidate` | `learn draft` | none; in practice the skill runs it |
| `candidate` | `trial` | a replay that passes, from `draft` or `replay` | none: the script decides |
| `candidate` | `rejected` | a replay that fails | none: the script decides |
| `candidate` | `candidate` | a replay that is not checkable | none: the script decides |
| `trial` | `active-local` | `learn approve` | an interactive terminal outside Claude Code |
| `trial` | `active-local` | `learn tick` under a recorded policy | none at the terminal; the policy file's hash must equal the last policy hash the ledger records |
| `trial` | `retired` | `learn tick`, when every cited path is gone | none |
| `active-local` | `trial` | `learn demote`, or the second wrong mark since its promotion, while its gate is not in the committed gate file | an interactive terminal outside Claude Code (`learn demote`, `learn wrong`); `tick`, which has none, finishes a demotion that did not happen |
| `active-local` | `suspended` | the same, while its gate is in the committed gate file (a land that stopped before its ledger entry, or a checkout that already holds it) | an interactive terminal outside Claude Code for `demote` and `wrong`; none for `tick` |
| `active-local` | `landed` | `learn land --yes` | an interactive terminal outside Claude Code |
| `landed` | `active-local` | `learn revert --yes` | an interactive terminal outside Claude Code |
| `landed` | `suspended` | `learn demote`, or the second wrong mark since its landing | an interactive terminal outside Claude Code for `demote` and `wrong`; none for `tick` |
| `suspended` | `retired` | `learn revert --yes` | an interactive terminal outside Claude Code |
| `retired` | `retired` | `learn revert --yes`, for a learning retired while its gate was still committed: the gate is taken out | an interactive terminal outside Claude Code |
| `candidate`, `trial`, `active-local` | `retired` | `learn retire` | an interactive terminal outside Claude Code |
| `landed`, `suspended` | `retired` | `learn retire`, only once no gate of it is left in the committed gate file; while one is, retire is refused and names the revert | an interactive terminal outside Claude Code |

The ledger, not a learning's own file, decides its status and the action its
gate may carry. Every step that writes first brings this machine's gate file
into line with the ledger. A gate the ledger does not grant is removed; one
it grants is restored while the ledger is intact. `rejected` and `retired`
are final, except that a revert can still take a retired learning's
committed gate out of the repository.

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
with `learn draft --redraft`, which the ledger records as a redraft. Which
recurrences a rejection covers follows the failure kinds as `FAILURES.md`
labels them now. The skill passes `--redraft` only when you ask for a new
draft in the conversation.

## The terminal check and the deny rules

This is the one place these two barriers are described; the other pages
link here.

> [!IMPORTANT]
> Eight subcommands are terminal-only: `approve`, `wrong`, `demote`,
> `retire`, `land`, `revert`, `policy set` and `policy clear`. Each runs
> only when its standard input and output are an interactive terminal and
> `CLAUDECODE` is unset; it does not check who is at that terminal.

**The terminal check.** Standard input and standard output must both be
terminals, and `CLAUDECODE` must be unset. The check relies on what
`scripts/lib/tty.mjs` records from the Claude Code environment-variable
reference (read 2026-11-19): Claude Code sets `CLAUDECODE` in the
subprocesses it spawns, and IDE extensions set it in their integrated
terminals. So a command Claude Code runs, or one typed in an IDE's
built-in terminal, is refused; use a separate terminal window. Run
anywhere else, or with either stream redirected, a terminal-only
subcommand exits 3. It changes no learning, but it first runs the gate
repair, which can rewrite this machine's `gates.local.json`. `land` and
`revert` need the terminal only with `--yes`: without it each is a dry run
that writes nothing, and anyone may run it. No flag or variable skips the
check.

**The deny rules.** `apply` installs, beside the gate hook, Bash and
PowerShell deny rules over `learn.mjs` for all eight, so Claude Code
declines to run them: a second barrier. Each rule matches the text
`learn.mjs` followed, after a space, by one of the subcommand words. The
rules cover `land` and `revert` whole, their dry runs included, by design:
the dry run is yours to read. A command that reaches the script another
way, through a package script or with the subcommand quoted, is not caught
by them, and only the terminal check stops it. An unrelated command that
holds that text, such as a commit message, is declined too. An install made
before a rule existed is proposed the ones it lacks by the next `apply`.

**The skill.** `harness-learn` runs none of the eight, not even the dry
runs of `land` and `revert`, and not `policy show`.

Neither barrier is isolation: a process running as you can forge a terminal
and clear `CLAUDECODE`, or call the kit's functions from Node directly. See
[Limits](../../README.md#limits).

## Approval

Run `learn show <id>`, read the gate, and pass the hash it prints to
`learn approve <id> --sha256 <hash> --action <warn|block>`, at a terminal.
Any change to the gate's content changes the hash and voids the approval.

`learn show <id>` also lists the gate's latest ten firings, each as the
`<session>:<line>` reference that `learn wrong` takes, and says how many
earlier ones there are; `learn show <id> --firings` lists every one. To mark
a firing wrong, pass its reference: `learn wrong trial-1:15`, at a terminal.

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
running as you can append to. An approval with `learn approve` does not
depend on the log's firing counts, but it is a ledger entry like any
other, and a process running as you can forge it too.

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
- its gate, at the action its approval recorded, in `.claude/kh-harness/gates.json`;
- a record of both in the manifest.

Without `--yes` it is a dry run: it shows the notes and the diff, needs no
terminal, and writes nothing in the repository or the data directory. With
`--yes`, at a terminal, it meets `apply`'s refusals: not on the default
branch, not on a dirty tree, unless `--allow-default-branch` or
`--allow-dirty` waives one. A `LEARNED.md` or `gates.json` that kh-harness
no longer owns stops it with exit 3. `RULES.md` is never written. The ledger
records `approvedBy: 'owner'` for the landing, whoever promoted the learning
here. The change is left uncommitted, and the command says so: review it
with `git status` and `git diff` and commit it. Only then does the gate
bind everyone who has the repository. `detect`'s `P5.integrity` checks that
every committed gate has an approved entry.

## Reverting

`learn revert <id>` takes the learning's gate, entry and manifest record out
of the repository, whichever are left; `--yes` at a terminal writes it, and
the dry run writes nothing. What it does in each case, and what to type
after a land or revert that stopped, is in the table under
[Recovery and every revert case](#recovery-and-every-revert-case).

## Suspending

A landed gate judged wrong is suspended on this machine: by `learn demote`,
or by the second `learn wrong` mark since its landing (`tick` finishes a
demotion that did not happen). The committed gate then stops acting here
and still binds everyone else. The gate hook tells you once per session that
a suspension is in force. `learn revert <id> --yes` takes the gate out of
the repository and retires the learning. `learn retire` is refused while
the gate is still committed, since retiring writes no file, and the refusal
names the revert.

## Recovery and every revert case

Each step writes in a fixed order — a land writes `LEARNED.md`, then
`gates.json`, the manifest, its ledger entry, the learning file, and last
removes the local gate; a revert first writes a landed learning's gate back
to the local gate file, and keeps the manifest record until its ledger
entries are written — so a step that stops leaves a state the same command
finishes. A committed gate never stands without its registry entry; until a
stopped step is finished, `P5.integrity` reports what it left as failing.

| Situation | Type, at a terminal | Result |
|---|---|---|
| A landed learning, its gate and entry in the working tree | `learn revert <id> --yes` | Gate, entry and manifest record removed; the learning is `active-local` again, its gate written back to this machine first, its approval standing. Commit the change. |
| A suspended learning | `learn revert <id> --yes` | Gate, entry and record removed; the learning is retired. |
| A learning retired while its gate was still committed | `learn revert <id> --yes` | The gate is taken out; the ledger records `reverted` and `retired` again. |
| A landed or suspended learning with nothing of it in this checkout (an uncommitted land discarded) | `learn revert <id> --yes` | Reverted on this machine only; no file is written, and the dry run and the result say so. |
| The working tree's `gates.json` no longer holds the gate, and the commit `HEAD` names still does | `learn revert <id> --yes` | It goes on. Its first note says this run did not remove the gate, the commit still holds it until its removal is committed, and `git status` shows the files; for a learning it retires, that restoring the file from the commit puts the gate back in force here. |
| The same, and the commit cannot be read, or holds a gate file larger than the hook loads | `learn revert <id> --yes` | It goes on; the notes say why the commit could not be checked. |
| A land or revert killed between a file write and the manifest write | the same command again | The file on disk is recognised as that step's own write (exactly what it makes from the recorded file) and the step finishes. Any other difference is a hand edit and is refused. |
| A land stopped before its ledger entry, or between that entry and the learning file | `learn land <id> --yes` | Every file is found as it would write it, and the land finishes. A revert of such a learning says to run the land again. |
| A revert stopped after part or all of its ledger entries | `learn revert <id> --yes` | Recognised from the ledger's last entries; only what is missing is written, and a manifest record left behind is removed. |
| A learned file edited by hand, still holding the learning | restore it from git, or take the learning out of it by hand, then `learn revert <id> --yes` | Refused (exit 3) until then; the refusal says both ways. |
| A gate, entry or record under the same id at another hash | — | Refused, never removed: it is not this learning's. |
| A branch switch to a checkout without the committed gate | any writing `learn` command, or `learn tick` | The landed learning's gate is enforced nowhere until then; the repair writes it back to this machine. |
