---
name: harness-init
description: Inspect this repository and propose the harness it is missing — detection, the prompt-gated documents only a human can approve, and the mechanical steps the CLIs apply.
disable-model-invocation: true
---

# harness-init

This skill inspects a repository and proposes the harness it is missing. It
derives every claim from this repository — never from a template — and shows
it before writing: a diff, a proposal, or a question. It never writes
`CLAUDE.md` in place when one already exists; it writes
`docs/harness/CLAUDE.proposed.md` instead and leaves merging it to the user.
It reports credentials it finds — location and type only — and never rotates
them.

## Phases

Each phase covers a group of runbook steps, marked *script* (the CLI derives
and writes it), *prompt* (judgement about this repository, gated), or
*advise* (reported, never acted on). Read only the reference for the phase
you are running.

| Phase | Steps | Kind | Reference |
|---|---|---|---|

Each phase's row appears here once its reference exists. An empty table
means no phase reference exists yet — running detection (see the first-run
rule, below) is the only thing to do so far.

## The gate rule

> Every phase ends at a gate. Show what you propose, wait for the user, and
> if they decline, stop at that phase and report what was and was not done.
> Do not carry on to the next phase because the previous one succeeded.

## The first-run rule

> If `docs/harness/detect.json` does not exist, run detection before
> anything else. Every phase reference reads it, and a phase run without it
> is a guess.

## Before you start

- Read [references/detect.md](references/detect.md) for how to run
  detection and read what it reports.
- Read [references/gates.md](references/gates.md) for how to present a gate
  and what declining it means.
