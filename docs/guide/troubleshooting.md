# Troubleshooting

The refusals and notices an owner is likely to meet, quoted from the code,
and what ends each one. A message reads `kh-harness: …` on stderr unless
said otherwise. `<…>` stands for a value the message fills in.

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

Exit 3, from `apply`; `uninstall` says `refusing to uninstall:` and the
same reason. Restore the manifest with `git checkout -- .claude/kh-harness.manifest.json`
or from a backup. There is no flag that skips this.

### settings.json cannot take a patch

    .claude/settings.json <problem>, so the settings patches above cannot be applied — nothing was written. Fix the file and re-run.

Exit 2. The file is not valid JSON, or one of its keys has the wrong shape.
Fix it by hand; kh-harness never rewrites a settings file it cannot parse.

### A file no longer matches what kh-harness last wrote

    <path> no longer matches what kh-harness last wrote (a hand edit, a deletion, or a write that stopped before the manifest recorded it), so kh-harness no longer updates it; restore it from git and run again

From `learn land` or `learn revert`, about `docs/harness/LEARNED.md` or
`.claude/kh-harness/gates.json`. Nothing is written. Restore the file from
git (`git checkout -- <path>`) and run the same command again. A land or
revert that stopped partway also ends here; running it again after the
restore finishes it.

## The terminal check

### approve refused: standard input is not an interactive terminal

    approve refused: standard input is not an interactive terminal; it needs a person at an interactive terminal outside Claude Code, and nothing was changed.

Exit 3. The same appears for `wrong`, `demote`, `retire`, `policy set` and
`policy clear`, and for `land` and `revert` with `--yes`. The reason may
instead be `standard output is not an interactive terminal` (output is
redirected or piped), or:

    CLAUDECODE is set: this is a Claude Code session; run the command from a separate terminal

Run the command yourself in a standalone terminal window, not through
Claude Code and not in an IDE's built-in terminal, which sets `CLAUDECODE`
too. Do not redirect its input or output. No flag or variable skips the
check.

### Claude Code declines a learn subcommand

A deny rule such as `Bash(*learn.mjs* approve*)` stopped the command before
it ran. This is intended: it is the second barrier. Run the command
yourself, as above. A deny rule also declines an unrelated command that
holds that text, such as a commit message containing `learn.mjs approve`;
reword the command.

## learn

A `learn` step the library refuses prints `kh-harness: <subcommand>: ` and
then the reason, and exits 2.

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

While the ledger's chain is broken, `draft` refuses, `tick` removes every
learned local gate and restores none, and nothing is promoted. `log status`
reports where the chain breaks. There is no repair command. Restore
`ledger.jsonl` from a backup of the data directory if you have one;
otherwise `log purge --yes` removes the ledger with everything else, and
the learnings start again.

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

### A phase with no name

`detect`'s summary prints the fifth phase as `Phase 5 —` with no title. The
checks under it (`P5.failures`, `P5.sessionlog`, `P5.toolgate`,
`P5.integrity`) are the session log and learned gates.
