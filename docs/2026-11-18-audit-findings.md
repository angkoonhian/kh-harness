# kh-harness audit — second pass, after the Tier 1–4 fixes

- **Date:** 2026-11-18, branch `angkoonhian/fireworm` @ `25ae270`
- **Method:** three parallel read-only audits (CLI core; generated hooks and evidence modules; skill, docs, tests, CI and product). Each probed throwaway repositories outside the worktree. A finding marked **[ran]** was reproduced by an auditor with a probe; **[reasoned]** was derived from code or from the Claude Code documentation and not executed; **[unverified]** names the part that could not be confirmed. None was re-run by a second party.
- **Baseline:** `npm test` — 1010 tests, 1009 pass, 0 fail, 1 skipped (the POSIX mode-bit test on win32). The Tier 1 fixes sampled (unborn HEAD, CRLF hashing, placeholder-then-literal) hold.
- **Counts:** 1 critical, 18 high, 36 medium, 21 low.

The findings share three causes:

1. **"Could not look" collapses into "nothing there"** at input boundaries (C1, C4, C7, C8, C10).
2. **Suppression state in the hooks only grows**, and "nothing to say" shares exit 0 with "could not check" (H1, H2, H5, H7, M3, M11, L2).
3. **Safety machinery is applied per call site, not per effect** (C5, C6, C15), and the skill describes gates the CLI cannot honour (S2, S3).

IDs: `C` core CLIs and libraries, `H`/`M`/`L` hooks by severity, `S` skill, `D` documentation, `T` tests, `CI` workflows, `E` evals, `P` product.

---

## Critical

**C1. A failed fallback walk becomes an empty file list, and `P0.security` says `verified`.** [ran]
`scripts/lib/scan.mjs:243` (`walkFiles(root) ?? []`), `:249-256`. In a non-git directory any `readdirSync` error anywhere discards the whole walk; the sweep reads nothing and prints the clean-sweep sentence. Reproduced with a `ghp_…` file present and an unrelated sibling directory made unreadable.
*Fix:* catch per directory, keep what was read, return unreadable directories as `file-unreadable` findings; a total walk failure makes the check `failing`.

## High — core

**C2. The credential patterns miss shapes the hook mask already knows.** [ran]
`scripts/lib/detect-exposure.mjs:44-59`, `:71`. A tracked env file with a URL-userinfo password, `AWS_SECRET_ACCESS_KEY`, an `hf_` token, a bare JWT, a Slack webhook, `DB_PASS=`, a SendGrid key and a quoted password containing spaces returned `verified`.
*Fix:* one pattern table shared by the sweep and `assets/scripts/harness-redact.mjs`.

**C3. Tracked files under any `build/` or `dist/` segment are never scanned.** [ran]
`scripts/lib/detect-exposure.mjs:259`, `:326`. In git mode the list already respects `.gitignore`, so these are tracked files skipped with no count.
*Fix:* no directory-name skips in git mode; report a count per deliberate skip class.

**C5. A forged manifest makes `uninstall --yes` strip the user's own deny rules and hooks, exit 0.** [ran]
`scripts/lib/settings-merge.mjs:218-250`, `:254-266`; `scripts/lib/uninstall-lib.mjs:598-608`. File entries have three provenance gates; settings patches have none. `settings.json` became `{}` and the manifest was deleted.
*Fix:* revert only hook entries whose script is a generator path, and only deny rules a generator can produce; verify `entrySha256`.

**C6. `detect`'s one write has no containment check.** [ran]
`scripts/detect.mjs:72-76`. With `docs/harness` as a junction, `detect` overwrote a file outside the repository.
*Fix:* `assertContained` before the write, exit 2 on refusal, atomic write.

## High — hooks

**H1. The Stop gate disables itself after three blocks in a session.** [ran]
`assets/scripts/verify-touched.mjs:318-321`; `MAX_BLOCKS_PER_SESSION` in `harness-redact.mjs:869`. `count` never resets on a pass.
*Fix:* reset on a passing run; make the cap consecutive-without-pass.

**H2. A failure that recurs after a pass is suppressed as already reported.** [ran]
`verify-touched.mjs:323-327`; lint twin at `lint-touched.mjs:402-409`.
*Fix:* clear `lastSignature` and the per-file lint entry on a clean run.

**H3. Layer-1 redaction drops every diagnostic naming a directory in the command.** [ran]
`verify-touched.mjs:316`. With `-p packages/app` every tsc line is removed and the model gets only the redaction notice.
*Fix:* exempt tokens that resolve to an existing path, or remove layer 1 for path-shaped tokens.

**H4. The whole-command substring match drops diagnostics for a one-word script.** [ran]
`harness-redact.mjs:152`. `"lint": "eslint"` leaves only the bare file path.
*Fix:* token-boundary match with a length floor.

**H5. The lint sensor drops new errors after three distinct reports per file.** [ran]
`lint-touched.mjs:411`.
*Fix:* never suppress; at the cap emit a one-line count; reset on clean.

**H6. In a worktree the Stop gate verifies the main checkout.** [reasoned from the hooks reference; the hook ignoring payload `cwd` ran]
`harness-redact.mjs:313`.
*Fix:* prefer the payload `cwd`'s git top level, or state which checkout was verified.

