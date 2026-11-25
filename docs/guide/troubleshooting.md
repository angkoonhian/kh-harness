# Troubleshooting

The refusals and notices an owner is likely to meet, quoted from the code,
and what ends each one. Messages go to stderr. `apply`, `log` and `learn`
put `kh-harness: ` before each (and `learn` the subcommand's name after
it), which the quotes below leave out; `uninstall` prints its messages with
no prefix. `<…>` stands for a value the message fills in.

[Back to the README](../../README.md) ·
[How it works](how-it-works.md) ·
[Command reference](commands.md) ·
[Session log](session-log.md) ·
[Learning loop](learning-loop.md)

## apply, land and revert

### Refusing on the default branch

    refusing to apply on the default branch "main". A user must be able to `git diff` exactly what this tool did — switch to a feature branch, or re-run with --allow-default-branch if this is intentional.

Exit 3, nothing written. Switch to a branch (`git switch -c harness`) and
re-run, or add `--allow-default-branch`. `learn land` and `learn revert`
say `land` or `revert` in place of `apply`. A dry run prints the same text
after `note: --yes would be refused —` and writes nothing either way.

### Refusing with uncommitted changes

    refusing to apply with uncommitted changes to tracked files. Commit or stash first so you can `git diff` what this tool did, or re-run with --allow-dirty.

Exit 3. Commit or stash your changes, or add `--allow-dirty`. The kit's own
earlier writes never count as dirty.

### git could not report whether the tree is clean

    git could not report whether the tree is clean (<reason>), so the dirty-tree gate cannot run. Re-run with --allow-dirty to proceed without it.

Install git or make the directory readable to it, or add `--allow-dirty`.
When git cannot be consulted at all, `--yes` needs both waivers.

### GIT_DIR is set over a directory that is not a repository

    <repo> is not a git repository by its own .git, and GIT_DIR is set, which kh-harness does not follow: unset it to have this directory read as it is

Every git call the kit makes runs without `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_COMMON_DIR` and `GIT_OBJECT_DIRECTORY`, so it reads
the repository at the path it was given. A path that is not a repository
by its own `.git`, while one of those variables is set, is an error and
not "not a repository", so the two refusals are not waived over it. Unset
the variable, as the message says.

### The manifest could not be read

    <repo>/.claude/kh-harness.manifest.json exists but could not be read as a valid kh-harness manifest. Continuing would overwrite it with a fresh, empty one and permanently lose the record of what this tool previously installed — refusing instead. Restore the file from git history (or from a backup) and re-run; there is no automatic repair.

Exit 3, from `apply`. `uninstall` refuses in its own words:

    refusing to uninstall: <repo>/.claude/kh-harness.manifest.json exists but could not be read as a valid kh-harness manifest, so what this tool installed cannot be told apart from your own files. Restore it from git history and re-run.

and `learn land` and `learn revert` in theirs:

    .claude/kh-harness.manifest.json exists but could not be read as a valid kh-harness manifest, so nothing is written; restore it from git and run again

Each exits 3, `apply` with or without `--yes`. Restore the manifest with
`git checkout -- .claude/kh-harness.manifest.json` or from a backup. There
is no flag that skips this.

### nothing to uninstall

    nothing to uninstall: no manifest found

Exit 3, from `uninstall`. There is no `.claude/kh-harness.manifest.json` in
the repository given: nothing was installed there, an earlier `uninstall`
finished and removed the manifest with the last record, or the manifest
was deleted, in which case the kit's own files can no longer be told apart
and must be removed by hand.

### uninstall keeps LEARNED.md and gates.json

    docs/harness/LEARNED.md (holds <n> landed learnings, which are yours: `learn revert <id>` takes each out of the repository, and uninstall removes this file once it holds none)

