# kh-harness Phase 3 — intent and rules

**Status:** Draft for implementation
**Date:** 2026-11-02
**Builds on:** `docs/2026-11-02-landscape-gap-analysis.md` (R1, R3, R6 in part)
**Supersedes:** nothing. Adds a phase; changes no existing check's semantics.

---

## 1. Problem

The kit installs mechanics: a bootstrap script, lint and typecheck hooks,
protected paths, a handoff file. It holds nothing about *what the
application is for*, *how it is supposed to behave*, *what counts as
success or failure*, or *which rules follow from that*. The agent is told
how to run the tests and never told what the tests are supposed to protect.

Two consequences, both observed:

- A repository's rules, where they exist at all, sit as prose in `CLAUDE.md`
  ("always scope queries by tenant"). Nothing records whether anything
  *enforces* that sentence, so a rule Claude is merely told is
  indistinguishable from one it cannot break. The literature (Gloaguen 2026,
  McMillan 2026) finds that told-only rules do not improve outcomes and that
  compliance with them decays within a session.
- `oxen/2026` reached the mature form by hand: 13 critic subagents, each one
  a business rule with an enforcer. The kit cannot see, scaffold or audit
  any of it.

**What this builds:** a Phase 3 with three checks. An **intent document**
(prompt-gated, human-confirmed) that states purpose, behaviour, success,
failure and non-goals. A **rules registry** (scaffolded empty, filled by the
human, parsed by the kit) where every rule names what enforces it, so an
unenforced rule is a `declared` claim and an enforced one is evidence. A
**re-injection hook** that puts the registry's rules back in front of the
model every turn, bounded in bytes, so the rules survive context decay.

**What it does not build:** no rule authoring by the kit, no rule engine, no
critic generation (that is a later phase and needs the registry first), no
machine-readable acceptance list (deferred; see §9).

---

## 2. Goals, non-goals, anti-goals

### Goals

1. Every repository the kit touches can state, in one place a human
   confirmed, what the application is for and what success and failure mean.
2. Every rule the project holds has a recorded enforcer, or is recorded as
   having none. "Told" and "enforced" are visibly different states.
3. The rules reach the model every turn, not only at session start.
4. Drift is detected: a rule whose enforcer path no longer exists is
   reported; an intent document missing a required section is reported.
5. Additive, reversible, evidence-gated — the same properties every existing
   check has. A second run on an unchanged repository proposes nothing.

### Non-goals

- Writing a rule, an invariant, a success criterion or a purpose statement
  on the user's behalf. The kit scaffolds the shape and parses the content;
  it never supplies the content.
- Judging whether a rule is *right*. The registry records enforcement, not
  correctness.
- Running enforcers. `detect --verify` may later execute `enforced-by: test`
  commands; v0.2 does not.

### Anti-goals (failure even if it technically works)

- A registry template whose example rules a user leaves in place and the
  model then obeys. Every example lives inside an HTML comment, never in
  loadable body text — the same rule `path-rule.md.tmpl` already follows.
- A re-injection hook that grows with the registry until it crowds the
  context. It is byte-bounded and says when it truncated.
- An intent document generated from `detect.json` and a template. A
  templated statement of purpose is a guess dressed as a derivation; the
  prompt step reads the repository first, like recon does.

---

## 3. Why this shape (prior art)

| Choice | Prior art | Why taken |
|---|---|---|
| A separate intent document, not a CLAUDE.md section | Kiro `product.md`, OpenAI `PRODUCT_SENSE.md`, spec-kit constitution | CLAUDE.md is operational and size-budgeted; Anthropic's guidance is to keep it to what cannot be inferred from code. Intent is read at planning time, not every turn. |
| Sections: purpose, users, behaviour, success, failure, non-goals, open questions | PRD convention; spec-kit `spec-template.md` success criteria and `[NEEDS CLARIFICATION]`; Shape Up no-gos | Each section answers a question an agent otherwise guesses at. Open questions is where the kit's `couldNotDerive` discipline lands in a human document. |
| Rules with `enforced-by` | Adobe ai-repo-harness-guide `INVARIANTS.md` ("Enforced by:", `[not yet enforced]` as the automation backlog) | It is the kit's own claim/evidence split, applied to a sentence. |
| Re-injection per prompt | McMillan 2026 compliance decay; Claude Code `UserPromptSubmit` → `additionalContext` | The only mechanism that counters within-session decay without a longer file. |
| Registry is Markdown with `key: value` bullets, not JSON or YAML | zero-dependency rule; `HANDOFF.md` precedent; humans edit it | A 40-line parser is cheaper than a YAML dependency, and the file must stay pleasant to edit by hand. Anthropic's "JSON is altered less by the model" argument applies to machine-maintained state, which this is not. |

