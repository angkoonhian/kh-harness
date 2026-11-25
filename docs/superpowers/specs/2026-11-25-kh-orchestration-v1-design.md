# kh-orchestration v1 design

Date: 2026-11-25. Status: awaiting the owner's approval.

This document lives in the kh-harness repository until the kh-orchestration repository exists; it moves there as that repository's first design document.

## Intent

The owner wants one AI coding workflow that is robust and repeatable: changes pass a fixed series of checks ("officers") for lint, typing and project rules; a separate reviewer checks the code and the feature; work is given to models of different strength; and the project's business rules are the final point of reference, kept current as features are added.

The owner approves changes to the rules. The coding is left entirely to the agents.

Verified research (see `reports/AI coding agent orchestration verified.md`) supports code-enforced checks, one writer and one fresh-context reviewer. It does not support adding more agents or routing by predicted difficulty. The design follows that evidence.

## Goals

- A change cannot be committed or merged through git's normal commit and merge paths unless the officers passed on exactly that code. A branch built any other way is caught before merging.
- The verdict comes from programs, never from a model's judgement.
- The rules, and the checks that enforce them, change only with the owner's approval, except rules the owner has marked as minor, which agents may reword.
- It works in any Claude Code session, with or without Orca.
- It applies automatically in an installed repository. No session has to be told to use it.
- It fits beside kh-harness with no duplicated hooks, registries or logs.

## Non-goals

- Several writers working in parallel on one task.
- Model critics as blocking gates.
- Pushing, merging, or opening pull requests. A run ends at a branch that is ready to merge.
- Agents other than Claude Code as writer or reviewer in v1.
- An Orca plugin or status panel.

## Anti-goals

- A gate that passes silently when it crashes or is skipped.
- A second copy of anything kh-harness already owns.
- Any safety property that depends on Orca's worker feature, which Orca labels experimental.

## Constraints

- kh-orchestration is its own repository and its own Claude Code plugin. It depends on kh-harness; kh-harness never depends on it.
- Zero runtime dependencies, Node 22 or later, the same as kh-harness.
- Installation follows kh-harness's discipline: a dry run first, every write recorded in a manifest, a clean uninstall, and no write to a file it did not create.
- Orca starts agents with permission prompts off. In one test a permission deny rule did not hold while a hook block did. Enforcement therefore uses hooks and a git hook, never permission rules alone.
- Claude Code hooks fail open when they crash unless told otherwise.
- vyugate, the first target, has no CI and no existing git hooks. Its agents never push (rule V3); the owner does. Checks compare against the local `main` branch.

## Approaches

Three ways to drive the stages were considered.

1. **A program drives; the owner's chat only starts it (chosen).** A kh-orchestration command starts each Orca worker, waits for its report and runs the officers. The order is fixed by code. It is the most to build.
2. **The coordinator chat drives; code checks it.** Less to build, and it is how Orca's guide expects workers to be used. A model decides the order, and a skipped stage is caught only at commit time.
3. **A Claude Code workflow script drives.** Rejected: it cannot pause for the owner's input, a resumed workflow replays results without firing hooks, and a budget-halted workflow reports success.

The owner chose approach 1 on 2026-11-25, with approach 2 as the fallback if the outstanding Orca tests fail. In every approach the commit gate is the final authority.

## The work is five stages, designed one at a time

This document designs stage 0 and stage 1 in full. Stages 2 to 4 are outlined; each gets its own design document, because each depends on results from the stage before.

| Stage | What | Depends on |
|---|---|---|
| 0 | kh-harness: published contract, hook merge with an extension point, `detect` reports the second plugin | nothing |
| 1 | kh-orchestration: officer runner, commit gate, approval lock; vyugate's V8 and V11 as the first coded checks | stage 0 |
| 2 | A private set of 20 to 50 evaluation tasks drawn from real failures | stage 1 |
| 3 | Task packets, the Orca driver, and a fresh-context reviewer | stages 1 and 2, three Orca tests |
| 4 | Model tiers: start cheaper, move up when the officers fail a change | stage 3 |

