# kh-harness

A Claude Code plugin and five small Node scripts that inspect a repository,
propose only the agent harness it is missing, write it when you say so, and
remove it again cleanly.

[![version 0.2.0](https://img.shields.io/badge/version-0.2.0-blue)](CHANGELOG.md)
[![Node 22+](https://img.shields.io/badge/node-%3E%3D22-339933)](package.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](.claude-plugin/plugin.json)
[![ci](https://github.com/angkoonhian/kh-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/angkoonhian/kh-harness/actions/workflows/ci.yml)

For a developer who already has a repository and uses Claude Code in it.
`detect` reports what the repository has and what it lacks, with the
evidence it read. `apply` writes only what that report proposed, as a dry run
until you add `--yes`. `uninstall` removes what the kit wrote, and nothing
of yours; it leaves `detect`'s report and any landed learning, and says so.
Once installed, the harness can also keep a log of your sessions
on your machine and turn a tool failure that recurs into a small gate on
tool calls. A gate the kit drafts starts at `observe`, where it blocks
nothing. The kit's own commands move it further only when run at an
interactive terminal outside Claude Code, or, on this machine, when
`learn tick` finds a policy recorded in the kit's ledger. Those are checks
against accident and against an agent using the tools as given, not
isolation: a process running as you can forge either, and the gate hook
enforces whatever the gate files hold, however a gate got there. See
[Limits](#limits).

**What it does that you should know before installing**

- Its lint sensor and stop gate run this repository's own `lint`,
  `typecheck` or `test` scripts automatically, after edits and at each turn
  end.
- Before every tool call it loads and runs each module listed in
  `.claude/kh-harness/extensions.json`, which can block the call. The file
  and its modules are files in this repository, so a `git pull` that adds
  or changes them changes what runs before every tool call by itself. The
  sha256 the file records for a module proves only that the module holds
  the bytes the file names; it is not an approval. kh-harness never writes
  that file.
- Once you enable the session log, it stores every prompt and every tool
  call's input and output on this machine, after a best-effort credential
  scrub.

**What it will not do**

- Overwrite or delete a file it did not write. In `.claude/settings.json`,
  which may be yours, it adds only its own hook entries and deny rules, and
  `uninstall` removes only those, but each rewrites the whole file: content
  and indentation are kept, key order and inline spacing are normalised. It
  never writes `CLAUDE.md`.
- Send anything over the network itself; `detect --verify` and the hooks
  run your own scripts, which may.
- Promote or land a gate from a `learn` command unless the command is run at
  an interactive terminal outside Claude Code, or, for promotion on this
  machine only, the ledger records a policy. These are checks against
  accident and against an agent using the tools as given; a process running
  as you can forge a terminal or a ledger line, and the gate hook enforces
  whatever the gate files hold. See [Limits](#limits).

**What you get**

- **A capability report** — `docs/harness/detect.json`, each check
  `verified`, `declared`, `absent`, `failing` or `n/a`, with its evidence.
- **A lint sensor** — your package's own `lint` script, on each file Claude
  edits.
- **A stop gate** — your root `typecheck` or `test` script at the end of
  each turn.
- **A session brief and a handoff file** — the top of `HANDOFF.md` at each
  session start.
- **A rules registry and a rules brief** — `docs/harness/RULES.md`,
  re-stated on every prompt once it holds a rule.
- **A loop warning** — one sentence when the same call fails the same way
  three times with no different failure between them.
- **A session log** — every session, on your machine, outside the
  repository, once you enable it.
- **A failure taxonomy** — `docs/harness/FAILURES.md`, where you name what
  recurs.
- **A gate hook** — learned gates on tool calls, with deny rules that
  protect it.
- **An integrity check** — kit files against the manifest, and each
  committed gate against its approval.

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Commands](#commands)
- [Turning on the session log and the learning loop](#turning-on-the-session-log-and-the-learning-loop)
- [What it stores and what it never stores](#what-it-stores-and-what-it-never-stores)
- [Limits](#limits)
- [Documentation](#documentation)
- [Requirements and exit codes](#requirements-and-exit-codes)

## Quick start

The output below was captured on 2026-11-20 on Windows, from a scratch
repository with a `package.json` declaring `lint` and `test` scripts. It is
trimmed where marked `…`, and paths are shortened to `<repo>` and `<data>`.
`<kh-harness>` is where you cloned this repository.

**1. Install the plugin.** From the root of your kh-harness checkout:

```sh
claude plugin marketplace add ./
claude plugin install kh-harness@kh-harness-local
```

Only `./` works; `claude plugin marketplace add .` is rejected with
`Invalid marketplace source format` (measured earlier and recorded in
`scripts/lib/plugin-install.test.mjs`; not re-run for this release). `claude plugin list` then lists
`kh-harness@kh-harness-local`, with `Read from:` naming your checkout: a
folder marketplace reads from the working tree, so it is not a copy. The
plugin ships two skills, `harness-init` and `harness-learn`, and one hook,
the start-of-session notice below. In the repository you want harnessed,
`/harness-init` walks you through the steps below. You can also run the
scripts yourself.

Once the plugin is enabled, you don't have to remember which repositories
have the harness. At the start of every session, the plugin's one hook,
`scripts/session-nudge.mjs`, checks the repository the session opened in:

| The repository | What the session is told |
|---|---|
| has no harness | that it has none, and that Claude may offer `/kh-harness:harness-init` once, installing only if you agree |
| has a harness from an older kit | both versions, and that Claude may offer the upgrade, again only if you agree |
| has a harness from a newer kit | that the plugin needs updating |
| has a manifest that can't be read | that, and to run `detect` |
| has a harness at this version, isn't a git repository, or is kh-harness itself | nothing |

The hook writes nothing in the repository and always exits 0. To silence
it in one repository, run `git config kh-harness.nudge off` there. To
silence it everywhere, set `KH_HARNESS_NUDGE=off`.

**The plugin keeps itself up to date.** The same hook starts
`scripts/self-update.mjs` in the background on the plugin's own checkout,
the folder `claude plugin list` shows as `Read from:`. It fetches the
branch's upstream at most once an hour, however many sessions start, and
moves to it only when that is a plain fast-forward. It leaves the checkout
exactly as it is when the checkout:

- has uncommitted changes to tracked files,
- has commits of its own that the upstream lacks,
- is on a detached HEAD or a branch with no upstream, or
- isn't a git checkout at all, such as a cached copy of the plugin.

It never merges, rebases, resets or stashes, and git is never allowed to
wait for a password. The next session is told once that the plugin updated,
or once why it couldn't, and runs the new version. The record is kept in
the checkout's `.git` folder as `kh-harness-self-update.json`. To turn
this off, set `KH_HARNESS_AUTO_UPDATE=off`.

A repository's own harness is not upgraded by itself: `apply` writes hooks
that run commands, so the session is told the versions and offers the
upgrade, and it happens only if you agree.

> [!WARNING]
> **Before you run `apply --yes` anywhere: it can install hooks that execute
> this repository's own `lint`, `typecheck` or `test` scripts
> automatically**: the package's `lint` script after each edit, and the root
> `typecheck` (or `test`) script, over the whole repository, at the end of
> each turn. A `git pull` that changes those scripts changes what runs by
> itself. On a large codebase the stop gate can add 10–30 s per turn. The
> plugin installs none of this; `apply` writes the hooks into your
> repository when you ask it to. The plugin's own hook, the start-of-session
> notice, runs no repository script. The before-a-tool-call hook it installs
> also runs each module `.claude/kh-harness/extensions.json` lists, and those
> are repository files too: a `git pull` that adds or changes them changes
> what runs before every tool call.

**2. Inventory the repository.** From the repository, on a branch:

```sh
git switch -c harness
node <kh-harness>/scripts/detect.mjs .
```

```
kh-harness 0.2.0 — demo-app
profile: typescript-single   branch: harness

Phase 0 — Reconnaissance
  [x] P0.inventory       verified
        produced by this run
  [x] P0.security        verified
…
  [ ] P0.recon           absent
      → run the recon prompt to write docs/harness/recon.md (the skill drafts this; apply does not write it)
…
Phase 2 — Senses
…
  [ ] P2.sensor          absent
      → install scripts/lint-touched.mjs and register a PostToolUse hook
  [ ] P2.stopgate        absent
      → install scripts/verify-touched.mjs and register a Stop hook
…
Phase 5 — Learning
  [ ] P5.failures        absent
      → scaffold docs/harness/FAILURES.md — generated EMPTY; each failure kind is named by hand, with the recurrence signatures it covers
…
12 proposals: 9 apply can write, 2 for the skill to draft, 1 for a human. Nothing has been written except docs/harness/detect.json.
…
```

`detect` writes only `docs/harness/detect.json`.

**3. Read what `apply` would write.** Without `--yes` nothing is written:

```sh
node <kh-harness>/scripts/apply.mjs .
```

```
…
kh-harness: 35 actions to close 9 capability gaps for <repo>

--- docs/harness/RULES.md  [P3.rules]
    no rules registry found
…
--- .claude/settings.json (hook: PostToolUse)  [P2.sensor]
…
WHAT THE HOOKS EXECUTE — read this before running `apply`
  `apply` registers up to seven hook scripts, each on the events named below.
  Three of them can run THIS REPOSITORY'S OWN CODE AUTOMATICALLY, by Claude
  Code, without being asked each time:
…
  On PreToolUse and PostToolUseFailure, and on PostToolUse where the lint
  hook is installed, the two hooks of the event are started by one of three
  entry scripts (dispatch-pre-tool.mjs, dispatch-post-tool.mjs,
  dispatch-tool-failure.mjs), so the event starts one process, not two.
  Each hook does what is said for it here, in the same order every time.
…
Dry run — nothing written. Re-run with --yes to apply.
```

Read the disclosure the dry run prints, `WHAT THE HOOKS EXECUTE`, before
you continue. It names each hook, the events it runs on, and what it reads
and runs.

**4. Write it.**

```sh
node <kh-harness>/scripts/apply.mjs . --yes
git status --short
```

```
…
wrote      docs/harness/RULES.md
wrote      docs/harness/FAILURES.md
wrote      .claude/scripts/session-log.mjs
…
patched    .claude/settings.json (permissions.deny)
patched    .claude/settings.json (PostToolUse)
…
?? .claude/
?? HANDOFF.md
?? docs/
```

`--yes` prints the proposals again before one line per action. On the
default branch it refuses (exit 3) unless you add `--allow-default-branch`;
with uncommitted changes to tracked files it refuses unless you add
`--allow-dirty`. Review with `git diff` and commit. A second `detect` now
reports the installed checks as `declared`.

The kit's hook scripts load one another, so `apply` writes them at one kit
version or not at all. While a file at one of their paths under
`.claude/scripts/` is edited, unstamped or not recorded in the manifest,
`apply` writes and updates none of them and registers no hook that is not
yet installed; `detect` names the file and what to do. See
[a hook script is kept, so no hook script is written](docs/guide/troubleshooting.md#a-hook-script-is-kept-so-no-hook-script-is-written).

**5. Undo it, if you want to.**

```sh
node <kh-harness>/scripts/uninstall.mjs .         # what it would remove
node <kh-harness>/scripts/uninstall.mjs . --yes
```

```
Will remove:
  docs/harness/RULES.md
  .claude/scripts/session-log.mjs
…
Will keep:
  docs/harness/FAILURES.md (ours-modified)
Will leave in place (written by `detect`, which records nothing as installed; delete it by hand if you do not want it):
  docs/harness/detect.json
…
Will keep this machine's session log for this repository (data, outside the repository — uninstall never removes it):
  <data> (50634 bytes)
…
Removed:
  docs/harness/RULES.md
…
Kept:
  docs/harness/FAILURES.md (ours-modified)
.claude/kh-harness.manifest.json remains: it records what was kept, and running uninstall again acts on it.
Left in place (written by `detect`, which records nothing as installed; delete it by hand if you do not want it):
  docs/harness/detect.json
```

- A file you edited is kept and named, and then the manifest is kept with
  it.
- A kit hook entry you edited in `.claude/settings.json` is left
  registered, and the script it runs is kept with every script that one
  loads, so no registered hook points at a removed file. `uninstall` names
  each and exits 2; put the entry back or delete it, and run it again.
- The two files `learn land` writes, `docs/harness/LEARNED.md` and
  `.claude/kh-harness/gates.json`, are both kept while either holds a
  landed learning. `uninstall` says how many, and that
  `learn revert <id>` takes each out; once they hold none it removes both.
- A recorded file or settings entry you already removed by hand is reported
  as already gone and dropped from the record. A manifest left with nothing
  to record is removed.
- `docs/harness/detect.json` is left, and `uninstall` says so.
- The session log is never removed by `uninstall`; `log purge --yes`, from
  an interactive terminal outside Claude Code, removes it.

The exact rules are under
[what uninstall removes](docs/guide/commands.md#uninstall).

## How it works

There are three kinds of part: the five commands, run by you or by a model
following a skill; the two skills, which are instructions a model reads;
and the hook scripts `apply` installs, which Claude Code runs on its own
events. The two flows below are the short version.
[How kh-harness works](docs/guide/how-it-works.md) explains the machinery:
what runs when, where every file lives, how `detect` decides, and what the
checks do and do not show.

### Setting up the harness

```mermaid
flowchart LR
    R[Your repository] --> D[detect reads it]
    D --> J[detect.json with evidence]
    J --> P[proposals for what is absent]
    P --> DR[apply dry run shows diffs]
    DR -->|with yes| W[files and settings written]
    W --> M[manifest records each write]
    M --> U[uninstall removes only what is recorded]
```

1. `detect` reads the repository and writes `docs/harness/detect.json`:
   each check's state and the evidence it read.
2. Each `absent` check that can be decided carries a proposal. One that
   cannot be decided asks a question instead of guessing.
3. `apply` shows every proposal as a diff and writes nothing until you add
   `--yes`.
4. With `--yes` it writes inside a write allowlist enforced in code, never
   over a file it did not write, and records each write in
   `.claude/kh-harness.manifest.json` by content hash.
5. `uninstall` removes a file only when the manifest records it, its content
   is unchanged and it carries the kit's stamp.

### The learning loop

```mermaid
flowchart LR
    H[Hooks record sessions] --> R[Script finds a recurrence]
    R --> N[Owner names it]
    N --> S[Skill drafts a gate]
    S --> P[Script replays it]
    P --> T[Silent trial at observe]
    T --> A[Owner approves at a terminal]
    A --> L[Owner lands it]
```

1. The hooks record each session, once you enable the log.
2. Plain code finds a recurrence: the same failing tool call in two or more
   sessions under the same kit hooks and model.
3. You name it in `docs/harness/FAILURES.md`.
4. The `harness-learn` skill drafts one gate for it.
5. The script replays the gate against the log. A model never reports the
   result.
6. A gate that passes runs at `observe`: it records each firing and blocks
   nothing.
7. You run `learn approve` with its hash, for `warn` or `block` on this
   machine; the command runs only at an interactive terminal outside Claude
   Code. Or `tick` promotes it under a policy whose hash the ledger records.
8. You land it in the repository, where it binds everyone once committed.

### What runs during a session

`apply` installs up to seven hook scripts in `.claude/scripts/`. Claude
Code runs each on the event it is registered for. On `PreToolUse` and
`PostToolUseFailure`, and on `PostToolUse` where the lint hook is
installed, the event's two hooks are registered together as one entry script (`dispatch-pre-tool.mjs`,
`dispatch-post-tool.mjs`, `dispatch-tool-failure.mjs`) that runs them one
after the other in a single process, so each of those events starts one
kit process, not two. An install made before the entry scripts is moved
to them by the next `apply --yes` (a plain `apply` is a dry run that shows
the move), which `detect` reports as `P0.hookmerge`, except on an event
whose kit registrations you changed.

| Hook script | Event | What it does | Can it block? |
|---|---|---|---|
| `session-brief.mjs` | `SessionStart` | prints the top of `HANDOFF.md` into the session | no |
| `rules-brief.mjs` | `UserPromptSubmit` | adds up to 1,500 bytes of your rules to the prompt's context | no |
| `tool-gate.mjs` | `PreToolUse` | tries every gate in the two gate files against the call | yes, when a gate with action `block` matches |
| `lint-touched.mjs` | `PostToolUse`, after `Write` or `Edit` | runs the owning package's `lint` script and reports on the edited file. For a `.py` file the owner is the nearest `pyproject.toml`: its `lint` entry under `[scripts]` or `[tool.poetry.scripts]`, or else the `scripts.lint` of a `package.json` in that same directory (a uv workspace driven through npm) | no |
| `loop-watch.mjs` | `PostToolUseFailure` | one fixed sentence at the third identical failure with no different failure between | no |
| `verify-touched.mjs` | `Stop` | runs the root `typecheck` script, or `test` | yes: a failure different from the last one reported stops the turn from ending, at most 3 times between passing runs |
| `session-log.mjs` | 16 events | records each event, once you enable the log | no |

The plugin adds one hook of its own, `session-nudge.mjs` on `SessionStart`,
which is silent in a repository whose harness is at the plugin's version
(see [Quick start](#quick-start)).

What each reads and writes, and one session walked through in time order,
are under
[what runs when](docs/guide/how-it-works.md#what-runs-when).

## Commands

| Command | What it does | Writes |
|---|---|---|
| [`detect`](docs/guide/commands.md#detect) | Inventories the repository and reports each capability with its evidence | `docs/harness/detect.json` only |
| [`apply`](docs/guide/commands.md#apply) | Writes what `detect` proposed; a dry run without `--yes` | the repository, with `--yes` |
| [`uninstall`](docs/guide/commands.md#uninstall) | Removes what `apply` wrote, and `land`'s two files once they hold no landed learning; nothing of yours; a dry run without `--yes` | the repository, with `--yes` |
| [`log`](docs/guide/commands.md#log) | The session log for one repository on this machine | the data directory |
| [`learn`](docs/guide/commands.md#learn) | The learnings for one repository on this machine | the data directory; `land` and `revert` also the repository |

Each takes `--help` for its full contract. The flags of the first three:

| Command | Flag | What it does |
|---|---|---|
| `detect` | `--verify` | Runs the test, lint and typecheck commands it found. **This executes the repository's own commands.** |
| `detect` | `--json` | Prints the full report on stdout instead of the summary. |
| `apply`, `uninstall` | `--yes` | Actually write or remove; without it, a dry run. |
| `apply` | `--allow-dirty` | Proceed with uncommitted changes to tracked files. |
| `apply` | `--allow-default-branch` | Proceed on the default branch. |

### `log`

| Subcommand | What it does | Writes | Standalone terminal |
|---|---|---|---|
| [`enable`](docs/guide/commands.md#log-enable) | Turns the log on for this repository on this machine | data directory | no |
| [`disable`](docs/guide/commands.md#log-disable) | Turns it off; what it holds is kept | data directory | no |
| [`status`](docs/guide/commands.md#log-status) | What the log holds and whether it can be trusted | no | no |
| [`report`](docs/guide/commands.md#log-report) | Recurring failures and how each gate fired | no | no |
| [`maintain`](docs/guide/commands.md#log-maintain) | Seals and expires what the session-start hook did not reach, on a disabled log too | data directory | no |
| [`purge`](docs/guide/commands.md#log-purge) | Lists, or with `--yes` removes, the whole data directory: the log, the ledger, the learnings, the policy and this machine's gates | data directory, with `--yes` | **yes**, for `--yes` |

### `learn`

| Subcommand | What it does | Writes | Standalone terminal |
|---|---|---|---|
| [`candidates`](docs/guide/commands.md#learn-candidates) | Recurrences no learning stands for | no | no |
| [`evidence`](docs/guide/commands.md#learn-evidence) | The recorded calls behind one recurrence | no | no |
| [`draft`](docs/guide/commands.md#learn-draft) | Stores a drafted gate and replays it | data directory | no |
| [`replay`](docs/guide/commands.md#learn-replay) | Replays a candidate again | data directory | no |
| [`list`](docs/guide/commands.md#learn-list) | Every learning, its status and the approvals | no | no |
| [`show`](docs/guide/commands.md#learn-show) | One learning, its gate and its hash, and its latest ten firings as `session:line` (`--firings` for all) | no | no |
| [`approve`](docs/guide/commands.md#learn-approve) | Promotes a gate on trial to `warn` or `block` on this machine | data directory | **yes** |
| [`wrong`](docs/guide/commands.md#learn-wrong) | Marks one recorded firing wrong | data directory | **yes** |
| [`demote`](docs/guide/commands.md#learn-demote) | Takes a gate back to `observe`, or suspends a landed one here | data directory | **yes** |
| [`retire`](docs/guide/commands.md#learn-retire) | Ends a learning; refused while its gate is still committed | data directory | **yes** |
| [`tick`](docs/guide/commands.md#learn-tick) | Runs the unattended rules once | data directory | no |
| [`land`](docs/guide/commands.md#learn-land) | Writes a promoted learning into the repository, uncommitted; the dry run writes nothing | repository and data directory, with `--yes` | **yes**, for `--yes` |
| [`revert`](docs/guide/commands.md#learn-revert) | Takes a learning's gate, entry and record out of the repository, from whatever is left | repository and data directory, with `--yes` | **yes**, for `--yes` |
| [`policy show`](docs/guide/commands.md#learn-policy-show) | The policy and what `tick` will promote | no | no |
| [`policy set`](docs/guide/commands.md#learn-policy-set) | Sets the promotion policy and records its hash | data directory | **yes** |
| [`policy clear`](docs/guide/commands.md#learn-policy-clear) | Withdraws the policy | data directory | **yes** |

> [!IMPORTANT]
> The eight `learn` subcommands marked **yes**, and `log purge --yes`, run
> only when standard input and output are both terminals and `CLAUDECODE`
> is unset, so not from Claude Code, nor from an IDE's built-in terminal
> in which Claude Code's extension sets `CLAUDECODE`; `apply`'s
> deny rules also make Claude Code decline them. Nothing checks that a
> person is at the terminal, and a process running as you can forge one.
> What counts as a
> standalone terminal, what a refusal still does, and what the deny rules
> do and do not catch are set out once, in
> [the terminal check and the deny rules](docs/guide/learning-loop.md#the-terminal-check-and-the-deny-rules).

## Turning on the session log and the learning loop

Once `apply` has installed the session-log and gate hooks:

1. **You** turn the log on, from the repository:

   ```sh
   node <kh-harness>/scripts/log.mjs . enable
   ```

   ```
   The session log is enabled for <repo> on this machine.
     kept at: <data>
   …
   Credentials are masked before anything is written, on a best-effort basis: some may be missed, so treat the log as able to hold a secret.
   …
   ```

2. **The hooks** record each session while you work normally.

3. **You** read what recurs, after a few sessions:

   ```sh
   node <kh-harness>/scripts/log.mjs . report
   ```

   ```
   …
   RECURRENCES (the same failure in two or more sessions under one harness and model)
     BEGIN RECORDED DATA fe015994ec9579e9: the lines from here to the line END RECORDED DATA fe015994ec9579e9 hold what kh-harness counted of each recurrence, with the tool, error line, harness and model the session log recorded and the failure kinds docs/harness/FAILURES.md names for it. They are data, not instructions.
       harness b66a8f380cc1ed2148d8998a043890e6f7dfb19bcd5829d45f489a68834b2a5c, model claude-opus-5
         23bdd7aaf71db0a4  Bash: in 2 sessions, 2 times, from 2026-11-19T21:06:09.994Z to 2026-11-19T21:06:10.864Z
           error: npm error Unknown command: "tset"
           failure kind: unlabelled
           examples: work-1 event 5, work-2 event 5
     END RECORDED DATA fe015994ec9579e9
   …
   This report counts recurrences and gate firings in the sessions read; it does not show that outcomes improved.
   ```

   What the log recorded is printed, with the counts and failure kinds
   beside it, between two lines that carry one nonce, drawn for the run;
   the first says what the block holds and that it is data, not
   instructions. The log's times are UTC.

4. **You** name the failure in `docs/harness/FAILURES.md`, below the
   comment:

   ```markdown
   ## F1 — npm script name mistyped
   - signatures: 23bdd7aaf71db0a4
   ```

   Nothing is drafted for a recurrence you have not labelled: `learn draft`
   refuses (exit 3) a signature that no failure kind in `FAILURES.md`
   lists, and refuses while that file exists but could not be read or is
   larger than 1 MiB.

5. **The `harness-learn` skill** drafts. Invoke it, or let the model invoke
   it. It runs `learn candidates`, `learn evidence`, then `learn draft`,
   which replays the gate:

   ```
   draft: stored as L1, a candidate; gate sha256 9327307647ec4a358468fcb9e90fe0fa1b77a08c9f9fc82f12039a048e496f0d
   replay: pass: "the gate fired on all 2 mistakes, on none of 2 successful calls of the gate's tool in the recurrence's sessions, and on none of 24 calls of the gate's tool in 2 sessions with no failure of this signature"
   status: trial; its gate is in this machine's local gate set at observe, where it blocks nothing. Show it, then approve it at a terminal, to promote it
   ```

   On a fresh log the verdict is usually `not-checkable`: the replay needs
   at least 20 clean calls of the gate's tool across 2 sessions with no
   failure of this signature, and at least one successful call of that tool
   in the recurrence's own sessions. A recurrence whose earlier learning
   the replay rejected, or that was retired after a wrong mark, after its
   gate was suspended, or by you, is drafted again only with
   `learn draft --redraft`; so is another recurrence labelled with the same
   failure kind. The skill passes `--redraft` only when you ask for a new
   draft in the conversation.

6. **The gate hook** runs the gate at `observe` and records each firing.
   **`tick`**, run by you or the skill, repairs, demotes and promotes under
   a policy whose hash the ledger records; it never runs by itself.

7. **You** read the learning:

   ```sh
   node <kh-harness>/scripts/learn.mjs . list
   node <kh-harness>/scripts/learn.mjs . show L1
   ```

8. **You** approve it, in a standalone terminal, with the hash `show`
   printed:

   ```sh
   node <kh-harness>/scripts/learn.mjs . approve L1 --sha256 <hash> --action block
   ```

   From Claude Code, or any non-terminal, it refuses:

   ```
   kh-harness: approve refused: standard input is not an interactive terminal; it runs only from an interactive terminal outside Claude Code (standard input and output both terminals, CLAUDECODE unset), and nothing was changed.
   ```

9. **You** land it, on a branch. First the dry run, which needs no terminal
   and writes nothing; it prints its notes and the diff:

   ```sh
   node <kh-harness>/scripts/learn.mjs . land L1
   ```

   In the scratch run behind this page `L1` had not been approved — that
   needs an interactive terminal outside Claude Code — so the dry run
   refused it (exit 3):

   ```
   kh-harness: land: L1 is trial; only a learning promoted on this machine is landed
   ```

   Once approved, write it from a standalone terminal:

   ```sh
   node <kh-harness>/scripts/learn.mjs . land L1 --yes
   ```

   It prints the same diffs as the dry run, made from the files it then
   writes. It writes `docs/harness/LEARNED.md`,
   `.claude/kh-harness/gates.json` and the manifest, and ends: `The change
   is not committed: review what this run changed with git status and git
   diff, and commit it; until then it reaches no one else.` Commit it.

To take a learning back, use `wrong`, `demote`, `revert` or `retire`; see
[The learning loop](docs/guide/learning-loop.md).

## What it stores and what it never stores

The log lives in `~/.claude/kh-harness/<key>/` (or under `KH_DATA_DIR`,
when that variable holds an absolute path; a relative value is ignored),
never in the repository. Once enabled, it stores:

- each event's ids and times, and which kit hooks and model were in force;
- each prompt you type;
- each tool call's input and output, after a best-effort credential scrub;
- the first line of each error.

It never stores the agent's own account of its work (its last message, a
compaction summary), the input of a pre-tool event beyond its hash, or a
transcript's contents. While disabled, it stores nothing new. Content is
removed once a session's last event is 90 days old, but only from a session
that has been sealed and still matches the index, and only when a session
starts while the log is enabled or `log maintain` is run. `log maintain`
runs on a disabled log too; no session start expires anything while the
log is disabled. `log status` counts the sessions holding content past the
period and says why. Structure is kept until you purge. Full detail, what
the scrub misses, and the cost figures are on
[The session log](docs/guide/session-log.md).

## Limits

> [!WARNING]
> These controls run on one user account. **They are detection and deny
> rules, not isolation**: anything the agent can run as you, it can use to
> undo them.

- An agent with a shell can append a syntactically valid line to the
  ledger, including a forged approval or wrong marks, or rewrite the ledger
  with a new valid chain. Nothing marks such a line as forged: `learn list`
  prints a forged approval as `recorded as approved by owner`, like a real one, and the
  chain shows only damage that breaks it. The seal index of the session log
  is chained the same way, with no key, and can be rewritten the same way.
- One whole line of junk in the ledger breaks its chain. While it is
  broken, every learned gate in this machine's gate file is removed at the
  next `learn` step that writes, none is restored, and nothing is promoted.
  The same repair drops this machine's suspensions, so a committed gate you
  suspended acts here again. There is no command that repairs the ledger;
  what to do is under
  [the ledger is broken](docs/guide/troubleshooting.md#the-ledger-is-broken).
  An unterminated last line, as an append that stopped partway leaves, is
  not a break: every reader passes over it and the next append removes it.
- The ledger records two hashes for a learning: one of its gate, and one of
  its title, why and evidence. A learning file that differs from either is
  not vouched for. A learning drafted by an earlier build has no second
  hash: `learn list` and `learn show` name it, a policy does not promote
  it, and the hash is recorded by `learn approve` or `learn land --yes`,
  each of which prints the text first.
- The gate hook enforces every gate in the committed gate file
  (`.claude/kh-harness/gates.json`) and in this machine's gate file as they
  stand. It checks no approval. Approval is checked by the kit's `learn`
  commands and reported by `detect`'s integrity check, not by the hook, so a
  gate added by a teammate's commit, a hand edit or a program the agent runs
  warns or blocks as soon as it is there.
- The gate hook tries every gate against a call. The call is denied when
  any matching gate blocks, and the text Claude gets names each matching
  gate above `observe`, blocks first, up to 4,000 characters, with a last
  line counting the ones that did not fit. Each match records a firing,
  but only while the session log is enabled.
- `detect`'s integrity check compares each committed gate with its entry in
  `docs/harness/LEARNED.md`: the gate's hash and, on its own line, the
  action approved. It cannot see a hand edit that changes both files
  together. An entry landed before entries recorded the action has no
  `approved-action` line, and `detect` reports its gate as not approved for
  its action until the learning is reverted and landed again.
- A learned rule is re-told on every prompt unless its entry in
  `LEARNED.md` says its gate blocks (`- approved-action: block`). One that
  warns, or whose entry has no such line, is re-told. The hook reads the
  entry, not the gate in force: a rule whose blocking gate is suspended on
  a machine, or whose gate file cannot be read there, is neither blocked
  nor re-told on that machine.
- Learning ids are assigned per machine. A landing pulled from another
  machine can hold the id of a local learning; `learn list`, `learn show`
  and `learn tick` report it, the committed gate is the one applied under
  that id, and nothing renumbers: retire the local learning and draft its
  recurrence again with `--redraft`.
- A learning, its ledger and its approvals live on the machine that drafted
  it. A machine that holds no learning under that id answers
  `learn revert <id>` with `no such learning`, so a committed gate is
  reverted by the machine that landed it, or by editing the two learned
  files by hand.
- An agent can write `gates.local.json` directly, and the gate hook enforces
  what it holds. `tick`, or the next `learn` command that writes, removes
  every gate the ledger does not vouch for; until then the forged gate acts.
- The firing counts a policy relies on come from the session log, which the
  same user can append to. Forged firings can satisfy a policy. An
  approval of a hash with `learn approve` does not depend on the log's
  firing counts; it is a ledger entry like any other, and can be forged the
  same way.
- The kit's internal functions can be called from Node with a made-up
  terminal result. The terminal check guards the command line, not the
  library.
- A process running as you can also forge a terminal and clear
  `CLAUDECODE`.
- The deny rules match the text `learn.mjs` followed, after a space, by a
  subcommand word, in the Bash and PowerShell tools. A command that reaches
  the script another way, through a package script or with the subcommand
  quoted, is not caught by them, and only the terminal check stops it. In
  the kit's own repository, whose `package.json` defines `learn` and `log`
  scripts, `npm run learn -- approve …` and `npm run log -- purge --yes`
  are such commands: neither holds the text `learn.mjs` or `log.mjs`, so
  no deny rule matches it, and the terminal check is what refuses it. An
  unrelated command that holds that text, such as a commit message, is
  declined too.
- The deny rules cover `land` and `revert` whole, so Claude Code also
  declines an agent's dry run of either, by design: the dry run is yours to
  read.
- Four more deny rules match `log.mjs` with `purge` and `--yes`, in either
  order, in the Bash and PowerShell tools. `log purge` without `--yes` is
  not denied. As with the `learn` rules, a command that reaches the script
  another way is stopped by the terminal check alone.
- A dry run of `land` or `revert` writes nothing in the repository or the
  data directory, but the `git status` it runs for the dirty-tree check may
  refresh `.git/index`, as git does.
- The deny rules on the protected paths stop Claude Code's file tools and
  the shell file commands it recognises. A program the agent runs that
  writes those files itself is not caught. The data-directory rule covers
  `~/.claude/kh-harness/` only; a data directory moved with `KH_DATA_DIR`
  needs a rule you add yourself.
- `log enable`, `log disable` and `log maintain` need no terminal and are
  not denied. `log purge --yes` deletes the ledger, the learnings, the
  policy and this machine's gate file with the log, which switches off
  every gate promoted on this machine and drops every suspension, so each
  committed gate suspended here acts again. It therefore runs only when
  standard input and output are terminals and `CLAUDECODE` is unset (exit
  3 otherwise), and is denied to the agent; a process running as you can
  forge the terminal or delete the directory itself. `log disable` stops
  new firings being recorded, so `observe` gates record nothing; it does
  not stop promotion: `tick` counts the firings already in the log, so a
  recorded policy can still promote after the disable. What stops
  promotion under a policy is `learn policy clear`, at a terminal.
- Retention removes content only from a session that is sealed and still
  matches the index, and only when a session starts while the log is
  enabled or `log maintain` is run. After `log disable` no session start
  expires anything, so recorded content stays until you run `log maintain`
  or `log purge --yes`. A session start seals and expires only sessions up
  to 2 MiB on disk and leaves larger ones for `maintain`. A session resumed
  later keeps its earlier content until the period after its last event. A
  session whose events carry no time never expires.
- Reads are bounded. A session file, the seal index or the ledger over
  256 MiB is not read, and `FAILURES.md` over 1 MiB is not read; a
  transcript holding a line over 64 MiB is reported as not checked. Each
  is reported as not read or unreadable, not as empty. A session over
  256 MiB is not sealed or expired either, and `log status` names it. While
  `FAILURES.md` is not read, `learn draft` refuses and a policy promotes
  nothing.
- Nothing is written through a data directory, sessions directory, blob
  store or session file that is a link; `log` and `learn` refuse (exit 3)
  a data directory that is a link.
- A refused terminal-only step changes no learning, but first runs the gate
  repair, which can rewrite this machine's `gates.local.json`.
- A fresh log returns `not-checkable` for most drafts until it holds at
  least 20 clean calls of the gate's tool across 2 sessions, and at least
  one successful call of that tool in the recurrence's own sessions. The
  replay requires the gate to fire on none of those successful calls.
- A failure's signature does not depend on the directory or worktree the
  command is run from: a failure records the project root, and one
  recorded without it is read against the work tree the data directory is
  keyed by. A failure recorded before this in a repository whose common
  directory is not a `.git` directory (a bare repository with worktrees, a
  submodule) is read against the directory the command was pointed at.
- A call interrupted while its tool ran is not counted as a failure. A
  failure with no harness and model recorded before it, or with no first
  error line or input hash, is left out of every recurrence, and
  `log report` counts each kind.
- A session is flagged as holding outside content only when it used
  `WebFetch`, `WebSearch` or an MCP tool. A download made through Bash is
  not seen.
- After a branch switch to a checkout without a committed gate, or once an
  uncommitted land is discarded, a landed learning is enforced nowhere until
  the next `learn` command that writes, or `tick`.
- A session is sealed only after 10 minutes without a new event, and
  `log maintain` waits for that too. Until then those events are checked by
  nothing, and `log status` says so ("events not yet sealed, in N sessions,
  are not checked"). A session whose events sit in a claimed or temporary
  file, as an interrupted seal leaves them, is counted by every report and
  its events are not read until a maintenance run finishes the seal.
- The harness identity is checked once per prompt. Tool events after a
  mid-turn edit to an installed hook are attributed to the previous base
  until the next prompt.
- A `warn` gate's message reaches the model after the call has run; only
  `block` stops a call.
- The credential scrub is best-effort; see
  [what the scrub misses](docs/guide/session-log.md#the-credential-scrub-and-what-it-misses).
  The log will at some point hold a secret.
- The lint sensor and the Stop gate filter what they show the model by
  dropping lines that repeat a part of their own command, but only parts of
  8 characters or more count: a shorter secret in a
  `sh: <word>: command not found` line reaches the model unless the
  credential mask recognises it.
- `uninstall` keeps the two files `learn land` writes while either holds a
  landed learning, so it takes no landed gate out of the repository. It
  removes the gate hook, though: a kept `gates.json` is enforced only where
  the hook is installed. The rule is under
  [uninstall](docs/guide/commands.md#uninstall).
- Every hook the kit installs exits 0 beside an older or missing sibling
  script, and the work that needed the sibling is not done: beside an
  unusable `harness-redact.mjs` no gate applies, nothing is recorded and
  nothing is linted. Each hook says what is not done in at most one notice
  per session, which names the remedy: run `apply --yes`, and if `apply`
  reports a file kept or gone, restore it to what kh-harness wrote and run
  `apply --yes` again.
- `apply --yes` writes the manifest, holding the settings patches it is
  about to make and every file written so far, then replaces
  `.claude/settings.json` once, by a temporary file and a rename, then
  writes the manifest again. A kill on either side of the settings rename
  leaves a state `uninstall` removes and the next `apply` completes; after
  a kill between the rename and the last manifest write, a settings file
  the kit created is not recorded as its own, so `uninstall` leaves it as
  an empty object. A kill earlier, while the files are being written,
  leaves files the manifest does not record: remove them by hand (or
  `git clean`), since `apply` does not overwrite a file it has no record
  of.

Nothing here claims that the harness or an agent improved. The commands
report counts: recurrences, replays, firings and what followed them.

## Documentation

| Page | What it covers |
|---|---|
| [How kh-harness works](docs/guide/how-it-works.md) | The parts, what runs when, where every file lives, how each decision is made |
| [Command reference](docs/guide/commands.md) | Every command, subcommand and flag, with real output |
| [The session log](docs/guide/session-log.md) | What is stored and where, the scrub, retention, sealing, cost |
| [The learning loop](docs/guide/learning-loop.md) | States of a learning, replay, policy, landing, reverting, recovery |
| [Troubleshooting](docs/guide/troubleshooting.md) | Each refusal and notice, and what ends it |
| [The contract](docs/CONTRACT.md) | What another plugin may rely on: the contract file, the rules registry, the manifest, the `PreToolUse` extension point and `recordExternalEvent` |
| [Intent](docs/INTENT.md) | What the kit is for, its success and failure tests, its non-goals |
| [Rules](docs/harness/RULES.md) | The kit's own rules registry, each rule with its enforcer |
| [Session log and learning loop design](docs/superpowers/specs/2026-11-19-session-log-and-learning-loop-design.md) | The design, and where the build differs from it |
| [Audit, 2026-11-18](docs/2026-11-18-audit-findings.md) | The audit this release's fixes answer |
| [Changelog](CHANGELOG.md) | What changed in each release |

### Development

    npm test

**`npm test` needs Node 22.1 or later**, a step above the Node 22 the kit
itself needs: it runs the latency budget tests after the rest of the suite,
alone, and leaves them out of the first run with `--test-skip-pattern`,
which Node added in 22.1.0. The commands and the hooks the kit installs
declare Node 22.0 as their floor (`package.json`). CI runs the newest 22.x
release and 24, on Linux and Windows, so 22.0 itself is claimed and not
exercised. `scripts/lib/latency-phase.test.mjs` holds the first sentence
to the flags the script uses.

The suite needs no network. **The eval suite cannot measure
`harness-init`:** its `disable-model-invocation: true` keeps it out of the
model's context, and `claude plugin eval` passes prompts verbatim, so a
literal `/harness-init` is inert text. The comments in
`.github/workflows/ci.yml` record two causes of a `meanDelta: 0` that says
nothing about the plugin: pull-request runs, at about $1.31 and 11 minutes
each, in which the skill could not fire; and three earlier runs in which
every arm aborted with `turns=0` before the model was called, because the
runner lacked the Bash sandbox backend. No eval case
exists for `harness-learn`. The CI `eval` job runs only on
`workflow_dispatch`, and shows as skipped, never passed, without a
credential.

## Requirements and exit codes

| Requirement | |
|---|---|
| Node | 22 or later for the commands and the installed hooks; 22.1 or later for `npm test`; CI runs 22 and 24 on Linux and Windows |
| Dependencies | none at run time |
| Claude Code | to use the plugin, the hooks and the skills; the scripts run without it |
| git | for `apply`'s branch and dirty-tree refusals |

| Exit code | Meaning |
|---|---|
| `0` | did what it said |
| `2` | could not act: a bad path or argument, a second path, unreadable settings, a failed write or removal, a `learn` id, signature or firing that names nothing, anything that could not be read, locked or written, a `tick` or `log maintain` that could not do part of its work |
| `3` | refused to act: the default branch, a dirty tree, a corrupt or missing manifest, a terminal-only subcommand or `log purge --yes` run where the terminal check does not pass, a learning in the wrong status for the step or one the ledger does not vouch for, a well-formed draft `learn draft` does not accept (unlabelled, already covered, or needing `--redraft`), a data directory that is a link |

Nothing is sent anywhere. Nothing else is an exit code; a crash is a bug.