**H7. A missing linter, a crashed linter and a timeout are all reported as clean.** [ran]
`lint-touched.mjs:504`, `:531`.
*Fix:* a once-per-session "could not check this file" message.

## High — skill and product

**S1. The skill never says where the CLIs live.** `skills/harness-init/references/detect.md:11`, `phase-1-legible.md:9`, `phase-3-intent.md:68`. Under a plugin install the working directory is the target repository. [unverified: how reliably the model infers the path]
*Fix:* one explicit path line in `SKILL.md`, with a test.

**S2. Phase gating is not real for script steps.** [ran] `apply` has no scope flag; the first `apply --yes` installs both executing hooks before the Phase 2 disclosure is read. `phase-2-sensors.md:159-162` is then false.
*Fix:* `apply --only <check-id|phase>`, or one disclosed gate.

**S3. The skill omits the two `apply` gates, exit 3 and stale-report handling.** `SKILL.md:40-42`.
*Fix:* a "before any `--yes`" section; always re-run `detect`.

**D1. `apply` says "already satisfies every applicable step" when it does not.** [ran] `scripts/apply.mjs:297`; `scripts/lib/report.mjs:155`.
*Fix:* "nothing apply can write; N checks still absent, M questions open".

**D2. "A proposal is something `apply` can write" is false for three checks.** [ran] `P0.recon`, `P1.instructions`, `P4.remote` carry proposals with no generator; counts are wrong.
*Fix:* a `kind` per proposal (`apply` / `skill` / `human`).

**P1. No upgrade path for an installed harness.** [ran] `scripts/lib/propose.mjs:663-692` runs only for `absent` checks. A simulated upgrade with all four hook assets changed produced "no actions".
*Fix:* a version-skew check in `detect`; update actions for `ours-unmodified` files.

**P2. No CI or team enforcement mode.** `detect` exits 0 on a failing security check and dead rule pointers.
*Fix:* `detect --check` with non-zero exits.

## Medium — core

- **C4.** A credential in a remote's push URL is not seen. [ran] `scripts/lib/detect-harness.mjs:387-392`. *Fix:* OR across every line per remote.
- **C7.** An unparseable `settings.json` (UTF-8 BOM) leaves hook scripts installed but unregistered, exit 0; `detect` reports the file as missing. [ran] `scripts/lib/apply-lib.mjs:640-646`, `:680-685`; `scripts/lib/detect-harness.mjs:67-71`. *Fix:* strip the BOM; make unparseable its own state; exit 2.
- **C8.** An unparseable `package.json` is reported as missing a lint script. [ran] `scripts/lib/detect-stack.mjs:17-20`, `:106`. *Fix:* a `manifestUnreadable` flag and a question.
- **C9.** The bootstrap script is assembled from mismatched evidence (`pip install` for a JS repository; the `npm init` placeholder test). [ran] `scripts/lib/detect-stack.mjs:9-13`; `scripts/lib/profiles/typescript.mjs:5`. *Fix:* per-ecosystem install commands; treat the placeholder body as no test.
- **C10.** A structurally odd manifest crashes `apply` and `uninstall` with exit 1. [ran] `scripts/lib/manifest.mjs:46-48`. *Fix:* validate entry shapes; return `corrupt`.
- **C11.** Targeting a sub-directory: the second `apply --yes` is refused over the kit's own writes. [ran] `scripts/apply.mjs:118-139`. *Fix:* strip the `--show-prefix`.
- **C12.** `--verify` results are never rendered and change no state. [ran] `scripts/detect.mjs:64-66`; `scripts/lib/report.mjs:129-176`.
- **C13.** A `--verify` timeout orphans the process tree. [ran] `scripts/lib/verify.mjs:25`. *Fix:* reuse `runBounded`.
- **C14.** Valid workspace patterns (`./packages/*`, `packages/*/`) match nothing. [ran] `scripts/lib/detect-stack.mjs:52-66`.

## Medium — hooks

- **M1.** Appending the file path breaks scripts that are not `<linter> [files]` (`next lint`, `turbo run lint`, `tsc --noEmit`). [ran] `lint-touched.mjs:229-233`.
- **M2.** Basename attribution blames the edited file for another file's errors. [ran] `lint-touched.mjs:248-252`.
- **M3.** A Stop exit 2 can be downgraded by Claude Code when stderr mentions a missing file. [reasoned from the hooks reference; matching unverified] `verify-touched.mjs:355-357`. *Fix:* block with a JSON `decision` on stdout.
- **M4.** The `npm init` placeholder test earns a Stop gate that blocks with no content. [ran] `scripts/lib/stopgate-evidence.mjs:23-28`.
- **M5.** Credential mask gaps: ANSI colour codes bypass it; missing key names and vendor shapes; PEM bodies; quoted values with spaces. [ran] `harness-redact.mjs:168-205`.
- **M6.** The SessionStart brief has no mask, no control stripping and no delimiter. [ran] `assets/scripts/session-brief.mjs:59-70`.
- **M7.** Rule text can break out of its delimiter and carry invisible characters. [ran] `assets/scripts/rules-brief.mjs:108-119`.
- **M8.** One over-long rule starves the whole brief. [ran] `rules-brief.mjs:125`.
- **M9.** Killing the hook orphans the verification process. [ran on Windows] `harness-redact.mjs:776-842`.
- **M10.** Generated deny rules such as `Edit(build/**)` match at any depth, on the evidence of one tracked file. [reasoned from the permissions reference] `scripts/lib/protected-evidence.mjs:157-158`; `scripts/lib/profiles/typescript.mjs:46`.
- **M11.** A marker `package.json` with no `lint` script silently disables the sensor beneath it. [ran] `lint-touched.mjs:449-453`.

