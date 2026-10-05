# Case A — oxen/2026 (rich, already-harnessed repository)

Validated 2026-09-29 against kh-harness HEAD `ff2ef61` (118/118 tests passing at time of run).

## Command

```
node scripts/detect.mjs /c/Users/Dreambuilds/desktop/oxen/2026
```

Run from `C:\Users\Dreambuilds\desktop\kh-harness`.

## Corrected prediction under test

The original task brief predicted a short proposal list against an assumed
stack-specific profile. Before any run, that was corrected on structural
grounds: oxen/2026 keeps its applications as ~20 independent nested git
repositories (each with its own `.git`), not as subdirectories of the parent
repo. `git ls-files` in the parent does not descend into them, so no
stack-identifying manifest (`package.json`, `pyproject.toml`, etc.) is visible
from the parent. Corrected prediction:

- profile: **`generic`**
- nested-repository disclosure: **roughly 20** entries

## Full summary output

```
kh-harness 0.1.0 — C:\Users\Dreambuilds\desktop\oxen\2026
profile: generic   branch: feature/knowledge-chatbot

Phase 0 — Reconnaissance
  [x] P0.inventory       verified
        produced by this run
  [!] P0.security        failing
        token-in-local-settings at .claude/settings.local.json
        credentials-in-doc at .deepdive-work/querybuilders-helpers.json
        credentials-in-doc at .deepdive-work/user-company-site.json
        token-in-tracked-file at .obsidian/plugins/obsidian-local-rest-api/data.json
        token-in-tracked-file at 2026/2026/oxen.com.sg.key
        credentials-in-doc at docs/superpowers/plans/2026-05-02-login-redesign.md
        credentials-in-doc at docs/superpowers/plans/2026-05-17-job-activity-report.md
        credentials-in-doc at .claude/orchestration.backup-2026-05-30-170542/docs/agents/qa/e2e-test.md
        credentials-in-doc at .claude/orchestration.backup-2026-05-30-170709/docs/agents/qa/e2e-test.md
        credentials-in-doc at docs/superpowers/plans/2026-05-24-portal-auth-gateway.md
        credentials-in-doc at docs/superpowers/plans/2026-09-24-knowledge-chatbot-1-skeleton-and-ingestion.md
        token-in-tracked-file at docs/superpowers/plans/2026-09-29-kh-harness-1-detection-and-gap-model.md
        credentials-in-doc at docs/superpowers/plans/2026-09-29-kh-harness-1-detection-and-gap-model.md
  [ ] P0.recon           absent
      → run the recon prompt to write docs/harness/recon.md

Phase 1 — Legible
  [-] P1.bootstrap       n/a
        not applicable to profile generic
  [~] P1.instructions    declared
        CLAUDE.md (153 lines)
        153 lines exceeds the 150-line budget; prune rather than replace
  [ ] P1.architecture    absent
      → run the architecture prompt to write docs/ARCHITECTURE.md
  [ ] P1.pathrules       absent
      → scaffold .claude/rules/ with globs derived from the workspace layout

Phase 2 — Senses
  [-] P2.scripts         n/a
        not applicable to profile generic
  [-] P2.sensor          n/a
        not applicable to profile generic
  [-] P2.stopgate        n/a
        not applicable to profile generic
  [ ] P2.protected       absent
      → create .claude/settings.json with deny rules for protected paths
  [-] P2.langserver      n/a
        not applicable to profile generic

Phase 4 — Continuity
  [ ] P4.remote          absent
      → add a git remote so the harness is backed up off this machine
  [ ] P4.continuity      absent
        missing: HANDOFF.md, session-brief hook
      → install HANDOFF.md and session-brief hook

Nested repositories (20) — not scanned:
  • accounts-oxen-com-sg (nested-repo)
  • admin-oxen-com-sg (nested-repo)
  • api-oxen-com-sg (nested-repo)
  • client-oxen-com-sg (nested-repo)
  • fieldops-oxen-com-sg (nested-repo)
  • knowledge-oxen-com-sg (nested-repo)
  • lta-vms-oxen-com-sg (nested-repo)
  • monitoring-oxen-com-sg (nested-repo)
  • my-oxen-com-sg (nested-repo)
  • oxen-core (nested-repo)
  • oxen-internal-dashboard (nested-repo)
  • oxen-tokens (nested-repo)
  • oxen.com.sg (nested-repo)
  • reports-oxen-com-sg (nested-repo)
  • sdm-oxen-com-sg (nested-repo)
  • settings-oxen-com-sg (nested-repo)
  • sitehq-construction-oxen-com-sg (nested-repo)
  • sts-oxen-com-sg (nested-repo)
  • support-oxen-com-sg (nested-repo)
  • va-oxen-com-sg (nested-repo)

Exposures (13) — this repository only; 20 nested repositories not scanned — values are never printed; rotate by hand:
  ! high   token-in-local-settings at .claude/settings.local.json
  ! medium credentials-in-doc at .deepdive-work/querybuilders-helpers.json
  ! medium credentials-in-doc at .deepdive-work/user-company-site.json
  ! high   token-in-tracked-file at .obsidian/plugins/obsidian-local-rest-api/data.json
  ! high   token-in-tracked-file at 2026/2026/oxen.com.sg.key
  ! medium credentials-in-doc at docs/superpowers/plans/2026-05-02-login-redesign.md
  ! medium credentials-in-doc at docs/superpowers/plans/2026-05-17-job-activity-report.md
  ! medium credentials-in-doc at .claude/orchestration.backup-2026-05-30-170542/docs/agents/qa/e2e-test.md
  ! medium credentials-in-doc at .claude/orchestration.backup-2026-05-30-170709/docs/agents/qa/e2e-test.md
  ! medium credentials-in-doc at docs/superpowers/plans/2026-05-24-portal-auth-gateway.md
  ! medium credentials-in-doc at docs/superpowers/plans/2026-09-24-knowledge-chatbot-1-skeleton-and-ingestion.md
  ! high   token-in-tracked-file at docs/superpowers/plans/2026-09-29-kh-harness-1-detection-and-gap-model.md
  ! medium credentials-in-doc at docs/superpowers/plans/2026-09-29-kh-harness-1-detection-and-gap-model.md

6 proposals. Nothing has been written except docs/harness/detect.json.

Could not derive — answer these before applying:
  ? This repository contains 20 nested repositories (...). Stack detection and credential scanning covered this repository only; each nested repository must be assessed separately.
  ? Stack detection did not reach a decision (confidence below 0.5). What is this project's primary stack? Stack-specific steps were skipped as a result.
  ? No lockfile found, so the package manager is unknown. Confirm which one this project uses.
  ? An instruction file already exists. Which of its rules are decisions that cannot be re-derived from source? Those must survive any regeneration.
```

