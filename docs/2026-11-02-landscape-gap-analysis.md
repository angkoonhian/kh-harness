# kh-harness against the 2026 harness landscape — gap analysis

- **Date:** 2026-11-02
- **Kit under review:** `kh-harness 0.1.0` at `59893f7`, `npm test` = 749 pass / 0 fail / 1 skipped
- **Method:** read every non-test source file and skill reference; read the three real `detect.json` reports the kit has produced (`oxen/2026`, `cashmigo`, `hobby/sitewatch`); three parallel web sweeps (official vendor docs, community frameworks with live GitHub star counts, business-rules and quality-measurement literature). Every external claim below carries its URL. Claims about kh-harness itself were checked against the code, not the README.

---

## 0. Verdict

kh-harness is the most *careful* installer in its category: additive-only, evidence-gated, manifest-tracked, reversible, with a credential sweep that refuses to go silent. Nothing surveyed matches that discipline. But it is a v1 that automates the **mechanical half** of a 25-step runbook and stops. Three things stand between it and "extremely robust and actually increases quality":

1. **It cannot show that it improves anything.** The eval suite is documented as unable to measure the skill, and the 2026 literature is now clear that instruction files alone do *not* raise task success. The measurable wins are adherence, blocked violations and efficiency, and the kit measures none of them.
2. **It has no concept of a rule.** Everything it installs is either a file for a human to fill in or a hook that runs an existing script. There is no registry of the project's invariants, no link from a rule to the mechanism that enforces it, and no detection of rules that are stated but unenforced. This is the "business rules manager" gap, and it is the single highest-leverage addition because it fits the kit's own claim-versus-evidence doctrine exactly.
3. **On real repositories it under-delivers.** `P0.security` is `failing` on all three real targets, mostly from test fixtures and planning docs; the 20-repo umbrella fell to `generic` and got one actionable proposal; and your own `oxen/2026` harness (13 critic agents, an orchestration router) has outgrown what the kit knows how to detect.

Everything below is ordered by leverage.

---

## 1. What the three real runs show (local evidence)

| Repo | Profile | Checks absent with a proposal | `P0.security` | Notes |
|---|---|---|---|---|
| `oxen/2026` | **generic** | 1 (`P4.remote`) | failing (6) | 20 nested repos detected; stack confidence < 0.5; path-rules became a question |
| `cashmigo` | typescript-workspace | 0 (all applied) | failing (5) | sensor question: "5 packages, may be too slow" left unanswered |
| `hobby/sitewatch` | python | 10 | failing (3) | all 3 hits are `credentials-in-doc literal` in `tests/` and a plan doc |

Findings:

- **F1. The security check is red everywhere, for the wrong reasons.** Of 14 exposures across the three repos, 11 are `credentials-in-doc` with a `literal` value, and the locations are `tests/test_runtime.py`, `docker-compose.yml`, `ci.yml`, and `docs/superpowers/plans/*.md`. The README's own warning applies: "it always says failing here" is how a real finding gets normalised into noise. The project's rule against an ignore list is right, but there is a third option between "ignore" and "fail": **classify by path role and value shape, and only let `high` drive the state.** A `password = "test"` in a `tests/` directory under a `docker-compose.yml` is a `fixture-credential` finding, reported but not failing. Evidence for the role comes from the path and from the manifest (`tests/`, `__tests__/`, `*.test.*`, `fixtures/`, compose/CI files), which is detection, not suppression.
- **F2. Umbrella repositories are a dead end.** `oxen/2026` holds 20 nested repos and the kit correctly refuses to recurse. But "assess each separately" is the entire output. An umbrella mode that runs `detect` per nested repo and prints one roll-up table (profile, proposals, exposures per child) is pure read-only detection and would have turned a useless report into a useful one.
- **F3. Three languages.** `detect-stack.mjs` recognises TypeScript, JavaScript and Python only. Go, Rust, Java/Kotlin, Ruby, PHP, C#, Swift all fall to `generic`, which disables every stack-specific check. A profile is "a detection adapter and a command vocabulary" per the spec, so each new one is small: manifest name, lockfile → install command, canonical lint/typecheck/test tools.
- **F4. Two `couldNotDerive` questions recur on every workspace and are never answered.** "Which packages should the sensor cover" and "which CLAUDE.md rules cannot be re-derived" appear on every run and have no path to resolution. A question with no follow-up is a question the user learns to skip.
- **F5. The generated hooks fail open.** `propose.mjs` registers `{ type: 'command', command: 'node …' }` with no `onFailure`. Claude Code hooks fail open by default; `onFailure: "block"` exists (v2.1.295+) precisely so a crashed or timed-out guard blocks instead of silently passing. For the lint sensor, open is correct. For any future credential or protected-path guard, it is not. Source: https://code.claude.com/docs/en/hooks
- **F6. Nothing verifies the harness after install.** `apply` checks that the script files exist before registering a hook, which is good. Nothing afterwards checks that the hook actually fired, that `CLAUDE.md` does not contradict `package.json`, or that the handoff is still current. Claude Code ships `/doctor prompt-audit` for exactly the contradiction case; the kit never mentions it. Source: https://code.claude.com/docs/en/memory

