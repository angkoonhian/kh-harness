# Intent

- last-reviewed: 2026-11-20

This is kh-harness's own intent document — the one every repository it
touches is asked to keep. It is the acceptance test for the shape: if the
kit's own purpose, success and failure could not be stated in these seven
sections, the sections would be wrong.

## Purpose

Bring an existing repository up to a working agent harness without
guessing. A harness runbook exists; executing it by hand produces a
different result every time and spends attention on the mechanical steps
that belong on the judgement steps. kh-harness runs the mechanical steps,
derives everything it writes from evidence in the repository, shows every
write before it happens, and stops at each step that needs a human.

If it works, a developer points it at any repository they already have and,
an hour later, has a harness they can read, diff, trust and remove.

Once installed, the harness can record its sessions on the owner's machine
and turn a failure that recurs across them into one small tool-call gate,
replayed against the record before it can affect a session, and promoted
by the kit's commands only from an interactive terminal outside Claude
Code or under a policy whose hash the ledger records.

## Users

A developer who owns a repository and uses Claude Code in it. They may have
no harness at all, a partial one, or a mature hand-built one; the kit must
be useful, and safe, in all three cases. The mature case is the one that
can falsify the design — a repository that already has everything must be
proposed nothing.

Not for: a greenfield project with no code yet (there is no scaffolder, by
design); a team wanting a readiness score or a maturity level; anyone
wanting the kit to decide frameworks, layouts or conventions for them.

## How it works

Five CLIs, two skills, no runtime. `detect` reads the repository and
writes one report (`docs/harness/detect.json`) naming each capability as
verified, declared, absent, failing or not applicable, with the evidence
it read. `apply` writes only what `detect` proposed, inside a write
allowlist enforced in code, and records every write in a manifest by
content hash. `uninstall` removes only what the manifest records, only
when the content still matches (line endings aside) and still carries the
generator's stamp, and never a file the user has written into. The
`harness-init` skill walks a human through the phases, gating every
judgement step.

`log` turns the session log on for one repository on one machine and
reports what it holds; the log lives outside the repository. `learn` runs
the learning loop: a model, through the `harness-learn` skill, drafts a
gate for a recurring failure the owner has named in
`docs/harness/FAILURES.md`, and `learn draft` refuses one the owner has not
named; the script replays it against the log and tries it silently; only
`learn approve` run at an interactive terminal outside Claude Code, or
`tick` under a policy whose hash the ledger records, promotes it, and only
`learn land --yes` at such a terminal lands it in the repository. The
terminal check is that standard input and output are both terminals and
`CLAUDECODE` is unset; it does not show that a person is present, and a
process running as the user can forge either check. The gate hook enforces
whatever the gate files hold.
Mechanics live in `scripts/` and are unit-tested; judgement lives in
`skills/` as prose the model reads. See `README.md` for the commands.

## Success

- A second run on an unchanged repository proposes nothing.
  Shown by: `scripts/lib/gap-model.test.mjs` "a fully harnessed repo
  yields zero proposals" and `scripts/lib/detect-cli.test.mjs` "a harnessed
  repo gets no proposals".
- Every write is reviewable as a diff before it lands, and `apply` without
  `--yes` writes nothing. Shown by: `scripts/lib/lifecycle.test.mjs`,
  every stage 2.
- Apply then uninstall leaves `git status` as it was, except for files the
  user edited and the two learned files while they hold a landed learning,
  which are listed, and `detect`'s own report, which uninstall says it
  leaves. Shown by: `scripts/lib/lifecycle.test.mjs`
  "apply then uninstall leaves git status clean".
- The kit passes its own checks: its own credential sweep, its own intent
  document, its own rules registry. Shown by: the DOGFOOD tests in
  `scripts/lib/detect-exposure.test.mjs` and
  `scripts/lib/dogfood-intent.test.mjs`.
- No `learn` command promotes a gate to warn or block unless it runs at an
  interactive terminal outside Claude Code, or under a policy whose hash
  the ledger records. Shown by:
  `scripts/lib/learn-promote.test.mjs` "approval is refused without an
  interactive terminal" and "a policy file written without a ledger
  record promotes nothing and tick says so".