## Corrected prediction: verdict

- profile `generic`: **matches** (observed: `generic`).
- nested repositories "roughly 20": **matches exactly** (observed: 20).

**PASS** on the corrected prediction.

## Proposal count: 6

`P0.recon`, `P1.architecture`, `P1.pathrules`, `P2.protected`, `P4.remote`, `P4.continuity`.

## Per-proposal hand verification

Task instructions for Case A: "Go through every proposal it emits and verify
by hand, against the repository, that the capability is genuinely absent." Each
line below states the direct filesystem/git evidence checked (not the tool's
own output) that supports the tool's "absent" call.

| Proposal | Hand verification | Result |
|---|---|---|
| `P0.recon` — write `docs/harness/recon.md` | `ls docs/harness/recon.md` → no such file (the directory did not exist until this run created it for `detect.json`). | Genuinely absent. |
| `P1.architecture` — write `docs/ARCHITECTURE.md` | Checked all three candidate paths by hand: `docs/ARCHITECTURE.md`, `ARCHITECTURE.md`, `docs/architecture.md` — none exist. | Genuinely absent. |
| `P1.pathrules` — scaffold `.claude/rules/` | `ls -la .claude/rules/` → no such directory. Confirmed the 13 files under `.claude/agents/` (the "thirteen critic agents") are a different mechanism (per-task subagent definitions), not directory-scoped auto-loaded path rules. | Genuinely absent. |
| `P2.protected` — deny rules in `.claude/settings.json` | Read `.claude/settings.json` directly: its only top-level key is `hooks` (one `PreToolUse` matcher for `Bash`, wired to the graphify search-context hook). No `permissions` key, hence no `permissions.deny` array, at all. Also checked `.claude/settings.local.json`: only `permissions.allow` and `enabledPlugins`, no `deny`. | Genuinely absent. |
| `P4.remote` — add a git remote | `git remote -v` in the repo returns **no output** — zero remotes configured. | Genuinely absent. |
| `P4.continuity` — install `HANDOFF.md` and a session-brief hook | Checked `HANDOFF.md` and `docs/HANDOFF.md` — neither exists. Searched `.claude` for any file matching `*session-brief*` — none. `.claude/scripts/` contains only `route.mjs` and `route.test.mjs` (the orchestration router mentioned in the task, not a session-continuity hook). `.claude/settings.json` has no `SessionStart` hook at all; `.claude/settings.local.json` has no `hooks` key. | Genuinely absent. |

