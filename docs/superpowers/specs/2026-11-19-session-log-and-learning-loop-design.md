# Session log and learning loop — design

- **Date:** 2026-11-19
- **Status:** the owner directed implementation to proceed on 2026-11-19, as one plan covering the prerequisites and all three phases. Choices marked [my call] were stated to the owner and not individually confirmed.
- **Evidence:** `reports/Self improving agents and harnesses.md`, `reports/Trace foundations for self improving harnesses.md`, `docs/2026-11-18-audit-findings.md`
- **Size:** a project, in three phases that each ship something useful without the next

Decisions are marked **[decided]** where the owner made them in conversation and **[my call]** where I chose and the owner has not explicitly agreed.

## Intent

kh-harness installs a harness once and then stands still. The owner wants a harness that gets better from the agent's own work: slower than full autonomy, and still able to improve itself without being driven by hand.

The research says what that takes. Every system with credible gains keeps the complete record of every run and returns to it; every documented failure is a case of acting on a claim that could not be checked against that record. So the record comes first. The loop built on it is deliberately narrow, because independent re-runs put the general benefit of harness evolution near zero on unseen tasks, and nobody has measured it in this setting: one repository, months of sessions, a human approving.

What kh-harness has that the surveyed tools lack is the other half: a registry in which every rule names its enforcer, a manifest that identifies the exact harness by content hash, and a clean uninstall. No surveyed tool combines those with learning that ends in a mechanical check.

## Goals

1. Record every session completely and locally, attributable to the exact harness that produced it.
2. Find failures that recur across sessions, with plain code and no model.
3. Turn a recurring failure into one small, mechanical, individually reversible enforcer, validated against the record before it can affect a session.
4. Run without the owner for every step that cannot block work or put text into the model's context; let the owner pre-authorise the rest by policy.
5. Report only what was counted: recurrences, firings, replays passed, on how many sessions, under which harness and model.

## Non-goals

- No evolutionary search over harness variants, no benchmark built from the repository's history, no population or archive of whole harnesses.
- No model-written prose learnings appended to `CLAUDE.md`, the rules brief or any always-loaded file.
- No claim that the agent "improved". No readiness or quality score.
- No network, no daemon, no runtime dependency.
- No generated code that executes. A learned enforcer is data interpreted by one kit-owned hook.
- No editing of the user's lint configuration, tests or CI by the kit.

## Anti-goals

Each of these would make the feature a failure even if it works:

- A log that leaks a credential the owner did not know was being stored.
- A learned rule the owner cannot trace to evidence or remove alone.
- An enforcer that blocks correct work and cannot be seen to be doing so.
- The loop weakening a guard, a gate, a sensor or its own record.
- A report that says more than was checked.

## Constraints

- Zero runtime dependencies, Node 22+, Windows and POSIX, no shell required.
- The existing doctrine: write only what detection proved; report only what is true; dry run by default; the write allowlist and containment in code; no `--force`; no ignore list.
- Claude Code's hook payloads are documented; its transcript format is declared internal and changes between versions.
- Hooks cannot observe a user interrupt, a cancelled tool, or a permission denial outside auto mode. `SessionEnd` has a 1.5-second budget.
- On one user account nothing is out of reach of an agent with a shell. Every control here is detection plus deny rules, not isolation, and the documentation must say so.

## Approaches

**A. Evidence ratchet [decided].** A complete session log; deterministic recurrence detection; one registry entry with one declarative enforcer per learning; replay before activation; silent trial; promotion by approval or by an owner-written policy; individual revert. Slower than full autonomy, modest in what it claims, and consistent with the kit's doctrine.

**B. Autonomous harness search.** Generate harness variants, evaluate them on a benchmark built from merged commits, promote winners. Rejected as the core: a single repository cannot resolve the small effects it would chase (single-run noise of 2 to 6 points on a benchmark with hundreds of tasks); the matched-budget independent study found evolution no better than retrying; the evaluation tooling needs WSL2 on Windows; and unattended promotion is where evaluator tampering is documented. A paired with/without run to catch a large regression remains a possible later add-on.

