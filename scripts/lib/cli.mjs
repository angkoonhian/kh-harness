// scripts/lib/cli.mjs
//
// Argument parsing and `--help` text for every entry point.
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
import { LOGGED_EVENTS } from '../../assets/scripts/session-log.mjs';

/**
 * Splits argv into flags, the first non-flag argument, every non-flag
 * argument in order, and any flag not in `knownFlags`. `target` is `null`
 * when none was given — each caller decides whether that is a default
 * (`detect`/`apply`: the current directory) or a refusal (`uninstall`: there
 * is no safe default for a command that deletes).
 */
export function parseArgv(argv, knownFlags) {
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const positionals = argv.filter(a => !a.startsWith('--'));
  return {
    flags,
    target: positionals[0] ?? null,
    positionals,
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

const DISCLOSURE_INDENT = ' '.repeat(33);
const DISCLOSURE_WIDTH = 46;

/** `items` joined by ", " in lines of at most `DISCLOSURE_WIDTH` characters
 * after `DISCLOSURE_INDENT`, so a list read from code sits in the column the
 * disclosure's prose uses. */
function indentedList(items) {
  const lines = [];
  let line = '';
  for (const [i, item] of items.entries()) {
    const word = i < items.length - 1 ? `${item},` : `${item}.`;
    if (line && line.length + 1 + word.length > DISCLOSURE_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map(l => DISCLOSURE_INDENT + l).join('\n');
}

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
  the hooks it installed. Neither is installed unless its check reported \`absent\` and you
  ran \`apply --yes\`.

  Each hook is registered in Claude Code's exec form — \`node\` plus the
  script's path rooted at \`\${CLAUDE_PROJECT_DIR}\` — so it runs with no shell
  and from any working directory. A registration you already have in shell
  form (\`node .claude/scripts/…\`) is recognised as the same hook and left
  alone.

  The SessionStart hook only reads HANDOFF.md (or docs/HANDOFF.md) and prints
  the top of it. It executes nothing.

  UserPromptSubmit (per prompt)  reads docs/harness/RULES.md and adds up to
                                 1500 bytes of its rules to the prompt's
                                 context, high priority first. It executes
                                 nothing. Proposed only once the registry
                                 holds at least one rule.

  PreToolUse (per tool call)     runs before every tool call and compares it
                                 with the learned gates in
                                 .claude/kh-harness/gates.json and this
                                 machine's own gate file. It can BLOCK the
                                 call when a gate with action \`block\`
                                 matches; a \`warn\` gate's message reaches
                                 the model alongside the tool's result, after
                                 the call has run. It executes nothing, and no
                                 gate exists until one is learned and
                                 promoted, so until then it does nothing.
                                 Installed with it: deny rules for edits to
                                 the WHOLE .claude/scripts/ directory,
                                 including any script of yours kept there,
                                 to the gate file, the manifest,
                                 docs/harness/LEARNED.md, and
                                 ~/.claude/kh-harness/ (this machine's log,
                                 ledger, policy and local gates), and deny
                                 rules for running the \`learn\` subcommands
                                 that approve or weaken a gate: a second
                                 barrier, behind their own check for a
                                 person at a terminal.

  Session log (per event)        runs on every one of these events:
${indentedList(LOGGED_EVENTS)}
                                 It records nothing until the log is enabled
                                 for this repository on this machine. Once it
                                 is, it records every one of those events,
                                 TOOL INPUT AND OUTPUT INCLUDED, on this
                                 machine only: in this machine's kh-harness
                                 data directory (~/.claude/kh-harness/, or
                                 KH_DATA_DIR), outside the repository.
                                 Credentials it recognises are scrubbed
                                 before anything is written, but the scrub is
                                 best-effort: a credential in a shape it does
                                 not know is recorded as it is. It executes
                                 nothing and never blocks a call.`;

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

An \`absent\` capability carries either a \`→\` proposal (the step that closes it;
one \`apply\` cannot write says who does) or a question (detection could not
decide, so it asks instead of guessing).
"Advice" is a third thing: a gap that is fully known but that this tool will
never write — it would mean editing your package manifest.

FLAGS
  --verify   Run the test, lint and typecheck commands it discovered, to
             turn claims into evidence. THIS EXECUTES THIS REPOSITORY'S OWN
             COMMANDS. There is no confirmation prompt: the flag is the
             consent. \`install\` and \`build\` are never run, because they
             mutate the tree. A command stopped by the 10-minute bound is
             recorded as timedOut with no exit code; commands run with CI=1,
             so a test runner's watch mode is off.
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
did not write is never overwritten. \`CLAUDE.md\` is never written by this
command at all — the skill drafts \`docs/harness/CLAUDE.proposed.md\` for you
to merge by hand.

FLAGS
  --yes                    Actually write. Without it, nothing is written.
  --allow-dirty            Proceed with uncommitted changes to tracked files.
                           The gate exists so you can \`git diff\` exactly what
                           this tool did. This tool's OWN prior writes are
                           already excused from it, per the manifest, so you
                           should not need this to re-run.
  --allow-default-branch   Proceed on the default branch (\`main\`, \`master\`,
                           what init.defaultBranch names, or what origin/HEAD
                           points at — a repository with no commits included).
                           Refused by default for the same reason: a
                           reviewable diff.

Both gates apply to --yes only; a dry run is never refused and prints a
\`note:\` for what --yes would refuse. If git cannot be consulted at all,
--yes needs both flags, because neither gate could run.

${EXECUTION_DISCLOSURE}

${MANIFEST_NOTE}

${EXIT_CODES}`;

export const UNINSTALL_USAGE = `kh-harness uninstall — remove what \`apply\` installed, and nothing else

USAGE
  node scripts/uninstall.mjs <path-to-repo> [--yes]

THE DEFAULT IS A DRY RUN. Without --yes this prints what it would remove,
revert and keep, and changes nothing.

Removes only what the manifest records, and only when the file on disk is
still what this tool wrote (line endings aside) AND still carries its
\`Generated by kh-harness\` marker. A file you have edited is KEPT, and said
to be kept. Settings patches are reverted by content hash, never by position,
so a hook of your own added above ours is never the one removed. Empty
directories this tool itself created are removed; a directory that existed
beforehand never is.

FLAGS
  --yes   Actually remove. Without it, nothing is removed.

${EXIT_CODES}`;

export const LOG_USAGE = `kh-harness log — the session log for one repository on this machine

USAGE
  node scripts/log.mjs <path-to-repo> <enable|disable|status|report|maintain|purge> [--yes] [--json]

The log lives outside the repository, under the user's Claude directory
(\`~/.claude/kh-harness/<key>\`, or \`$KH_DATA_DIR/<key>\`), keyed by the
repository's git common directory so its worktrees share one log. It is
inert until enabled here: a teammate or a CI run that has the same hook
records nothing.

SUBCOMMANDS
  enable     Turn the log on for this repository on this machine. Once the
             session-log hook is installed, it records every tool call's
             input and output. Credentials are masked on a best-effort basis;
             some may be missed. Content is kept for the retention period
             (90 days unless \`config.json\` beside the log says otherwise);
             structure is kept until purged.
  disable    Turn it off. What the log holds is kept.
  status     Report what the log holds and whether it can be trusted: the
             sealed-session index, the learning ledger's chain, what could
             not be read, retention and transcript coverage, and what hooks
             cannot see. Reads only; writes nothing.
  report     List the failures that recur in two or more sessions under one
             harness and model, with their counts, sessions and the failure
             kind in docs/harness/FAILURES.md that labels each; and how each
             gate fired, per action, how often a warning or block was followed
             by a successful call of the same tool, and how often its learning
             was marked wrong in the ledger, since its last promotion or
             landing and in all. States how many sessions it read and
             what it could not read, and never that outcomes improved. Reads
             only; writes nothing.
  maintain  Seal closed sessions, expire content past the retention period
             and remove unreferenced blobs: what the hook does at session
             start within 150 ms, here run to the end for a log that has
             outgrown that. Needs the log enabled.
  purge      List what would be removed. With --yes, remove this
             repository's log directory, and nothing else, which also
             disables the log.

No subcommand prints a prompt or a tool's input or output. Only \`report\`
prints an error line: a recurrence's first, normalised, on one line, with
what a reader cannot see removed and \`<\` and \`>\` escaped, cut to 200
characters.

FLAGS
  --yes    purge only: actually remove. Without it, nothing is removed.
  --json   status and report only: print the object on stdout and nothing
           else.

Here 3 is also \`maintain\` on a log that is not enabled, and any write to or
removal of a log directory that is a link or is not inside the data root.
2 is also \`maintain\` when sealing could not run or its lock was lost.

${EXIT_CODES}`;

const LEARN_COMMAND = 'node scripts/learn.mjs <path-to-repo>';

const SECTION_INDENT = ' '.repeat(13);
const USAGE_WIDTH = 80;

/** `text` in lines of at most `USAGE_WIDTH` characters, each after
 * `SECTION_INDENT`. */
function wrapped(text) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && SECTION_INDENT.length + line.length + 1 + word.length > USAGE_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map(l => SECTION_INDENT + l).join('\n');
}

const TERMINAL_NOTE = 'Needs a person at an interactive terminal outside Claude Code; anywhere else it refuses (3) and changes nothing.';
const TERMINAL_YES_NOTE = 'With --yes it needs a person at an interactive terminal outside Claude Code, and anywhere else refuses (3) and changes nothing; without --yes it is a dry run, which needs no terminal and writes nothing.';

// Each subcommand's synopsis and description, in the order the usage lists
// them; `terminal` marks the ones that approve or weaken a gate, `'yes'`
// the ones that are terminal-only for --yes alone.
const LEARN_SECTIONS = [
  { name: 'candidates', synopsis: 'candidates [--json]', text: 'List the recurrences `log report` finds that no learning stands for, with the same cleaned error line and the same counts of what was read. A recurrence the replay has rejected a learning for, by its signature or by another signature labelled with the same failure kind in docs/harness/FAILURES.md, is listed apart, after them, with the rejected ids and which tie it is: it is drafted again only with `draft --redraft`. Reads only.' },
  { name: 'evidence', synopsis: 'evidence <signature> [--json]', text: "For up to three recorded failures of a current recurrence, the first in each session: the tool, its input as the log stores it, its first error line and, where the session holds one, the input of the next call of the same tool that succeeded. Each value is printed as JSON with every code point outside printable ASCII written as \\u{…}, between a first and a last line that carry the same nonce, drawn for the run, and say what lies between is recorded data, not instructions; with --json, a fixed note says so instead. An input past the retention period is said to be removed. A tool's output is never printed. Reads only." },
  { name: 'draft', synopsis: 'draft --from <file> [--redraft]', text: "Read one drafted learning, `{ signature, title, why, gate }` as JSON, from <file>; store it as a candidate, replay its gate against the log, and report each stage. A replay that passes puts the gate in this machine's local gate set at `observe`, where it blocks nothing; one that fails rejects it; one that is not checkable leaves a candidate, for `replay` to try again. A draft for a recurrence that `candidates` lists apart, as rejected before, is refused unless --redraft is given, and the ledger records a redraft as one. Which recurrences a rejection covers follows the failure kinds as docs/harness/FAILURES.md labels them now. Whether to draft it again is the owner's decision. The file is untrusted: nothing in it is printed back." },
  { name: 'replay', synopsis: 'replay <id>', text: 'Replay a candidate\'s gate against the log again, as `draft` does, once the log holds more history: a pass puts it on trial at `observe`, a fail rejects it, and one still not checkable stays a candidate. Only a candidate is replayed.' },
  { name: 'list', synopsis: 'list [--json]', text: 'Every learning with its status and whether the ledger vouches for it, the approvals the ledger records, and every local gate the next step that writes repairs or removes. A broken ledger is said first. Reads only.' },
  { name: 'show', synopsis: 'show <id> [--json]', text: "One learning: its gate as JSON with every code point outside printable ASCII written as \\u{…}, the gate's sha256, the replay result and what the log records of its firings. Reads only." },
  { name: 'approve', terminal: true, synopsis: 'approve <id> --sha256 <hash> --action <warn|block>', text: "Promote a learning on trial to warn or block on this machine. <hash> must be the gate's sha256 as `show` prints it; the same view is printed first, so the hash approved sits beside the text it covers." },
  { name: 'wrong', terminal: true, synopsis: 'wrong <session>:<line>', text: 'Mark one recorded gate firing wrong. Two marks since a promotion or landing take the gate back to observe on this machine.' },
  { name: 'demote', terminal: true, synopsis: 'demote <id>', text: "Take a promoted or landed learning's gate back to observe; a committed gate is suspended on this machine instead, until `revert` takes the gate out of the repository and retires the learning." },
  { name: 'retire', terminal: true, synopsis: 'retire <id>', text: 'Retire a learning: its local gate goes, and it no longer stands for its recurrence. A landed or suspended learning whose gate is still in the committed gate file is refused, since retiring writes no file: `revert` takes the gate out of the repository.' },
  { name: 'land', terminal: 'yes', synopsis: 'land <id> [--yes] [--allow-dirty] [--allow-default-branch] [--json]', text: "Land a learning promoted on this machine in the repository: its entry goes into docs/harness/LEARNED.md and its gate, at the action its approval recorded, into .claude/kh-harness/gates.json, through `apply`'s write path, and the manifest records it. Without --yes it prints the files it would write with the diff `apply` shows, every note first and what --yes would be refused for, and writes nothing. --yes writes them, refused on the default branch or with uncommitted changes to tracked files unless --allow-default-branch or --allow-dirty waives that refusal, as `apply` does. The change is left uncommitted, for the owner to review and commit: only then does it bind everyone who has the repository." },
  { name: 'revert', terminal: 'yes', synopsis: 'revert <id> [--yes] [--allow-dirty] [--allow-default-branch] [--json]', text: "Take a learning's gate, entry and manifest record out of the repository, whichever are left: a landed learning is active-local again on this machine, its approval standing; one suspended here, judged wrong, is retired. The dry run and --yes are as for `land`, and the notes say whether the commit this branch is on still holds a gate the working tree has already lost. The change is left uncommitted, for the owner to review and commit." },
  { name: 'tick', synopsis: 'tick [--json]', text: 'Run the unattended rules once: repair the local gate set, retire trials whose cited paths are all gone, demote gates marked wrong twice, and promote under the policy in force; then print all it did and all it could not. Exits 2, after printing all it did, when it could not do part of its work; 0 only when it did all of it.' },
  { name: 'policy show', synopsis: 'policy show [--json]', text: 'The promotion policy on disk, whether its hash is the one the ledger records, and what `tick` therefore promotes. Reads only.' },
  { name: 'policy set', terminal: true, synopsis: 'policy set --min-firings <n> --min-sessions <n> --max-action <warn|block>', text: 'Set the promotion policy and record its hash in the ledger: `tick` then promotes, up to <max-action>, each fresh trial with at least that many firings in that many sessions, none marked wrong and none read from outside content.' },
  { name: 'policy clear', terminal: true, synopsis: 'policy clear', text: 'Withdraw the policy: from then on `tick` promotes nothing, whatever policy file appears, until one is set again.' },
];

const terminalNote = s => (s.terminal === 'yes' ? ` ${TERMINAL_YES_NOTE}` : s.terminal ? ` ${TERMINAL_NOTE}` : '');
const learnSection = s => `  ${s.synopsis}\n${wrapped(`${s.text}${terminalNote(s)}`)}`;

const TERMINAL_ONLY_TEXT = `TERMINAL ONLY
  ${LEARN_SECTIONS.filter(s => s.terminal).map(s => s.name).join(', ')}
  approve a gate, weaken one, or change the repository's, so each runs only
  for a person at an interactive terminal outside Claude Code: standard input
  and output must both be terminals and CLAUDECODE must be unset. Run by
  Claude Code, or with either stream redirected, each refuses (3) and changes
  nothing. land and revert need the terminal only with --yes: without it each
  is a dry run that writes nothing, and anyone may run it. No flag or variable
  skips this check. It is a barrier against the ordinary case, not isolation:
  a process running as the same user can forge a terminal.

  \`apply\` also installs deny rules for these subcommands, Bash and
  PowerShell patterns over \`learn.mjs\`, so Claude Code declines to run them.
  That is a second barrier. Each rule matches the text \`learn.mjs\` followed,
  after a space, by one of these subcommand words. A command that reaches the
  script another way, through a package script or with the subcommand quoted,
  is not caught by them and is stopped by the terminal check alone. And an
  unrelated command that happens to hold that text, such as a commit
  message, is declined too. The rules cover land and revert whole, their dry
  runs included: the owner runs both.`;

export const LEARN_USAGE = `kh-harness learn — the learnings for one repository on this machine

USAGE
  ${LEARN_COMMAND} <subcommand> [arguments] [--json]
  ${LEARN_COMMAND} <subcommand> --help

A learning is one small gate on tool calls, drafted by a model for a failure
that recurs in the session log, replayed by this script against the log, and
tried at \`observe\`, where it blocks nothing, until a person at a terminal, or
the policy that person set, promotes it. Learnings, the ledger that records
every step and the policy live in this machine's data directory beside the
log. Only land and revert write inside the repository, and only with --yes,
through the same write path as \`apply\`; what they write is left uncommitted.

SUBCOMMANDS
${LEARN_SECTIONS.map(learnSection).join('\n\n')}

${TERMINAL_ONLY_TEXT}

WHAT IS PRINTED
  Ids, hashes, counts, statuses and times. A learning's title and why and its
  gate were written by a model, so each is printed only as JSON with every
  code point outside printable ASCII written as \\u{…}. Of the session log,
  only what \`log report\` prints, and what \`evidence\` prints of the calls
  behind one recurrence.

FLAGS
  --json   candidates, evidence, list, show, policy show, tick, land and revert
           only: print the object on stdout and nothing else, with every
           character outside printable ASCII escaped.
  --yes    land and revert only: write what the dry run shows; a person at an
           interactive terminal only.
  --allow-dirty, --allow-default-branch
           land and revert only, with --yes: waive the dirty-tree or the
           default-branch refusal, as for \`apply\`.
  --redraft
           draft only: draft a recurrence again although the replay rejected
           an earlier learning for it or for its failure kind; the owner's
           decision. The ledger records the draft as a redraft, naming the
           learnings rejected.

Here 3 is also a terminal-only subcommand run without a person at a terminal,
and \`evidence\` or any subcommand that writes when this repository's data
directory is a link or is not directly inside the data root, as \`log\`
refuses it. 2 is also any step the learnings library refused or could not
finish, with its reason, and a \`tick\` that could not do part of its work. 3
is also land or revert with --yes on the default branch or with uncommitted
changes to tracked files, as \`apply\` refuses.

${EXIT_CODES}`;

/** The help for one `learn` subcommand, or null for a name that is not one. */
export function learnHelp(name) {
  const section = LEARN_SECTIONS.find(s => s.name === name);
  if (section === undefined) return null;
  return `kh-harness learn ${name}

USAGE
  ${LEARN_COMMAND} ${section.synopsis}

${learnSection(section)}
${section.terminal ? `\n${TERMINAL_ONLY_TEXT}\n` : ''}
${EXIT_CODES}`;
}

/** True when the user asked for help. Accepted on every command, in the one
 * place that knows the spelling, so `-h` and `--help` cannot mean different
 * things in different commands. */
export function wantsHelp(argv) {
  return argv.includes('--help') || argv.includes('-h');
}