## Stage 0: what changes in kh-harness

The hook merge has its own short design document, `2026-11-25-hook-merge-design.md`. It is summarised here only where kh-orchestration relies on it.

### The contract

kh-harness gains `docs/CONTRACT.md` and a `contract` number, starting at 1. The number is an installed file, `.claude/kh-harness/contract.json`, so another plugin can read which contract the install in a repository honours. A repository without the file has an install older than the contract.

The contract lists what another plugin may rely on:

- **The rules registry format** in `docs/harness/RULES.md`: one level-2 heading per rule and `key: value` bullets, including a new optional `approval` key (`owner` or `agent`), which kh-harness accepts and otherwise ignores.
- **A new `enforced-by` value, `officer`.** Its `pointer` is the repository path of the check. `detect` reports an officer rule whose pointer does not exist.
- **The manifest location and schema** (`.claude/kh-harness.manifest.json`, schema 1), read-only to others.
- **The hook extension point** (below).
- **A way to append to the session log**: one exported function in the installed scripts, `recordExternalEvent(root, sessionId, { source, type, data })`. It appends one bounded, redacted event to that session's log and is kept through sealing and retention like the kit's own events. It needs a session id: called outside a session, or when the log is disabled for the repository, it writes nothing and returns `{ recorded: false }`.

A promised format changes only with a new contract number. kh-harness's tests include fixtures for each promised format, so an accidental change fails its own test suite.

### The hook extension point

After the merge, one process runs per tool-call event. The `PreToolUse` entry script reads `.claude/kh-harness/extensions.json`, a list of entries `{ id, version, module, sha256, onFailure }`.

- `module` is a path under `.claude/` in the repository.
- The hash is checked before the module is loaded. It catches a stale or half-updated install. It is not a defence against an agent, which could edit both files; the approval lock below is.
- An extension exports one synchronous function, `preToolUse(payload)`, returning `allow` or `block` with a fixed message. It may read small files and must not start a process or wait on anything. There is no in-process time limit, because a timer cannot interrupt synchronous code; a hang is ended by Claude Code's own hook timeout.
- Each extension runs inside its own try/catch. On a throw, a malformed result or a hash mismatch, that entry's `onFailure` applies: `block` or `allow`.
- Extensions exist only on `PreToolUse`, the one event where a call can be refused.
- An extension runs only where the `PreToolUse` entry script is registered. kh-orchestration's `apply` refuses to install where it is not, and its `detect` reports when the registration has since been removed.

kh-harness's `detect` reads the extensions file and reports each extension, its version and any hash mismatch.

## Stage 1: kh-orchestration

### Shape

A Claude Code plugin with three commands, mirroring kh-harness: `detect` (read-only report), `apply` (dry run by default, then install) and `uninstall`. It installs into a target repository:

- `.claude/kh-orchestration/officers.json`, the officer list;
- `.claude/kh-orchestration/scripts/`, the runner and the hook extension;
- one entry in `.claude/kh-harness/extensions.json`;
- `pre-commit` and `pre-merge-commit` git hooks;
- `.claude/kh-orchestration.manifest.json`, recording every file and patch.

It also keeps state that is never committed, under the repository's shared git directory (`git rev-parse --git-common-dir`) in `kh-orchestration/`: verdicts, approvals, waivers, exemptions, the on/off switch, and a copy of the commit-gate script. Every worktree sees this state.

`apply` refuses, with a message naming what to update, when the repository has no `.claude/kh-harness/contract.json`, when its number is outside the supported range, or when the `PreToolUse` entry script is not registered.

### Officers

An officer is a command that exits 0 for pass and non-zero for fail. `officers.json` lists each as `{ id, rule, argv, appliesTo, timeoutSeconds, options }`:

