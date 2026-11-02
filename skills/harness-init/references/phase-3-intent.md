# Phase 3 — intent and rules

Three runbook steps, all addenda to the 25-step runbook (the same way
step 7a was a prompt the runbook lacked). Step 26 is *prompt*: a judgement
about this repository that only a human who works in it can confirm. Step
27 is *script* for its scaffold and *prompt* for its content. Step 28 is
*script*. Read [references/gates.md](gates.md) before presenting any gate
below.

This phase runs after Phase 1 and before Phase 2, deliberately: what the
application is for decides which rules matter, and which rules matter
decides which sensors and protected paths are worth installing.

## Why this phase exists

Everything the kit installs elsewhere is mechanics: a bootstrap script,
hooks that run scripts the repository already had, a handoff file. None of
it says what the application is *for*, how it is supposed to behave, what
counts as success or failure, or which rules follow from that. The 2026
studies the design cites found two things: an agent follows the rules it is
told, and its compliance with told rules decays as a session runs. So this
phase separates a rule Claude is merely *told* from one something actually
*holds*, and puts the rules back in front of the model on every prompt.

## Step 26 — the intent document

*Prompt.* Derive `docs/INTENT.md` from this repository — never from a
template. There is deliberately no starting template for this file: a
templated statement of purpose is a guess dressed as a derivation, exactly
the shape the architecture step refuses for the same reason.

Read, at minimum, before writing anything: `docs/harness/detect.json`
(the first-run rule in `SKILL.md`); `docs/harness/recon.md` if Phase 0
wrote it; the README; the entry points; and the *names* of the tests — a
test name is the closest thing most repositories have to a stated success
criterion, and a test that asserts something never happens is a stated
failure criterion.

Then **write `docs/INTENT.md`** with these seven level-2 sections, in this
order. *Verified against `scripts/lib/intent-evidence.mjs`'s
`INTENT_SECTIONS`:* detection credits the document by these headings (US
spellings and the aliases that module lists are accepted too), and reports
any that are missing.

| Section | What it answers |
|---|---|
| Purpose | why this exists, for whom, and what changes if it works |
| Users | who it serves — and who v1 is *not* for |
| How it works | the three to seven journeys that matter, pointing at entry points and `docs/ARCHITECTURE.md`, not restating them |
| Success | what "working" means, measurably where possible, each criterion pointing at the test or metric that shows it |
| Failure | what must never happen, how it would be detected, and any budget or threshold |
| Non-goals | what this deliberately does not do, so the agent does not helpfully add it |
| Open questions | everything above that the repository could not answer |

Where a section cannot be answered from the repository, write the
question under **Open questions** rather than a guess. A confident sentence
under Purpose that the repository does not support is worse than an honest
question: it becomes a premise the agent reasons from. Optionally add a
`- last-reviewed: YYYY-MM-DD` bullet near the top; detection reports it as
freshness evidence.

Gate: show the full proposed content, name `docs/INTENT.md` as a new file
the user can delete, and wait. Do not continue to step 27 because the
write succeeded — the gate is what confirms the content.

## Step 27 — the rules registry

*Script, then prompt.* Run `node scripts/apply.mjs <path-to-repo>` (dry
run). *Verified against `scripts/lib/propose.mjs`'s
`rulesScaffoldProposal` and `assets/templates/RULES.md.tmpl`:* the kit
writes `docs/harness/RULES.md` **generated EMPTY** — one heading and one
HTML comment holding the schema, the enforcer list and a worked example.
The example is inside the comment so it is never loaded as a rule; the
registry parses to zero rules until a human writes one outside it. Tell
the user plainly that the scaffold is empty until filled in — an empty
registry is not a finished step. `apply --yes` after the dry-run review is
the only write.

Then the prompt half. Read what `detect.json` reported under `P3.rules`'s
advice: the instruction file and `.claude/rules/*.md` hold N rule-shaped
lines ("must", "never", "always", …) at the line numbers it names. Open
those lines, read `docs/INTENT.md`'s Success and Failure sections, and
**propose** registry entries in this shape:

```markdown
## R1 — Every database query is scoped to the current tenant
- why: a cross-tenant read is a data breach, not a bug
- enforced-by: critic
- pointer: .claude/agents/tenant-scoping.md
- priority: high
```

`enforced-by` is `none` unless you found a real enforcer and can name it
in `pointer`: an existing deny rule (`settings:permissions.deny`), a hook
(`settings:hooks.<Event>`), a lint config, a test file, or an agent under
`.claude/agents/`. **Never invent an enforcer.** A rule recorded as
`enforced-by: none` is a claim, and the registry exists precisely so that
claims and held rules can be told apart; a rule recorded as held by
something that does not hold it is the one entry the registry must never
contain. Detection reports every pointer that stops resolving, so a wrong
pointer is also a wrong report on every future run.

Gate: show the proposed entries as a diff against the scaffold, name
`docs/harness/RULES.md`, and wait. Write only after the user confirms.
Declining leaves the empty scaffold, which is a correct state.

## Step 28 — the re-injection hook

*Script.* *Verified against `scripts/lib/gap-model.mjs`'s `P3.reinject`
and `propose.mjs`'s `reinjectProposal`:* decidable only once the registry
holds at least one active rule — a hook with nothing to inject is noise on
every prompt, so detection asks for rules first rather than proposing it.
Installs `.claude/scripts/rules-brief.mjs`, the shared
`harness-redact.mjs`, and a `UserPromptSubmit` hook with no matcher.

**Say this before the gate, not after:** accepting means the registry's
rules are added to the model's context on **every prompt** — `high`
priority first, superseded rules skipped, bounded at **1500 bytes** with
the cut announced in the text itself. The hook reads one file
(`docs/harness/RULES.md`) and executes nothing else: it runs no script of
this repository's, writes nothing, keeps no state, and when the registry
is missing, unreadable or empty it prints nothing and exits 0. It is the
only hook this kit installs that is *meant* to fail open, because it
injects a reminder rather than guarding an action. The one exception is
visible, not silent: if the shared `harness-redact.mjs` beside it is
missing or older than the hook (a repository upgraded from an earlier
kh-harness), it prints one line to stderr naming the fix and exits 1 — a
hook-error notice in the transcript, never a blocked prompt and never a
stack trace. *Verified against `assets/scripts/rules-brief.mjs`'s header
comment, which states each of these properties.*

Gate: show the dry run, name the two script files and the settings patch
by path, and wait. If the user declines, nothing is written — `apply`
without `--yes` is itself a dry run.

## What declining leaves behind

Step 26: nothing — no write happens without the gate. Step 27: the empty
scaffold if `apply --yes` ran, which a later run recognises as ours and
never re-proposes; nothing at all if it did not. Step 28: nothing. Report
what was proposed and what was declined, and stop; do not carry on to
Phase 2 because this phase technically ran.