**C. Session reflection into prose.** The agent reflects at session end and appends to the rules file. Rejected: self-written skills scored 8 to 12 points below having none, generated context files cost about 20% more for no gain, and it is what every existing tool already does.

## Prerequisites

The loop reads hook signals and `detect` states, so these findings from `docs/2026-11-18-audit-findings.md` are fixed first. They are the opening stage of the one plan that covers this whole design **[decided: one plan for everything]**:

- Signals that go quiet or lie: H1, H2, H3, H4, H5, H7, C1, C7, C10, D1, D2.
- Secrets, since tool output will be stored: C2, M5 (one shared pattern table), M6, M7.
- Removal and write safety the loop will rely on: C5, C6.
- Delivery: P1 (upgrade path), so new hooks reach repositories that already installed the kit.

The session log (Phase 1) may be built alongside these, so that history starts accumulating. It depends only on C2 and M5.

## Design

### Phase 1 — the session log

**What is recorded.** One kit-owned hook script, `session-log.mjs`, registered for every hook event the Claude Code reference documents as carrying session activity: session start and end, prompt submission, tool use before and after, tool failure, stop and stop failure, sub-agent start and stop, compaction before and after, instruction-file loading, permission requests and denials, and model switches. The exact event names and payload fields are read from the hooks reference at implementation time, and a test pins the set.

Each event is one JSON line with these field groups:

| Group | Fields |
|---|---|
| Envelope | `schema`, contiguous `seq`, timestamp, previous-event hash |
| Identity | session id, prompt id, tool-use id, agent id, worktree path |
| Harness | manifest state hash, kit version, Claude Code version, model |
| Tool call | event type, tool name, normalised-input hash, status, exit class, first error line, duration, input and output sizes |
| Content | tool input and tool output, scrubbed |
| Harness activity | which instruction and rule files loaded; each kit enforcer's firing and outcome |
| Truncation | truncated flag, omitted size, content hash |

**Harness identity [my call].** Two hashes are recorded on every event, so that the loop's own activity does not reset its evidence:

- The **base hash** covers the kit-installed harness: the bytes on disk of every file the manifest records (not the hashes the manifest stored, so a human edit to a hook shows) plus the kit's settings patches, excluding learned gates. Recurrence is grouped by base hash and model.
- The **learned-set hash** covers the ids and content hashes of the learned gates in force for that session, on this machine and in the tree. It attributes a firing to the exact set of learnings and does not partition recurrence counts.

A change to a file the kit did not write, such as the owner's own rules, changes neither hash. Reports therefore say "under the same kit harness", never "under an unchanged repository".

Successes are logged as well as failures. The agent's own account of what it did is never an observed event; if stored at all it is typed as a claim.

**Content capture [decided].** Full tool input and output, once the log is enabled on a machine. Scrubbed at write time with the shared credential table; the tool states in its own output that the scrub is best-effort. A payload up to 64 KB is stored inline; a larger one is stored once in a content-addressed side store and referenced by hash. Closed sessions are gzip-compressed.

**Retention [decided in outline; the 90-day figure is my call].** Structure is kept indefinitely. Content is kept for a period the owner sets, 90 days by default.

**Where it lives [my call].** Outside the repository, under the user's Claude directory, keyed by a hash of the repository's git common directory so that worktrees share one log. The kit never edits `.gitignore`, and a log outside the tree cannot be committed by accident. The log is data, not installation: `uninstall` reports its location and size and leaves it, and a separate purge command removes it.

**Enablement [my call].** `apply` installs and registers the hook like any other, with the same disclosure. The hook is inert until the log is enabled on that machine, by a command that records the enablement in the user data directory. A teammate or a CI run that pulls the repository logs nothing until they opt in.

**Tamper evidence [my call; no source implements this].** Each event carries the hash of the previous one, and each closed session's final hash is appended to an index. This shows accidental damage and naive edits. It does not stop a process running as the same user, and the documentation says so.