---

## 4. The three checks

All three are **phase 3**, named **intent** in the report. Runbook step
numbers 26, 27 and 28 are **addenda** to the 25-step runbook, the same way
step 7a was a prompt the runbook lacked. They are applicable to every
profile including `generic`: nothing here depends on language.

### 4.1 `P3.intent` — step 26, *prompt*

**lookedFor:** `docs/INTENT.md`, documentation the instruction file points
at, any documentation-shaped file.

**State logic** mirrors `P1.architecture` exactly, and for the same
decidability reason:

| Finding | State |
|---|---|
| `docs/INTENT.md` exists | `declared`, evidence lists the required sections found and **names each required section that is missing** |
| no canonical file, but the repository holds documentation-shaped files | `absent`, `decidable: false`, question: "No docs/INTENT.md found, but the repository holds N documentation-shaped files (…). Does one of these already state the application's purpose, success and failure criteria?" |
| no documentation anywhere | `absent`, proposal: "run the intent prompt to write docs/INTENT.md" |

The required sections (level-2 headings, matched case-insensitively on the
first word): `Purpose`, `Users`, `Behaviour` (or `Behavior`), `Success`,
`Failure`, `Non-goals`, `Open questions`. A document with every heading but
empty bodies is still `declared`: the kit measures presence of the shape,
not quality of the prose, and says so in the evidence.

**No generator.** Like steps 6 and 7a, the skill writes this file itself
after reading the repository, and gates on the full content. `apply` has
nothing to write for this id, and `propose.test.mjs`'s "no registered
generator" discipline pins that.

### 4.2 `P3.rules` — step 27, *script* (scaffold) then *prompt* (fill)

**lookedFor:** `docs/harness/RULES.md`; rule-shaped lines in the
instruction file and under `.claude/rules/`.

**Registry format.** One rule per level-2 heading. The heading carries the
id and the rule; bullet lines carry keys. Keys the kit reads:

```markdown
## R1 — Every database query is scoped to the current tenant

- why: a cross-tenant read is a data breach, not a bug
- enforced-by: critic
- pointer: .claude/agents/tenant-scoping.md
- verify: npm test -- tenant
```

| Key | Required | Values |
|---|---|---|
| heading | yes | `## <id> — <rule>` where id matches `^[A-Za-z][\w.-]*$` |
| `why` | no | free text, one line |
| `enforced-by` | yes | `deny` · `hook` · `lint` · `test` · `critic` · `ci` · `review` · `none` |
| `pointer` | when enforced-by ≠ none/review | a repository-relative path, or `settings:permissions.deny` / `settings:hooks.<Event>` |
| `verify` | no | a command a human can run to confirm the enforcer works |
| `priority` | no | `high` · `normal` (default `normal`); only `high` rules are re-injected first |

Unknown keys are ignored without error, the same way Claude Code treats
unknown rule frontmatter. Every example in the template sits inside an
HTML comment.

**State logic:**

| Finding | State |
|---|---|
| no registry | `absent`, proposal: "scaffold docs/harness/RULES.md — generated EMPTY; rules are added by hand" (decidable: the path is ours) |
| registry present, zero parseable rules | `declared`, evidence: "docs/harness/RULES.md (0 rules — scaffold not yet filled in)" |
| registry present, N rules | `declared`, evidence: "N rules: a enforced (deny b, hook c, …), d with enforced-by: none"; **plus one evidence line per rule whose `pointer` names a path that does not exist**, naming the rule id and the path |
| registry present and every rule with a pointer resolves, and none is `none` | `verified`? **No.** `verified` means executed. Nothing ran. The best this check reports without `--verify` is `declared` with "every pointer resolves". Stated here so nobody upgrades it later without adding execution. |

**Advice** (never a proposal, never written): the instruction file and
`.claude/rules/*.md` hold N lines matching the rule-shaped pattern
`\b(must|must not|never|always|do not|don't|forbidden|required)\b`
(case-insensitive). Reported as a count and line numbers per file, never
the sentences themselves (a sentence may carry anything), with the advice
"consider moving each into docs/harness/RULES.md with an `enforced-by`
line, so told rules and enforced rules can be told apart". The line-number
form lets a user open the exact spot without the kit echoing prose into
`detect.json`.

