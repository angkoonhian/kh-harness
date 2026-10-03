# Phase 4 — continuity

Two runbook steps. Step 15 is *advise* — it prints instructions and a
verification check, and the kit takes no action itself. Step 16 is
*script*. Read [references/gates.md](gates.md) before presenting the gate
at the end.

## Step 15 — git remote, and relocating memory that may hold credentials

*Advise.* *Verified against `scripts/lib/gap-model.mjs`'s `P4.remote`
check and `scripts/lib/propose.mjs`'s `GENERATORS` table:* when this
repository has no git remote, detection reports the gap — but
`propose.mjs`'s generator table has no entry for `P4.remote` at all, so
`apply` can never write one, whether the user accepts or declines. This
step prints instructions instead (`git remote add origin <url>`) and a
verification check (`git remote -v`, confirming the new remote is listed).
**The kit never touches your git remotes** — where your work is backed
up, and who can reach it, is a decision about this repository's own
relationship to the outside world, not something a derivation from its
files gets to make for you.

The same step also covers a second gap, with the same shape: if phase 0's
security sweep (`P0.security`) found a credential sitting inside something
Claude Code treats as its own memory — `CLAUDE.md`, a file under
`.claude/rules/`, or `.claude/settings.json` — this step prints
instructions for relocating it (to an untracked file, an environment
variable, or a secrets manager) and a verification check: confirm the
original location no longer contains the literal value. **The kit never
relocates memory itself.** A credential sitting in a repository's own live
memory may be exactly what another process or session already depends on
reading from that exact spot; moving it automatically risks breaking that
dependency, or carrying a live credential into a new location with a
different, unreviewed exposure — a judgment call this tool has no safe way
to make on your behalf, so it only ever advises and never acts, on either
half of this step.

## Step 16 — session brief and handoff

*Script.* *Verified against `scripts/lib/propose.mjs`'s
`GENERATORS['P4.handoff']`/`['P4.sessionbrief']` and
`assets/scripts/session-brief.mjs`:* installs `HANDOFF.md` from a template
when none exists, plus `.claude/scripts/session-brief.mjs` and the shared
`harness-redact.mjs`, registering a `SessionStart` hook that prints the
handoff's own content at the start of every session.

The hook's output is bounded in BYTES, not merely lines, against the
platform's own documented 10,000-character cap on a hook's stdout. A
handoff that runs long is truncated, and the truncation is stated in the
output itself — both that more lines exist beyond what is shown, and,
separately, that the shown portion was itself cut at the byte limit, since
those are two different facts a reader needs — rather than the brief
simply failing to arrive with no indication why.

## The gate, and what declining leaves behind

Show the dry run, name `HANDOFF.md` and the two script files by path, and
wait — see [references/gates.md](gates.md). For step 16, the same rule as
every other script step in this skill holds: `apply` without `--yes` is
itself a dry run, so if the user declined, nothing was written — nothing
to revert, nothing partially installed. For step 15, nothing is ever
written regardless of the answer, because no generator exists for it at
all; declining there means only that the printed instructions were not
carried out by hand. Report what was proposed, what was declined, and
stop.