**Blind spots are reported.** An optional transcript reader fills in interrupts, cancelled tools and permission denials. It records the Claude Code version per session, and on an unknown line type it reports "not checked" for that session instead of guessing. An interrupt inferred from a prompt that never reaches a stop event is labelled as derived.

**Untrusted content.** A session in which a tool fetched outside content (web fetch, web search, any MCP tool) is flagged. Text read from the log is always treated as data.

**Cost, measured on the owner's Vyugate transcripts (7,134 tool calls in 16 days):** about 48 MB of full content, roughly 90 MB a month at that pace before compression; about 13 MB a month for structure alone (assuming 1 KB per call). A minimal Node append measured about 55 ms on the owner's machine. The logging hook spawns no child process, and its latency is measured in CI against a stated budget.

**Commands.** A `log` CLI: enable and disable on this machine; status (location, size, sessions, date range, chain intact or not, blind-spot coverage); purge.

**Phase 1 ships:** a complete, attributable, searchable local record. It has value with nothing built on it.

### Phase 2 — recurrence report, taxonomy, ledger

**Recurrence [the threshold of two is my call].** The unit of evidence is a pattern that recurs across sessions: the same tool and normalised input producing the same first error line in two or more sessions under the same manifest hash and model. Kit-specific patterns are added: an enforcer firing repeatedly, and a stop gate failing after the agent declared completion. Plain code computes this; no model is involved. Two is the practitioner threshold and has no measured basis.

**Report.** `log report` lists recurrences with counts, sessions, harness and model, and whether any contributing session was flagged for outside content. Views are always rebuildable from the raw log.

**Taxonomy [my call].** A kit-scaffolded, human-written file in the repository, `docs/harness/FAILURES.md`: one heading per failure kind, each naming the recurrence signatures it covers. The owner labels the first batches, with the skill presenting them. This follows the practitioner method, which puts human review of traces before any model grouping. The kit scaffolds the shape and parses it; it never writes a label.

**Ledger [location is my call].** An append-only file in the user data directory beside the log, written only by the kit's CLI. Every proposed, replayed, trialled, promoted, rejected, demoted, retired or reverted learning is one line: learning id, event kind, evidence references (signature ids, session ids and counts, never content), content hash of the learning, base and learned-set hashes before and after, who approved (the owner, or a policy identified by its hash), and time. Rejected candidates are recorded and never enter the live harness. The ledger is hash-chained like the log. It is per machine and never committed, so branches and worktrees cannot break its chain on merge. What the team sees of a learning is its committed registry entry, which carries an evidence summary and the approved content hash.

**Phase 2 ships:** a report of what keeps going wrong, and the record the loop will write to. Useful with no proposer.

### Phase 3 — the loop

**The unit of change.** One learning is one registry entry plus, where it has a mechanical enforcer, one gate definition. New registry keys: `origin: learned`, `status: candidate | trial | active | retired`, `evidence:` (a summary: signature, session count, date range), `approved-sha256:`.

**Learned entries live in their own file [my call].** `docs/harness/RULES.md` is the owner's file once it holds a rule, and the kit never writes into a file the owner has edited. Learned entries therefore go in a separate kit-owned file, `docs/harness/LEARNED.md`, in the same format. The registry parser, the rules brief and `detect` read both. Rule R3 and the existing uninstall behaviour are unchanged.

**Where the loop may write [my call].** One invariant: **running unattended, the loop writes only to the user data directory, never inside the repository.** Candidates, trial gates, trial counters, the ledger and any machine-local demotion all live beside the log. The gate hook reads gates from two places: the committed `.claude/kh-harness/gates.json`, which binds everyone who has the repository, and the machine-local set, which binds only this machine.

Every write into the repository goes through the same path as `apply`: a dry run by default, the write allowlist and containment, and the refusals on a dirty tree and on the default branch. Sharing a learning with the team is therefore an ordinary reviewable commit that adds one entry to `LEARNED.md` and one gate to `gates.json`. A teammate is never bound by a gate that was not committed and reviewed.

