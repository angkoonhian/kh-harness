# Intent

- last-reviewed: 2026-11-02

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

Three CLIs, one skill, no runtime. `detect` reads the repository and
writes one report (`docs/harness/detect.json`) naming each capability as
verified, declared, absent, failing or not applicable, with the evidence
it read. `apply` writes only what `detect` proposed, inside a write
allowlist enforced in code, and records every write in a manifest by
content hash. `uninstall` removes only what the manifest records, only
when the content still matches (line endings aside) and still carries the generator's stamp, and
never a file the user has written into. The `harness-init` skill walks a
human through the phases, gating every judgement step. Mechanics live in
`scripts/` and are unit-tested; judgement lives in `skills/` as prose the
model reads. See `docs/ARCHITECTURE.md` for the module layout and
`README.md` for the commands.

## Success

- A second run on an unchanged repository proposes nothing.
  Shown by: `gap-model.test.mjs` "a fully harnessed repo yields zero
  proposals" and `detect-cli.test.mjs` "a harnessed repo gets no proposals".
- Every write is reviewable as a diff before it lands, and `apply` without
  `--yes` writes nothing. Shown by: `lifecycle.test.mjs`, every stage 2.
- Apply then uninstall leaves `git status` as it was, except for files the
  user edited, which are listed. Shown by: `lifecycle.test.mjs` "a complete
  apply-then-uninstall cycle leaves git status clean".
- The kit passes its own checks: its own credential sweep, its own intent
  document, its own rules registry. Shown by: the DOGFOOD tests in
  `detect-exposure.test.mjs` and `dogfood-intent.test.mjs`.
- Validation on real repositories modifies no existing file and proposes
  only genuinely absent capabilities. Recorded in `docs/validation/`.

## Failure

- A guessed step that is run and trusted — a bootstrap command, a lint
  command, a rule — written without evidence. Detected by: the "no guessed
  steps" discipline in `propose.test.mjs` and the eval grader of the same
  name.
- A check that reports more than it read: `verified` without execution,
  `no credentials` when a file was skipped unread. Detected by: the
  unreadable-file finding in `detect-exposure.mjs`, and "never reports
  verified" in `gap-model.test.mjs`.
- A hook that runs something the user did not knowingly accept, or whose
  output floods or leaks. Detected by: the execution disclosure in
  `cli.mjs`, and the bounding and redaction tests in
  `harness-redact.test.mjs`.
- A security check that normalises to noise — red on every real repository
  for reasons nobody acts on. Detected by: the three real detect reports
  recorded in `docs/2026-11-02-landscape-gap-analysis.md`. Not yet fixed;
  see Open questions.
- Deleting a user's work on uninstall. Detected by: the forged-manifest
  tests in `uninstall-lib.test.mjs`.

## Non-goals

- No scaffolder and no greenfield mode.
- No runtime: no daemon, no server, no listener, no network at run time.
- No opinions about frameworks, databases, directory layouts or
  conventions. Profiles are detection adapters and command vocabularies,
  nothing more.
- No credential remediation. Location and type are reported; a human
  rotates.
- No `--force`, no ignore list, no readiness score.
- The kit never writes a rule, an invariant, a purpose statement or an
  architecture description. It scaffolds shapes and parses content.

## Open questions

- `P0.security` reports `failing` on every real repository it has met,
  mostly from test-fixture passwords and planning documents. Classifying
  findings by path role (test, fixture, compose, CI) without an ignore
  list is designed (gap analysis, finding F1) and not built.
- Only TypeScript, JavaScript and Python have profiles. Every other stack
  falls to `generic`, which disables the stack-specific checks.
- The eval suite cannot engage the skill (`disable-model-invocation`
  keeps it out of the model's context), so there is no measured delta.
  Whether a read-only companion skill should exist to make the kit
  measurable is undecided.
- Whether `detect --verify` should run `enforced-by: test` commands from
  the rules registry and upgrade `P3.rules` to `verified`.
