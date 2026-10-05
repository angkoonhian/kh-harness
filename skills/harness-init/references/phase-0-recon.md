# Phase 0, step 4 — recon

*Prompt-gated.* This step derives a judgement about this repository that
`docs/harness/detect.json` deliberately does not make, and only a human who
works in this repository can confirm it. Read [references/gates.md](gates.md)
before presenting the gate below.

## Read `detect.json` first

Detection has already enumerated what this repository contains —
`node scripts/detect.mjs <path> --json` writes `docs/harness/detect.json`
and nothing else (see [references/detect.md](detect.md) for how to run it
and read its three report sections). If that file does not exist yet, run
detection before anything in this step; the first-run rule in `SKILL.md`
covers this, and recon run without it is a guess.

Detection and recon are deliberately two different layers: detection
enumerates facts (files found, scripts declared, a check's `state`), and
recon interprets them. Do not restate anything `detect.json` already says —
that is detection's job, not this one's.

## The question recon answers

**What would a new developer get wrong here?** Not "what does this
repository contain" — `detect.json` already answers that, exhaustively, and
restating it is noise, not recon. Answer instead: where would someone who
has never worked in this repository make a wrong assumption, trip over an
undocumented step, or miss a convention that is nowhere written down?

## Explore before writing

Read, at minimum:

- the entry points (what actually runs — the main script, the server
  bootstrap, the CLI's own entry file);
- the test setup (how tests are run and what they assume is already in
  place before they do);
- the CI config (what a pipeline enforces that a human reading the source
  alone would not see);
- the files most frequently touched in recent history (a rough proxy for
  where the real complexity and the real churn live, not a tool claim —
  reading recent commits or a log of frequently-changed paths is ordinary
  exploration, not something this skill derives for you).

Only write `docs/harness/recon.md` once this reading is done. A recon
document assembled from `detect.json` and a guess, without actually reading
the repository, is exactly the "guessed step" this skill exists to avoid.

## Write, then gate

Write `docs/harness/recon.md`. Then gate: show it in full and wait. Per
`references/gates.md`, name the one file this step writes, state that it is
a new file the user can delete, and do not continue past this point because
writing it "succeeded" — the gate is what confirms the content, not the
write.

## Credentials: recon will meet them

Recon reads file *bodies* directly — entry points, test setup, CI config,
history — in a way detection's pattern table does not: it can land on a
credential quoted in prose, sitting in a config comment, or baked into a
fixture, none of which match a known secret shape. The rule below exists
because recon's output is a narrative a human reads, not because detection
has a blind spot — a secret quoted in a narrative is exactly as
irreversible, once reported, as one sitting in a settings file.

*Verified against `scripts/lib/detect-exposure.mjs`'s `detectExposures`:* a
credential embedded in a git remote URL is already reported, as a
`token-in-remote-url` finding, sourced from the repository's own remotes —
this is already in `detect.json`'s `exposures` array before recon ever
runs. **Do not re-list it.** Read the exposures list `detect.json` already
carries (see [references/detect.md](detect.md)) and treat anything there
as handled; recon's own job is only what that sweep did not already catch
and name.

Whatever recon's own reading surfaces that `detect.json` does not already
carry, the same rule applies: report its location and credential type in
`recon.md` — never the value, and never rotate it, regardless of how it
was found. A credential finding cannot be un-seen once reported, which is
exactly why `references/gates.md` names it as the irreversible kind of
thing a gate must state plainly, not bury in the rest of the diff.

## What not to write

- Anything already in `detect.json` — a restated fact is not an
  observation, it is duplication that will drift from its source the first
  time detection changes.
- Anything that reads as advice rather than observation. Recon reports what
  is true of this repository today; it does not recommend what to do about
  it — that judgement belongs to the later, prompt-gated steps that
  actually propose a file.