**Enforcer kinds, in order of preference [my call].**

1. **Tool-call gate.** A declarative rule in a kit-owned file, `.claude/kh-harness/gates.json`, interpreted by one kit hook on tool use: tool name, the input field to test, a pattern, an action (`observe`, `warn`, `block`), and a fixed message. The pattern language is linear-time only: literals, anchored tokens and globs. No model-written regular expression and no generated code. This kind is fully automatic because the log contains exactly the inputs it tests, so replay is exact.
2. **Project check.** A lint rule, a static-analysis rule or a regression test in the user's own tooling. The kit does not write these. The skill drafts a patch for the owner or the agent to land through normal development; once it exists the registry entry points at it and `detect` verifies the pointer.
3. **Told rule.** Prose, only for a non-obvious convention the repository does not already state. Never promoted by policy. Counted against a registry budget.

**The loop.**

| Step | Runs | Decides |
|---|---|---|
| Record | hook | automatic |
| Find recurrences | script | automatic |
| Name the pattern | owner, with the skill | owner, for the first batches |
| Draft one learning | model, reading the raw log and the report | automatic |
| Replay | script | automatic |
| Trial (`observe`) | hook | automatic |
| Promote to `warn` or `block` | script | owner's approval, or owner's policy |
| Count firings and outcomes | hook and script | automatic |
| Demote or retire | script | automatic for learned entries only |

**Replay.** Two checks, both run by the script and never reported by the model. The differential check: the gate fires on the recorded mistakes and does not fire on the calls that followed and succeeded. The false-positive check: the gate does not fire on any tool call in sessions with no recurrence. A gate that fails either is recorded as rejected. About half of generated checks fail validation in the nearest research, so "no valid check could be produced" is a normal, reported outcome.

**Trial.** A gate that passes replay is written to the machine-local set with action `observe`. It logs what it would have done, blocks nothing and adds nothing to the model's context. Without a policy, this is the furthest the loop goes alone.

**Promotion has two scopes.** Promotion on this machine changes the machine-local gate to `warn` or `block`. Promotion into the repository is the commit described above. A policy can authorise only the first; it then queues the repository change as a pending proposal for the owner to land.

**Demotion of a committed gate** is likewise machine-local when automatic: the gate is suspended on this machine, the suspension is recorded in the ledger and shown in the report, and the removal from the tree is queued as a proposal.

**Promotion [approval by default is my call].** Promotion changes the action to `warn` or `block`. It requires the owner's approval of the exact content hash; any later byte change voids it. The approval display shows the raw text and exposes invisible characters. The owner may instead write a promotion policy in the user data directory, for example a minimum number of trial firings with none marked wrong. A promotion under policy records the policy's hash in the ledger. Without a policy file, nothing is promoted automatically. A learning whose evidence includes a session flagged for outside content is never promoted by policy.

**Approval is terminal-only [decided].** The commands that approve a promotion, mark a firing wrong, and enable or change a policy refuse to run unless standard input and output are an interactive terminal. A command the agent runs through Claude Code has no interactive terminal, so the agent cannot approve its own work; the owner approves from a separate terminal window. `apply` also proposes a deny rule for these subcommands, and every approval is recorded in the ledger. This is a barrier against the ordinary case, not isolation: a process running as the same user could still forge a terminal, and the documentation says so.

**Demotion and retirement.** Two counters per learning: how often it fired, and what followed. The owner can mark a firing as wrong. A learned gate marked wrong twice returns to `observe`. A learning whose cited path or command no longer exists is retired. A gate with no firings is reported as dormant and left alone, since a solved problem and a dead check look the same. The loop never demotes or retires a rule the owner wrote or a base enforcer the kit installed.

**Revert.** The manifest records each learning's writes separately, so one learning can be removed without touching the rest.

**Protected surface.** The hooks, the gate interpreter, the manifest, the log, the ledger and the policy file are outside what the model may write. `apply` proposes deny rules for them, and `detect` gains an integrity check that reports any kit-owned file whose bytes no longer match the manifest, and any break in the ledger chain. The acceptance order is fixed: a change must first not weaken a guard, gate or sensor; then not regress an existing check; only then is it considered an improvement.

