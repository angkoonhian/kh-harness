# Hook merge and extension point design

Date: 2026-11-25. Status: approved in outline by the owner on 2026-11-25; revised the same day after an inventory of the code (see "Revisions"). Size: a medium change to kh-harness. It is stage 0 of `2026-11-25-kh-orchestration-v1-design.md`.

## Intent

Each tool call in an installed repository starts two Node processes on `PreToolUse`, two on `PostToolUse` for a `Write` or `Edit` where the lint sensor is installed, and two on `PostToolUseFailure`. Measured on this machine, a bare Node start costs about 15 ms and any one kit hook 22 to 27 ms, while both `PreToolUse` hooks loaded in one process cost about 26 ms. Hook time is process start time, so one process per event roughly halves it.

The same change gives a second plugin a place to add gates without adding a process.

## Goals

- One Node process per tool-call event instead of two.
- No change in what is logged, gated, linted or warned about.
- A failure in one half never stops the other half.
- An extension point on `PreToolUse` that other plugins can register with, as described in the contract.
- Existing installs move to the new registration through `apply`, reported in the dry run.
- `uninstall` removes everything the merge adds.

## Non-goals

- Rewriting the hooks in another language.
- Merging the hooks on session-level events, which fire rarely.
- Changing the gate language or the log format.
- Extensions on events other than `PreToolUse`. Nothing needs them yet.

## Approaches

1. **One entry script per event that imports the existing hook modules (chosen).** Each existing script keeps its logic and its tests and gains an exported function. A shared core reads the payload once, calls each half in its own try/catch and combines the results.
2. **One dispatcher script taking the event and halves as arguments.** Rejected after reading the code: the kit writes, recognises and removes only registrations of the form `node <one script>`. A second argument is invisible to `detect` and to the duplicate check, and `uninstall` would refuse to remove the entry as not the kit's own.
3. **A long-running helper process the hooks talk to.** The fastest per call, but it adds a daemon to a kit whose rule is "commands, no runtime".

The owner chose to reduce process count on 2026-11-24. Approach 1 keeps the existing tests, isolation and registration form.

## Design

### Entry scripts and the shared core

Four new installed scripts under `.claude/scripts/`:

| Script | Registered on | Runs, in order |
|---|---|---|
| `dispatch-pre-tool.mjs` | `PreToolUse`, no matcher | extensions, the tool gate, the session log |
| `dispatch-post-tool.mjs` | `PostToolUse`, no matcher | the session log, then the lint sensor when the tool is `Write` or `Edit` |
| `dispatch-tool-failure.mjs` | `PostToolUseFailure`, no matcher | the session log, the loop warning |
| `harness-dispatch.mjs` | not registered | the shared core the three import |

Each entry is registered exactly as the kit registers every hook today: `node` with the one script path. Each runs a fixed set of halves.

`dispatch-post-tool.mjs` is installed and registered only where the lint sensor is. Where it is not, `PostToolUse` has one kit hook and nothing to merge. The other thirteen logged events keep `session-log.mjs` registered directly.

The core:

- reads standard input once and hands the parsed payload to each half;
- runs each half inside its own try/catch, so a throw in one is contained and the next still runs; like the hooks today, a half that throws prints nothing;
- emits one combined result (below);
- keeps the kit's current behaviour on its own failures, which is to exit 0.

**Combining results.** All four scripts report through JSON on standard output; `lint-touched.mjs` also reports through exit code 2 with text on standard error. The core merges them so each half's message reaches the same reader as before:

- a `deny` from any half or extension wins on `PreToolUse`, with the reasons joined in running order;
- `systemMessage` texts are joined, and `additionalContext` texts are joined;
- the exit code is the highest any half returned, and standard error is every half's standard error in order;
- when the exit code is 2, Claude Code ignores the JSON, so any notice another half produced is appended to standard error instead of being dropped.

**The four scripts.** Each gains an exported function that takes the parsed payload and returns its result without writing or exiting. `tool-gate.mjs` already has a pure `decide`, and `session-log.mjs` an async `record`. `lint-touched.mjs` and `loop-watch.mjs` run and exit on import today and write from inside their helpers; they are restructured so the helpers return their output, and gain the entry-point guard the other two have. Neither checks the event or the tool today, relying on the registration; their exported functions apply those tests themselves. Run directly, all four behave exactly as they do now.

**One process means the halves run one after another.** On an edit, the `PostToolUse` process stays alive while the linter runs, after the log line is written. The latency gain is for calls that do not lint.