- Running unattended, the loop writes nothing inside the repository.
  Shown by: `scripts/lib/learn-promote.test.mjs` "tick writes nothing
  inside the repository".
- Validation on real repositories modifies no existing file and proposes
  only genuinely absent capabilities. Recorded in `docs/validation/`.

## Failure

- A guessed step that is run and trusted — a bootstrap command, a lint
  command, a rule — written without evidence. Detected by:
  `scripts/lib/propose.test.mjs` and the eval grader
  `evals/greenfield-ts/graders/no-guessed-steps.md`.
- A check that reports more than it read: `verified` without execution,
  `no credentials` when a file was skipped unread. Detected by: the
  unreadable-file finding in `scripts/lib/detect-exposure.mjs`, and
  `scripts/lib/gap-model.test.mjs` "never reports verified".
- A hook that runs something the user did not knowingly accept, or whose
  output floods or leaks. Detected by: the execution disclosure in
  `scripts/lib/cli.mjs`, and the bounding and redaction tests in
  `scripts/lib/harness-redact.test.mjs`.
- A security check that normalises to noise — red on every real repository
  for reasons nobody acts on. Partly addressed: a credential-shaped key
  whose value is a code reference is collapsed into one count, and a
  literal in a test or fixture path is listed at severity `low` and does
  not fail the check. Detected by: `scripts/lib/detect-exposure.test.mjs`
  and the three real detect reports recorded in
  `docs/2026-11-02-landscape-gap-analysis.md`. Compose, CI and planning
  documents are not classified; see Open questions.
- Deleting a user's work on uninstall. Detected by: the forged-manifest
  tests in `scripts/lib/uninstall-lib.test.mjs`.
- A log that keeps a credential, or a learning that acts on an agent's own
  claim. Detected by: `scripts/lib/harness-log.test.mjs` and
  `scripts/lib/session-log.test.mjs` "the agent's own account of its work
  is never logged". The scrub is best-effort, so this failure is reduced,
  not ruled out.
- A learned gate that blocks correct work unseen, or that the owner cannot
  trace to evidence or remove alone. Detected by: the replay in
  `scripts/lib/replay.test.mjs`, the firing counts in
  `scripts/lib/log-report.test.mjs`, and revert in
  `scripts/lib/learn-land.test.mjs`.

## Non-goals

- No scaffolder and no greenfield mode.
- No runtime: no daemon, no server, no listener, no network at run time.
- No opinions about frameworks, databases, directory layouts or
  conventions. Profiles are detection adapters and command vocabularies,
  nothing more.
- No credential remediation. Location and type are reported; a human
  rotates.
- No `--force`, no ignore list, no readiness score.
- The kit's scripts never author a rule, an invariant, a purpose statement
  or an architecture description; they scaffold shapes and parse content.
  A learning is drafted by the model, validated by the script against the
  record, and is moved past `observe` by the kit's commands only through
  an approval at an interactive terminal outside Claude Code or a policy
  whose hash the ledger records.
- No claim that the agent or the harness improved. The loop reports
  counts: recurrences, replays, firings and what followed them.

## Open questions

- `P0.security` still reports `failing` on repositories whose findings
  sit in compose files, CI configuration or planning documents. Only test
  and fixture paths are classified by role (gap analysis, finding F1);
  whether to classify more roles without an ignore list is undecided.
- Only TypeScript, JavaScript and Python have profiles. Every other stack
  falls to `generic`, which disables the stack-specific checks.
- The eval suite cannot engage `harness-init` (`disable-model-invocation`
  keeps it out of the model's context), so there is no measured delta for
  it.
- Whether `detect --verify` should run `enforced-by: test` commands from
  the rules registry and upgrade `P3.rules` to `verified`.
- Whether a recurrence threshold of two sessions separates harness defects
  from model limitations. No source validates it, and no study reports the
  precision of checks generated from agent mistakes.