**How it runs without the owner [my call].** The deterministic steps run inside a strict time budget at session start, or on demand. Drafting needs a model, so it runs when a new skill, `harness-learn`, is invoked: by the owner, or by the agent when the session brief reports pending recurrences and the owner has turned that on. The brief text is a fixed template with counts only.

**Commands.** A `learn` CLI: list candidates; replay; show a learning with its evidence; approve by hash; mark a firing wrong; demote; revert; retire. A model-invocable `harness-learn` skill drives it.

### Shipped defaults

The changes that research loops keep rediscovering are added as ordinary detected capabilities, without waiting for a loop to find them: a guard against finishing with no change made, and warnings when a session loops on one failing call. The kit already ships verification before finishing as its Stop gate. These go through the existing `detect` and `apply` path.

### Doctrine changes

- `docs/INTENT.md` non-goals: "the kit never writes a rule" becomes "the kit's scripts never author a rule; a learning is drafted by the model, validated by the script against the record, and takes effect only on the owner's approval or the owner's policy".
- New rules for the kit's own registry, each `enforced-by: test`: a learned enforcer is data and never code; the log never stores an agent claim as an observed event; no learning is promoted without a content-bound approval or a recorded policy hash; the loop never alters a human-authored rule or a base enforcer.
- The README's "three commands" becomes five, and its claim that per-prompt re-injection is evidenced is corrected: compliance decay within a session is measured, re-injection is not.
- `assets/templates/RULES.md.tmpl:15` already promises that the kit proposes an enforcer; Phase 3 makes that true.

## Refinements made while planning

These replace the corresponding statements above. Each was forced by a fact the design had not accounted for.

- **Tamper evidence is per session, not per event.** Parallel tool calls and sub-agents append to one session at the same time, so an event cannot reliably carry the hash of the one before it. Events are appended independently; a closed session is hashed whole and that hash is chained into an index.
- **Harness identity is recorded once per session and again whenever it changes,** not copied onto every event. Every event still resolves to exactly one identity.
- **The ledger's chain is reported by `log status`,** since the ledger is per machine. `detect` checks only what is in the repository: kit-owned files against the manifest, and each committed gate against its approved hash.
- **The guard against finishing with no change is dropped.** It comes from benchmark agents that must submit a patch. In interactive use, ending a turn without a change is normal, and the guard would misfire. The loop warning ships; the kit's Stop gate already covers verification before finishing.
- **A learning has one more state, `active-local`:** promoted on this machine and not yet committed.

## What the feature may claim

Recurrences found, enforcer firings and what followed, replays passed and failed, on how many sessions, under which manifest hash and model. Before crediting a persistent change, the report compares against "retrying would have fixed it". It never states that outcomes improved. If a paired run is added later, a null result is reported as "no detectable difference at this sample size".

## Left to the builder

- The exact hook event list and payload field names, from the current hooks reference.
- The JSON schema details, file naming and directory layout inside the log directory.
- The normalisation used for input hashes and error first lines.
- The session-start time budget and the latency budget, set from measurement.
- The glob and token pattern syntax for gates.
- The registry budget for told rules.
- CLI flag names and output wording, following the existing `--help` conventions.

## Open risks

- Enforcer generation is the unproven part: no peer-reviewed study converts agent mistakes into checks with reported precision. The tool-call gate is chosen first because it is the one kind that can be replayed exactly.
- Recurrence at a threshold of two may be mostly noise or mostly model limitations; no source validates a way to separate a harness defect from a model limitation. The taxonomy step exists to let the owner make that call.
- Two hooks per tool call cost about 0.1 seconds each time on Windows.
- The scrub is best-effort; the log will at some point hold a secret.

## As built: where the implementation differs

Recorded when version 0.2.0 was prepared, on 2026-11-19. The text above is the design as agreed; where it and this list disagree, this list describes the code. Each entry gives the deviation and the reason for it.