---

## 2. Capability matrix

Thirty capability categories were observed across ~45 tools (star counts live from the GitHub API on 2026-11-02). Condensed to what matters for an additive repo installer:

| Capability | Who does it well | kh-harness |
|---|---|---|
| Evidence-based instruction file | everything-claude-code (294k), beads, aider | **Yes** |
| Path-scoped rules | Cursor `.mdc`, Copilot `applyTo`, agent-os standards discovery | **Partial** — scaffolds only, never derives a convention from code |
| Architecture doc | OpenAI `docs/` as system of record, Devin DeepWiki | **Yes** (prose only) |
| **Invariants / business rules with "Enforced by"** | Adobe ai-repo-harness-guide `INVARIANTS.md`, spec-kit constitution, Evolu ADR rules | **No** |
| **Architecture constraint linting** | dependency-cruiser (7.4k), eslint-plugin-boundaries, import-linter, ArchUnit, archfit | **No** |
| Cross-tool rule sync (AGENTS.md standard) | ruler (3.0k), rulesync, native Claude Code AGENTS.md support v2.1.277+ | **No** — inventories `.cursor/rules` etc., proposes nothing |
| Spec / plan / task docs with gates | spec-kit (145k), OpenSpec (73k), BMAD (55k), cc-sdd | **No** (out of scope by design, correctly) |
| Task tracker for agents | beads (28k), taskmaster | **No** |
| Cross-session continuity | HANDOFF conventions, `thepushkarp/handoff` PreCompact capture, Anthropic `feature_list.json` | **Partial** — template + SessionStart brief; no staleness check, no PreCompact/SessionEnd capture |
| PostToolUse lint / Stop verify gates | claudekit, aider `--lint-cmd`, gstack `/verify` | **Yes** (strongest in class on bounding and redaction) |
| Hook policy engine (TDD, tests-before-commit, forbidden patterns) | tdd-guard → Probity policy file | **Partial** — protected paths only |
| Destructive-command guard | gstack `/careful`, disler hooks, claudekit file-guard | **No** Bash patterns; Edit denies only |
| Secret scanning | gitleaks (30k), trufflehog, Semgrep | **Partial** — tracked-file shapes, no history, no pre-commit install |
| Git-hook manager / commitlint / ADR / Danger | pre-commit, husky, lefthook, commitlint AI guide, adr-tools, log4brains | **No** |
| Autonomous loop / converge | official `ralph-loop`, spec-kit converge | **No** |
| Worktree isolation, subagents, critics | superpowers, vibe-kanban, your own `oxen/2026` agents | **No** (runbook 17–19 deferred) |
| Cost / observability | ccusage (19k), OTel metrics, `InstructionsLoaded` hook | **No** |
| Harness self-audit | AgentShield, `/doctor prompt-audit`, `/skill-doctor` | **Partial** — inventory + credential scan only |
| Reversible install with manifest | ruler `revert`, kh uninstall | **Yes** — best surveyed |
| Measurement of effect | `claude plugin eval`, mutation testing, critic-loop studies | **No** — suite cannot engage the skill |

Sources: community inventory from the live GitHub API; https://github.com/github/spec-kit ; https://github.com/steveyegge/beads ; https://github.com/intellectronica/ruler ; https://github.com/dyoshikawa/rulesync ; https://github.com/nizos/probity ; https://github.com/carlrannaberg/claudekit ; https://github.com/garrytan/gstack ; https://github.com/alexei-led/archfit ; https://opensource.adobe.com/ai-repo-harness-guide/04-Harness-Components/ ; https://code.claude.com/docs/en/best-practices ; https://code.claude.com/docs/en/hooks ; https://code.claude.com/docs/en/plugin-evals