**Switching one half off.** The registration stays the switch. To run only one half of a merged event, the owner replaces the entry script's registration with the single script's own registration. `detect` accepts either. As today, `apply` proposes any kit hook that is missing, so a half the owner removed is offered again; the migration itself never turns one back on.

### Extensions

`dispatch-pre-tool.mjs` reads `.claude/kh-harness/extensions.json`. A missing file means no extensions. Each entry is `{ id, version, module, sha256, onFailure }`.

- `module` must be a path under `.claude/` in the repository, with no `..` segment.
- The core hashes the module file and loads it only when the hash equals the entry's. This catches a stale or half-updated install; it is not a defence against deliberate editing of both files.
- An extension exports one synchronous function, `preToolUse(payload)`. It may read small files and must not start a process or wait on anything. There is no in-process time limit, because a timer cannot interrupt synchronous code; Claude Code's own hook timeout ends a hang.
- It returns `{ decision: 'allow' }` or `{ decision: 'block', message }`.
- A throw, a malformed result or a hash mismatch applies that entry's `onFailure`, `block` or `allow`, with a fixed message naming the extension's `id`.
- A malformed `extensions.json` blocks, since the file exists to hold gates.

If the loader module itself is missing or older than the entry script, the entry script blocks when an `extensions.json` exists and says nothing when it does not. This differs from the kit's gate hook, which lets calls through with a notice, because a missing loader would otherwise switch another plugin's gates off silently.

An extension is code from the repository run by a kit hook on every tool call. The install-time notice that says which hooks run repository code is updated to say so.

kh-harness never writes `extensions.json`. Another plugin's installer does, and records it in its own manifest. The kit's existing deny rule on `.claude/kh-harness/**` already covers the file.

An extension runs only where `dispatch-pre-tool.mjs` is registered. A plugin that depends on its extension must check that registration and report when it is missing.

### Install and migration

- On a fresh repository `apply` registers the entry scripts instead of the separate hooks, and `session-log.mjs` on the other logged events.
- On an existing install, the four separate hooks are all present, so today's `apply` proposes nothing. The merge adds a check that reports an event still using separate registrations, and a new kind of proposal that replaces registrations. `apply` only appends today; it gains the ability to remove a registration it recorded and add another in one step.
- An event is migrated only when every registration the kit made on it is still exactly as the manifest recorded, judged by the recorded hash of each entry. If the owner changed or removed any of them, that event is left as it is and `detect` says so. A half therefore never runs twice, and a half the owner switched off stays off.
- The dry run shows the entries to be removed and the entry to be added.
- `uninstall` removes the entry scripts and their registrations like any other the kit wrote.

### Detect and other readers

Every place that asks "is this hook registered" accepts the entry script for its event as well as the single script:

- the checks for the session log (all sixteen events), the tool gate, the lint sensor and the loop warning;
- `log status`, which counts the events the session log covers;
- the rule-pointer check for `settings:hooks.<Event>`, which must not count an entry script as an enforcer on the strength of its logging half alone.

`detect` also lists each extension, its version, its hash state and its `onFailure`.

### The contract

`docs/CONTRACT.md` describes what another plugin may rely on, with a fixture test for each promise. The contract number, starting at 1, is an installed file, `.claude/kh-harness/contract.json`, so that another plugin reads the contract of the install in front of it. `apply` installs and updates it like any other kit file. The promises are listed in the kh-orchestration design.

## Measured by

- Latency budget tests for each entry script pass; before and after wall times are recorded in the execution log.
- Every existing test of the four scripts passes unchanged, except two assertions that pin the fresh-install registration to the single script.
- A test in which one half throws shows the other half's effect still happened.
- A test of an existing install shows the dry run proposing exactly the migration, a second `apply` proposing nothing, and `uninstall` leaving no entry script or registration behind.
- A migration test with one registration changed by the owner shows that event left alone and the others migrated.
- Extension tests cover: allow, block, throw and hash mismatch, for both `onFailure` values, and a malformed file, which always blocks.
- `log status` on a migrated install still reports all sixteen events.

## Revisions

2026-11-25, after reading the code:

- A single dispatcher taking arguments became three entry scripts with a shared core, because the kit handles only one-argument registrations.
- Extensions are limited to `PreToolUse`.
- The contract number moved from the manifest to an installed file, because `apply` writes the manifest only when it has something else to do.
- The size was restated from small to medium: migration needs a new kind of proposal, and four readers besides the hook checks depend on the current layout.

## Left to the builder

- Whether the four scripts' exported functions share a small helper.
- The exact fixed messages.
- Internal names in the shared core.
