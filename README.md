# harness-kit

Inventories an existing repository against the harness runbook, proposes only
what is missing, and — if you say so — writes it. Additive by design: it never
overwrites, never deletes a file you authored, and never rewrites one it did
not write itself.

Two rules it holds itself to, and which the rest of this document is mostly
about keeping honest:

- **Write only what detection proved.** A bootstrap script with guessed steps
  is worse than none, because it will be run and trusted.
- **Report only what is true.** Every state it prints says what was *looked
  for*, not what *is*. A check that could not decide asks a question instead
  of proposing something.

Zero runtime dependencies. Node 22+. Nothing is sent anywhere.

## The three commands

    node scripts/detect.mjs    <path-to-repo> [--verify] [--json]
    node scripts/apply.mjs     <path-to-repo> [--yes] [--allow-dirty] [--allow-default-branch]
    node scripts/uninstall.mjs <path-to-repo> [--yes]

Each takes `--help` for its full contract. `apply` and `uninstall` **default to
a dry run**: without `--yes` they print exactly what they would do, and do
nothing.

A normal first pass:

    node scripts/detect.mjs .        # read the report
    node scripts/apply.mjs .         # read the diffs — nothing is written
    node scripts/apply.mjs . --yes   # write them
    git diff                         # this is the point of the branch gates below

### `detect`

Reports every capability as one of `verified` / `declared` / `absent` /
`failing` / `n/a`, with the evidence it read. Writes exactly one file into the
target repository, `docs/harness/detect.json`, and changes nothing else.

An `absent` capability carries either a `→` **proposal** (`apply` can write
this) or a **question** (detection could not decide, so it asks rather than
guesses). **Advice** is a third thing: a gap that is fully known but that this
tool will never write, because closing it means editing your package manifest
— the file most likely to be hand-tuned, and the one this tool must not touch.

| Flag | What it does |
|---|---|
| `--verify` | Runs the build, test, lint and typecheck commands it discovered, to turn claims into evidence. **This executes this repository's own commands.** There is no confirmation prompt: the flag is the consent. `install` is never run, because it mutates the tree. |
| `--json` | Prints the full report to stdout instead of the human summary. Warnings go to stderr, so stdout stays parseable. |

`P0.security` scans tracked files, git remote URLs and the two `.claude`
settings files for credential shapes. It never prints a value, only a location.
A file it could **not read** is reported as a finding of its own and the check
cannot say `verified` while one exists — a sweep that skipped a file in silence
is the one failure this check must never have.

**This repository passes its own check.** `node scripts/detect.mjs .` reports
`P0.security verified` on harness-kit itself, and a test (`DOGFOOD:
harness-kit passes its own P0.security check`) fails if that ever stops being
true. It is worth stating because it was not always so: the detector's own
test fixtures used to be committed as credential-shaped literals, so the tool
failed on itself, and "it always says failing here" is exactly how a real
finding gets normalised into noise. The fix was to assemble those fixtures at
runtime, not to add a suppression mechanism — there is no ignore list, and
there will not be one, because an exclusion that silences the check on this
repository silences it on yours too.

### `apply`

Writes the files and settings patches `detect` proposed. Nothing else, ever:

- A **write allowlist in code** (not a permission rule in `settings.json`,
  which would appear to work and silently would not) bounds every path.
- **Filesystem containment** is checked before any write, so a symlink or
  junction cannot route a write out of the repository.
- A file this tool did not write is **never overwritten**. An existing
  `CLAUDE.md` is never touched at all — a proposal for it is redirected to
  `docs/harness/CLAUDE.proposed.md` for you to merge by hand.
- A file you have since **edited** is left alone and reported as `kept`.
- There is **no `--force`**. Not a flag, not an option, not a code path. git is
  the escape hatch, which is what the two refusals below exist to protect.

| Flag | What it waives |
|---|---|
| `--yes` | Nothing — this is what makes it write at all. Without it you get proposals and diffs. |
| `--allow-dirty` | The refusal to run with uncommitted changes to tracked files. That gate exists so you can `git diff` exactly what this tool did. This tool's own prior writes are already excused from it, via the manifest, so re-running should not need this. |
| `--allow-default-branch` | The refusal to run on `main` or `master`, for the same reason. |

### `uninstall`

Removes what `apply` installed, and nothing else. A path is removed only when
the manifest records it, the bytes on disk still match what was written, **and**
the content still carries the `Generated by harness-kit` marker. Anything else
is kept, and said to be kept, with the reason.

Settings patches are reverted by content hash, never by position, so a hook of
your own added above ours is never the one removed. Empty directories this tool
itself created are removed; a directory that existed beforehand never is.

| Flag | What it does |
|---|---|
| `--yes` | Actually remove. Without it, nothing is removed. |

## What installing the hooks means — read this before `apply`

`apply` can install three Claude Code hooks. Two of them cause **this
repository's own scripts to be executed automatically**, by Claude Code,
without being asked each time:

| Hook | When | What it runs |
|---|---|---|
| `PostToolUse` | after each `Write`/`Edit` | the **owning package's `lint` script**, on the one file just edited, bounded at 30s |
| `Stop` | at the end of each turn | the **root package's `typecheck` script**, or `test` if there is no `typecheck`, over the **whole repository**, bounded at 120s |
| `SessionStart` | at session start | nothing — it reads `HANDOFF.md` (or `docs/HANDOFF.md`) and prints the top of it |

A repository's own lint or test script is arbitrary code in every project; that
is not new. What changes is **automation**: you stop typing it, and a `git pull`
that edits `scripts.lint` therefore changes what now runs by itself.

The `Stop` gate's cost scales with the size of the **repository**, not the size
of the edit. On a large codebase expect 10–30s added per turn. If that is the
wrong trade for you, do not install it — or `uninstall` it, which reverts both
hooks and removes both scripts.

Neither hook is installed unless its check reported `absent` **and** you ran
`apply --yes`. Both hooks' output is bounded and passes a two-layer credential
filter before any of it reaches the model.

## The manifest

`.claude/harness-kit.manifest.json` records every file written and every
settings patch applied, with a hash of what was written. It is what `uninstall`
reads to know what is removable, and what `apply` reads to know what it must
never re-write or overwrite.

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
| `2` | could not act (bad path, unreadable settings, a write or removal failed) |
| `3` | refused to act (default branch, dirty tree, corrupt manifest, no manifest) |

Nothing else. A crash is a bug, not a contract.

## What it leaves in your repository

- `docs/harness/detect.json` — written by every `detect` run, including runs
  pointed at this repository itself. It is **not** removed by `uninstall`
  (it is a report, not an installation), so a `?? docs/harness/` in
  `git status` after exercising the tool is expected.
- Whatever `apply --yes` wrote, each entry listed in the manifest.

## Development

    npm test