- `rule` is the ID in `RULES.md` the officer enforces, or null for a tool check such as lint.
- `argv` is an array, run without a shell.
- `appliesTo` is a list of globs; an officer whose globs match no changed file is recorded as skipped.
- `options` is a free object passed to the officer as JSON in an environment variable, for per-officer settings such as V8's two glob lists.

"Changed" always means changed between the tree and its **base**: the merge base of `HEAD` with the configured base branch (`main` for vyugate, the local branch). On the base branch itself the base is `HEAD`.

Officers run in the listed order and all of them run, so one report shows every failure. The runner never edits code.

`apply` writes a first `officers.json` holding a tool officer for each of `lint`, `typecheck` and `test` that exists as a script in the root `package.json`. The owner edits it from there. Rule officers are scripts kept in the target repository, written per project.

### The verdict

`run` works only on a tidy tree: nothing unstaged in tracked files and no untracked, unignored files. Otherwise it stops and says what to stage. It then:

1. computes the tree hash of the index with `git write-tree`, and the base commit;
2. runs the officers against the working tree, which now equals that tree;
3. writes a verdict record keyed by tree and base: each officer's result, the first 4,000 characters of each failure's output, and the digest of the protected files (below) as they are in that tree;
4. appends the same summary to its own run journal in the shared state and, when run inside a session, to kh-harness's log through `recordExternalEvent`.

### The commit gate

The `pre-commit` and `pre-merge-commit` hooks run the gate script from the shared state, so the gate does not depend on files in the tree being committed. The gate computes the tree and base and allows the commit only when:

- a passing verdict exists for that tree and base; and
- the tree's protected-files digest is one the owner approved.

Otherwise it refuses and prints the command to run.

When the tree lacks the kh-orchestration install (an older branch, or files deleted), the gate refuses unless the owner has exempted that branch by name. An exemption is listed by `detect` and by `verify-branch`.

git does not run these hooks for rebase, cherry-pick, revert or `git am`. Those are not blocked, since agents need them. They are caught by `verify-branch`, which checks that the head of a branch has a passing verdict for its tree and base and an approved digest. Because the verdict is taken against the base, it covers the whole branch, however its commits were made. The owner runs `verify-branch` before merging.

The hook extension blocks the ways around the gate from inside a session: `git commit` or `git merge` with `--no-verify` or `-n`, `git -c core.hooksPath=…`, `git commit-tree`, and any write to the shared state or to the git hooks folder. Its `onFailure` is `block`.

`apply` never overwrites an existing git hook or a configured `core.hooksPath`. It reports the conflict and prints the one line to add to the existing hook.

### The approval lock

Some files decide what "passing" means. An agent that could change them could make any change pass, so they change only with the owner's approval. The **protected files** are:

- `docs/harness/RULES.md`, which holds the business rules (below);
- `.claude/kh-orchestration/officers.json`;
- every officer script that `officers.json` names inside the repository;
- everything under `.claude/kh-orchestration/scripts/`;
- everything under `.claude/kh-harness/` (`extensions.json`, `contract.json`);
- everything under `.claude/scripts/`, the kh-harness hook scripts that run the extension;
- `.claude/settings.json`.

