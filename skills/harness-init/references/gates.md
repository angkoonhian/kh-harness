# Gates

Every phase ends at a gate — see `SKILL.md`'s gate rule. This reference
covers what a gate is, how to present one, and what declining it means.

## What a gate is

A gate is the point where this skill stops deriving and hands a decision to
the user. It exists because every *prompt* step (recon, `CLAUDE.md`,
`ARCHITECTURE.md`) produces a claim about THIS repository that only a human
who works in it can confirm — and because every *script* step still writes
files and settings, which the user should see before they land. A gate is
not a formality to get past; it is the mechanism that keeps a wrong
derivation from becoming a written file.

## How to present one

- **Show the diff.** If a file already exists, show what would change
  against it, not just the proposed content in isolation. If it does not
  exist yet, show the full proposed content.
- **Name the files.** Say exactly what would be written or modified, by
  path — never "some files" or "the usual setup."
- **State what is irreversible and what is not.** A new file the user can
  delete is not the same as a settings patch that changes what runs on
  every edit, or a credential finding that cannot be un-seen once reported.
  Say which kind this is.
- **Ask, then stop.** Do not keep talking past the question while waiting
  for an answer.

## Declining is a normal outcome

A gate the user declines is not a failure to recover from and retry. Report
what was proposed, that it was declined, and move on — do not re-propose
the same thing a different way in the hope of a different answer, and do
not continue to the next phase because this one technically "ran."

> A gate the user declines is a successful run of this skill. Report what
> you proposed, what they declined, and leave the repository as it was.

## `apply` without `--yes` is itself a dry run

Every *script* step in this skill calls into `apply`, and `apply`'s own
default is to write nothing: without `--yes` it prints every proposal and a
diff of exactly what it would write. That means a gate for a script step
can always be demonstrated for real, by actually running the command, before
anything is written — there is no need to simulate what `apply` would do
when you can show its real dry-run output instead. Only pass `--yes` after
the user has seen that output and confirmed it.