**The prompt half.** After the scaffold is written, `phase-3-intent.md`
tells the skill to read `docs/INTENT.md` (if present), `CLAUDE.md`, and the
rule-shaped lines detect reported, and to **propose** registry entries in
the gate — written into the registry only after the user confirms, and
with `enforced-by` filled in only where the skill can point at a real
enforcer it found (an existing deny rule, hook, lint config, test file or
agent). Everything else is `none`. The skill never invents an enforcer.

### 4.3 `P3.reinject` — step 28, *script*

**lookedFor:** a `UserPromptSubmit` hook registered at
`.claude/scripts/rules-brief.mjs`.

**Decidable only when** the registry exists and parses to ≥1 rule — the
same evidence gate shape as `P2.sensor` (no lint script, no sensor). A hook
with nothing to inject is noise.

**Installs:** `.claude/scripts/rules-brief.mjs`, the shared
`harness-redact.mjs`, and a `UserPromptSubmit` hook entry
`node .claude/scripts/rules-brief.mjs`.

**Behaviour of the hook:** reads `docs/harness/RULES.md` via a parser that
lives in `harness-redact.mjs` (the only module beside it in the user's
repository; same import direction as `findHandoff`, for the same reason:
detect and the hook must agree on what a rule is). Emits JSON on stdout:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}
```

`<text>` is: one header line naming the registry path; then `high`-priority
rules, then `normal`, each as `<id>: <rule> [enforced-by: <x>]`; bounded to
**1,500 bytes** (my call: roughly 10–15 rules, a small fraction of the
10,000-character hook cap, chosen so the hook is cheap on every single
prompt), with a final line "… N more rules in docs/harness/RULES.md" when
truncated. Output passes `maskCredentials`. On any read or parse failure it
prints nothing and exits 0 — fails open, correctly, because it injects
context rather than guarding an action. No marker files, no state.

**Registration:** `registeredHook(harness, 'UserPromptSubmit', RULES_BRIEF_PATH, …)`,
the same function the other three hooks use, so a user's own
`UserPromptSubmit` hook is disclosed, never counted as ours.

---

## 5. What the skill does (reference `phase-3-intent.md`)

Phase 3 runs **after** Phase 1 and before Phase 2 in the skill's table —
intent informs which rules matter, and rules inform which protected paths
and sensors matter. The phase table in `SKILL.md` gains one row:

| Phase | Steps | Kind | Reference |
|---|---|---|---|
| 3 | 26, 27, 28 | prompt, script+prompt, script | `references/phase-3-intent.md` |

The reference covers:

- **Step 26.** Read `detect.json`, `recon.md` (if present), the README, the
  entry points and the tests' names (test names are the closest thing a
  repository has to a stated success criterion). Write `docs/INTENT.md` with
  the seven sections. Where a section cannot be answered from the
  repository, write the question under **Open questions** rather than a
  guess. Gate: show the whole file, name it, wait.
- **Step 27.** Run `apply` (dry run) to show the scaffold; after `--yes`,
  read the rule-shaped lines detect reported and propose registry entries,
  each with `enforced-by: none` unless a real enforcer is found and named.
  Gate: show the proposed entries as a diff against the scaffold, wait,
  then write.
- **Step 28.** Run `apply` for the hook. State plainly, before the gate,
  that accepting means the registry's rules are added to every prompt's
  context, bounded at 1,500 bytes, and that the hook reads one file and
  executes nothing else.
- **What declining leaves behind:** nothing for 26 and 27's prompt half
  (no write without the gate); `apply`'s dry run for the script halves.

`skill-phases.test.mjs`-style tests pin: the "executes nothing else"
disclosure sits near the step-28 gate; step 26 pairs "gate" with
"wait"/"stop"; the INTENT path is written, never a template name.

---

## 6. Safety, idempotency, uninstall

- **Write allowlist:** `docs/harness/RULES.md` is under the existing
  `docs/harness/` prefix; `.claude/scripts/rules-brief.mjs` under
  `.claude/`. `docs/INTENT.md` is written by the skill, not `apply`, like
  `docs/ARCHITECTURE.md` — it is added to `ALLOWED_EXACT` anyway so a
  future generator cannot be refused by accident, and to `KIT_OUTPUT_FILES`
  so a pointer at it is not credited as the repository pointing at its own
  docs.
- **Uninstall:** `RULES.md` and `rules-brief.mjs` join
  `GENERATOR_PRODUCIBLE_EXACT`; `templateFor('docs/harness/RULES.md')`
  returns `RULES.md.tmpl` so `hasUserAuthoredBody` keeps a registry the
  user has filled in. A filled registry is the user's work by definition.
- **Hook output:** credentials masked through the shared chokepoint;
  bounded; the hook never writes anywhere.
- **No value echo:** detect reports counts and line numbers for rule-shaped
  lines, never the lines. The registry's own rule text does appear in
  `detect.json` evidence only as ids and counts, never bodies.
- **Idempotent:** a second `apply` after the scaffold proposes nothing for
  P3.rules (manifest), and P3.reinject proposes only once the registry has a
  rule — so the usual sequence is: apply (scaffold) → fill in → apply (hook).
  The report says this in the P3.reinject evidence when the registry is
  empty: "registry has 0 rules; the re-injection hook is proposed once it
  has at least one".

---

## 7. Testing

| Layer | Tests |
|---|---|
| `harness-redact.mjs` `parseRules` | headings with/without ids, missing keys, unknown keys, CRLF, a rule inside an HTML comment is **not** parsed, duplicate ids reported |
| `gap-model.mjs` P3.* | the three-state tables in §4; pointer-missing evidence; advice counts; `verified` never reported; rogue-check guard still holds for step 26–28 |
| `propose.mjs` | P3.rules generator produces the scaffold; P3.reinject produces hook + script + redact asset and is gated on ≥1 rule; coherence test covers both automatically; P3.intent has **no** generator (pinned like P2.scripts) |
| `rules-brief.mjs` | emits valid JSON with `hookEventName: UserPromptSubmit`; byte bound honoured and announced; `high` before `normal`; masked credential never reaches stdout; missing/empty registry → no output, exit 0 |
| `uninstall-lib.mjs` | a filled registry is kept as user-authored; an untouched scaffold is removed |
| `lifecycle.test.mjs` | a fixture walks: detect (P3.rules absent) → apply (scaffold) → fill one rule → detect (P3.reinject absent) → apply (hook) → detect (all declared) → uninstall (scaffold kept because filled, hook reverted) |
| skill tests | phase table row; link integrity; disclosures (§5) |
| dogfood | kh-harness's own `docs/INTENT.md` and `docs/harness/RULES.md` exist and parse; the kit passes its own P3 checks |

---

## 8. Dogfooding — the kit's own intent and rules

The first registry written is kh-harness's own. Its rules already exist as
tests; the registry gives them ids and makes the enforcement explicit:

- `R1` write only what detection proved — `enforced-by: test`, pointer
  `scripts/lib/propose.test.mjs`
- `R2` only a decidable `absent` may propose — `enforced-by: test`, pointer
  `scripts/lib/gap-model.test.mjs` (rogue-check tests)
- `R3` never overwrite a file the kit did not write — `enforced-by: test`,
  pointer `scripts/lib/apply-lib.test.mjs`
- `R4` never print a credential value — `enforced-by: test`, pointer
  `scripts/lib/harness-redact.test.mjs`
- `R5` no `--force`, no ignore list — `enforced-by: review`

`docs/INTENT.md` for kh-harness states: purpose (bring an existing repo to a
working agent harness without guessing), success (a second run proposes
nothing; a user can `git diff` every write), failure (a guessed step that
is run and trusted; a security check that normalises to noise; a hook that
runs something the user did not knowingly accept), non-goals (no
scaffolder, no runtime, no opinions about frameworks).

This is also the acceptance test for the design: if the kit's own intent
and rules cannot be expressed in the schema, the schema is wrong.

---

## 9. Deferred, deliberately

- **Machine-readable acceptance list** (Anthropic `feature_list.json`,
  spec-kit success criteria with test traceability). Valuable for long
  autonomous runs; needs the intent document to exist first. Next phase.
- **Critic scaffolds from the registry** (runbook 17–19). Needs rules with
  ids to hang on. Next phase.
- **`--verify` running `enforced-by: test` commands** and upgrading
  P3.rules to `verified`. Needs the existing `verifyCommands` to accept
  arbitrary commands with cwd, and an honest timeout story.
- **Architecture fitness-function configs** (R2 in the gap analysis).
  Separate design.

---

## 10. Open questions (my calls, flagged)

1. **Phase order in the skill.** I place Phase 3 between 1 and 2. The
   runbook's own order puts sensors before continuity; intent has no slot.
   If the user prefers intent *first* (before recon's CLAUDE.md proposal,
   so the CLAUDE.md derives from stated intent), the table row moves and
   nothing else changes.
2. **Registry path.** `docs/harness/RULES.md` keeps it with the kit's other
   outputs and inside the existing allowlist. `docs/RULES.md` would be more
   discoverable but is a new allowlist entry and sits beside user docs.
3. **Re-injection budget.** 1,500 bytes. Measured against nothing yet;
   the first dogfood run will say whether it is too tight.
