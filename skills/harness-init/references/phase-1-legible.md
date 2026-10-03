# Phase 1 — legible

Four runbook steps: two *script* (the CLI derives and writes them) and two
*prompt* (judgement about this repository, gated). Read
[references/gates.md](gates.md) before presenting either gate below.

## Running the script steps

Steps 5 and 7b both go through `node scripts/apply.mjs <path-to-repo>`.
Without `--yes` this is a dry run: it prints every currently *decidable*
proposal and a diff of exactly what it would write, and writes nothing.
*Verified against `scripts/apply.mjs` and `scripts/lib/cli.mjs`'s
`APPLY_USAGE` text:* `apply` has no flag to scope a run to one step or one
check — a single invocation shows (and, with `--yes`, writes) every
decidable proposal across every phase at once, not just the one this skill
is currently walking through. The diff for step 5's bootstrap script and
step 7b's path rules can both appear in the same run. Read the whole diff
before passing `--yes`, not only the lines this step expects.

## Step 5 — bootstrap script

*Script.* Run the CLI as above. *Verified against
`scripts/lib/bootstrap-install.mjs` and `scripts/lib/propose.mjs`'s
`bootstrapProposal`/`bootstrapScriptLines`:* the install line comes from a
detected lockfile paired with the package manager it implies — a
deterministic, frozen form (for example `npm ci`, not `npm install`) so the
script can never silently rewrite a lockfile on a clean checkout — and the
build/test lines come only from script *names* already declared in the
root package, never from script bodies. Nothing else about a clean checkout
is derivable from evidence alone, and the generated `scripts/bootstrap.sh`
says so in its own comment: it asks, inline, whether this repository also
needs database migrations, seed data, environment files, or a virtual
environment created or activated first — a question for you to answer in
the script itself, not one this step guesses at.

The exact command shape differs by package manager (bare `pnpm build`
versus `npm run build`, for instance); that per-stack detail lives in its
own profile reference, not repeated here.

No gate beyond the dry-run review above: `apply --yes` is the only write,
and it is demonstrated for real rather than simulated.

## Step 6 — `CLAUDE.md` proposal

*Prompt.* Derive the proposal from `docs/harness/recon.md` and
`docs/harness/detect.json` — never from a template, and never by guessing
at conventions recon did not confirm.

**Write `docs/harness/CLAUDE.proposed.md`. Never write `CLAUDE.md` in place.**
This holds in both directions, not only when `CLAUDE.md` already exists:

- If `CLAUDE.md` exists, show a diff of the proposal against it. `CLAUDE.md`
  is the file most likely to be hand-tuned and to carry decisions that
  cannot be re-derived from source — a wrong derivation overwriting it
  would destroy exactly what can never be regenerated. This step must
  never write, overwrite, or replace CLAUDE.md in place, under any
  circumstance.
- If `CLAUDE.md` does not exist, still write the proposal to
  `docs/harness/CLAUDE.proposed.md` rather than to `CLAUDE.md` itself, and
  leave moving it into place to the user. An unreviewed file landing at the
  path Claude Code reads automatically, every session, is not something
  this step gets to decide on its own, existing file or not.

There is no generator for this in `scripts/lib/propose.mjs` — `apply` has
nothing to write for `P1.instructions` today (confirmed against
`scripts/lib/gap-model.mjs`'s `P1.instructions` check and the generator
table in `propose.mjs`). This step's write is the skill's own, not a CLI
call, which is exactly why the rule above has no `--yes` to hide behind.

Gate: show the full proposed content (or the diff, if `CLAUDE.md` exists),
name the one file being written, and wait.

## Step 7a — `ARCHITECTURE.md` proposal

*Prompt.* The same derivation as step 6 — from `recon.md` and
`detect.json`, never a template — aimed at `docs/ARCHITECTURE.md` instead.
*Verified against `scripts/lib/gap-model.mjs`'s `P1.architecture` check and
`propose.mjs`'s generator table:* there is no generator for this step
either, by the same reasoning as step 6 — a derived architecture document
is a judgement call this skill makes once, directly, not a mechanical
rewrite `apply` repeats.

Unlike the bootstrap and path-rule scaffolds, there is deliberately no
starting template for this file: a templated architecture document is a
guess dressed as a derivation, and this is exactly the gap the runbook
otherwise leaves without a prompt.

Gate: show the full proposed content, name `docs/ARCHITECTURE.md`, and
wait before anything is written.

## Step 7b — path-scoped rules

*Script.* Run the CLI as above. *Verified against
`scripts/lib/pathrules-evidence.mjs` and `propose.mjs`'s
`pathRuleProposal`:* one file per non-root workspace package, at
`.claude/rules/<package>.md`, with its `paths` frontmatter glob derived
from that package's own directory in the workspace layout — the only
pattern derivable from structure alone. The per-stack detail of how a
workspace's packages are enumerated lives in the same profile reference
step 5 mentions, not repeated here.

Every generated file's body is left empty but for a heading and an HTML
comment: the conventions that belong in a path-scoped rule are the user's
to write, and inventing them would be a guess this skill has no evidence
for. Tell the user plainly that the generated files are empty until they
fill them in — an empty rule file is not a finished step.

**State this plainly, not as a footnote:** a path-scoped rule is
summarised away when context is compacted — Claude Code re-reads and
re-injects `CLAUDE.md` after compaction, but a rule under `.claude/rules/`
returns to context only the next time a matching file is read. Anything
that must never be forgotten belongs in `CLAUDE.md` or a hook, never in one
of these files alone. This is the reason every generated body here starts
empty rather than with a guessed convention: a rule that is both wrong and
silently forgettable is worse than no rule.

No gate beyond the dry-run review in "Running the script steps," above.
