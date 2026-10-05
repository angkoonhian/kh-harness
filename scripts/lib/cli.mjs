// scripts/lib/cli.mjs
//
// Argument parsing and `--help` text for all three entry points.
//
// Whole-branch review, F10: three entry points, three argument conventions.
// `detect.mjs` and `apply.mjs` each carried their own identical copy of the
// flag/target split and the unknown-flag warning; `uninstall.mjs` — the ONE
// command that deletes files — had neither, so `uninstall --yes .` said
// "repository not found: --yes" and `uninstall . --yse` silently did nothing
// of what was asked. `detect.mjs`'s own comment explains why the warning
// exists ("A typo like `--verfiy` used to be a silent no-op"); that reasoning
// applies at least as much to the command that removes things.
//
// Whole-branch review, F5: and none of the three had a `--help`, while the
// only document written for a user said the tool "cannot yet apply
// anything". A user who cannot discover `--allow-dirty` exists reaches for
// `--yes` on a dirty tree and does not understand the refusal. The text
// lives here, next to the parser, because the flag names and the sentences
// describing them must move together — and the three sentences that are
// genuinely the same for every command (what the hooks execute, the exit
// codes, where the manifest is) are written ONCE below and shared, rather
// than copied into three help strings that would drift the way the parsers
// did.

/**
 * Splits argv into flags, the first non-flag argument, and any flag not in
 * `knownFlags`. `target` is `null` when none was given — each caller decides
 * whether that is a default (`detect`/`apply`: the current directory) or a
 * refusal (`uninstall`: there is no safe default for a command that
 * deletes).
 */
export function parseArgv(argv, knownFlags) {
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  return {
    flags,
    target: argv.find(a => !a.startsWith('--')) ?? null,
    unknown: [...flags].filter(f => !knownFlags.has(f)),
  };
}

/** The unknown-flag warning, on stderr — never stdout, which `--json`
 * callers parse. A warning, never a failure: the run continues. */
export function warnUnknown(unknown) {
  if (unknown.length) {
    process.stderr.write(`kh-harness: ignoring unknown flag(s): ${unknown.join(', ')}\n`);
  }
}

// --- The sentences every command shares -----------------------------------

/**
 * The disclosure the review found existed nowhere a user could read before
 * deciding to run the tool (F5). `stopgateProposal`'s own `reason` discloses
 * its cost honestly at proposal time, in a dry-run preview a user may skim,
 * and `sensorProposal`'s says only "no PostToolUse hook registered" — yet the
 * sensor fires far more often. The marginal risk kh-harness adds is not that
 * `npm run lint` is arbitrary code (it always was) but AUTOMATION: the user no
 * longer types it, and a `git pull` that changes `scripts.lint` changes what
 * now runs by itself.
 */
export const EXECUTION_DISCLOSURE = `WHAT THE HOOKS EXECUTE — read this before running \`apply\`
  Installing the two process hooks means THIS REPOSITORY'S OWN SCRIPTS ARE RUN
  AUTOMATICALLY, by Claude Code, without being asked each time:

    PostToolUse (per edit)  the owning package's \`lint\` script, on the one file
                            Claude just edited, bounded at 30s.
    Stop (per turn end)     the root package's \`typecheck\` script, or \`test\` if
                            there is no \`typecheck\`, over the WHOLE repository,
                            bounded at 120s. Cost scales with the size of the
                            repository, not the size of the edit — a large
                            codebase may see 10-30s added per turn.

  A repository's own lint/test script is arbitrary code in every project; what
  changes here is that you stop typing it. A \`git pull\` that edits
  \`scripts.lint\` therefore changes what runs by itself. \`uninstall\` reverses
  both hooks. Neither is installed unless its check reported \`absent\` and you
  ran \`apply --yes\`.

  The SessionStart hook only reads HANDOFF.md (or docs/HANDOFF.md) and prints
  the top of it. It executes nothing.`;

