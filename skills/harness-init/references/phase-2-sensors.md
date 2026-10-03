# Phase 2 — sensors

Four runbook steps. Three are *script* (steps 9, 10, 11: the CLI derives
and writes them); step 8 is *advise within a script phase* — it reports a
gap and never writes it. Read [references/gates.md](gates.md) before
presenting the gate at the end.

## Read this before presenting either hook's gate

Steps 9 and 10 each install a hook. Accepting either means this
repository's own `lint`, `typecheck`, or `test` script — whatever is
already declared in its `package.json` — starts running automatically, on
the user's behalf, without being asked each time: step 9's sensor runs the
repository's own lint script on every edit, and step 10's stop gate runs
`typecheck` (or `test`, with no `typecheck`) at the end of every turn. Say
this plainly, before either gate, not as a footnote once it is reached —
accepting the gate is agreeing to let these scripts execute unattended.

## Step 8 — missing `lint`/`typecheck` scripts

*Advise, inside a script phase.* *Verified against
`scripts/lib/gap-model.mjs`'s `P2.scripts` check and its
`lintAdvice`/`typecheckAdvice`:* the kit reports, per package, which of
`lint`/`typecheck` is missing, and never writes `package.json` itself —
that file sits deliberately outside `apply`'s own write allowlist, because
it is the file most likely to be hand-tuned.

Where a package's own ecosystem already proves a tool is in use — an
ESLint config file, a `tsconfig.json` in the package's own directory or at
the repository root, a ruff/mypy/pyright config — the advice names the
exact derived command to add (for example, `"lint": "eslint ."`). Where no
such config exists, the advice names only the missing capability and says
plainly that the command cannot be derived; it never invents one. Nothing
is written either way — this step's only output is the report.

## Step 9 — the per-edit sensor

*Script.* *Verified against `scripts/lib/propose.mjs`'s `sensorProposal`
and `assets/scripts/lint-touched.mjs`:* decidable only when some package in
the repository declares a `lint` script — a sensor with nothing to run
would be pure noise. Installs `.claude/scripts/lint-touched.mjs`, the
shared `.claude/scripts/harness-redact.mjs`, and a `PostToolUse` hook
scoped to the `Write` and `Edit` tools exactly, so that every time Claude
edits or writes a `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.py` file, this
repository's own lint script runs against that one file, automatically.

When the owning package's lint script reports a problem, the hook writes
it to stderr and exits 2. This never blocks the edit that already
happened — only Claude's next turn sees it — so the point is speed, not
gatekeeping. **It never goes silent on a standing failure.** If the
identical issue on the identical file is reported again, the hook does not
drop into a quiet exit 0 — it writes a terse one-line notice instead
(`lint-touched: <file> — unchanged since the last edit`, with a running
count of how many times this exact issue has now been reported) and still
exits 2. This is deliberate: silence from a sensor is indistinguishable
from the lint passing, and the one moment this feedback matters most — a
fix attempt that did not work — is exactly the moment going quiet would
report success by omission instead.

## Step 10 — the stop gate

*Script.* *Verified against `scripts/lib/propose.mjs`'s `stopgateProposal`
and `assets/scripts/verify-touched.mjs`:* decidable only when the ROOT
package declares a `typecheck` or `test` script — a `Stop` event has no
single file to anchor on, so only the repository's own root-level command
is a trustworthy answer. Installs `.claude/scripts/verify-touched.mjs`,
the shared `harness-redact.mjs`, and a `Stop` hook: accepting this means
this repository's own `typecheck` script (or `test`, with no `typecheck`)
runs automatically at the end of every turn, not something asked for each
time.

**The cost is measured, not estimated — say the numbers before the gate,
not after someone notices turns got slower.** This is a whole-program
check with no incremental cache, so its cost scales with the size of the
repository, not the size of the edit: measured during an earlier plan at
roughly 1 second added per turn on a 40-module repository, climbing to
10-30 seconds per turn at around 1000 modules. A user on a large codebase
should be able to decline this step for that reason, with the number in
hand, rather than discover it as unexplained latency later.

It blocks at most three times per session, keyed to each failure's own
signature — so the identical failure reported twice blocks only once, but
a genuinely different failure later in the same session still gets its own
block — and it honours `stop_hook_active`, the flag the platform sets once
its own cap has already fired. The platform's own documented cap is eight
consecutive blocks *(verified against `assets/scripts/verify-touched.mjs`'s
header comment, which names `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`)* — ours, at
three, is deliberately tighter, not the same bound restated.

## Step 11 — protected paths

*Script.* *Verified against `scripts/lib/protected-evidence.mjs` and
`gap-model.mjs`'s `P2.protected`:* emits `permissions.deny` entries
(`Edit(<glob>)`) only for paths with real evidence already in this
repository — a lockfile, tracked build output, migrations, or generated
files that actually exist. A gitignored build directory (`dist/`,
`build/`) is regenerable scratch with nothing of the user's to protect,
and the evidence filter deliberately never sees it *(verified against
`profiles/typescript.mjs`'s own comment: "a gitignored directory is
regenerable scratch... a rule with no evidence would be exactly the
opinion-without-basis" this project already struck once)*. The report says
this plainly — an untracked or gitignored file of the same kind "would not
be visible here" — rather than letting an empty proposal read as "nothing
here is worth protecting."

## The gate

Show the dry run (`apply` without `--yes` prints every proposal above and
a diff of exactly what it would write), name every file and settings patch
by path, and wait — see [references/gates.md](gates.md). **If the user
declines, nothing is written**: `apply`'s own default, with no `--yes`, is
itself a dry run, so a decline and an unconfirmed "not yet" look identical
on disk — nothing partially installed, nothing to revert. Report what was
proposed and that it was declined, and stop; do not carry on to phase 4
because this phase technically ran.