---

## 3. What the evidence says about "increases quality"

This matters because it decides *what* the kit should optimise for.

- **Gloaguen et al., "Evaluating AGENTS.md"** (v3, 2026-09-29): context files "do not generally improve task success rates" and raise inference cost by 20%+ on average; agents *do* follow the instructions; files help "for specifying non-standard coding practices"; repository overviews are not helpful. https://arxiv.org/abs/2602.11988
- **Khatri** (288 runs, Claude Code + Codex): no measurable correctness change within a 10–15 pp equivalence bound. https://arxiv.org/abs/2607.27250
- **McMillan factorial** (1,650 sessions): file size, position, architecture, contradictions in adjacent files have no detectable effect; **compliance decays about 5.6% in odds per additional generated function**. Within-session decay dominates. https://arxiv.org/abs/2605.10039
- **Lulla et al.** (124 PRs): AGENTS.md associated with 28.6% lower median runtime and 16.6% fewer output tokens, comparable completion. https://arxiv.org/abs/2601.20404
- **Otterson**: a critic loop killed ~78% of surviving mutants (95% CI 0.59–0.93). https://arxiv.org/abs/2607.23002
- **Agent READMEs corpus** (2,303 files): tests 76%, implementation 71%, architecture 68%, **security 15%, performance 15%**. Non-functional invariants are the under-documented class. https://arxiv.org/abs/2511.12884
- **Anthropic's own framing** (best practices): CLAUDE.md is non-deterministic; "if you keep adding emphasis to a CLAUDE.md line and Claude still misses it, that's a sign the line belongs in a hook"; "describe your architecture in CLAUDE.md" is listed under *stop doing*; keep the enforced set small. https://code.claude.com/docs/en/best-practices

**Implication.** The quality case for kh-harness cannot rest on CLAUDE.md or ARCHITECTURE.md. It rests on (a) deterministic enforcement of a *small* set of rules, (b) re-injection against within-session decay, (c) critics/verification loops, and (d) measuring adherence and blocked violations rather than claiming better code. The kit's instincts are already aligned with this; its feature set is not.

---

## 4. Recommendations, by leverage

### Tier 1 — the business rules layer (the "business rules manager")

This is the one addition that changes what the tool *is*, and it is the shape most consistent with the existing doctrine.

**R1. A rules registry: `docs/harness/RULES.md` (or `INVARIANTS.md`).** One entry per rule, each with: `id`, the rule in one sentence, `why` (one sentence), `enforced-by: hook | deny | lint | test | ci | none`, and a pointer to the enforcer. Prior art: the Adobe guide's `INVARIANTS.md` with "Enforced by:" annotations, where `[not yet enforced]` *is* the automation backlog; spec-kit's constitution with a justified-violation table; Evolu's "if a task conflicts with an accepted ADR, stop and ask". The kit should **never author a rule** (that is the user's judgement), but it can:
- **detect** rule-shaped sentences already in `CLAUDE.md`, `.claude/rules/*.md`, `ARCHITECTURE.md` ("must", "never", "always", "do not") and propose moving them into the registry with `enforced-by: none`, which is just the kit's existing `declared` state applied to a sentence;
- **report** the ratio of enforced to unenforced rules as a check (`P1.rules`), with the unenforced list as the proposal queue;
- **propose the cheapest enforcer** for the rule classes it can recognise, each evidence-gated:
  - "never edit X" → `permissions.deny` `Edit(X)` (already have this machinery);
  - "never read secrets" → `Read(./.env)`, `Read(./secrets/**)` denies, which hold in every permission mode;
  - "never run X" → PreToolUse Bash pattern (see R4);
  - "A must not import B" → a dependency-cruiser / import-linter / eslint-plugin-boundaries config (see R2);
  - "run tests before commit" → Probity-style `requireCommand` or a PreToolUse on `git commit`.
- **re-inject the top N rules** per turn via a `UserPromptSubmit` hook emitting `additionalContext`, bounded to a few hundred bytes. This is the only known countermeasure to McMillan's within-session decay, and it is cheap.