A landed learning is the owner's content, so `uninstall` keeps both learned
files while either holds one. The other file is listed as
`kept because <file> is: the learned registry and the gate file stay or go
together`. Run `learn revert <id> --yes` for each, at a terminal on the
machine that landed it, commit, and run `uninstall` again. Note that
`uninstall` removes the gate hook: a kept `gates.json` is enforced only
where the hook is installed.

### uninstall lists something as already gone

A recorded file you deleted, or a recorded hook entry or deny rule you took
out of `.claude/settings.json` by hand, is listed under
`Already gone, so only the record of it is dropped:` and its record is
removed from the manifest. Nothing to do. A manifest left with no record is
removed. `docs/harness/detect.json` is always left, and listed under
`Left in place`; delete it by hand if you do not want it.

### uninstall could not revert a hook entry, and kept its script

    Could not revert:
      /hooks/PreCompact (patch-modified: the entry kh-harness recorded is not there as written while one that runs a kit script is, so that one is taken to be it, edited, and is left registered with its script kept; put it back as written or delete it, then run uninstall again)
    Kept:
      .claude/scripts/session-log.mjs (hook-still-registered: a hook entry left in .claude/settings.json still runs it, or a script that loads it, and with the script gone that hook would fail on every event; put the entry back as kh-harness wrote it or delete it, then run uninstall again)
    .claude/kh-harness.manifest.json remains: it records what was kept, and running uninstall again acts on it.

Exit 2. A kit hook entry in `.claude/settings.json` was changed since
kh-harness wrote it, by adding a `timeout` for instance, so `uninstall`
does not take it for its own and leaves it registered. Claude Code goes on
running that entry, so the script it runs stays on disk, with every script
that one loads; every other kit file and entry is removed. Open
`.claude/settings.json`, delete the entry under the event named (or put it
back as kh-harness wrote it), and run `uninstall --yes` again: the kept
scripts and the manifest then go.

The same `hook-still-registered` line appears, with exit 0, for a hook
entry of your own that runs a kit script. While `.claude/settings.json`
cannot be read, every hook script is kept, and the exit code is 2:

      .claude/scripts/tool-gate.mjs (hook-still-registered: .claude/settings.json could not be read, so a hook entry in it may still run it, or a script that loads it; mend the file, then run uninstall again)