**The session log**

- Tamper evidence is per sealed session, not per event: a session idle for 10 minutes is sealed at a later session start or by `log maintain`, hashed whole, and its hash appended to an index whose lines are chained; events not yet sealed are covered by nothing. Parallel tool calls and sub-agents append to one session at once, so no event can name the one before it.
- The seal index's chain, like the ledger's, has no key: a process running as the user can rewrite the file with a new, valid chain, removing a real line or inserting a forged one, and nothing shows it. The chains show only damage that breaks them; nothing marks a well-formed forged line as forged. A key the agent could not read is not available to a hook on one user account.
- The envelope has no contiguous `seq`, and a tool event has no exit class: each line carries `schema`, `ts` and `pid`, and a failure carries its first error line and a status of `error` or `interrupted` (when the payload's `is_interrupt` is set), nothing finer. The `seq` was dropped with the per-event hash, for the same reason: parallel tool calls and sub-agents append to one session independently. The exit class was not built, and no reason is recorded.
- Kit enforcers' firings are not all logged: only learned gates' firings (`gate_firing`) are recorded. The lint sensor's and the Stop gate's reports never reach the log. Not built.
- An interrupt inferred from a prompt that never reaches a stop event is not derived or labelled. Not built. Interrupts are recorded in two ways only: the logging hook gives a failed tool call the status `interrupted` when `PostToolUseFailure` carries `is_interrupt`, and the transcript reader counts the interrupt markers in a transcript.
- The Content group is capped per string value, not per payload: each string longer than the inline cap is moved to a blob.
- The harness line is written at session start, on a model switch, and on a prompt whose identity or model has moved; identity is therefore re-checked per prompt, and tool events after a mid-turn edit to an installed hook are attributed to the previous base until the next prompt. Hashing the harness on every tool call would read every hook script on every call.
- No hook records the Claude Code version, because no hook payload carries it. The transcript reader reads it where transcript lines carry it, but nothing records or reports it yet.
- The transcript reader fills in user interrupts only; cancelled tools and permission denials outside auto mode stay listed as blind spots. The transcript format is internal, so the reader reads only the interrupt markers it recognises and reports a session holding any line type it does not know as not checked.
- A `PreToolUse` or `PermissionRequest` event stores the input's hash and size, not the input; the input and output are stored once, with the `PostToolUse` or `PostToolUseFailure` result. Storing the input twice doubles the content for no new fact.
- The `log` command also has `maintain`, which runs sealing and retention for minutes instead of the session start's 150 ms, for a log that has outgrown that budget. It refuses a disabled log.
- Retention expires only sealed (indexed) sessions, and runs only while the log is enabled: at a session start or from `log maintain`. After `log disable`, recorded content stays on disk with no time limit until `log purge --yes`. Retention is part of the sealing module, which runs only when the hook does its session-start work, and the hook does nothing for a disabled log.

**Recurrence and the report**

- A recurrence is a failing tool call only: the same tool, input hash and normalised first error line in two or more sessions under one base hash and model. The kit-specific patterns (an enforcer firing repeatedly, a stop gate failing after the agent declared completion) are not detected; gate firings are counted per gate in `log report` instead. A failure under an unreadable or missing base, or with no model, is counted as unattributed and grouped with nothing, so unrelated sessions are never merged.
- The report does not compare a gate against "retrying would have fixed it". It counts how often a warn or block firing was followed by a successful call of the same tool, and states that it does not show that outcomes improved.

**The ledger and the policy**

- A promotion policy is bound to the ledger: setting it records a ledger entry of kind `policy` with the policy's hash, and clearing it is a `policy` entry with a null hash. A policy file whose hash is not the one last recorded promotes nothing. Anything running as the owner can write the policy file, so the file alone cannot be trusted.
- Each ledger entry records the base and learned-set hashes at the time of the entry, not before and after. Its `evidence` is a signature, a session count, a first and last time and the outside-content flag, not session ids; the evidence fields are a closed set, so no excerpt can ride along. A `wrong` entry does name a session: its `firing` is `{ sessionId, line }`, the firing marked.

**Learnings and gates**

- The gate language is `literal` (a substring), `token` (the value bounded by non-word characters or the string's ends) and `glob` with `*` as its only wildcard; `?` is a literal character. A value needs at least 3 characters that are neither `*` nor whitespace, a gate inspects only the first 65536 characters of its field, and a gate file holds at most 100 gates. These bounds keep matching linear and the worst case near 0.09 s per tool call; the earlier caps cost about 0.65 s.
- A gate id is `L` and 1 to 9 digits with no leading zero, and is never reused on that machine, so a ledger entry names one learning for good.
- A learning has the statuses `candidate`, `rejected`, `trial`, `active-local` (promoted on this machine, not committed), `landed`, `suspended` and `retired`. The ledger, not the learning's file, is the authority for the status and for the action its gate may carry, because the file is covered by no hash.
- Replay needs history: the false-positive check counts only calls of the gate's own tool whose inspected field is a string, and it needs at least 20 such clean calls across at least 2 sessions; with fewer, the verdict is `not-checkable` and the draft stays a candidate for `learn replay`. Silence over too few calls proves nothing.
- A rejected recurrence, or another recurrence that `docs/harness/FAILURES.md` labels with the same failure kind, is drafted again only with `learn draft --redraft`, and the ledger records the draft as a redraft. Without this, a model could redraft until a replay passes.
- `tick` retires a trial whose cited paths are all gone, but does not retire an enforcing gate whose citations are gone: one promoted on this machine is reported in `citationsGone` and left until `learn retire` is run for it at an interactive terminal outside Claude Code, and a landed one is neither retired nor reported. Otherwise an agent could switch a guard off by deleting a file.
- Only tool-call gates are drafted. Project checks and told rules are not drafted, and there is no registry budget for told rules.
- Retirement on a dead citation checks only the paths in a gate's `cites`; a cited command is not checked. Not built.
- No gate is reported as dormant. A gate's firing count is shown by `learn show` and `log report`, zero included, but nothing labels a gate with no firings. Not built.
- The design's `assets/templates/RULES.md.tmpl` promise, that the kit proposes an enforcer for each told rule, was not made true: the build withdrew the promise from the template instead, since the loop drafts gates only for recurring tool failures, never for a rule in `RULES.md`.
- Committed entries in `docs/harness/LEARNED.md` are only ever `status: active`; candidates, trials and retired learnings live in the per-machine data directory. A committed entry leaves the repository only by revert, which keeps the repository change a reviewable commit.

**Promotion, landing and reverting**

- Landing and reverting are the subcommands `learn land` and `learn revert`, terminal-only for the real write (`--yes`), and their ledger entries record `approvedBy: 'owner'` whoever promoted the learning on this machine, because a committed gate binds other people's agents. The dry run needs no terminal and writes nothing, in the repository or the data directory, though the `git status` its dirty-tree check runs may refresh `.git/index`. The write is left uncommitted, for the owner to review and commit. A policy therefore cannot put a gate into the repository.
- No repository change is queued as a pending proposal. A learning promoted under policy stays `active-local` until `learn land --yes` lands it; a committed gate suspended on this machine stays in the repository until `learn revert --yes` reverts it. Both run only at an interactive terminal outside Claude Code.
- A landed learning judged wrong (two wrong marks since its landing, or a demotion) is suspended on this machine, where its committed gate stops acting; it can then be reverted, which takes its gate out of the repository and ends it `retired`. Reverting a landed learning that was not suspended returns it to `active-local`, with its local gate restored, since a revert withdraws the rule from the repository and not the approval on this machine.
- After a branch switch to a checkout without the committed gate, or once an uncommitted land is discarded, a landed learning is enforced nowhere until the next `learn` command that writes, or `tick`, writes its local gate back. The repair runs only when one of those runs; `list` and `show` do not repair.
- A revert proceeds from whatever trace of the learning is left: its gate, its registry entry, its manifest record. Whenever the working tree's gate file lacks the learning's gate, it reads the gate file in the commit `HEAD` names. When that commit still holds the gate, the revert goes on and its first note says that the gate stays committed until its removal is committed; when the commit cannot be read, the note says why. On that account it notes and never refuses, because after any revert, until the owner commits, the commit still binds everyone. A landed or suspended learning with no trace in the checkout is reverted on this machine only. A learning retired while its gate was still committed can be reverted, and `retire` refuses a learning whose gate is still committed and names the revert, since retiring writes no file.
- An interrupted land or revert, including one killed between a file write and the manifest write, is finished by running the same command again: a file on disk that is exactly what the step makes from the recorded file is adopted, and any other difference is refused as a hand edit. A hand-edited learned file is a refusal (exit 3) for `land` and `revert`, where `apply` reports such a file as kept, because these steps would have to write that very file.

**Running without the owner**

- At session start the logging hook runs only sealing, retention and the notice below. The repair, the demotions, the retirements and the promotions under policy run only when `learn tick` runs, by hand or through the `harness-learn` skill, and the repair also runs before every other `learn` step that writes. The hook's 150 ms session-start budget is spent on sealing and retention, and the loop's steps take the learnings lock and read the whole ledger.
- The session-start notice is not the session brief's: it comes from the logging hook, only when `autodraft` is set in the log's `config.json`, only for a new session (`source: startup`), and it states how many sessions were sealed since the last `tick`, counted by position in the seal index, not pending recurrences. A resumed or compacted session may already hold the notice, and recurrences are not computed at session start.
- `learn evidence <signature>` was added: a read-only view of up to three recorded failures of one recurrence, printed between nonce-marked lines that say it is recorded data. The skill needs the recorded inputs to draft a gate, and reading the log directly would have meant an ad hoc script with no escaping.
- `learn` also has `draft`, `list`, `tick`, `land`, `policy show`, `policy set` and `policy clear`, which the design's command list left out.

**Shipped defaults and the protected surface**

- The guard against finishing with no change was dropped: in interactive use a turn that ends without a change is normal. The loop warning ships as `P2.loopwatch` (runbook step 13): one fixed sentence at the third identical consecutive failure of a call, counted per agent. It counts without a lock: each failure appends one record to the marker in a single write and reads back only a capped tail, so overlapping runs never lose a count. A run can be descheduled for longer than any lock wait it could afford.
- The deny rules cover `.claude/scripts/`, `.claude/kh-harness/`, the manifest, `docs/harness/LEARNED.md` and the default data directory `~/.claude/kh-harness/`. A data directory moved with `KH_DATA_DIR` is not covered. The rules also deny running the eight terminal-only `learn` subcommands (`approve`, `wrong`, `demote`, `retire`, `land`, `revert`, `policy set`, `policy clear`), `land` and `revert` whole, so an agent's dry run of either is declined too. `P5.toolgate` is declared only when every one of these rules is present, so an older install is proposed the ones it lacks.
- `detect` gained `P5.integrity` (runbook step 32), which checks only the repository: kit machinery against the manifest, each committed gate against an approval in `LEARNED.md`, and each landed learning against `gates.json`. The ledger's chain is reported by `log status`, since the ledger is per machine.
- The Protected surface's fixed acceptance order (a change must first not weaken a guard, gate or sensor, then not regress an existing check, only then count as an improvement) is not a mechanism. No code compares a change against it, and no reason is recorded. Not built.
- `uninstall` also removes what `land` wrote. Each learned file is removed only when unmodified, stamped and holding nothing but learnings the manifest records; then `LEARNED.md` is kept whenever `gates.json` is kept for a reason of its own, and `gates.json` is kept for its partner only when `LEARNED.md` holds an unrecorded learning, so a committed gate is never left without its registry entry. Removing `gates.json` clears the manifest's landed learnings. The ledger is not changed, so those learnings stay `landed` on this machine, and the repair later writes their gates back into the local gate file.