## Medium — skill, docs, tests, CI, evals, product

- **S4.** Write-before-gate and gate-before-write both appear (`SKILL.md:10-11`, `phase-0-recon.md:51`, `phase-3-intent.md:39`, `:138`).
- **S5.** The execution disclosure is only in `apply --help` (`scripts/lib/cli.mjs:61,166`), not in the dry run.
- **S6.** No guidance for the `generic` profile and no instruction to open a profile reference.
- **S7.** A full skill walk loads about 47 KB; much of it is maintainer provenance.
- **D3.** `docs/INTENT.md:81-82`, `:101-104` are stale on `P0.security`; the build covers test paths only.
- **D4.** `docs/INTENT.md` cites `docs/ARCHITECTURE.md`, which does not exist, and three test names that match nothing.
- **D5.** `assets/templates/RULES.md.tmpl:15` promises that the kit "proposes the cheapest enforcer it can derive"; no code does. `verify:` and `last-verified:` are parsed and never read.
- **T2.** Skill tests are text-presence tests; none runs the skill's literal commands from a target repository.
- **T3.** No test for the truth of the no-actions sentence, proposal counts, or a kit upgrade.
- **CI1.** No `timeout-minutes` in any workflow.
- **CI2.** An unpinned `npm install -g @anthropic-ai/claude-code` inside the test job (`ci.yml:27`).
- **E1.** With the plugin unengaged, three scored graders cannot pass in either arm.
- **P3.** Recurring questions have nowhere to store the answer; no `--profile` flag.
- **P4.** Thin stack coverage: Go gets no sensor; Python gets no sensor or Stop gate.
- **P5.** Nothing checks handoff freshness or re-validates enforcers beyond pointer existence.
- **P6.** Still 0.1.0, no changelog; `detect.json` `schema` never bumped.

## Low

- **C15.** `settings.json` is rewritten in place; new files are created without `wx`. [reasoned]
- **C16.** A tracked file deleted from the working tree makes `P0.security` `failing`. [ran]
- **C17.** A file passed as the target is not rejected up front. [ran]
- **C18.** A FIFO symlink could hang the sweep; a Bearer body containing `xxx` is skipped as a placeholder; uncapped reads. [reasoned]
- **L1.** The Stop gate does not set `CI=1`. [reasoned]
- **L2.** One timeout disables the gate for the session. [reasoned]
- **L3.** `maskCredentials` mangles rule prose. [ran]
- **L4.** Auto-fix detection can blame the wrong actor. [reasoned]
- **L5.** A leading `-` in a relative path is appended as an option. [reasoned]
- **L6.** Marker read-modify-write is neither atomic nor locked. [reasoned]
- **L7.** A heading containing U+2028 is dropped from injection with no notice. [ran]
- **L8.** A poetry entry point is treated as a shell command. [reasoned]
- **L9.** Exec-form `node` must be on Claude Code's own PATH. [reasoned]
- **S8.** Reference links use two conventions and the link test accepts the broken one.
- **S9.** `gates.md:9-10` omits the intent and rules steps.
- **D6.** Proposal text says `scripts/`; files land in `.claude/scripts/`.
- **D7.** `EXIT_CODES` in `cli.mjs:99-102` omits a README case; the kit uses little of its own harness.
- **T4.** `claude plugin validate --strict` skips where `claude` is not on PATH.
- **CI3.** No `permissions:` block; tag-pinned actions; duplicate runs; no macOS leg.
- **CI4.** The eval job runs branch code with a live token (acceptable for a single owner).
- **E2.** The eval prompts ask not to be asked to confirm, the opposite of the gate rule.

---

## Strengths to preserve

- Two-pass `apply`: allowlist and `assertContained` over the whole batch before any write.
- Layered file-removal gates in `uninstall`, re-derived at delete time.
- One path through git (`-z` everywhere; repository / non-repository / could-not-answer kept apart).
- Evidence modules shared by a check and its generator, with "only a decidable `absent` may propose" enforced centrally.
- Redaction by omission in `detect.json`.
- Exec-form hook registration, `requiresFiles`, scaffolds whose body is a static comment.

## Gap-analysis status (docs/2026-11-02-landscape-gap-analysis.md)

Built: R1 (registry, rule-shaped-line advice, re-injection); F1 for test paths only. Partly built: F4/R11. Open: R2–R10, R12–R17, F5, F6. Measurement (R17) was ranked first and nothing of it exists.
