# Troubleshooting

The refusals and notices an owner is likely to meet, quoted from the code,
and what ends each one. Messages go to stderr. `apply`, `log` and `learn`
put `kh-harness: ` before each (and `learn` the subcommand's name after
it), which the quotes below leave out; `uninstall` prints its messages with
no prefix. `<…>` stands for a value the message fills in.

[Back to the README](../../README.md) ·
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

### The manifest could not be read

    <repo>/.claude/kh-harness.manifest.json exists but could not be read as a valid kh-harness manifest. Continuing would overwrite it with a fresh, empty one and permanently lose the record of what this tool previously installed — refusing instead. Restore the file from git history (or from a backup) and re-run; there is no automatic repair.

Exit 3, from `apply`. `uninstall` refuses in its own words:

    refusing to uninstall: <repo>/.claude/kh-harness.manifest.json exists but could not be read as a valid kh-harness manifest, so what this tool installed cannot be told apart from your own files. Restore it from git history and re-run.

and `learn land` and `learn revert` in theirs:

    .claude/kh-harness.manifest.json exists but could not be read as a valid kh-harness manifest, so nothing is written; restore it from git and run again

Each exits 3. Restore the manifest with
`git checkout -- .claude/kh-harness.manifest.json` or from a backup. There
is no flag that skips this.

### nothing to uninstall

    nothing to uninstall: no manifest found

Exit 3, from `uninstall`. There is no `.claude/kh-harness.manifest.json` in
the repository given: nothing was installed there, or the manifest was
deleted, in which case the kit's own files can no longer be told apart and
must be removed by hand.

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

From `learn revert`. Run the land again, as it says.

### retire is refused while the gate is committed

    <id>: its gate is still in .claude/kh-harness/gates.json, binding everyone who has the repository; `learn revert <id> --yes` at a terminal takes it out of the repository and retires it

Run the revert it names, at a terminal, and commit the change.

## The terminal check

### approve refused: standard input is not an interactive terminal

    approve refused: standard input is not an interactive terminal; it needs a person at an interactive terminal outside Claude Code, and nothing was changed.

Exit 3. The same appears for `wrong`, `demote`, `retire`, `policy set` and
`policy clear`, and for `land` and `revert` with `--yes` (without it they
are dry runs, which need no terminal). The reason may
instead be `standard output is not an interactive terminal` (output is
redirected or piped), or:

    CLAUDECODE is set: this is a Claude Code session; run the command from a separate terminal

Run the command yourself in a standalone terminal window, without
redirecting its input or output. What the check requires is in
[the terminal check and the deny rules](learning-loop.md#the-terminal-check-and-the-deny-rules).

### Claude Code declines a learn subcommand

A deny rule such as `Bash(*learn.mjs* approve*)` stopped the command before
it ran, as intended, including a dry run of `land` or `revert`. Run the
command yourself, as above. If the declined command was not a `learn`
command at all, such as a commit message containing `learn.mjs approve`,
reword it. See
[the terminal check and the deny rules](learning-loop.md#the-terminal-check-and-the-deny-rules).

## learn

A `learn` step the library refuses prints `kh-harness: <subcommand>: ` and
then the reason. It exits 2, except `land` and `revert`, which exit 3 for a
refusal and 2 when they cannot act.

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

`learn list` shows the status. A candidate needs a replay that passes
first; a demoted learning is back on trial and can be approved again.

### only a candidate is replayed

    replay: <id> is trial; only a candidate is replayed

Nothing to do: the learning already passed its replay.

### The draft is refused

| Message | What ends it |
|---|---|
| `gate: must not carry id or action; both are assigned` | Remove `id` and `action` from the draft's gate. |
| `signature: must be 16 lowercase hex characters` | Copy the signature from `learn candidates`. |
| `signature: not the signature of a current recurrence` | Draft only for a recurrence that `learn candidates` lists now. |
| `gate: tool must be the recurrence's tool` | Use the tool the recurrence names. |
| `signature: learning <id> already covers this signature` | Work with that learning; retire it first to draft anew. |
| ``signature: the replay rejected <ids>; a new draft for this recurrence is the owner's decision, as `learn --help` documents`` | Add `--redraft` if you, the owner, want a new draft. |
| `gate: <field> must not contain a credential` | Draft the gate without the secret. |

### Replay is not checkable

    too little clean evidence: <n> calls of the gate's tool replayed in <m> sessions with no failure of this signature, where at least 20 calls in 2 sessions are required

The draft stays a candidate. Work normally until the log holds at least 20
clean calls of the gate's tool across 2 sessions without the failure, then
run `learn replay <id>`.

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

Otherwise `log purge --yes` removes the ledger with the rest of the data
directory, and the learnings start again. It does not touch the repository:
every landed gate stays in `.claude/kh-harness/gates.json`, binding everyone,
with no learning left on this machine to suspend or `revert` it. To take
them out, either:

- run `uninstall --yes`, which removes `docs/harness/LEARNED.md` and
  `gates.json` whole, with every landed gate in them, when both hold only
  learnings the manifest records (see
  [uninstall](commands.md#uninstall)); then `apply --yes` to reinstall the
  rest; or
- edit both files by hand to take out the gates you no longer want, and
  commit. Both files are kit-owned, so `detect`'s `P5.integrity` then
  reports them as modified, and also reports each learning the manifest
  still records as landed whose gate is no longer there; kh-harness no
  longer updates either file.

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
| `kh-harness gate hook: <problem>, so no gate applies — re-run …` | A shared module is missing or too old: re-run `apply --yes` from kh-harness. |

## log

### the log is not enabled

    the log is not enabled for <repo> on this machine; nothing was done. Enable it first: node scripts/log.mjs <repo> enable

Exit 3, from `log maintain`. Run `log enable` first.

### refusing to purge, refusing to write, refusing to read

    refusing to purge <data>: it is a link, so a write or removal would act on what it points at. Nothing was removed.

Exit 3. The data directory is a link or not directly inside the data root.
`learn` writing steps refuse the same directory with `refusing to write to
…`, and `learn evidence` with `refusing to read …`. Replace the link with a
real directory, or point `KH_DATA_DIR` at the data root you mean.

### Sessions are not sealed

    not sealed: <n> sessions appended to in the last 10 minutes, which may still be running

From `log maintain`. A session is sealed only after 10 minutes without a new
event. Run it again later.

## detect

### P5.integrity is failing

A recorded hook script was edited or deleted, a committed gate has no
approval in `docs/harness/LEARNED.md`, the gate file holds entries the gate
language rejects, or a landed learning has no gate. Restore what the lines
name from git, or finish the land or revert that stopped. The kit proposes
nothing here: restoring a file or approving a gate is your decision.