**No proposal was found for a capability that already exists.** No defect in
Case A's proposal list.

## Note: two brief predictions not upheld by the repository (flagged, not silently corrected)

The original task brief (not the two structural corrections already applied
before this run) additionally predicted that `P2.protected` and `P4.continuity`
would be **`declared`**. Direct inspection above shows both are genuinely
`absent`: `.claude/settings.json` has no deny rules at all, and no
`HANDOFF.md`/session-brief hook exists anywhere in the repository. The brief
also asserted "a GitLab token in remotes… is known to be present" as part of
why `P0.security` should fail; `git remote -v` returns zero remotes in this
repository, so that specific claim does not hold against the repository's
current state (P0.security is still correctly `failing`, but for the 13
in-repo exposures below, not a remote-URL credential — there are no remotes
to carry one).

This is **not** treated as a tool defect: it is the opposite of the load-bearing
failure mode (the tool is not proposing something that exists; the repository
genuinely lacks what three parts of the brief assumed it had). It is flagged
here, with direct repository evidence, for human review of the brief rather
than silently rewritten to match the tool's output, per the task's governing
rule.

## Exposures (13) — kind, location, severity only; no values printed

| # | Kind | Location | Severity | Genuine vs. documentation example |
|---|---|---|---|---|
| 1 | token-in-local-settings | `.claude/settings.local.json` | high | **Genuine.** A live `permissions.allow` entry embeds a real `Bearer` token (71 chars) used to curl the local Obsidian REST API plugin (`https://127.0.0.1:27124/`). This is the "Obsidian token" the brief anticipated. |
| 2 | credentials-in-doc | `.deepdive-work/querybuilders-helpers.json` | medium | Ambiguous, leans **code-reference**. The three `password`-keyed matches have a shape consistent with property-access/method-call code snippets (e.g. `x.y(z...)`), not raw literal secret strings — this file is generated output of a code-analysis ("deepdive") tool. Flagged conservatively by the scanner, which is the documented intended behavior. |
| 3 | credentials-in-doc | `.deepdive-work/user-company-site.json` | medium | Same as above — code-reference shape, generated analysis output. |
| 4 | token-in-tracked-file | `.obsidian/plugins/obsidian-local-rest-api/data.json` | high | **Genuine.** PEM private-key header present; this is the plugin's local TLS key material for the same local REST API. |
| 5 | token-in-tracked-file | `2026/2026/oxen.com.sg.key` | high | **Genuine and highest-risk of the set.** PEM private-key header present, in a file literally named after the production domain `oxen.com.sg`. Should be rotated/removed from the tree regardless of this validation. |
| 6 | credentials-in-doc | `docs/superpowers/plans/2026-05-02-login-redesign.md` | medium | **Documentation example** — a feature-planning doc; matched value shape is short and code-snippet-like. |
| 7 | credentials-in-doc | `docs/superpowers/plans/2026-05-17-job-activity-report.md` | medium | **Documentation example** — matched value classifies as a `$VAR`-style variable reference, not a literal. |
| 8 | credentials-in-doc | `.claude/orchestration.backup-2026-05-30-170542/docs/agents/qa/e2e-test.md` | medium | **Documentation/test-fixture example** — a QA end-to-end test spec; matched value is a quoted literal consistent with a test fixture password. |
| 9 | credentials-in-doc | `.claude/orchestration.backup-2026-05-30-170709/docs/agents/qa/e2e-test.md` | medium | Same file content, duplicated under a second orchestration backup snapshot directory. Same classification as #8. |
| 10 | credentials-in-doc | `docs/superpowers/plans/2026-05-24-portal-auth-gateway.md` | medium | **Documentation example** — planning doc for an auth gateway; short code-snippet-shaped match. |
| 11 | credentials-in-doc | `docs/superpowers/plans/2026-09-24-knowledge-chatbot-1-skeleton-and-ingestion.md` | medium | **Documentation example** — one of the three matches explicitly classifies as an environment-variable reference (`process.env`-style); the others are env-var-name-shaped, consistent with configuration documentation rather than literal secrets. |
| 12 | token-in-tracked-file | `docs/superpowers/plans/2026-09-29-kh-harness-1-detection-and-gap-model.md` | high | **Documentation example**, most likely — this is the kh-harness design plan itself, describing/illustrating the exposure scanner it specifies. The matched `Bearer` token is shorter (29 chars total) than and distinct in value-shape from the genuine Obsidian token in finding #1. |
| 13 | credentials-in-doc | `docs/superpowers/plans/2026-09-29-kh-harness-1-detection-and-gap-model.md` | medium | Same file as #12, a second `password`-shaped match; consistent with the same illustrative/example content. |