The other reason words `uninstall` prints are listed under
[uninstall](commands.md#uninstall).

### A hook script is kept, so no hook script is written

`detect` prints, under each hook check that is not yet installed:

    .claude/scripts/rules-brief.mjs is not written or registered while kh-harness keeps .claude/scripts/lint-touched.mjs (edited since kh-harness wrote it) as it is: its hook scripts load one another, so they are installed at one kit version or not at all. To install this hook, restore each edited file to what kh-harness wrote (git holds it, in the commit that installed it), then run apply again; left as it is, this hook stays off.

and asks once, for all of them, in `detect` and in `apply`:

    kh-harness keeps .claude/scripts/lint-touched.mjs (edited since kh-harness wrote it) as it is, and so writes and updates none of its hook scripts. Restore each edited file to what kh-harness wrote (git holds it, in the commit that installed it), then run apply again; or leave it, and the hooks not yet installed stay off. Which?

`apply` then lists the file as kept and writes no hook script:

    kept       .claude/scripts/lint-touched.mjs (modified since kh-harness wrote it — left as-is)

This output is from a scratch repository in which `lint-touched.mjs` had a
line added and `RULES.md` had gained its first rule, so that `detect`
would otherwise have proposed the rules brief.

The kit's scripts under `.claude/scripts/` load one another, so they are
written at one kit version or not at all. One file at any of their paths
that `apply` will not bring to this kit's version holds every one of them
back: none is written, none is updated, and no hook that is not already
registered is registered. Three things make a file such a one, and the
message names which:

| The file is | What ends it |
|---|---|
| `edited since kh-harness wrote it` | Restore it to what kh-harness wrote: `git checkout <commit> -- <path>`, from the commit that installed it. Then `apply --yes`. |
| `does not carry the kh-harness stamp` | Move the file out of `.claude/scripts/`, as the message says. Then `apply --yes`. |
| `not recorded in the manifest as written by kh-harness` | The same. |

A deleted file holds nothing back, but `apply` reports a deleted recorded
file as `gone` and does not write it again, so the hooks that load it stay
unregistered until it is restored. After an upgrade of the kit this is the usual cause of new hooks not
appearing: one hook script edited under the old version keeps every hook
script at the old version, and `P0.kitskew` lists the others as
`held back`. `uninstall --yes` followed by `apply --yes` does not end it,
because `uninstall` keeps the edited file and `apply` then meets it again.
Hooks already registered go on running at the version on disk.

### settings.json cannot take a patch

    .claude/settings.json <problem>, so the settings patches above cannot be applied — nothing was written. Fix the file and re-run.

Exit 2. The file is not valid JSON, or one of its keys has the wrong shape.
Fix it by hand; kh-harness never rewrites a settings file it cannot parse.

### A file no longer matches what kh-harness last wrote

    <path> no longer matches what kh-harness last wrote (a hand edit, a deletion, or a write that stopped before the manifest recorded it), so kh-harness no longer updates it; restore it from git and run again

From `learn land` or `learn revert`, about `docs/harness/LEARNED.md` or
`.claude/kh-harness/gates.json`. Exit 3, nothing written. Restore the file
from git (`git checkout -- <path>`) and run the same command again. A file
left by a land or revert killed between its write and the manifest's is not
this case: it is recognised as that step's own write, and running the same
command again finishes the step.

For a revert, a learned file that still holds the learning gets this
addition, and the alternative works too:

    …; or, if it is to stay as it is, take <id> out of it by hand and run `learn revert <id> --yes` again, which then finds nothing of <id> in it and goes on

A learned file that exists but that the manifest does not record is
refused the same way:

    <path> exists and the manifest does not record kh-harness writing it, so kh-harness does not write it; move it aside and run again

> [!NOTE]
> `apply` treats a kit file you edited differently: it keeps the file,
> reports it as `kept`, and carries on (exit 0). `learn land` and
> `learn revert` refuse instead (exit 3), because they would have to write
> that very file.

### A land stopped before its learning file was written

    <id>: a land of it stopped before its learning file was written; running `learn land <id> --yes` again at a terminal finishes it

From `learn revert`. Run the land again, as it says. The land finishes
only a file the ledger vouches for: if its title, why or evidence was
changed since the landing, the land refuses with
`the ledger records another title, why or evidence for this learning`, and
`learn show <id>` says what mends it (put the file back as it was).

### retire is refused while the gate is committed

    <id>: its gate is still in .claude/kh-harness/gates.json, binding everyone who has the repository; `learn revert <id> --yes` at a terminal takes it out of the repository and retires it

Run the revert it names, at a terminal, and commit the change.

## The terminal check

### approve refused: standard input is not an interactive terminal

    approve refused: standard input is not an interactive terminal; it runs only from an interactive terminal outside Claude Code (standard input and output both terminals, CLAUDECODE unset), and nothing was changed.

Exit 3. The same appears for `wrong`, `demote`, `retire`, `policy set` and
`policy clear`, and for `land` and `revert` with `--yes` (without it they
are dry runs, which need no terminal). `log purge --yes` refuses in the
same words, ending `and nothing was removed.` The reason may
instead be `standard output is not an interactive terminal` (output is
redirected or piped), or:

    CLAUDECODE is set: this is a Claude Code session; run the command from a separate terminal

Run the command yourself in a standalone terminal window, without
redirecting its input or output. What the check requires is in
[the terminal check and the deny rules](learning-loop.md#the-terminal-check-and-the-deny-rules).

### Claude Code declines a learn subcommand

A deny rule such as `Bash(*learn.mjs* approve*)` stopped the command before
it ran, as intended, including a dry run of `land` or `revert`.
`log purge --yes` is declined the same way, with `--yes` before or after
`purge`; `log purge` without `--yes` is not. Run the command yourself, as
above. If the declined command was not a `learn`
command at all, such as a commit message containing `learn.mjs approve`,
reword it. See
[the terminal check and the deny rules](learning-loop.md#the-terminal-check-and-the-deny-rules).

## learn

A `learn` step that does not go through prints `kh-harness: <subcommand>: `
and then the reason. One rule gives the exit code for every subcommand: 3
when the step refused (the terminal check, a learning in the wrong status
or one the ledger does not vouch for, a hash that is not the one shown, a
draft it does not accept, a firing already marked wrong), 2 when it could
not act (a malformed argument or draft, an id, signature or firing that
names nothing, anything that could not be read, locked or written). The
full list is under [learn](commands.md#learn).

### only a learning promoted on this machine is landed

    land: <id> is trial; only a learning promoted on this machine is landed

Exit 3. Approve the learning at a terminal first (`learn show`, then
`learn approve`). `revert` says, for a learning in no state to revert:

    revert: <id> is trial; only a learning landed or suspended on this machine, or one this machine landed that has left its gate, registry entry or manifest record in this repository, is reverted

### the hash approved is not the learning's content

    <id>: the hash approved is not the learning's content; show it again and approve the hash it shows

Run `learn show <id>` and approve the `gateSha256` it prints. A changed
gate has a new hash.

### only a learning on trial is approved

    <id> is <status>; only a learning on trial is approved

Exit 3. `learn list` shows the status. A candidate needs a replay that passes
first; a demoted learning is back on trial and can be approved again.

### only a candidate is replayed

    replay: <id> is trial; only a candidate is replayed

Exit 3. Nothing to do: the learning already passed its replay. When the
message goes on `a step had stopped after the ledger recorded it, and the
learning file was first brought into line with the ledger: <id>`, an
earlier replay had stopped after its ledger entry, and this run finished
it.

### The draft is refused

| Message | What ends it |
|---|---|
| `gate: must not carry id or action; both are assigned` | Remove `id` and `action` from the draft's gate. |
| `signature: must be 16 lowercase hex characters` | Copy the signature from `learn candidates`. |
| `signature: not the signature of a current recurrence` | Draft only for a recurrence that `learn candidates` lists now. |
| `gate: tool must be the recurrence's tool` | Use the tool the recurrence names. |
| `signature: learning <id> already covers this signature` | Work with that learning; retire it first, then draft anew with `--redraft`. If the message adds that its learning file is gone and `tick` records it retired, run `learn tick`. If it adds that `tick` does not retire it, the ledger records an action above `observe` or an approver for it: restore the learning file. |
| ``signature: no failure kind in docs/harness/FAILURES.md lists this signature, and only the owner names a failure: …`` | Label the recurrence yourself in `FAILURES.md`: a `## F<n> — <kind of failure>` heading and a `- signatures: <signature>` line. |
| `signature: docs/harness/FAILURES.md exists but could not be read, so whether a failure kind lists this signature is not known; nothing was drafted` | Make the file readable. The same refusal, with `is larger than the <n> bytes kh-harness reads of a file`, means it is over 1 MiB. |
| ``signature: an earlier learning for this recurrence did not hold: <ids, each with how it ended>; a new draft for it is the owner's decision, as `learn --help` documents`` | The earlier learning was rejected by its replay, or retired after a wrong mark, after its gate was suspended, or by you; it may be one for another signature of the same failure kind. Add `--redraft` if you, the owner, want a new draft. |
| `gate: <field> must not contain a credential` | Draft the gate without the secret. |

The first four rows and the last exit 2 (a malformed draft, or a signature
that names no current recurrence); the four `signature:` refusals between
them exit 3.

### Replay is not checkable

    too little clean evidence: <n> calls of the gate's tool replayed in <m> sessions with no failure of this signature, where at least 20 calls in 2 sessions are required

The draft stays a candidate. Work normally until the log holds at least 20
clean calls of the gate's tool across 2 sessions without the failure, then
run `learn replay <id>`.

The reason may instead, or also, be:

    no successful call of the gate's tool is recorded in the recurrence's sessions, so nothing there shows the gate leaves a good call alone

The replay requires the gate to fire on none of the successful calls of its
tool in the sessions that hold the failure, and at least one such call must
be recorded. It becomes checkable once a session records both the failure
and a successful call of that tool. Other reasons name a session that could
not be read in full, or calls whose content has expired or was moved to a
blob.

### tick passed a trial over

    trials the policy passed over: <id> (<reason>)

Under a policy, `tick` does not promote a trial when an earlier learning
for its recurrence or failure kind was marked wrong, when the ledger
records no hash of its title, why and evidence, or while
`docs/harness/FAILURES.md` could not be read or is over 1 MiB. Approve the
learning yourself at a terminal if you want it promoted; for the last
reason, make the file readable.

### The ledger records no hash of a learning's title, why and evidence

    learnings whose title, why and evidence the ledger records no hash of: <ids>

From `learn list`. The learning was drafted before kh-harness recorded that
hash. Its gate, status and action are vouched for as before. An approval or
a landing at a terminal records the hash, and until then a policy does not
promote it.

### A learning's id is held by another committed gate

    learnings whose id the committed gate file holds for another gate, so their own gate is not applied: <ids>
      ids are assigned per machine and nothing renumbers a learning: `retire <id>` at a terminal, then draft its recurrence again with --redraft

From `learn list` and `learn tick`, typically after pulling a landing made
on another machine. The gate hook applies the committed gate under that id
and ignores the local one. Do as the second line says.

### A learning file was rolled forward

    learning files a stopped step left behind the ledger, rolled forward: <ids>

From `learn tick`; `learn list` names the same files before any step has
written. A step had stopped after its ledger entry and before the learning
file was written. The ledger is the authority, so the file's status and
action were rewritten from it. Nothing to do.

### The ledger is broken

    the ledger cannot be read or its chain is broken, so no learning can be told settled and no id never used can be assigned

While the ledger's chain is broken:

- `draft` refuses, and nothing is promoted;
- the next `learn` step that writes, `tick` included, removes every learned
  gate from this machine's gate file and restores none;
- the same repair drops this machine's suspensions, so a committed gate you
  suspended acts on this machine again.

`log status` reports the line where the chain breaks. There is no repair
command. Restore `ledger.jsonl` from a backup of the data directory if you
have one.

An unterminated last line is not this case: an append that stopped partway
leaves one, every reader passes over it, and the next append removes it.
A ledger larger than 256 MiB is not read at all; `log status` then says
`ledger: not read; it is larger than the <n> bytes this command reads of a
file`.

Otherwise `log purge --yes`, from an interactive terminal outside Claude
Code, removes the ledger with the rest of the data directory, and the
learnings start again. It does not touch the repository: every landed gate
stays in `.claude/kh-harness/gates.json`, binding everyone, with no
learning left on this machine to suspend or `revert` it, and `uninstall`
keeps both learned files while they hold a learning. To take the gates
out, edit both files by hand and commit. Both files are kit-owned, so
`detect`'s `P5.integrity` then reports them as modified, and also reports
each learning the manifest still records as landed whose gate is no longer
there; kh-harness no longer updates either file.

### tick could not do all of its work

    tick could not do all of its work: <n> steps not done, listed above.

Exit 2, after the report. The `NOT DONE` list says what was not done and
why. A common case is a policy file that does not match the recorded hash:
set the policy again with `learn policy set` at a terminal.

### A notice from the gate hook

The gate hook tells you, once per session, in a message shown to you and
not to the model:

| Notice | What ends it |
|---|---|
| `… could not be read, so none of its gates apply.` | Restore or fix the named gate file. |
| `… could not be parsed, so none of its gates apply.` | The file is not a gate file; `tick` rewrites this machine's file from an intact ledger. A committed `gates.json`: restore it from git. |
| `<n> entries in … were rejected and do not apply; its other gates do.` | Remove or fix the rejected entries; `detect`'s `P5.integrity` names them in the committed file. |
| `<n> entries in this machine's gate file gates.local.json tried to replace a committed gate with a weaker or different rule and were ignored.` | Run `learn tick`, which removes entries the ledger does not vouch for. |
| `<n> committed gates are suspended on this machine; learn lists them.` | Intended after a suspension. Revert the learning to take its gate out of the repository. |
| `kh-harness gate hook: <problem>, so no gate applies — re-run …` | A shared module is missing or too old; see the next section. |

When more than one gate matches a call, the text names each matching gate
above `observe` on its own line, `kh-harness gate <id>: <message>`, blocks
first, and the call is denied if any of them blocks. A last line
`kh-harness: <n> more matching gates are not shown.` appears when the text
would pass 4,000 characters; those gates' firings are recorded all the
same.

### Every tool call is blocked by the extensions file

Every tool call is denied, and Claude is shown one of these:

    kh-harness: .claude/kh-harness/extensions.json cannot be used (<problem>), so every tool call is blocked. Repair or remove the file outside this session.

    kh-harness: .claude/scripts/<file> <problem> while .claude/kh-harness/extensions.json exists, so every tool call is blocked. Run kh-harness apply --yes from a kit at least as new as the one that installed .claude/scripts/dispatch-pre-tool.mjs, or remove the extensions file, outside this session.

    kh-harness: the extensions .claude/kh-harness/extensions.json lists were not applied to this call (<cause>), so it is blocked. A time limit shortened through HK_RUN_DEADLINE_MS or HK_STDIN_TIMEOUT_MS in the environment hooks run with blocks every call this way.

The first: the extensions file another plugin wrote is not one the
`PreToolUse` entry script can read. `<problem>` says why: for example it is
not JSON (a byte order mark at its start counts), lists more than 8
extensions, has an entry that is not as [the contract](../CONTRACT.md#the-extensions-file)
describes one, or `.claude/kh-harness` is a link. The second: `<file>` is
`harness-dispatch.mjs` or `harness-extensions.mjs`, and it is missing, or
from another kit version than the entry script, so nothing can run the
extensions the file lists. The third: the hook's run ended before the
extensions were applied; `<cause>` says how. On every call it means one of
the two time limits is shortened: look for `HK_RUN_DEADLINE_MS` or
`HK_STDIN_TIMEOUT_MS` under `env` in `.claude/settings.json`,
`.claude/settings.local.json` or `~/.claude/settings.json`, and in the
shell that started Claude Code.

Since every tool call is blocked, Claude cannot fix it in the session. In
a terminal outside Claude Code: for the second, run
`node scripts/apply.mjs <repo> --yes` from a kh-harness checkout at least
as new as the one that installed the entry script, since an older one puts
the older files back; for the first, reinstall the plugin that wrote the
file, or remove the file; for the third, remove the variable. `detect`
names the first two under `P5.extensions`.

### An extension says it checks no call

    kh-harness extension <id>: <reason>, so it checks no call (onFailure: allow).

Shown to you once per session. The extension `<id>` registered in
`.claude/kh-harness/extensions.json` could not decide calls: `<reason>`
says why, for example `its module file does not match the sha256 recorded
for it`. Its entry says `onFailure: allow`, so calls go ahead without its
check. Reinstall the plugin that registered it. With `onFailure: block`,
the same failure blocks every call instead, with a message ending
`so this call is blocked (onFailure: block).`

### A hook says a shared module is missing or older

    kh-harness lint-touched: .claude/scripts/harness-redact.mjs <problem>, so edited files are not linted — re-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared asset; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.

Each of the seven hooks checks, before it does anything, that the sibling
scripts it loads provide what it needs. Beside an older or missing sibling
it exits 0, does not do the work that needed the sibling, and says so in
at most one notice per session. The notice says what is not done:

| Hook | What its notice says is not done |
|---|---|
| gate hook | no gate applies |
| session log | nothing is recorded; or, beside an older or missing `harness-seal.mjs` only, sessions are not sealed and old content is not expired |
| rules brief | the project rules are not re-told |
| loop warning | repeated failures are not counted |
| lint sensor | edited files are not linted |
| Stop gate | nothing is verified when Claude stops |
| session brief | names the module that is missing or older |

What ends it is the notice's own remedy: run `apply --yes` from
kh-harness. If `apply` then reports the file as `kept` (you edited it) or
`gone` (you deleted it, and `apply` does not write a deleted recorded file
again), restore it to what kh-harness wrote, from the commit that
installed it, and run `apply --yes` again. `uninstall --yes` followed by
`apply --yes` does not do this for an edited file; see
[a hook script is kept, so no hook script is written](#a-hook-script-is-kept-so-no-hook-script-is-written).

### An entry script says a file is missing or older

    kh-harness dispatch-pre-tool: .claude/scripts/harness-dispatch.mjs <problem>, so no kh-harness hook ran on PreToolUse — re-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.

    kh-harness dispatch: .claude/scripts/<hook file> <problem>, so this entry script did not run the <name> hook — re-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.

The three entry scripts, `dispatch-pre-tool.mjs`, `dispatch-post-tool.mjs`
and `dispatch-tool-failure.mjs`, run their event's two hooks through the
shared core `harness-dispatch.mjs`. `<problem>` is `is missing or cannot
be loaded`, or that the file is older than the entry script and lacks what
it needs.

- The first notice, from the entry script named at its start: the core is
  missing or older, so neither hook ran on that event.
- The second: one hook's file is missing or older. `<name>` is `gate`,
  `log`, `lint` or `loop`. The entry script did not run that hook, and ran
  the other one. The hook still runs if it is also registered on its own,
  as an older kit's `apply` registers it.

Either notice is a message shown to you. It is given on every call of the
event, not once per session, and never changes the entry script's exit
code. What ends it is the same remedy as for a hook's own notice, above:
`apply --yes`, and restoring a file `apply` reports as `kept` or `gone`.
On `PreToolUse`, while `.claude/kh-harness/extensions.json` exists, the
first notice is replaced by a block of every call; see
[every tool call is blocked by the extensions file](#every-tool-call-is-blocked-by-the-extensions-file).

### Running only one hook of a tool-call event

On `PreToolUse`, `PostToolUse` and `PostToolUseFailure`, one entry script
runs both of the event's kit hooks, so its registration in
`.claude/settings.json` turns both on or off together. To run only one of
them, replace the entry script's registration with that hook's own. For
the gate hook alone on `PreToolUse`:

```json
"PreToolUse": [
  {
    "hooks": [
      { "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/scripts/tool-gate.mjs"] }
    ]
  }
]
```

The lint sensor's own registration carries `"matcher": "Write|Edit"`
beside `hooks`, as the kit wrote it before the entry scripts.

- `detect` accepts either form: a hook registered by itself counts as
  registered, as one run by its entry script does. `P0.hookmerge` reports
  the event as left on separate registrations, because the registration
  is not one kh-harness recorded.
- `apply` will propose the other hook again, on its own registration,
  each time it runs, and `--yes` installs it with the rest of the run.
- `uninstall` takes the registration you wrote for the kit's own, edited:
  it leaves it registered and keeps the scripts it loads, as under
  [uninstall could not revert a hook entry, and kept its script](#uninstall-could-not-revert-a-hook-entry-and-kept-its-script).

## log

### maintain exits 2

    content was not expired, because retention did not run: <reason>

`log maintain` exits 2, after printing what it did, when sealing, retention
or the blob sweep did not run or stopped before its end for a reason other
than the time limit. The message names the step and the reason; run it
again once the reason is gone. `log maintain` no longer needs the log
enabled: it runs on a disabled log, and with no log for the repository on
this machine it says so and exits 0.

### purge --yes refused

    purge --yes refused: standard input is not an interactive terminal; it runs only from an interactive terminal outside Claude Code (standard input and output both terminals, CLAUDECODE unset), and nothing was removed.

Exit 3. `log purge --yes` deletes the ledger, the learnings, the policy and
this machine's gate file with the log, so it takes the same check as the
terminal-only `learn` subcommands. Run it yourself in a standalone
terminal. `log purge` without `--yes` lists what would be removed and
needs no terminal. Exit 2 from `purge --yes` means another process held
one of the data directory's locks; run it again.

### refusing to purge, refusing to write, refusing to read

    refusing to purge <data>: it is a link, so a write or removal would act on what it points at. Nothing was removed.

Exit 3. The data directory is a link or not directly inside the data root.
`log enable`, `log disable`, `log maintain` and the `learn` writing steps
refuse the same directory with `refusing to write to …`, and
`learn evidence` with `refusing to read …`. Replace the link with a real
directory, or point `KH_DATA_DIR` at the data root you mean.

### KH_DATA_DIR seems to be ignored

`KH_DATA_DIR` is used only when it holds an absolute path. A relative value
is ignored and the log is read and written under `~/.claude/kh-harness/`.
`log status` prints the location in use.

### A session is counted and not read

    sessions with events in a claimed or temporary file, which are not read until a maintenance run finishes sealing them: <n>

From `log report` and `learn candidates`. A seal was interrupted. Run
`log maintain`, or start a session with the log enabled, to finish it.

    sessions larger than this command reads, counted as unreadable: <ids>

A session file over 256 MiB is not read, sealed or expired.

### Sessions are not sealed

    not sealed: <n> sessions appended to in the last 10 minutes, which may still be running

From `log maintain`. A session is sealed only after 10 minutes without a new
event. Run it again later.

## detect

### P5.extensions is failing

`.claude/kh-harness/extensions.json` is there, and one of these holds:

- it cannot be used: the line says why, and that every tool call is
  blocked;
- a module it lists does not match its recorded sha256, is missing, is not
  a file under `.claude/` in this repository, or could not be read; the
  line ends with what that does to a call, by the entry's `onFailure`;
- `.claude/scripts/dispatch-pre-tool.mjs` is not registered on
  `PreToolUse`, so no extension runs;
- the entry script, `harness-dispatch.mjs`, `harness-extensions.mjs` or a
  module it loads is missing or is not the file this kit installs. Run
  `apply --yes`; `P0.kitskew` says whether it can update each one.

kh-harness never writes the extensions file or its modules. A module that
does not match is fixed by reinstalling the plugin that registered it; a
malformed file, by that plugin or by removing the file. `detect` never
loads a module.

### P5.integrity is failing

A recorded hook script was edited or deleted, a committed gate has no
approval in `docs/harness/LEARNED.md`, the gate file holds entries the gate
language rejects, or a landed learning has no gate. Restore what the lines
name from git, or finish the land or revert that stopped. The kit proposes
nothing here: restoring a file or approving a gate is your decision.

Two lines are about a gate's action:

    <id> in .claude/kh-harness/gates.json: its action changed since it was approved — it is not the approved-action of <id> in docs/harness/LEARNED.md

The gate file and the registry entry disagree about `warn` or `block`.
Restore the file that was edited.

    <id> in .claude/kh-harness/gates.json: not approved for its action — its entry in docs/harness/LEARNED.md records no approved-action, as an entry landed by an older kh-harness does not; `learn revert <id> --yes` then `learn land <id> --yes`, at a terminal on the machine that landed it, writes one

Do as it says. Until then the prompt hook re-tells that learned rule on
every prompt, since its entry does not say its gate blocks.
