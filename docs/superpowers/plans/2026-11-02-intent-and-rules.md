# Intent and Rules (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Phase 3 to kh-harness with three checks — an intent document (`P3.intent`), a rules registry where every rule names its enforcer (`P3.rules`), and a per-prompt re-injection hook (`P3.reinject`) — following every existing doctrine (evidence-gated, additive, manifest-tracked, reversible).

**Architecture:** A rules parser lives in the shared hook asset `assets/scripts/harness-redact.mjs` (the only module that can reach both `detect` and the installed hook, same direction as `findHandoff`). Two small evidence modules (`intent-evidence.mjs`, `rules-evidence.mjs`) are shared by the gap-model checks and the proposal generators so check and generator cannot drift. One new template, one new hook script, three new checks, one new skill reference.

**Tech Stack:** Node 22+, zero runtime dependencies, `node --test`, existing module conventions.

**Spec:** `docs/superpowers/specs/2026-11-02-intent-and-rules-design.md`

## Global Constraints

- Zero runtime dependencies; Node `>=22`; `npm test` = `node --test "scripts/lib/**/*.test.mjs"`.
- Only a decidable `absent` may propose; the check declares, `buildGaps` enforces. Never `verified` without execution.
- The kit writes no rule, invariant or purpose statement. Template examples live inside HTML comments only.
- Every generated file carries `STAMP_MARKER` via `versionStamp` (render.mjs). Hook scripts import only `./harness-redact.mjs` and node builtins.
- Hook stdout is byte-bounded; credentials pass `maskCredentials`; no hook writes inside the repository.
- Detection never prints a sentence from a user file into `detect.json`: counts and line numbers only.
- Credential-shaped test fixtures are assembled at runtime, never committed as literals (DOGFOOD test).
- Reference markdown wraps at ~75 columns; tests that pin prose use `\s+` between words.
- Commit after each task on branch `feat/intent-and-rules`; attribution trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A registry heading with the id but no em-dash (`## R1 Every query…`) — parser must still yield a rule with id `R1`; tested in Task 1.
2. A rule whose `pointer` is `settings:hooks.Stop` must count as resolved when a Stop hook is registered, not be reported as a missing path; tested in Task 3.
3. A registry whose only content is the untouched scaffold must make `P3.reinject` *not* propose, and the report must say why; tested in Task 4.
4. A `docs/INTENT.md` whose headings are `## Behavior` (US spelling) or `## Non-Goals` must count as present; tested in Task 2.
5. A filled registry must survive `uninstall --yes` as `user-authored-body` while an untouched scaffold is removed; tested in Task 7.

---

### Task 1: Rules parser in the shared asset

**Files:**
- Modify: `assets/scripts/harness-redact.mjs` (append a new section after `findHandoff`)
- Test: `scripts/lib/rules-registry.test.mjs` (create)

**Interfaces:**
- Produces:
  - `export const RULES_PATH = 'docs/harness/RULES.md'`
  - `export const ENFORCERS = ['deny','hook','lint','test','critic','ci','review','none']`
  - `export function parseRules(text) → { rules: Rule[], problems: string[] }` where `Rule = { id: string, rule: string, why: string|null, enforcedBy: string, pointer: string|null, verify: string|null, priority: 'high'|'normal', line: number }`
  - `export function findRules(root) → string|null` (returns `RULES_PATH` when the file exists)

Parsing rules (the algorithm the tests pin):
- Strip HTML comments first (`<!-- … -->`, multi-line), so commented examples never parse.
- A rule starts at a level-2 heading `^##\s+(?<id>[A-Za-z][\w.-]*)(?:\s+[—–-]+\s+|\s+)(?<rule>.+)$`. A `##` heading not matching this shape is a problem: `line N: heading is not "<id> — <rule>"`.
- Keys are bullet lines `^\s*[-*]\s*(\w[\w-]*)\s*:\s*(.*)$` until the next `##`. Key names are case-insensitive; `enforced-by`/`enforcedby`/`enforced_by` all map to `enforcedBy`.
- `enforcedBy` missing → `'none'` plus problem `R1: no enforced-by line — recorded as none`. Value not in `ENFORCERS` → `'none'` plus problem naming the value.
- `priority` other than `high` → `'normal'`.
- Duplicate id → problem `duplicate id R1 at line N`; the later one is dropped.
- CRLF tolerated.

