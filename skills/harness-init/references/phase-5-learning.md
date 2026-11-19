# Phase 5 — the session log and learned gates

Four runbook steps. Steps 29, 30 and 31 are *script* (the CLI derives and
writes them); step 32 is *advise* — `detect` reports it and nothing is
ever written for it. This phase installs the machinery only: no learning
exists after it, and the loop that drafts learnings is the separate
`harness-learn` skill, run later on a log that holds sessions. Read
[references/gates.md](gates.md) before presenting the gate at the end.

## Read this before presenting the gate

Say both of these plainly, before the gate:

- **The session log records tool input and output.** Once the owner runs
  `log enable` for this repository on this machine, the logging hook
  records every logged event, the full input and output of each tool call
  included, in this machine's data directory (`~/.claude/kh-harness/`, or
  `KH_DATA_DIR`), outside the repository. Credentials it recognises are
  scrubbed before anything is written, and the scrub is best-effort: a
  credential in a shape it does not know is stored as it is. Until the log
  is enabled, the hook records nothing.
- **The gate hook can block a tool call.** It runs before every tool call
  and applies the learned gates. None exists until one is learned and
  promoted, so until then it does nothing.

*Verified against `scripts/lib/cli.mjs`'s `EXECUTION_DISCLOSURE`, which
`apply` prints in its dry run whenever a hook is proposed — read it there
rather than a second copy here.*

## Step 29 — the failure taxonomy

*Script.* *Verified against `scripts/lib/gap-model.mjs`'s `P5.failures`
and `propose.mjs`'s `failuresScaffoldProposal`:* applies under every
profile. Scaffolds `docs/harness/FAILURES.md` empty — every example sits
inside one HTML comment. The owner names each kind of recurring failure
there, with the recurrence signatures it covers; the kit parses the file
and never writes a label. `detect` reports it `declared`, with counts only,
and never `verified`, because labels are a person's judgement. A
filled-in taxonomy is kept on uninstall.

## Step 30 — the gate hook

*Script.* *Verified against `gap-model.mjs`'s `P5.toolgate`, `propose.mjs`'s
`toolGateProposal` and `toolGateDenyRules`, and
`assets/scripts/tool-gate.mjs`'s header comment:* applies under every
profile. Installs `.claude/scripts/tool-gate.mjs` with the modules it
imports (`harness-gates.mjs`, `harness-log.mjs`, `harness-redact.mjs`) and a
`PreToolUse` hook with no matcher. The gates are data in
`.claude/kh-harness/gates.json` (committed) and this machine's own gate
file; the hook interprets them and builds no code from them. A `block`
gate denies the call with its message; a `warn` gate's message reaches
Claude after the call has run; an `observe` gate only records a firing,
and only while the log is enabled.

It is installed with deny rules: edits to the whole `.claude/scripts/`
directory (including any script of the owner's kept there),
`.claude/kh-harness/`, the manifest, `docs/harness/LEARNED.md` and
`~/.claude/kh-harness/`, and running the `learn` subcommands that approve
or weaken a gate. The step is `declared` only when the hook and every one
of these rules are present; an existing install missing some is proposed
exactly those.

## Step 31 — the session log hook

*Script.* *Verified against `gap-model.mjs`'s `P5.sessionlog`,
`propose.mjs`'s `sessionLogProposal` and `assets/scripts/session-log.mjs`'s
header comment:* applies under every profile. Installs
`.claude/scripts/session-log.mjs` with the modules it imports
(`harness-log.mjs`, `harness-seal.mjs`, `harness-redact.mjs`) and registers
it on every event in its `LOGGED_EVENTS` list, with no matcher. An install
missing some events is proposed only those. The hook never blocks, never
writes to stderr, spawns no process, and with the log disabled reads only
the event name and the session id. Whether the log is enabled is machine
state, so `detect` never reads it: the step is `declared`, never
`verified`. Never enable the log on the owner's behalf; `log enable` is
theirs to run.

## Step 32 — the integrity check

*Advise.* *Verified against `gap-model.mjs`'s `P5.integrity` and
`scripts/lib/integrity-evidence.mjs`:* `failing` when a harness file the
manifest records under `.claude/scripts/` (or the gate file or the learned
registry, when recorded) is modified or missing, when a committed gate has
no `docs/harness/LEARNED.md` entry approving its hash, when the gate file
holds entries the gate language rejects, or when a landed learning has no
gate behind it; `declared` otherwise; `n/a` with no manifest. It reads only
the repository and proposes nothing: restoring a file or approving a gate
is the owner's decision. Report each failing line as `detect` printed it.

## The gate

Show the dry run, name every file and settings patch by path, and wait —
see [references/gates.md](gates.md). **If the user declines, nothing is
written**: `apply` without `--yes` is itself a dry run. Report what was
proposed and that it was declined, and stop. Accepting installs no
learning and enables no log; tell the user that `log enable`, and later the
`harness-learn` skill, are the next steps, and that both are theirs to
start.