export const EXIT_CODES = `EXIT CODES
  0  did what it said
  2  could not act (bad path, unreadable settings, a write or removal failed)
  3  refused to act (default branch, dirty tree, corrupt manifest, no manifest)`;

export const MANIFEST_NOTE = `THE MANIFEST
  \`.claude/kh-harness.manifest.json\` records every file written and every
  settings patch applied, with a hash of what was written. It is what
  \`uninstall\` reads to know what is removable, and what \`apply\` reads to know
  what it must never re-write or overwrite. Deleting it makes this tool's own
  work permanently un-uninstallable; corrupting it makes \`apply\` refuse (3)
  rather than silently replace it.`;

export const DETECT_USAGE = `kh-harness detect — inventory a repository against the harness runbook

USAGE
  node scripts/detect.mjs <path-to-repo> [--verify] [--json]

Reports, per capability, one of: verified / declared / absent / failing / n/a,
with the evidence it actually read. Writes exactly one file into the target
repository, \`docs/harness/detect.json\`, and changes nothing else.

An \`absent\` capability carries either a \`→\` proposal (\`apply\` can write this)
or a question (detection could not decide, so it asks instead of guessing).
"Advice" is a third thing: a gap that is fully known but that this tool will
never write — it would mean editing your package manifest.

FLAGS
  --verify   Run the build, test, lint and typecheck commands it discovered,
             to turn claims into evidence. THIS EXECUTES THIS REPOSITORY'S OWN
             COMMANDS. There is no confirmation prompt: the flag is the
             consent. \`install\` is never run, because it mutates the tree.
  --json     Print the full report to stdout instead of the human summary.
             Unknown-flag warnings go to stderr, so stdout stays parseable.

${EXIT_CODES}`;

export const APPLY_USAGE = `kh-harness apply — write the files and settings \`detect\` proposed

USAGE
  node scripts/apply.mjs <path-to-repo> [--yes] [--allow-dirty] [--allow-default-branch]

THE DEFAULT IS A DRY RUN. Without --yes this prints every proposal and a diff
of exactly what it would write, and writes nothing. There is no --force; git
is the escape hatch.

Additive only, and structurally so: a write allowlist in code (not a settings
rule), filesystem containment checked before any write, and a file this tool
did not write is never overwritten. An existing \`CLAUDE.md\` is never touched —
a proposal for it is redirected to \`docs/harness/CLAUDE.proposed.md\` for you
to merge by hand.

FLAGS
  --yes                    Actually write. Without it, nothing is written.
  --allow-dirty            Proceed with uncommitted changes to tracked files.
                           The gate exists so you can \`git diff\` exactly what
                           this tool did. This tool's OWN prior writes are
                           already excused from it, per the manifest, so you
                           should not need this to re-run.
  --allow-default-branch   Proceed on \`main\`/\`master\`. Refused by default for
                           the same reason: a reviewable diff.

${EXECUTION_DISCLOSURE}

${MANIFEST_NOTE}

${EXIT_CODES}`;

export const UNINSTALL_USAGE = `kh-harness uninstall — remove what \`apply\` installed, and nothing else

USAGE
  node scripts/uninstall.mjs <path-to-repo> [--yes]

THE DEFAULT IS A DRY RUN. Without --yes this prints what it would remove,
revert and keep, and changes nothing.

Removes only what the manifest records, and only when the file on disk is
still byte-identical to what this tool wrote AND still carries its
\`Generated by kh-harness\` marker. A file you have edited is KEPT, and said
to be kept. Settings patches are reverted by content hash, never by position,
so a hook of your own added above ours is never the one removed. Empty
directories this tool itself created are removed; a directory that existed
beforehand never is.

FLAGS
  --yes   Actually remove. Without it, nothing is removed.

${EXIT_CODES}`;

/** True when the user asked for help. Accepted on every command, in the one
 * place that knows the spelling, so `-h` and `--help` cannot mean different
 * things in different commands. */
export function wantsHelp(argv) {
  return argv.includes('--help') || argv.includes('-h');
}