- [ ] **Step 1: Write the failing tests** in `scripts/lib/rules-registry.test.mjs`:

```js
test('parses a heading with id, em-dash and rule, plus keys', …)       // id 'R1', rule text, why, enforcedBy 'critic', pointer, verify, priority 'normal'
test('a heading without an em-dash still yields the id and the rest as the rule', …) // Review Focus 1
test('missing enforced-by is recorded as none and reported as a problem', …)
test('an unknown enforced-by value is recorded as none and reported', …)
test('priority high is kept; anything else is normal', …)
test('a rule inside an HTML comment is NOT parsed', …)
test('duplicate ids keep the first and report the second', …)
test('CRLF input parses identically to LF', …)
test('unknown keys are ignored without a problem', …)
test('empty text yields zero rules and zero problems', …)
test('findRules returns the path when docs/harness/RULES.md exists, else null', …)
```

- [ ] **Step 2: Run** `node --test scripts/lib/rules-registry.test.mjs` — expected FAIL (`parseRules` is not exported).
- [ ] **Step 3: Implement** in `assets/scripts/harness-redact.mjs`, with a header comment explaining (a) why the parser lives in the asset (same reason as `findHandoff`), (b) that the file is Markdown with `key: value` bullets because it is human-edited, (c) that comment-stripping is what keeps template examples inert.
- [ ] **Step 4: Run** the test file — expected PASS. Run `npm test` — expected all green (the asset's existing tests must still pass).
- [ ] **Step 5: Commit** `feat(rules): parse the rules registry in the shared hook asset`.

---

### Task 2: Intent evidence module

**Files:**
- Create: `scripts/lib/intent-evidence.mjs`
- Test: `scripts/lib/intent-evidence.test.mjs`

**Interfaces:**
- Produces:
  - `export const INTENT_PATH = 'docs/INTENT.md'`
  - `export const INTENT_SECTIONS = ['Purpose','Users','Behaviour','Success','Failure','Non-goals','Open questions']`
  - `export function intentSections(text) → { found: string[], missing: string[] }` — matches level-2 headings; comparison is case-insensitive, hyphen/space-insensitive, and accepts `Behavior` for `Behaviour`; returned names are the canonical `INTENT_SECTIONS` spellings.
  - `export function intentEvidence(root) → null | { path: string, found: string[], missing: string[] }`

- [ ] **Step 1: Write the failing tests:**

```js
test('all seven canonical headings are found, none missing', …)
test('Behavior (US) and Non-Goals (capital G) count as present', …)   // Review Focus 4
test('a level-3 heading does not count', …)
test('missing sections are named in canonical order', …)
test('intentEvidence returns null when docs/INTENT.md is absent', …)
test('intentEvidence reads the file and reports found/missing', …)
```

- [ ] **Step 2: Run** — expected FAIL (module not found).
- [ ] **Step 3: Implement.** `intentEvidence` uses `readIfPresent` from `./scan.mjs`.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat(intent): evidence module for docs/INTENT.md sections`.

---

### Task 3: Rules evidence module

**Files:**
- Create: `scripts/lib/rules-evidence.mjs`
- Test: `scripts/lib/rules-evidence.test.mjs`

**Interfaces:**
- Consumes: `parseRules`, `findRules`, `RULES_PATH` from `../../assets/scripts/harness-redact.mjs`; `readIfPresent` from `./scan.mjs`.
- Produces:
  - `export function rulesRegistryEvidence(root, harness) → null | { path, count, byEnforcer: Record<string, number>, unenforced: string[] /* ids */, missingPointers: { id, pointer }[], problems: string[] }`
    - A pointer `settings:permissions.deny` resolves iff `harness.claudeDir.denyRules > 0`; `settings:hooks.<Event>` resolves iff `harness.claudeDir.hookEvents?.[Event]?.length > 0`; any other pointer resolves iff `existsSync(join(root, pointer))` after rejecting absolute paths and `..` segments (a rejected pointer is reported as missing).
  - `export const RULE_SHAPED = /\b(must(?:\s+not)?|never|always|do\s+not|don['’]t|forbidden|required)\b/i`
  - `export function ruleShapedLines(root, harness) → { file: string, lines: number[] }[]` over the instruction file (`harness.instructions.path`) and every `harness.claudeDir.rules` entry; HTML comments and fenced code blocks are stripped before matching; files with zero hits are omitted.

- [ ] **Step 1: Write the failing tests:**

```js
test('returns null when there is no registry', …)
test('counts rules by enforcer and lists unenforced ids', …)
test('a pointer to a missing file is reported with its id', …)
test('settings:hooks.Stop resolves when a Stop hook is registered, and is missing when not', …)  // Review Focus 2
test('settings:permissions.deny resolves iff denyRules > 0', …)
test('an absolute or .. pointer is reported as missing, never resolved', …)
test('ruleShapedLines reports line numbers only, never the sentence', …)
test('ruleShapedLines ignores fenced code and HTML comments', …)
test('ruleShapedLines omits files with no hits', …)
```

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat(rules): registry evidence shared by check and generator`.

---

### Task 4: The three checks, profile steps, phase name

**Files:**
- Modify: `scripts/lib/gap-model.mjs` (append three entries to `CHECKS` after `P1.pathrules`; import from the two evidence modules and `RULES_BRIEF_PATH` from `./propose.mjs`)
- Modify: `scripts/lib/profiles/typescript.mjs:48`, `scripts/lib/profiles/python.mjs:36`, `scripts/lib/profiles/generic.mjs:28` — add `26, 27, 28` to `appliesToSteps()`
- Modify: `scripts/lib/report.mjs:5` — `PHASE_NAMES[3] = 'Intent'`
- Modify: `scripts/lib/propose.mjs` — add and export `const RULES_BRIEF_PATH = '.claude/scripts/rules-brief.mjs'` (the generator comes in Task 6; the constant is needed now so `registeredHook` can identify ours)
- Test: `scripts/lib/gap-model.test.mjs` (append), `scripts/lib/report.test.mjs` (append one test), `scripts/lib/profiles/index.test.mjs` (append one test)

**Interfaces:**
- Consumes: Task 2 and Task 3 exports; `registeredHook(harness, event, ourPath, proposal, { manifest, root })` already in gap-model.mjs.
- Produces check ids `P3.intent` (step 26, phase 3), `P3.rules` (27, 3), `P3.reinject` (28, 3) with the state tables from spec §4.

Exact strings the tests pin:
- `P3.intent` proposal: `run the intent prompt to write docs/INTENT.md`
- `P3.intent` question: `No docs/INTENT.md found, but the repository holds N file(s) with a documentation-shaped name (…). Does one of these already state the application's purpose and its success and failure criteria?`
- `P3.intent` declared evidence, missing sections: `docs/INTENT.md (missing sections: Failure, Non-goals)`; none missing: `docs/INTENT.md (all 7 sections present — presence of the shape is what was measured, not the quality of the prose)`
- `P3.rules` proposal: `scaffold docs/harness/RULES.md — generated EMPTY; rules are added by hand, each with the enforcer that holds it`
- `P3.rules` evidence for an unfilled scaffold: `docs/harness/RULES.md (0 rules — scaffold not yet filled in)`
- `P3.rules` evidence for N rules: `docs/harness/RULES.md: 3 rules — 2 enforced (critic 1, test 1), 1 with enforced-by: none (R3)`; plus one line per missing pointer: `R1: pointer .claude/agents/tenant-scoping.md does not exist`; plus problems each as a line prefixed `registry: `.
- `P3.rules` advice when `ruleShapedLines` is non-empty: `CLAUDE.md holds 4 rule-shaped lines (lines 12, 18, 40, 41) not in docs/harness/RULES.md — consider moving each there with an enforced-by line, so told rules and enforced rules can be told apart` (one advice line per file).
- `P3.reinject` evidence when the registry has zero rules (state `absent`, `decidable: false`, no proposal): question `The re-injection hook has nothing to inject until docs/harness/RULES.md holds at least one rule — add rules, then re-run detect.` Review Focus 3.
- `P3.reinject` when registry absent: state `n/a`? No — `absent`, `decidable: false`, same question (nothing to inject yet). The `n/a` state is reserved for profile inapplicability.
- `P3.reinject` proposal (registry has ≥1 rule, hook not ours): `register a UserPromptSubmit hook that re-injects the registry's rules into every prompt, bounded at 1500 bytes`.

- [ ] **Step 1: Write the failing tests** (gap-model.test.mjs; use the existing `bareHarness`/`byId` helpers and a temp root for file-backed cases):

```js
test('P3.intent: proposes when no documentation exists anywhere', …)
test('P3.intent: asks (undecidable) when documentation-shaped files exist but no docs/INTENT.md', …)
test('P3.intent: declared, naming missing sections', …)
test('P3.intent: declared with the all-present sentence when nothing is missing', …)
test('P3.rules: proposes the scaffold when no registry exists', …)
test('P3.rules: declared with the 0-rules sentence for an unfilled scaffold', …)
test('P3.rules: declared evidence counts enforcers, names unenforced ids and missing pointers', …)
test('P3.rules: never reports verified', …)   // iterate several fixtures, assert state !== 'verified'
test('P3.rules: advice names counts and line numbers, never a sentence', …)
test('P3.reinject: undecidable with the add-rules question when the registry is absent or empty', …)
test('P3.reinject: proposes when the registry has a rule and no hook of ours is registered', …)
test('P3.reinject: declared when OUR path is registered on UserPromptSubmit; a foreign hook is disclosed, not credited', …)
test('P3 checks apply to the generic profile', …)   // selectProfile(nothing).appliesToSteps() includes 26,27,28
```
report.test.mjs: `test('renderSummary names phase 3 Intent', …)`.

- [ ] **Step 2: Run** `node --test scripts/lib/gap-model.test.mjs scripts/lib/report.test.mjs scripts/lib/profiles/index.test.mjs` — expected FAIL.
- [ ] **Step 3: Implement** the three checks following the comment discipline of neighbouring checks (say *why* each state is what it is; cite the shared evidence module so check and generator agree by construction).
- [ ] **Step 4: Run** the three test files, then `npm test` — expected PASS. The rogue-check tests still pass because `buildGaps` is unchanged.
- [ ] **Step 5: Commit** `feat(gap-model): P3.intent, P3.rules, P3.reinject checks`.

---

### Task 5: Registry template and the `P3.rules` generator

**Files:**
- Create: `assets/templates/RULES.md.tmpl`
- Modify: `scripts/lib/propose.mjs` — add `rulesScaffoldProposal` and register `'P3.rules'`; export `RULES_PATH` (re-exported from the asset)
- Test: `scripts/lib/propose.test.mjs` (append)

**Interfaces:**
- Produces: `GENERATORS['P3.rules']` → `[{ kind: 'file', path: 'docs/harness/RULES.md', step: 27, contents, reason: 'no rules registry found' }]`.

Template contract (pinned by tests and by uninstall's `markdownRemainder`):
- Line 1: `{{stamp}}` (renders to an HTML comment).
- A single `# Rules` heading.
- Everything else inside ONE static HTML comment: the schema (heading shape, the seven keys, the `ENFORCERS` list verbatim), one fully worked example rule, the sentence "A rule with `enforced-by: none` is a claim; it is the automation backlog", and the instruction to delete the comment's example rather than uncomment it.
- No placeholder other than `{{stamp}}` (so `markdownRemainder(rendered) === markdownRemainder(template)`).

- [ ] **Step 1: Write the failing tests:**

```js
test('P3.rules generator writes docs/harness/RULES.md from the template with the stamp', …)
test('the rendered scaffold parses to zero rules (every example is inside a comment)', …)  // parseRules(contents).rules.length === 0
test('the scaffold body is nothing but headings and comments (markdownRemainder is empty)', …)
test('SECRET: P3.intent has no registered generator and never will produce a write', …)  // mirror the P2.scripts pin
```
The existing coherence test picks up `P3.rules` automatically.

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Write the template and the generator.**
- [ ] **Step 4: Run** `node --test scripts/lib/propose.test.mjs` then `npm test` — expected PASS.
- [ ] **Step 5: Commit** `feat(propose): scaffold the rules registry`.

---

### Task 6: The re-injection hook and its generator

**Files:**
- Create: `assets/scripts/rules-brief.mjs`
- Modify: `scripts/lib/propose.mjs` — add `reinjectProposal` and register `'P3.reinject'`
- Test: `scripts/lib/rules-brief.test.mjs` (create), `scripts/lib/propose.test.mjs` (append)

**Interfaces:**
- Consumes: `parseRules`, `findRules`, `projectRoot`, `maskCredentials` from `./harness-redact.mjs`.
- Produces: `GENERATORS['P3.reinject']` → three proposals, same shape as `P4.sessionbrief`: the script file (step 28, stamped), `redactAssetProposal(kitVersion)`, and `{ kind: 'settings-hook', event: 'UserPromptSubmit', step: 28, entry: { type: 'command', command: 'node .claude/scripts/rules-brief.mjs' }, requiresFiles: [RULES_BRIEF_PATH, REDACT_PATH], reason: hookRegistrationReason('UserPromptSubmit', check) }`. No `matcher` (UserPromptSubmit takes none).
- Hook constants: `export const RULES_BRIEF_MAX_BYTES = 1500` in the hook script; `HK_RULES_BRIEF_MAX_BYTES` env override for tests.

Hook behaviour (pinned):
- stdout is exactly one JSON object: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}` followed by `\n`.
- `<text>` = `Project rules (docs/harness/RULES.md):\n` then one line per rule `- <id>: <rule> [enforced-by: <x>]`, `high` priority first (stable order within a priority), then if truncated `… <n> more rule(s) in docs/harness/RULES.md`. Total `<text>` ≤ `RULES_BRIEF_MAX_BYTES` bytes; truncation drops whole rules, never mid-line.
- Every rule line passes `maskCredentials`.
- No registry, zero rules, unreadable file, parse failure → no stdout, exit 0.
- Honours `CLAUDE_PROJECT_DIR`.

- [ ] **Step 1: Write the failing tests** (`rules-brief.test.mjs`, spawn pattern from `session-brief.test.mjs`):

```js
test('emits valid JSON with hookEventName UserPromptSubmit and the rules as additionalContext', …)
test('high-priority rules come first', …)
test('byte bound is honoured and announced, dropping whole rules', …)   // set HK_RULES_BRIEF_MAX_BYTES small
test('a credential-shaped value in a rule line is masked', …)          // runtime-assembled fixture
test('no registry → no output, exit 0', …)
test('scaffold with zero rules → no output, exit 0', …)
test('CLAUDE_PROJECT_DIR is honoured from a nested cwd', …)
```
propose.test.mjs: `test('P3.reinject proposes script + redact asset + UserPromptSubmit hook with requiresFiles', …)`, `test('P3.reinject hook entry has no matcher', …)`.

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the hook (header comment: why it fails open, why it is byte-bounded, why no marker state) and the generator.
- [ ] **Step 4: Run** both test files, then `npm test` — expected PASS.
- [ ] **Step 5: Commit** `feat(hooks): UserPromptSubmit rules re-injection`.

---

### Task 7: Allowlist, kit-output set, uninstall

**Files:**
- Modify: `scripts/lib/apply-lib.mjs:34` — `ALLOWED_EXACT` add `'docs/INTENT.md'`
- Modify: `scripts/lib/detect-harness.mjs` — `KIT_OUTPUT_FILES` add `'docs/INTENT.md'`
- Modify: `scripts/lib/uninstall-lib.mjs` — import `RULES_BRIEF_PATH`, `RULES_PATH` from `./propose.mjs`; add both to `GENERATOR_PRODUCIBLE_EXACT`; `templateFor(RULES_PATH)` → `'RULES.md.tmpl'`
- Test: `scripts/lib/uninstall-lib.test.mjs` (append), `scripts/lib/apply-lib.test.mjs` (append one), `scripts/lib/detect-harness.test.mjs` (append one)

- [ ] **Step 1: Write the failing tests:**

```js
// uninstall-lib.test.mjs
test('an untouched RULES.md scaffold with an honest manifest is removed', …)
test('a RULES.md the user filled with one rule is kept as user-authored-body', …)   // Review Focus 5
test('rules-brief.mjs is generator-producible', …)
// apply-lib.test.mjs
test('docs/INTENT.md is on the write allowlist', …)
// detect-harness.test.mjs
test('a pointer at docs/INTENT.md is kit output, not a credited doc pointer', …)
```

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(apply,uninstall): phase-3 paths are allowed, producible and reversible`.

---

### Task 8: Lifecycle test for the Phase 3 cycle

**Files:**
- Test: `scripts/lib/lifecycle.test.mjs` (append one test using a fixture modelled on `fixture()`)

- [ ] **Step 1: Write the failing test** `PHASE 3 LIFECYCLE: scaffold → fill → hook → uninstall keeps the filled registry`:
  1. detect: `P3.rules` absent with proposal; `P3.reinject` undecidable; `P3.intent` absent with proposal (fixture has no docs).
  2. `apply --yes`: `docs/harness/RULES.md` exists, parses to 0 rules; no `UserPromptSubmit` hook.
  3. detect: `P3.rules` declared with the 0-rules sentence; `P3.reinject` still undecidable.
  4. Append one rule (id `R1`, `enforced-by: test`, `pointer: package.json`) to the registry; commit (`apply` refuses a dirty tree).
  5. `apply --yes`: `rules-brief.mjs` and `harness-redact.mjs` exist; `settings.hooks.UserPromptSubmit.length === 1`.
  6. detect: `P3.rules` declared with `1 rules — 1 enforced (test 1)`; `P3.reinject` declared.
  7. Run the hook with `CLAUDE_PROJECT_DIR` = fixture: JSON contains `R1`.
  8. `uninstall --yes`: hook reverted, `rules-brief.mjs` removed, `RULES.md` kept with reason `user-authored-body`.
- [ ] **Step 2: Run** `node --test scripts/lib/lifecycle.test.mjs` — expected FAIL until the earlier tasks are all in place (if run after them, it should pass on first try; if it fails, the failure is a real integration defect — fix it, do not weaken the test).
- [ ] **Step 3: Run** `npm test` — PASS.
- [ ] **Step 4: Commit** `test(lifecycle): phase 3 end to end`.

---

### Task 9: Skill reference and phase table

**Files:**
- Create: `skills/harness-init/references/phase-3-intent.md`
- Modify: `skills/harness-init/SKILL.md` — phase table gains row `| 3 | 26, 27, 28 | prompt, script+prompt, script | [references/phase-3-intent.md](references/phase-3-intent.md) |` placed between the Phase 1 and Phase 2 rows (spec §10 Q1 — my call)
- Test: `scripts/lib/skill-prompts.test.mjs` (append), `scripts/lib/skill-phases.test.mjs` (append)

Reference content (spec §5), with these sentences present verbatim-enough for the tests:
- Step 26 instructs to **write docs/INTENT.md** after reading the repository, lists the seven sections, says a section that cannot be answered goes under **Open questions** rather than a guess, and pairs "gate" with "wait".
- Step 27 says the scaffold is generated EMPTY, that proposed entries get `enforced-by: none` unless a real enforcer was found and named, and that the skill **never invents an enforcer**.
- Step 28 says, near the gate, that the hook **reads one file and executes nothing else**, and names the **1500**-byte bound.
- States that `docs/INTENT.md` has no template.

- [ ] **Step 1: Write the failing tests:**

```js
// skill-prompts.test.mjs
test('the intent step writes docs/INTENT.md and routes unknowns to Open questions', …)   // /\bwrite\b[^.]*docs\/INTENT\.md/i and /open\s+questions/i near /guess/i
test('the intent step has no template', …)                                               // doesNotMatch /INTENT\.md\.tmpl/
test('the rules step never invents an enforcer', …)                                      // /never\s+invent[^.]*enforcer/i
// skill-phases.test.mjs
test('step 28 discloses, near its gate, that the hook reads one file and executes nothing else, and names the byte bound', …)
test('SKILL.md phase table has a phase 3 row linking phase-3-intent.md', …)
```
`skill-links.test.mjs` covers link integrity automatically.

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Write the reference and the table row.**
- [ ] **Step 4: Run** the skill tests, then `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(skill): phase 3 — intent and rules`.

---

### Task 10: Dogfood — kh-harness's own intent and rules

**Files:**
- Create: `docs/INTENT.md` (kh-harness's own; content from spec §8, written as prose, not from a template)
- Create: `docs/harness/RULES.md` (R1–R5 from spec §8 with real pointers)
- Test: `scripts/lib/dogfood-intent.test.mjs` (create)

- [ ] **Step 1: Write the failing test:** run `intentEvidence(ROOT)` → `missing` is `[]`; run `rulesRegistryEvidence(ROOT, detectHarness(ROOT, files))` → `missingPointers` is `[]`, `problems` is `[]`, `count >= 5`, `unenforced` is `[]` or contains only ids whose `enforcedBy` is `review`.
- [ ] **Step 2: Run** — expected FAIL (files absent).
- [ ] **Step 3: Write both documents.** `docs/harness/` is gitignored? Check `.gitignore` (it currently lists what?) — if `docs/harness/` is ignored, the registry cannot be tracked there for this repository; in that case add a negation `!docs/harness/RULES.md` and say why in `.gitignore`.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS (the DOGFOOD security test must still pass: write no credential-shaped prose).
- [ ] **Step 5: Commit** `docs: kh-harness's own intent and rules registry`.

---

### Task 11: CLI text and README

**Files:**
- Modify: `scripts/lib/cli.mjs` — `EXECUTION_DISCLOSURE` gains a `UserPromptSubmit (per prompt)` row: reads `docs/harness/RULES.md` and prints up to 1500 bytes of it; executes nothing.
- Modify: `README.md` — "The three commands" table of hooks gains the row; a new section "Intent and rules" (what the two documents are, the `enforced-by` idea, that told and enforced rules are reported differently, that the kit never writes a rule).
- Test: `scripts/lib/cli.test.mjs` (append one assertion that the disclosure names `UserPromptSubmit` and `executes nothing`).

- [ ] **Step 1: Write the failing test.**
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Edit the text.**
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `docs: disclose the re-injection hook; document intent and rules`.

---

### Task 12: Whole-branch verification

- [ ] **Step 1:** `npm test` — all pass, 0 fail.
- [ ] **Step 2:** `node scripts/detect.mjs .` — Phase 3 shows `P3.intent declared`, `P3.rules declared` with 5 rules, `P3.reinject` undecidable or absent (the kit does not install hooks on itself). Paste the Phase 3 block into the PR description.
- [ ] **Step 3:** `claude plugin validate . --strict` — exit 0.
- [ ] **Step 4:** Run the kit against a throwaway clone of `cashmigo` (clone with `git clone --local --no-hardlinks` into the scratchpad, never the source): detect → apply → detect; confirm the Phase 3 cycle and that nothing outside the allowlist changed (`git status`).
- [ ] **Step 5:** Dispatch a fresh reviewer (superpowers:requesting-code-review) on the branch diff.