Summary: **2 genuine high-severity live secrets** (findings #4 the local TLS
key and #5 the production-domain-named private key are the most concerning;
#1 the Obsidian bearer token is genuine but low-blast-radius, local-only),
**1 ambiguous pair of generated-analysis files** (#2, #3, code-reference
shaped, not confirmed literal), and **7 documentation/example findings**
(#6–#13) inside planning docs and a QA test fixture, consistent with the
task's expectation that the scanner deliberately flags realistic-looking
example credentials rather than suppress them. No credential value is
reproduced anywhere in this record.

## `git status` — proof of no harm

Baseline captured before the run (`git status --porcelain --untracked-files=all`,
7223 lines, dominated by pre-existing untracked nested-repo/project content).
One tracked file was **already** modified before this tool ran:
`docs/superpowers/plans/2026-09-29-kh-harness-1-detection-and-gap-model.md`
(md5 `dd1ba6703d06c336930ad2a6e262a83a`, unrelated to this task — it is the
kh-harness plan itself, being edited elsewhere).

Post-run diff against that baseline:

```
717a718
> ?? docs/harness/detect.json
```

The only change is the new untracked `docs/harness/detect.json`. The
pre-existing modified file's md5 hash is **identical** before and after the
run (`dd1ba6703d06c336930ad2a6e262a83a`), confirming the tool did not touch it.

```
$ git status --porcelain --untracked-files=all | grep -v '^??'
 M docs/superpowers/plans/2026-09-29-kh-harness-1-detection-and-gap-model.md
```

No tracked file was modified by this run. **No harm.**

## Verdict

**PASS** — the corrected prediction (profile `generic`, ~20 nested
repositories disclosed) holds exactly, `P0.security` correctly fails on
genuine credential material in-tree, and every one of the 6 emitted
proposals was hand-confirmed against the repository as a genuine gap — no
proposal was made for a harness capability oxen/2026 already has. The three
un-corrected brief predictions about `P2.protected`, `P4.continuity`, and a
remote-hosted GitLab token are flagged above as discrepancies in the brief
itself (backed by direct repository evidence), not as tool defects, per the
task's governing rule.