**R2. Architecture fitness functions derived from the workspace layout.** The kit already enumerates packages and their directories. For a TypeScript workspace it can propose a `.dependency-cruiser.cjs` whose only rules are "no circular" and "no package imports another package's `src/` directly", both derivable from structure; for Python, an `.importlinter` contract per package. Each is `enforced-by: lint` for an architecture rule, and the kit's existing PostToolUse sensor already runs the lint script. OpenAI's harness-engineering post describes exactly this move: "when documentation falls short, we promote the rule into code", with lint messages that inject remediation into the agent's context. Only propose when the tool's config is absent *and* the workspace has ≥2 packages.

**R3. Make `P1.instructions` an audit, not a line count.** Today it reports `declared` plus a 150-line note. It should check for the things the kit already knows: does `CLAUDE.md` name a command that `package.json` does not declare (contradiction)? Does it reproduce a directory tree (Anthropic says stop)? Is it over 200 lines (Anthropic's target)? Is `/doctor prompt-audit` clean? Each is evidence the kit holds already, so each is a legitimate `declared`-with-evidence finding rather than a guess.

### Tier 2 — guardrails and continuity hardening

**R4. A PreToolUse guard layer.** The kit has Edit denies but no Bash guard, and auto mode is now the default for interactive sessions. Propose, evidence-gated: `Read` denies for `.env*` and `secrets/**` when such files exist; a PreToolUse Bash hook that blocks `git push --force` to the default branch, `rm -rf` outside the repo, and `curl … | sh`; `onFailure: "block"` on that hook. The guard script should reuse `harness-redact.mjs` and the marker machinery exactly as the other two hooks do. Note the documented limit: Bash permission rules match text, so `git -C . push` evades `Bash(git push *)`; a hook that parses the command is the right layer, and the kit should say so.

**R5. Secret scanning at commit time.** When a hook manager is detected (`.pre-commit-config.yaml`, `.husky/`, `lefthook.yml`), propose a `gitleaks protect --staged` entry. When none is detected, propose nothing and say why. Also add a one-shot **history** scan as a `--verify`-class option, since the current sweep reads only the working tree and a rotated-then-deleted token is the common case.

**R6. Handoff staleness and capture.** Three additions, all mechanical:
- stamp `HANDOFF.md` with the HEAD SHA and timestamp when it is written or updated;
- in `session-brief.mjs`, if HEAD has moved more than N commits since the stamp, or any file the handoff names no longer exists, print a one-line **stale** warning before the brief (drift-linter pattern);
- register a `PreCompact` hook that re-emits the top of the handoff so the summary keeps it, and a `Stop` or `SessionEnd` nudge that notes when the handoff's "Where I stopped" section is unchanged since session start. For long autonomous runs, offer Anthropic's `feature_list.json` (status flips only, JSON because the model alters it less) as an alternative to prose.

**R7. Cross-tool instruction files.** Claude Code now reads `AGENTS.md` natively; Codex, Jules, Gemini CLI, Copilot, Cursor, Amp, Factory, Cline all read it; the kit already inventories `.cursor/rules`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`. Propose `AGENTS.md` as the shared file and a two-line `CLAUDE.md` shim (`@AGENTS.md` import, which is Anthropic's own Windows recommendation over a symlink), *only when* a second tool's rule file is detected. When none is, do nothing.

**R8. Critics derivation (runbook 17–19).** Your `oxen/2026` has 13 subagents (`tenant-scoping`, `cross-tenant-leak`, `jwt-lifecycle`, `queue-backpressure`, …) and a router. That is the mature form of the harness, built by hand. The kit can detect `.claude/agents/*.md` and report count and coverage, and for the common invariant classes it can recognise from the registry in R1 (tenancy, auth, money, migrations), propose an **empty-bodied** critic scaffold with the rule id in its frontmatter, the same way path rules are scaffolded empty today. Otterson's 78% mutant-kill result is the strongest quality evidence in the whole literature, and it is for critic loops.

### Tier 3 — breadth and ergonomics

- **R9. More profiles.** Go, Rust, Java/Kotlin (Gradle/Maven), Ruby, PHP, .NET. Each ≈ 80 lines by the existing profile interface.
- **R10. Umbrella mode.** `detect --recurse-nested` that runs detection per nested repository and prints one roll-up. Read-only, so no new write surface.
- **R11. Answerable questions.** Give the two recurring `couldNotDerive` questions a resolution path: a `docs/harness/answers.json` the user fills in once (sensor package list, non-derivable CLAUDE.md rule ids) that `apply` reads. Without it, every run re-asks.
- **R12. Windows parity.** Hooks are `node …` and portable; `bootstrap.sh` is bash-only and the `.ps1` twin was dropped. Claude Code hooks now accept `shell: "powershell"` and Claude Code no longer requires Git Bash on Windows, so a `bootstrap.ps1` derived from the same `installCommand` is cheap and the Windows CI job already exists to test it.
- **R13. Headless disclosure.** `--bare` skips CLAUDE.md, hooks, skills and memory, so every gate the kit installs is absent in `--bare` CI runs. One sentence in `EXECUTION_DISCLOSURE` and the README.
- **R14. A `/handoff` skill** that writes the handoff sections from the transcript, gated like every other prompt step, so the continuity capability has a producer and not only a consumer.
- **R15. Sandbox proposal.** On macOS/Linux/WSL2, propose a `sandbox` settings block when `.env` files or deploy scripts are detected; say plainly that native Windows has no sandbox.

### Tier 1 again — measurement (this is what makes every claim above honest)

**R16. An eval that can engage the skill.** The suite cannot run because `disable-model-invocation: true` hides the skill and the runner passes prompts verbatim. Two routes that keep the product decision intact: (a) a thin, model-invocable companion skill (`harness-check`, read-only, runs `detect` and summarises) that the eval *can* exercise, with `tool_used`/`file_exists`/`regex` graders; (b) test the CLIs directly under `claude -p` with `--max-turns` and the kit's own `--json` output as the oracle. Pin `--model`, run ≥3 per arm, use `--ablation with-without`.

**R17. Measure adherence and blocked violations, not "better code".** Instrument what the kit already controls: count Stop-gate blocks per session (the marker files already exist), count PreToolUse denies, record `InstructionsLoaded` events, and surface a per-session "harness report" (ccusage-style, from local logs). Those numbers can be compared with and without the harness on the same task set. That is the claim the literature will let you make.

---

## 5. What not to change

The following are the kit's differentiators and every surveyed competitor that lacks them has the corresponding complaint in its issue tracker:

- No readiness score. The gap model stays the runbook.
- No `--force`, no ignore list, no templates carrying framework opinions.
- `absent` + `decidable` as the only path to a proposal; rogue-check tests guarding it.
- Manifest by content hash; uninstall by hash and marker.
- Hooks bounded in time and bytes, routed through one redaction chokepoint.
- `disable-model-invocation: true` on the installer skill.

Any item in §4 that would require weakening one of these should be dropped, not negotiated.

---

## 6. Suggested v0.2 check list

| id | step | kind | state logic | proposal when `absent` |
|---|---|---|---|---|
| `P1.rules` | new | script + prompt | registry present → `declared`; every rule has an enforcer → `verified` | migrate rule-shaped sentences into `docs/harness/RULES.md` with `enforced-by: none` |
| `P1.instructions` | 6 | script | add contradiction / tree / 200-line audits as evidence | unchanged |
| `P1.crosstool` | new | script | second tool's rule file detected and no `AGENTS.md` → `absent` | `AGENTS.md` + `@AGENTS.md` shim |
| `P2.archlint` | 20 | script | workspace ≥2 packages and no boundary-lint config → `absent` | dependency-cruiser / import-linter config, no-circular + no-cross-src rules |
| `P2.guard` | new | script | no PreToolUse Bash guard registered → `absent` | guard hook with `onFailure: block`, plus `Read(.env*)` denies when such files exist |
| `P2.precommit` | new | script | hook manager detected and no secret-scan entry → `absent` | `gitleaks protect --staged` entry |
| `P3.critics` | 17–19 | script + prompt | `.claude/agents/*.md` count and rule coverage | empty critic scaffold per recognised invariant class |
| `P4.handoff` | 16 | script | add staleness (SHA, missing paths) to evidence | PreCompact re-inject + Stop nudge |
| `P4.reinject` | new | script | no `UserPromptSubmit` re-injector → `absent` | top-N rules `additionalContext` hook, byte-bounded |
| `P0.security` | 3 | script | split `fixture-credential` from `credentials-in-doc`; only `high` drives `failing` | unchanged |

Order of implementation that pays back fastest: R16/R17 first (so every later change is measured), then R1, R4, R6, R2, R7, then breadth.