(Corrected 2026-11-26: the list first named only `extensions.json`. The stage 0 review showed that the kit's scripts, its contract file and the project settings are exactly what switches the extension off, and kh-harness does not protect them from an agent with a shell. `.claude/settings.local.json` is not committed, so the digest cannot cover it; the commit gate re-checks it instead, below.)

The **digest** is one hash over the contents of those files in a tree, with one exception for minor rules.

**Minor rules.** The owner's decision (2026-11-25): rule changes need the owner's approval, but agents may change small rules themselves. Which rules are small is the owner's call, recorded in the registry so that code can apply it:

- A rule may carry `approval: agent`. Without that line a rule needs the owner, which is the default for every existing and every new rule.
- For a rule marked `approval: agent`, the digest covers only its ID and its `approval`, `enforced-by` and `pointer` lines. An agent may therefore reword the rule, its `why`, `verify` and `priority` without approval.
- Adding or removing a rule, changing any line of an owner-approved rule, marking a rule `approval: agent`, and changing what enforces a rule all change the digest and need the owner.
- The hook extension lets an agent edit `RULES.md` at any time; the digest decides at commit whether the edit was within what agents may change. The other protected files stay blocked unless the worktree is open for proposals.
- Every agent-made rule change is listed in the verdict and in `verify-branch`'s report, so the owner sees it before merging.

- The owner runs `approve` in their own terminal. It shows the diff of the protected files against the last approved state on that branch and records the new digest in the shared state. Approvals are a set of digests, so branches with different approved content coexist.
- The commit gate accepts only a tree whose digest is in the set. A verdict taken before approval stays valid once its tree's digest is approved.
- The hook extension blocks an agent's edits to the protected files unless the owner has opened that worktree for proposals with `propose`. `approve` closes it again. This keeps an agent from quietly editing a check mid-task; the digest is what stops an unapproved change being committed.
- The hook extension blocks an agent from running `approve`, `propose`, the exemption command and the off switch.
- Right after `apply`, nothing is approved. `apply` ends by telling the owner to read the installed files and run `approve` once.

### Business rules

Business rules are entries in the existing registry, `docs/harness/RULES.md`, with IDs starting `B`, in the same format as every other rule. There is one registry, one parser, and kh-harness's existing session brief already shows it to every session. An officer's `rule` may be any ID in that file.

A change that adds or alters a feature proposes its rule changes there; the owner's `approve` is the sign-off. This is what keeps the rules current as features are added: a business-logic change with no approved rule or documentation change is refused by the V8 officer below.

### vyugate's first two coded checks

**V8, docs move with business logic.** Its `options` hold two glob lists: business-logic paths and documentation paths (which include `docs/harness/RULES.md`). The officer fails when a business-logic path changed against the base and no documentation path did. The owner can record a waiver for the branch with a reason; the waiver is kept in the shared state and named in the verdict.

**V11, migrations are append-only.** A Python script reads the `MIGRATIONS` list in `products/vision/backend/src/vyugate_api/db.py` at the base and in the tree, using Python's `ast` module. It passes only when the base list is an exact prefix of the current list.

In `RULES.md`, both rules change from `enforced-by: review` to `enforced-by: officer`, with a pointer to the script. That edit goes through `approve` like any other.

### Automatic use, with no command from the owner

The owner's requirement (2026-11-25): a chat uses kh-orchestration without being told to. Once installed in a repository, it applies to every session there. Three mechanisms provide this, and none relies on a model choosing to invoke a skill:

- **Enforcement is always on.** The git hook and the hook extension act on every commit and every tool call, whatever the session was asked to do.
- **A session-start brief.** The plugin's `SessionStart` hook adds a short fixed text to every session in an installed repository: that commits need a passing verdict, the command that produces one, whether this worktree is open for rule proposals, and (from stage 3) that feature work goes through the pipeline. It stays under 600 characters, and it is printed by code from the repository's state.
- **Refusals that say what to do next.** When the commit gate refuses, its message names the exact command to run. A session that ignored the brief is still routed into the workflow at the first commit.

From stage 3, the pipeline starts the same way: the commit gate refuses a change that meets the pipeline threshold and has no review record, and names the command that starts the run. The session then starts the run itself.

A skill is also shipped so the owner can ask for a run by name, but nothing depends on it being triggered.

The owner can switch kh-orchestration off for a repository with one command, run in their own terminal. The session-start brief then says it is off.

### What stage 1 is measured by

- A commit with a failing officer is refused; the same tree after a fix is accepted.
- A tree whose protected files differ from every approved digest is refused, even with a passing verdict.
- An agent's edit to a protected file other than `RULES.md` is blocked unless the worktree is open for proposals.
- An agent rewording a rule marked `approval: agent` can commit; the same edit to any other rule is refused until the owner approves.
- A branch rebuilt by rebase fails `verify-branch` until the officers pass on its head.
- With the hook extension loaded, kh-harness's latency budget tests still pass.
- Uninstall leaves the repository as it was, including the git hook.

## Stages 2 to 4 in outline

**Stage 2, evaluation set.** Twenty to fifty tasks taken from real failures in the session logs and git history of the owner's repositories. It measures how often the officers catch a known-bad change, how often they block a good one, and the time they add.

**Stage 3, packets, driver, reviewer.**
- A program writes a task packet to a file on the task branch: the approved request, the rules by ID, the allowed files, the officer commands and what counts as done. A worker's task text points at the packet.
- The reviewer's packet holds the diff, the rules and the officers' verdict, and leaves out the writer's reasoning.
- The driver starts each stage as an Orca worker and waits with `orca orchestration check --wait`.
- The reviewer is advisory at first: the gate requires that a review ran for that tree, not that it found nothing. Whether findings block is decided from the evaluation set.
- The full pipeline runs when a change touches three or more files or any business-logic path. Officers run on every commit.
- Three Orca behaviours must be tested first: a worktree started from a local, unpushed branch; the driver running from its own terminal; and a reviewer held read-only by a gate.

**Stage 4, model tiers.** The writer starts on a cheaper model and moves up one tier each time the officers fail its change, to a fixed limit, after which the run stops with a report.

## Known limits

- **The shared state is not tamper-proof.** An agent with shell access could write a false verdict or approval. The hook extension blocks writes to it from inside a session, and the run journal keeps a record, but this guards against skipped steps, not against an agent set on cheating. `verify-branch` re-running the officers is the remedy when it matters.
- **kh-harness's session log is off by default,** and takes events only from inside a session. The second record through `recordExternalEvent` exists only where the owner enabled the log, and only for runs an agent started.
- **A commit made outside Claude Code** is covered by the git hook but not by the hook extension, so `--no-verify` typed by a person still works. That is the owner's choice to make.
- **vyugate has no CI**, so nothing re-checks a branch after the owner's machine.

## Left to the builder

- Internal module layout of both changes, and test structure.
- The exact wording of messages, within kh-harness's rule that messages are fixed text.
- File names inside `.claude/kh-orchestration/scripts/`.
- How `verify-branch` reports, and whether it re-runs officers by default or on a flag.

## Corrections after stage 0 was built (2026-11-26)

`docs/CONTRACT.md` in kh-harness is the authority for what kh-orchestration may rely on. Where the text above differs:

- **Verifying the contract.** kh-orchestration does not ask `detect`. Its installer, its session-start brief and its commit gate each run the two functions the contract document provides: `checkContract1` (the contract file and its hashes, the exact `PreToolUse` registration, hooks not turned off, no project `env` that reaches the hook, its own entry listed and matching) and `probeContract1` (the installed hook, run on a call the extension must block, does block). The gate is relied on only when both return no problems and no warnings. The commit gate re-running them is what catches a registration or settings change made during a session, including one in `.claude/settings.local.json`.
- **The extension is one self-contained file** importing `node:` built-ins only, loaded from the bytes that were hashed. kh-orchestration's extension is bundled into one file at build time.
- **Its entry uses `onFailure: "block"`.**
- **Sharing `extensions.json`.** The installer changes only its own entry, keeps the others' fields and order, writes by temporary file and rename, and on removal deletes only its own entry.
- **`recordExternalEvent`** returns `{ recorded: false, reason }` with one of nine fixed reasons, accepts any safe session id, masks secrets rather than removing fields, and its `data` expires under retention like other content. `files` in the contract file must list `harness-log.mjs` and `harness-seal.mjs` before it is called.
- **A repository whose `.claude` is a link** has no contract 1 and cannot install kh-orchestration.
- **What stage 0 does not give.** kh-harness detects accident, not an agent with a shell, and a pull can add or change an extension with no approval step. The approval lock above and the commit gate are what make a change to those files need the owner; a worker started with permission prompts off can still switch the hook off for its own session, which the commit gate then refuses to accept work from.
