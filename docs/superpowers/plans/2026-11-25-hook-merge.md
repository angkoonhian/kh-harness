# Hook Merge (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one Node process per tool-call event (`PreToolUse`, `PostToolUse` where the lint sensor is installed, `PostToolUseFailure`) instead of two, with no change in what is logged, gated, linted or warned about, and move existing installs to that layout through `apply`.

**Architecture:** Each of the four hook scripts gains one exported function that takes the parsed payload and returns its result without writing or exiting. Three entry scripts, each registered as `node <one script>`, load a shared core that reads standard input once, runs each half in its own try/catch and emits one combined result. `apply` registers the entry scripts on a fresh repository and, on an existing install, replaces the registrations it recorded with the entry script in one step; every reader of "is this hook registered" accepts the entry script for its event.

**Tech Stack:** Node 22+, ES modules, `node:test`, no runtime dependencies. Standard library only.

**Spec:** `docs/superpowers/specs/2026-11-25-hook-merge-design.md`. Code facts with file and line: `docs/superpowers/plans/2026-11-25-stage0-inventory.md` (sections 1 to 10, taken at commit `eead407`). This plan is part A. Part B, written separately, covers the design's Extensions section, `docs/CONTRACT.md`, `contract.json` and `detect` listing extensions; nothing here touches them.

## Global Constraints

- Zero runtime dependencies. Node 22 and later, Windows and POSIX. No shell required by any hook.
- Installed hook scripts import only Node built-ins and sibling files in `.claude/scripts/`. Kit-side code may import from `assets/scripts/`, never the reverse.
- A kit registration is exec form with exactly one argument: `{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/<script>'] }` (`execEntry`, `scripts/lib/hook-evidence.mjs:25`). No registration this plan writes carries a second argument, a matcher or a `timeout`.
- No per-tool-call path starts a process that does not start one today. Only the lint half spawns, as `lint-touched.mjs` does now.
- Every hook and entry script exits 0 on its own failures and writes no stack trace. Exit 2 comes only from the lint half.
- Every message a hook or entry script prints is fixed text; nothing from the payload, a gate file or a settings file is copied into it.
- Run directly, the four hook scripts produce byte-for-byte the standard output, standard error and exit code they produce at `eead407`. Their existing tests are not edited, except the two install-layout assertions named in Task 5.
- `apply` is a dry run unless `--yes`. No `--force`. Every write into a repository passes `assertAllowed` and `assertContained`.
- Uninstall removes only what the manifest records and a generator could have written (`docs/harness/RULES.md` R6). A settings element is removed only when its hash is one the kit writes for a kit script.
- A check never claims more than it read (R7). No dead code, no speculative options, no comment that narrates history; a comment states a constraint the code cannot.
- Tests live in `scripts/lib/*.test.mjs` and run a hook as a child process. Fixture modules are named `*-fixtures.mjs`.
- Before writing code that depends on a Claude Code hook output shape, exit-code rule or matcher rule, read `https://code.claude.com/docs/en/hooks` and pin what was read in a test: that on exit 2 Claude Code still reads the fields of valid JSON on standard output and shows standard error to Claude (corrected 2026-11-25 from an earlier, wrong premise that the JSON is ignored), that `hookSpecificOutput.permissionDecision: 'deny'` is the `PreToolUse` denial, and that a matcher of plain names (`Write|Edit`) matches those tool names exactly.
- Commit after every task on the current branch. Never push. Commit subject: conventional type and scope, then a lower-case declarative sentence stating the behaviour. End each commit message with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- `npm test` passes after every task. A failing test this plan does not name is a finding: stop and report it, do not edit the test.

**Every task follows the same cycle,** written once here and ticked per task: write the failing tests named; run them and confirm they fail for the stated reason; implement; run the task's tests, then `npm test`; commit.

## Decisions made in this plan

Each is a choice the design left open or that the code forced. One line each, with the reason.

1. **The event and tool tests live only in the exported functions.** `lintHalf` and `loopHalf` test the event (and `lintHalf` the tool); the scripts' own `main` does not, because run directly they must behave exactly as now and neither tests them today.
2. **`lintHalf` runs only for `hook_event_name === 'PostToolUse'` and `tool_name` exactly `Write` or `Edit`.** That is what the `Write|Edit` matcher selects; a test ties it to `SENSOR_MATCHER`.
3. **A half result's `stderr` is the exact text to write, trailing newline included; `emit` writes JSON followed by `'\n'`.** `session-log.mjs` run directly keeps writing its JSON with no newline, so its dispatched output differs from its direct output by that one byte and nothing else.
4. **`combine` joins texts with `'\n'` and writes keys in the order `systemMessage`, `hookSpecificOutput`; inside it `hookEventName`, `permissionDecision`, `permissionDecisionReason`, `additionalContext`.** With one contributing half the output is then byte-identical to that script's own.
5. **A half that throws is silent.** The design says "recorded"; the fixed interface says it yields no result, and each script's own `main` swallows a throw today.
6. **No shared helper between the four scripts.** They cannot statically import a sibling that may be missing or older; each builds its own result object.
7. **Halves are loaded with a dynamic `import()` written in the entry script.** `loadedSiblings` reads quoted `./name.mjs` from each asset, so the entry script must hold the names and `harness-dispatch.mjs` must hold none. A half or core that is missing or older gets one fixed `systemMessage` on every call and exit 0, as `tool-gate.mjs` does beside a missing `harness-redact.mjs`.
8. **`dispatch-pre-tool.mjs` exports `preHalves` and so has the entry-point guard;** the other two export nothing and have none.
9. **The three entry scripts are rows of `HOOK_SCRIPTS`; `harness-dispatch.mjs` is a row of `HOOK_MODULES`.** `GENERATOR_SCRIPT_PATHS` grows to ten, which is what lets `uninstall` revert an entry registration and delete the files. The disclosure keeps "seven hook scripts" and adds a sentence on the three entry scripts.
10. **The event-to-entry table is `ENTRY_SCRIPTS` in `hook-evidence.mjs`,** because `propose.mjs` imports that module and not the reverse. A test ties each row's halves to what the entry asset names.
11. **One generator registers an event's entry script:** the non-logging half's (`P5.toolgate`, `P2.sensor`, `P2.loopwatch`) when that half is missing; else the logging half's (`P5.sessionlog`) when it is missing; else the new check's. So no event is ever proposed twice in a run, and an upgrade converges in one `apply`.
12. **The new check is `P0.hookmerge`, step 2, phase 0, directly before `P0.kitskew`** (which must stay last). It is `absent` only when an event holds both halves separately, each as recorded; `declared` when events are merged or left alone, with a line per event; `n/a` otherwise.
13. **The new proposal kind is `settings-hook-replace`,** carrying `remove` (entry hashes) beside the fields of `settings-hook`. With nothing to remove a plain `settings-hook` is proposed.
14. **An event is replaceable only when** every registration of one of its halves is a manifest-recorded patch for that event whose hash is one the kit writes for that script (exec or shell form), and every such recorded patch is still in the settings. Anything else leaves the event on separate registrations and `P0.hookmerge` says why.
15. **The records of removed registrations leave the manifest only after the settings file is replaced.** The manifest written first holds old and new records, so a killed run never leaves an entry in the file without a record; a record may outlive its entry, which `uninstall` already treats as gone.
16. **Nothing is done about `harnessIdentity().base`.** It hashes the installed scripts' bytes and the patch records, so it already moves with every kit update, and this update changes the four scripts' bytes whether or not the patches change. A test pins that it is stable across an `apply` that has nothing to do.
17. **`registeredHook` says how a half is run:** `<Event> hook: <script>, run by <entry script>`. `P5.sessionlog`'s headline sentence is unchanged; the three merged events appear as the qualified lines it already prints for an event credited another way.
18. **`rules-evidence.mjs` needs no code change.** Every entry script runs a hook besides the logging one, so its registration is an enforcer; a test pins that property of the table.
19. **An owner who removed one half keeps that event unmerged, and the half's own check proposes it again as today.** The migration never re-enables a half; `apply`'s existing behaviour is not changed.
20. **Latency budgets are 100 ms over 40 pairs,** the two existing tests' values, in `scripts/lib/harness-dispatch.test.mjs`.
21. **The migration tests build a pre-merge install from a current one** with a fixture that rewrites settings and manifest to separate registrations, so they need no git history and do not depend on what part B changes. One further test upgrades a real install made by the kit at `eead407`, skipped on a shallow clone.
22. **The execution log is `docs/plan-10-execution-log.md`.**

## Review Focus

Conditions the design implies that its own measures do not exercise; each is pinned by a test in the task named.

1. **An entry script beside a missing or older core or half.** It exits 0 with one fixed notice and the other half still runs. (Task 2)
2. **A lint failure and another half's notice in the same run.** Exit 2 makes Claude Code ignore standard output, so the notice is appended to standard error, not lost. (Task 2)
3. **A non-edit tool whose input has a `file_path`** (`Read` on a `.ts` file): the entry script has no matcher, so the lint half must refuse it itself. (Tasks 1, 2)
4. **`apply` killed between its manifest write and its settings write during a migration.** No entry is left without a record, `uninstall` still removes everything, and the next `apply` finishes. (Task 6)
5. **A repository that gitignores `.claude/`**, where no script resolves through the file scan: the halves are still credited through the entry script's recorded hash. (Task 4)

---

### Task 1: The four hook scripts export their halves (refactor, no behaviour change)

**Files:**
- Modify: `assets/scripts/tool-gate.mjs:289-299`, `assets/scripts/session-log.mjs:389-402`, `assets/scripts/lint-touched.mjs:60-76,385-397,510-522,524-685`, `assets/scripts/loop-watch.mjs:168-213`
- Create: `scripts/lib/half-fixtures.mjs`, `scripts/lib/hook-halves.test.mjs`

**Interfaces:**
- Produces: `HalfResult = { json: object | null, stderr: string, exitCode: 0 | 2 }`.
  - `tool-gate.mjs`: `export function gateHalf(payload): HalfResult | null`
  - `session-log.mjs`: `export async function logHalf(payload): Promise<HalfResult | null>`
  - `lint-touched.mjs`: `export async function lintHalf(payload): Promise<HalfResult | null>`
  - `loop-watch.mjs`: `export function loopHalf(payload): HalfResult | null`
  - `half-fixtures.mjs`: `runHalf(script, exportName, root, payload, { env } = {}): HalfResult | null` — spawns `process.execPath --input-type=module -e <program> <file URL of script> <exportName>` with `CLAUDE_PROJECT_DIR: root`; the program imports the module, then reads standard input, calls the export with the parsed payload and writes `JSON.stringify(result ?? null)`. It asserts exit 0 and empty standard error. Because the program reads standard input after the import, it also proves that importing the script neither reads standard input nor exits.

- [ ] **Step 1: Write the failing tests** in `scripts/lib/hook-halves.test.mjs`. Use `sandboxMarkerDir()` and a temporary `KH_DATA_DIR`. `direct(script, root, payload)` is `spawnSync(process.execPath, [script], …)` returning `{ status, stdout, stderr }`. Use a fresh project and session id for each side of a comparison, since notices are once per session.
```js
test('gateHalf returns what tool-gate.mjs prints, and null for another event', () => {
  // each root: a committed gate file with one `block` gate matching `rm -rf`
  const half = runHalf(GATE, 'gateHalf', rootA, call('half-1', 'rm -rf build'));
  const run = direct(GATE, rootB, call('half-1', 'rm -rf build'));
  assert.deepEqual(half, { json: JSON.parse(run.stdout), stderr: '', exitCode: 0 });
  assert.equal(run.stdout, JSON.stringify(half.json) + '\n');
  assert.equal(runHalf(GATE, 'gateHalf', rootA, { ...call('half-2', 'rm -rf build'), hook_event_name: 'PostToolUse' }), null);
});
test('logHalf records the event and returns null on a tool-call event', () => {
  // enabled project
  assert.equal(runHalf(LOG, 'logHalf', root, toolPayload('PreToolUse', 'half-log-1')), null);
  assert.deepEqual(readEvents(root, 'half-log-1').events.map(e => e.type), ['PreToolUse']);
  assert.equal(runHalf(LOG, 'logHalf', root, { session_id: 'half-log-1', hook_event_name: 'NotLogged' }), null);
});
test('session-log.mjs run directly still writes its notice with no trailing newline', () => {
  // an installed copy of assets/scripts/ without harness-log.mjs, as hook-skew.test.mjs builds one
  const run = direct(join(dir, 'session-log.mjs'), root, toolPayload('PreToolUse', 'half-log-2'));
  assert.deepEqual(Object.keys(JSON.parse(run.stdout)), ['systemMessage']);
  assert.equal(run.stdout.endsWith('\n'), false);
  const half = runHalf(join(dir, 'session-log.mjs'), 'logHalf', root, toolPayload('PreToolUse', 'half-log-3'));
  assert.equal(JSON.stringify(half.json), run.stdout);
});
test('lintHalf returns the report as stderr with exit code 2, exactly as lint-touched.mjs writes it', () => {
  // repo('node -e "console.error(\'src/a.ts:1 no-unused-vars\'); process.exit(1)"') twice
  const half = runHalf(LINT, 'lintHalf', repoA, edit('src/a.ts'));
  const run = direct(LINT, repoB, edit('src/a.ts'));
  assert.equal(run.status, 2);
  assert.deepEqual(half, { json: null, stderr: run.stderr, exitCode: 2 });
});
test('lintHalf runs for each tool SENSOR_MATCHER names and for no other tool or event; run directly the script still tests neither', () => {
  for (const tool of SENSOR_MATCHER.split('|')) assert.equal(runHalf(LINT, 'lintHalf', failingRepo(), { ...edit('src/a.ts'), tool_name: tool }).exitCode, 2, tool);
  const read = { ...edit('src/a.ts'), tool_name: 'Read' };
  assert.equal(runHalf(LINT, 'lintHalf', failingRepo(), read), null);
  assert.equal(runHalf(LINT, 'lintHalf', failingRepo(), { ...edit('src/a.ts'), hook_event_name: 'PreToolUse' }), null);
  assert.equal(direct(LINT, failingRepo(), read).status, 2, 'the direct run is as it was');
});
test('lintHalf returns the not-confirmed-clean notice as JSON with exit code 0', () => {
  // a lint script that exits 1 and names no file: { exitCode: 0, stderr: '' }, json keys ['systemMessage', 'hookSpecificOutput'], additionalContext === systemMessage
});
test('loopHalf warns at the third identical failure as loop-watch.mjs does, and refuses another event', () => {
  const halves = [1, 2, 3].map(() => runHalf(LOOP, 'loopHalf', rootA, failure('half-loop-1')));
  assert.deepEqual(halves, [null, null, { json: JSON.parse(WARNING_OUTPUT), stderr: '', exitCode: 0 }]);
  const other = { ...failure('half-loop-2'), hook_event_name: 'PostToolUse' };
  assert.deepEqual([1, 2, 3].map(() => runHalf(LOOP, 'loopHalf', rootA, other)), [null, null, null]);
  assert.deepEqual([1, 2, 3].map(() => direct(LOOP, rootB, other).stdout), ['', '', WARNING_OUTPUT], 'the direct run is as it was');
});
```

- [ ] **Step 2: Run and confirm failure**
  Run: `node --test scripts/lib/hook-halves.test.mjs`
  Expected: FAIL. The gate and log tests fail on a missing export; the lint and loop tests fail because importing the script reads standard input and exits.

- [ ] **Step 3: Implement the four exports**

- `tool-gate.mjs`: `gateHalf(payload)` returns `null` unless `isToolCall(payload)`; otherwise wraps what `main` computes today (`decide` or `siblingNotice`) as `{ json: output, stderr: '', exitCode: 0 }`, or `null` when that is `null`. `main` parses standard input, calls `gateHalf` and writes `JSON.stringify(result.json) + '\n'`.
- `session-log.mjs`: `logHalf(payload)` holds `main`'s body after the parse and returns `{ json: output, stderr: '', exitCode: 0 }`, or `null` when `output` has no key. `main` writes `JSON.stringify(result.json)` with no newline.
- `lint-touched.mjs`: `assetNotice` and `notConfirmedClean` return a `HalfResult` or `null` in place of writing and returning 0. `writeReport(lines)` becomes `report(lines): HalfResult`, returning `{ json: null, stderr: boundReport(lines) + '\n', exitCode: 2 }`; it stays the one place report text is built, and its comment is rewritten to say so. `main`'s body after the parse becomes `async function lintEdit(payload): Promise<HalfResult | null>` with each `return 0` now `return null`. `lintHalf(payload)` returns `lintEdit(payload)` when the payload is an object with `hook_event_name === 'PostToolUse'` and `tool_name` `'Write'` or `'Edit'`, else `null`. `main` parses, calls `lintEdit` (not `lintHalf`), writes `JSON.stringify(result.json) + '\n'` to standard output when `json` is not null and `result.stderr` to standard error when not empty, and returns `result?.exitCode ?? 0`.
- `loop-watch.mjs`: `main`'s body after the parse becomes `function countFailure(payload): HalfResult | null`, returning the object in place of each write. `loopHalf(payload)` returns `countFailure(payload)` when `hook_event_name === 'PostToolUseFailure'`, else `null`. `main` parses, calls `countFailure` and writes `JSON.stringify(result.json) + '\n'`.
- `lint-touched.mjs` and `loop-watch.mjs`: replace the closing IIFE with the `isEntryPoint()` function and guarded block `tool-gate.mjs:315-330` has, keeping each script's own exit code; add the `realpathSync` and `fileURLToPath` imports.

- [ ] **Step 4: Run the tests**
  Run: `node --test scripts/lib/hook-halves.test.mjs scripts/lib/tool-gate.test.mjs scripts/lib/session-log.test.mjs scripts/lib/lint-touched.test.mjs scripts/lib/loop-watch.test.mjs scripts/lib/hook-skew.test.mjs`, then `npm test`.
  Expected: PASS, with `git diff --stat` showing no change to the four existing test files.

- [ ] **Step 5: Commit** the files this task names, as `refactor(hooks): each of the four tool-call hooks exports a function that returns its result`.

### Task 2: The shared core, the three entry scripts, and the installed-script tables

**Files:**
- Create: `assets/scripts/harness-dispatch.mjs`, `assets/scripts/dispatch-pre-tool.mjs`, `assets/scripts/dispatch-post-tool.mjs`, `assets/scripts/dispatch-tool-failure.mjs`, `scripts/lib/harness-dispatch.test.mjs`
- Modify: `scripts/lib/hook-evidence.mjs`, `scripts/lib/propose.mjs:28-39,624-653,1033`
- Test: `scripts/lib/hook-skew.test.mjs:67-75`, `scripts/lib/propose.test.mjs:1829,1840,1856,1941`, `scripts/lib/settings-merge.test.mjs`, `scripts/lib/cli.test.mjs:191-192`

**Interfaces:**
- Consumes: `gateHalf`, `logHalf`, `lintHalf`, `loopHalf` (Task 1).
- Produces, from `harness-dispatch.mjs`:
  - `async function readPayload(): Promise<object | null>` — reads standard input once under `Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000`, the hooks' own `readStdin` rule; `null` when the text is not JSON for a non-array object.
  - `async function runHalves(payload, halves): Promise<HalfResult[]>` — `halves` is `[{ name: string, run: (payload) => HalfResult | null | Promise<HalfResult | null> }]`; each runs in order in its own try/catch; a throw or a `null` contributes nothing.
  - `function combine(event, results): { json: object | null, stderr: string, exitCode: 0 | 2 }`
  - `function emit(combined): void` — writes `JSON.stringify(combined.json) + '\n'` to standard output when `json` is not null, and `combined.stderr` to standard error when not empty.
  - `function half(name, file, exportName, load): { name, run }` — `run` awaits `load()` and calls the module's `exportName` with the payload; when `load()` rejects or the export is not a function, `run` returns `{ json: { systemMessage }, stderr: '', exitCode: 0 }` with the fixed sentence below.
- Produces, from `dispatch-pre-tool.mjs`: `export const preHalves = []`. The halves list is `[...preHalves, gate, log]`; **part B inserts the extensions half by filling `preHalves`,** so it runs before the gate with no other change to this file.
- Produces, from `hook-evidence.mjs`: `ENTRY_SCRIPTS`, a frozen object keyed by event, each `{ path: string, halves: string[] }`:
```js
export const ENTRY_SCRIPTS = Object.freeze({
  PreToolUse: { path: '.claude/scripts/dispatch-pre-tool.mjs', halves: ['.claude/scripts/tool-gate.mjs', '.claude/scripts/session-log.mjs'] },
  PostToolUse: { path: '.claude/scripts/dispatch-post-tool.mjs', halves: ['.claude/scripts/session-log.mjs', '.claude/scripts/lint-touched.mjs'] },
  PostToolUseFailure: { path: '.claude/scripts/dispatch-tool-failure.mjs', halves: ['.claude/scripts/session-log.mjs', '.claude/scripts/loop-watch.mjs'] },
});
```

- Produces, from `propose.mjs`: `DISPATCH_PRE_PATH`, `DISPATCH_POST_PATH`, `DISPATCH_FAILURE_PATH` (read from `ENTRY_SCRIPTS`), `HARNESS_DISPATCH_PATH = '.claude/scripts/harness-dispatch.mjs'`, `ENTRY_SCRIPT_PATHS` (the three, frozen), all exported.

**`combine` rules** (the design's "Combining results", made exact):

- `systemMessage`: every result's `json.systemMessage` that is a string, in order, joined with `'\n'`.
- `additionalContext`: every `json.hookSpecificOutput.additionalContext` that is a string, joined with `'\n'`.
- Denial, only when `event === 'PreToolUse'`: every `permissionDecisionReason` of a result whose `permissionDecision === 'deny'`, joined with `'\n'`.
- `hookSpecificOutput` is `{ hookEventName: event, permissionDecision: 'deny', permissionDecisionReason }` when there is a denial, with `additionalContext` added after it when there is context; else `{ hookEventName: event, additionalContext }` when there is context; else absent. No other key of a half's output is carried.
- `json` is `{ systemMessage?, hookSpecificOutput? }` in that key order, or `null` when it would have no key.
- `exitCode` is the highest; `stderr` is every result's `stderr` concatenated in order.
- When `exitCode === 2`: `json` becomes `null`, and `systemMessage` then `additionalContext`, each when not empty and each followed by `'\n'`, are appended to `stderr`.

**Fixed sentences.** `REMEDY` is the sentence `tool-gate.mjs:69` holds ("…to update the shared modules…").
- A half that cannot be used: `` `kh-harness dispatch: .claude/scripts/${file} ${problem}, so the ${name} hook did not run on this event — ${REMEDY}` `` where `problem` is `is missing or cannot be loaded` or `is older than its entry script and lacks what it needs`.
- A core that cannot be used, written by the entry script itself: `` `kh-harness ${entry name without .mjs}: .claude/scripts/harness-dispatch.mjs ${problem}, so no kh-harness hook ran on ${EVENT} — ${REMEDY}` `` with `problem` `is missing or cannot be loaded` or `is older than this entry script and lacks what it needs`.

- [ ] **Step 1: Write the failing tests**

In `scripts/lib/harness-dispatch.test.mjs`. `combine` and `runHalves` are pure and are imported into the test; everything else runs an entry script as a child with `runEntry(name, root, payload, { nodeArgs, env, dir = ASSETS })` returning `{ status, stdout, stderr }`. `installed(replaced)` is `hook-skew.test.mjs:56-65`'s helper, copied.
```js
test('combine keeps a single half\'s output byte for byte', () => {
  for (const json of [
    { systemMessage: 'n' },
    { systemMessage: 'n', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } },
    { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'c' } },
  ]) {
    assert.equal(JSON.stringify(combine('PreToolUse', [{ json, stderr: '', exitCode: 0 }]).json), JSON.stringify(json));
  }
});
test('a denial from any half wins on PreToolUse, with the reasons in running order', () => {
  const deny = reason => ({ json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }, stderr: '', exitCode: 0 });
  const warn = { json: { systemMessage: 's', hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'c' } }, stderr: '', exitCode: 0 };
  assert.deepEqual(combine('PreToolUse', [deny('a'), warn, deny('b')]), {
    json: { systemMessage: 's', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'a\nb', additionalContext: 'c' } },
    stderr: '', exitCode: 0,
  });
  assert.equal(combine('PostToolUse', [deny('a')]).json, null, 'a denial means nothing on another event');
});
test('with exit code 2 the JSON is dropped and every notice is appended to stderr', () => {
  const notice = { json: { systemMessage: 'n', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'c' } }, stderr: '', exitCode: 0 };
  const report = { json: null, stderr: 'report\n', exitCode: 2 };
  assert.deepEqual(combine('PostToolUse', [notice, report]), { json: null, stderr: 'report\nn\nc\n', exitCode: 2 });
  assert.deepEqual(combine('PostToolUse', []), { json: null, stderr: '', exitCode: 0 });
});
test('a half that throws yields nothing and the halves after it still run', async () => {
  const ok = name => ({ name, run: () => ({ json: { systemMessage: name }, stderr: '', exitCode: 0 }) });
  const results = await runHalves({}, [ok('a'), { name: 'b', run: () => { throw new Error('x'); } }, { name: 'c', run: async () => null }, ok('d')]);
  assert.deepEqual(results.map(r => r.json.systemMessage), ['a', 'd']);
});
test('dispatch-pre-tool.mjs prints the denial tool-gate.mjs prints and records what both hooks record', () => {
  // rootA, rootB: enabled projects, each with one committed `block` gate on `rm -rf`
  const merged = runEntry('dispatch-pre-tool.mjs', rootA, call('pre-1', 'rm -rf build'));
  const single = direct(GATE, rootB, call('pre-1', 'rm -rf build'));
  assert.deepEqual({ status: merged.status, stdout: merged.stdout, stderr: merged.stderr }, { status: 0, stdout: single.stdout, stderr: '' });
  assert.deepEqual(readEvents(rootA, 'pre-1').events.map(e => e.type).sort(), ['PreToolUse', 'gate_firing']);
});
test('dispatch-post-tool.mjs gives the lint report on stderr with exit 2, as lint-touched.mjs does, and logs the event', () => {
  const merged = runEntry('dispatch-post-tool.mjs', repoA, edit('src/a.ts', 'post-1'));   // failing linter, log enabled
  const single = direct(LINT, repoB, edit('src/a.ts', 'post-1'));
  assert.deepEqual({ status: merged.status, stdout: merged.stdout, stderr: merged.stderr }, { status: 2, stdout: '', stderr: single.stderr });
  assert.deepEqual(readEvents(repoA, 'post-1').events.map(e => e.type), ['PostToolUse']);
});
test('dispatch-post-tool.mjs does not lint for a tool that is not an edit, whatever its input names', () => {
  // the lint script writes a marker file when it runs
  for (const tool of ['Bash', 'Read']) {
    const r = runEntry('dispatch-post-tool.mjs', repo, { ...edit('src/a.ts', `post-${tool}`), tool_name: tool });
    assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: '', stderr: '' });
    assert.equal(readEvents(repo, `post-${tool}`).events.length, 1);
  }
  assert.equal(existsSync(join(repo, 'lint-ran')), false);
});
test('dispatch-tool-failure.mjs warns at the third identical failure as loop-watch.mjs does, and logs each', () => {
  const outputs = [1, 2, 3].map(() => runEntry('dispatch-tool-failure.mjs', root, failure('fail-1')).stdout);
  assert.deepEqual(outputs, ['', '', WARNING_OUTPUT]);
  assert.equal(readEvents(root, 'fail-1').events.filter(e => e.type === 'PostToolUseFailure').length, 3);
});
test('a notice session-log.mjs writes with no newline is the same JSON, with a newline, when dispatched', () => {
  const dir = installed({ 'harness-log.mjs': null });
  const single = direct(join(dir, 'session-log.mjs'), root, failure('nl-1'));
  const merged = runEntry('dispatch-tool-failure.mjs', root, failure('nl-2'), { dir });
  assert.equal(merged.stdout, single.stdout + '\n');
});
test('one half throwing does not stop the other', () => {
  const throwing = name => `export function ${name}() { throw new Error('boom'); }\n`;
  const noGate = installed({ 'tool-gate.mjs': throwing('gateHalf') });
  assert.deepEqual(runEntry('dispatch-pre-tool.mjs', root, call('iso-1', 'rm -rf build'), { dir: noGate }).stdout, '');
  assert.equal(readEvents(root, 'iso-1').events.length, 1, 'the log half still recorded the call');
  const noLog = installed({ 'session-log.mjs': throwing('logHalf') });
  const denied = runEntry('dispatch-pre-tool.mjs', gatedRoot, call('iso-2', 'rm -rf build'), { dir: noLog });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny', 'the gate still denied');
});
test('an entry script beside a missing or older half or core exits 0 with one fixed notice', () => {
  const older = runEntry('dispatch-pre-tool.mjs', root, call('skew-1', 'ls'), { dir: installed({ 'tool-gate.mjs': 'export {};\n' }) });
  assert.equal(older.status, 0); assert.equal(older.stderr, '');
  assert.match(JSON.parse(older.stdout).systemMessage, /^kh-harness dispatch: \.claude\/scripts\/tool-gate\.mjs is older than its entry script and lacks what it needs, so the gate hook did not run on this event — re-run `node scripts\/apply\.mjs <repo> --yes`/);
  assert.equal(readEvents(root, 'skew-1').events.length, 1);
  for (const [core, problem] of [[null, 'is missing or cannot be loaded'], ['export {};\n', 'is older than this entry script and lacks what it needs']]) {
    const r = runEntry('dispatch-tool-failure.mjs', root, failure('skew-2'), { dir: installed({ 'harness-dispatch.mjs': core }) });
    assert.equal(r.status, 0); assert.equal(r.stderr, '');
    assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['systemMessage']);
    assert.ok(JSON.parse(r.stdout).systemMessage.startsWith(`kh-harness dispatch-tool-failure: .claude/scripts/harness-dispatch.mjs ${problem}, so no kh-harness hook ran on PostToolUseFailure — `));
  }
});
test('standard input that is not a JSON object is nothing to do', () => {
  // each entry script with '', 'not json', '[1]' and 'null' on stdin: { status: 0, stdout: '', stderr: '' }
});
test('the PreToolUse and PostToolUseFailure entry scripts never spawn a child process', () => {
  // --require scripts/lib/session-log-forbid-spawn.cjs with KH_SPAWN_TRAP, as loop-watch.test.mjs:401-408: status 0 and no trap file
});
```

Edit the existing pins:
- `hook-skew.test.mjs` `PAYLOADS`: add `'dispatch-pre-tool.mjs'` (the `tool-gate.mjs` payload), `'dispatch-post-tool.mjs'` (the `lint-touched.mjs` payload) and `'dispatch-tool-failure.mjs'` (the `loop-watch.mjs` payload).
- `propose.test.mjs:1829`: `HOOK_MODULE_PATHS` is `[HARNESS_DISPATCH_PATH, HARNESS_GATES_PATH, HARNESS_LOG_PATH, HARNESS_SEAL_PATH, REDACT_PATH]`. `:1856`: the scripts with no import the patterns find are `[SESSION_LOG_PATH, TOOL_GATE_PATH, HARNESS_DISPATCH_PATH, REDACT_PATH]`. `:1941`: `assert.ok(GENERATOR_SCRIPT_PATHS.includes(TOOL_GATE_PATH))`.
- Add to `propose.test.mjs`:
```js
test('each entry script is installed with exactly the hooks ENTRY_SCRIPTS says it runs, and the core names no sibling', () => {
  for (const { path, halves } of Object.values(ENTRY_SCRIPTS)) {
    assert.deepEqual(loadedSiblings(path).filter(p => p !== HARNESS_DISPATCH_PATH).sort(), [...halves].sort(), path);
    assert.ok(loadedSiblings(path).includes(HARNESS_DISPATCH_PATH), path);
  }
  assert.deepEqual(loadedSiblings(HARNESS_DISPATCH_PATH), []);
  assert.equal(everyLoadedSibling(DISPATCH_PRE_PATH).includes(LINT_TOUCHED_PATH), false, 'the lint sensor is installed only with the PostToolUse entry script');
});
```

- Add to `settings-merge.test.mjs`: `'a recorded entry-script registration is reverted, and one carrying a second argument is kept'` — `revertPatch` on `{ hooks: { PreToolUse: [{ hooks: [execEntry(DISPATCH_PRE_PATH)] }] } }` with its patch leaves `{}`; the same entry with `args` of length 2 is kept as `not-generator-producible`.
- `cli.test.mjs:191-192`, for this task only (Task 5 gives the final form): the registered scripts equal `GENERATOR_SCRIPT_PATHS` without `ENTRY_SCRIPT_PATHS`, and `GENERATOR_SCRIPT_PATHS.length - ENTRY_SCRIPT_PATHS.length === 7`.

- [ ] **Step 2: Run and confirm failure**
  Run: `node --test scripts/lib/harness-dispatch.test.mjs scripts/lib/propose.test.mjs`
  Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `harness-dispatch.mjs` and undefined `ENTRY_SCRIPTS`.

- [ ] **Step 3: Implement**

`harness-dispatch.mjs` imports nothing and contains no quoted `./name.mjs`, in code or comment. Each entry script begins `#!/usr/bin/env node\n` (the stamp is inserted after that line). `dispatch-pre-tool.mjs` in full, since the tests do not fix its shape:
```js
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EVENT = 'PreToolUse';
const CORE = ['combine', 'emit', 'half', 'readPayload', 'runHalves'];

/** Halves run before the gate, in order. */
export const preHalves = [];

function coreNotice(problem) {
  process.stdout.write(JSON.stringify({ systemMessage: `kh-harness dispatch-pre-tool: .claude/scripts/harness-dispatch.mjs ${problem}, so no kh-harness hook ran on ${EVENT} — ${REMEDY}` }) + '\n');
  return 0;
}

async function main() {
  let core;
  try {
    core = await import('./harness-dispatch.mjs');
  } catch {
    return coreNotice('is missing or cannot be loaded');
  }
  if (CORE.some(name => !(name in core))) return coreNotice('is older than this entry script and lacks what it needs');
  const payload = await core.readPayload();
  if (payload === null) return 0;
  const combined = core.combine(EVENT, await core.runHalves(payload, [
    ...preHalves,
    core.half('gate', 'tool-gate.mjs', 'gateHalf', () => import('./tool-gate.mjs')),
    core.half('log', 'session-log.mjs', 'logHalf', () => import('./session-log.mjs')),
  ]));
  core.emit(combined);
  return combined.exitCode;
}
```

followed by `isEntryPoint()` and a guarded block that runs `main`, takes 0 on a throw, and calls `process.exit(code)` (not `exitCode`, for the reason `session-log.mjs:421` states). `dispatch-post-tool.mjs` (`PostToolUse`; `log` then `lint` from `lint-touched.mjs`/`lintHalf`) and `dispatch-tool-failure.mjs` (`PostToolUseFailure`; `log` then `loop` from `loop-watch.mjs`/`loopHalf`) are the same without `preHalves`, the two imports and the guard: they end with the unguarded run-and-exit. Each file's header comment says what it runs, in what order, that it always exits with the highest code a half returned, and that its registration is the switch.

`propose.mjs`: three rows appended to `HOOK_SCRIPTS` — `[DISPATCH_PRE_PATH]: { asset: 'scripts/dispatch-pre-tool.mjs', step: TOOL_GATE_STEP, reason: 'no PreToolUse entry script registered' }`, `[DISPATCH_POST_PATH]: { …'dispatch-post-tool.mjs', step: 9, reason: 'no PostToolUse entry script registered' }`, `[DISPATCH_FAILURE_PATH]: { …'dispatch-tool-failure.mjs', step: LOOP_WATCH_STEP, reason: 'no PostToolUseFailure entry script registered' }` — and one row first in `HOOK_MODULES`: `[HARNESS_DISPATCH_PATH]: { asset: 'scripts/harness-dispatch.mjs', step: TOOL_GATE_STEP, reason: 'the shared core the three entry scripts run their hooks through' }`.

- [ ] **Step 4: Run the tests**
  Run: `node --test scripts/lib/harness-dispatch.test.mjs scripts/lib/hook-skew.test.mjs scripts/lib/propose.test.mjs scripts/lib/settings-merge.test.mjs scripts/lib/cli.test.mjs`, then `npm test`.
  Expected: PASS. No generator registers an entry script yet, so no install changes.

- [ ] **Step 5: Commit** the files this task names, as `feat(hooks): three entry scripts run the hooks of one tool-call event in one process through a shared core`.

### Task 3: Latency budget tests for the entry scripts

**Files:**
- Modify: `scripts/lib/harness-dispatch.test.mjs`, `package.json:8`

**Interfaces:**
- Consumes: `addedLatency({ runHookOnce, stdin, env, pairs })` (`scripts/lib/latency-fixtures.mjs:37`), the entry scripts (Task 2).

- [ ] **Step 1: Write the tests.** At the end of `harness-dispatch.test.mjs`, under a dated comment giving the machine, Node version and the measured added milliseconds for each entry script (measure with the command in Task 9, Step 1). Each name is a single-quoted literal: `latency-phase.test.mjs` finds a latency file by the text `test('latency budget: `.
```js
const ADDED_LATENCY_BUDGET_MS = 100;
const LATENCY_PAIRS = 40;

/** Asserts `name` stays within the budget over LATENCY_PAIRS runs of `payload` and logged each run. */
function assertWithinBudget(name, root, payload) {
  const stdin = JSON.stringify(payload);
  const { added, summary } = addedLatency({
    runHookOnce: () => { const r = runEntry(name, root, stdin); assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); },
    stdin, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, pairs: LATENCY_PAIRS,
  });
  assert.ok(added <= ADDED_LATENCY_BUDGET_MS, `${summary}; budget for the difference ${ADDED_LATENCY_BUDGET_MS} ms`);
  assert.equal(readEvents(root, payload.session_id).events.filter(e => e.type === payload.hook_event_name).length, LATENCY_PAIRS);
}
test('latency budget: dispatch-pre-tool.mjs — the fastest of 40 interleaved runs adds no more than the budget recorded in the test to a bare node start', () => {
  // an enabled project with one committed gate that does not match
  assertWithinBudget('dispatch-pre-tool.mjs', root, call('latency-pre', 'npm test'));
});
test('latency budget: dispatch-post-tool.mjs — the fastest of 40 interleaved runs adds no more than the budget recorded in the test to a bare node start', () => {
  assertWithinBudget('dispatch-post-tool.mjs', enabledProject(), { session_id: 'latency-post', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'x'.repeat(4096) }, duration_ms: 10 });
});
test('latency budget: dispatch-tool-failure.mjs — the fastest of 40 interleaved runs adds no more than the budget recorded in the test to a bare node start', () => {
  assertWithinBudget('dispatch-tool-failure.mjs', enabledProject(), failure('latency-fail'));
});
```

- [ ] **Step 2: Run and confirm failure**
  Run: `node --test scripts/lib/latency-phase.test.mjs`
  Expected: FAIL — the files holding `test('latency budget: ` no longer equal the files the second run names.

- [ ] **Step 3: Wire the file into `package.json`.** Append ` scripts/lib/harness-dispatch.test.mjs` to the second run of `scripts.test`.

- [ ] **Step 4: Run the tests**
  Run: `npm test`
  Expected: PASS; the second run reports five latency tests. A budget failure here is a finding about the merge, not a number to raise: stop and report it.

- [ ] **Step 5: Commit** the files this task names, as `test(hooks): each entry script has a latency budget, run in the suite's second phase`.

### Task 4: Every reader of "is this hook registered" accepts the entry script

**Files:**
- Modify: `scripts/lib/hook-evidence.mjs:74-125`, `scripts/lib/log-lib.mjs:105-116`, `scripts/lib/lifecycle-fixtures.mjs`
- Test: `scripts/lib/gap-model.test.mjs`, `scripts/lib/log-cli.test.mjs`, `scripts/lib/rules-evidence.test.mjs`

**Interfaces:**
- Consumes: `ENTRY_SCRIPTS` (Task 2).
- Produces, from `hook-evidence.mjs`:
  - `entryScriptFor(event, scriptPath): string | null` — the entry script that runs `scriptPath` on `event`.
  - `directRegistrations(harness, event, scriptPath, matcher): registration[]` — the registrations on `event` that run `scriptPath` itself: by resolved `script`, or, when `script` is `null`, by `entrySha256` being a hash the kit writes for `scriptPath` under `matcher`.
  - `registeredHook` (signature unchanged) also credits `ourPath` when the event's entry script for it is registered under a matcher that covers `matcher`. Evidence for that case: `` `${event} hook: ${ourPath}, run by ${entry}` ``, and in the install-record branch `` `${event} hook: ${ourPath}, run by ${entry} (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)` ``. The install-record branch accepts a recorded patch whose hash is `hookEntrySha256(execEntry(entry))` and requires the entry script's file on disk. A direct registration, when present, is the one named.
- Produces, from `lifecycle-fixtures.mjs`: `loggingScript(d, event): string` — the basename of the event's entry script when `d`'s settings register it on `event`, else `'session-log.mjs'`.
- `runsKitScript` is unchanged: an entry-script registration is not "the logging hook", which is what makes it an enforcer for `settings:hooks.<Event>`.

- [ ] **Step 1: Write the failing tests**

`gap-model.test.mjs` (build `merged`, a harness whose `hookRegistrations` hold the three entry scripts on their events, `session-log.mjs` on the other thirteen, and every `toolGateDenyRules()` rule; use a stack that declares `lint`):
```js
test('each of the four hook checks is declared when its event holds the entry script in place of the single script', () => {
  const checks = gaps(lintStack, merged);
  for (const id of ['P5.toolgate', 'P2.sensor', 'P2.loopwatch', 'P5.sessionlog']) assert.equal(byId(checks, id).state, 'declared', id);
  assert.deepEqual(byId(checks, 'P5.toolgate').evidence, [`PreToolUse hook: ${TOOL_GATE_PATH}, run by ${DISPATCH_PRE_PATH}`]);
  assert.deepEqual(byId(checks, 'P2.sensor').evidence, [`PostToolUse hook: ${LINT_TOUCHED_PATH}, run by ${DISPATCH_POST_PATH}`]);
  assert.deepEqual(byId(checks, 'P5.sessionlog').evidence, [
    `${SESSION_LOG_PATH} is registered on all ${LOGGED_EVENTS.length} logged events: ${LOGGED_EVENTS.join(', ')}`,
    `PreToolUse hook: ${SESSION_LOG_PATH}, run by ${DISPATCH_PRE_PATH}`,
    `PostToolUse hook: ${SESSION_LOG_PATH}, run by ${DISPATCH_POST_PATH}`,
    `PostToolUseFailure hook: ${SESSION_LOG_PATH}, run by ${DISPATCH_FAILURE_PATH}`,
  ]);
});
test('an entry script on an event it is not for credits nothing there', () => {
  const c = byId(gaps(lintStack, withRegistrations({ PostToolUse: [{ script: DISPATCH_PRE_PATH, matcher: null }] })), 'P2.sensor');
  assert.equal(c.state, 'absent');
  assert.deepEqual(c.evidence, [`PostToolUse already holds another kh-harness hook: ${DISPATCH_PRE_PATH}`]);
});
test('the PostToolUse entry script under a matcher that does not fire for edits credits the log and not the lint sensor', () => {
  const h = withRegistrations({ PostToolUse: [{ script: DISPATCH_POST_PATH, matcher: 'Bash' }] });
  assert.equal(registeredHook(h, 'PostToolUse', LINT_TOUCHED_PATH, 'p', { matcher: SENSOR_MATCHER, kitScripts: GENERATOR_SCRIPT_PATHS }).state, 'absent');
  assert.equal(registeredHook(h, 'PostToolUse', SESSION_LOG_PATH, null, { kitScripts: GENERATOR_SCRIPT_PATHS }).state, 'declared');
});
test('an entry script the file scan cannot resolve is credited from the install record and the file on disk', () => {
  const sha = hookEntrySha256(execEntry(DISPATCH_PRE_PATH));
  const unresolved = Object.defineProperty({ script: null, matcher: null }, 'entrySha256', { value: sha });
  const d = repoWith({ [DISPATCH_PRE_PATH]: '//' });
  const manifest = { schema: 1, files: [], settingsPatches: [{ event: 'PreToolUse', container: '/hooks/PreToolUse', entrySha256: sha }] };
  const r = registeredHook(withRegistrations({ PreToolUse: [unresolved] }), 'PreToolUse', TOOL_GATE_PATH, 'p', { manifest, root: d, kitScripts: GENERATOR_SCRIPT_PATHS });
  assert.deepEqual(r, { state: 'declared', evidence: [`PreToolUse hook: ${TOOL_GATE_PATH}, run by ${DISPATCH_PRE_PATH} (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)`] });
  assert.equal(registeredHook(withRegistrations({ PreToolUse: [unresolved] }), 'PreToolUse', TOOL_GATE_PATH, 'p', { manifest: { ...manifest, settingsPatches: [] }, root: d, kitScripts: GENERATOR_SCRIPT_PATHS }).state, 'absent');
});
```

`log-cli.test.mjs`:
```js
test('status counts a logged event that holds its entry script', () => {
  const root = project();
  // session-log.mjs on the thirteen other events, each ENTRY_SCRIPTS[event].path on its own event
  assert.deepEqual(statusJson(root).hookEvents, { registered: LOGGED_EVENTS.length, logged: LOGGED_EVENTS.length });
  assert.equal(statusJson(root).hookRegistered, true);
});
test('status does not count an entry script registered on an event it is not for', () => {
  // dispatch-pre-tool.mjs on PostToolUse only
  assert.deepEqual(statusJson(root).hookEvents, { registered: 0, logged: LOGGED_EVENTS.length });
});
```

`rules-evidence.test.mjs`:
```js
test('settings:hooks.PreToolUse resolves when the entry script is the only hook on PreToolUse', () => {
  // RULES.md with `- enforced-by: hook` / `- pointer: settings:hooks.PreToolUse`; harness with [{ script: DISPATCH_PRE_PATH, matcher: null }]
  assert.deepEqual(rulesRegistryEvidence(d, harness).missingPointers, []);
});
test('every entry script runs a hook besides the logging one, so its registration is never the logging half alone', () => {
  for (const [event, { halves }] of Object.entries(ENTRY_SCRIPTS)) assert.ok(halves.some(h => h !== SESSION_LOG_PATH), event);
});
```

- [ ] **Step 2: Run and confirm failure**
  Run: `node --test scripts/lib/gap-model.test.mjs scripts/lib/log-cli.test.mjs scripts/lib/rules-evidence.test.mjs`
  Expected: FAIL — the four checks read `absent`, `log status` counts 13. The two `rules-evidence` tests pass already and stay as pins.

- [ ] **Step 3: Implement** `entryScriptFor`, `directRegistrations`, the `registeredHook` change, and in `log-lib.mjs` `hookRegistration(root)` counting an event when an entry on it names `SESSION_LOG_SCRIPT` or `entryScriptFor(event, SESSION_LOG_SCRIPT)`. Add `loggingScript` to `lifecycle-fixtures.mjs`. In `registeredHook`, an entry script on its own event is one of "ours" and so is never listed as an occupant.

- [ ] **Step 4: Run the tests**

Run the three files above, then `npm test`.
  Expected: PASS.

- [ ] **Step 5: Commit** the files this task names, as `feat(detect): a hook run by its event's entry script counts as registered, in detect and in log status`.

### Task 5: A fresh install registers the entry scripts

**Files:**
- Modify: `scripts/lib/propose.mjs:115-128,192-231,321-336`, `scripts/lib/gap-model.mjs:731-733`, `scripts/lib/cli.mjs:88-108`, `README.md:213`, `docs/guide/commands.md:221`
- Test: `scripts/lib/propose.test.mjs`, `scripts/lib/cli.test.mjs:176-216`, `scripts/lib/lifecycle.test.mjs`, and the install-layout pins listed in Step 1

**Interfaces:**
- Consumes: `ENTRY_SCRIPTS`, `registeredHook`, `directRegistrations` (Tasks 2, 4); `hookFiles`, `requiredFiles`, `execEntry`, `hasLintScript`.
- Produces, from `propose.mjs`:
  - `mergePlan(event, { harness, manifest, root, stack }): { entry: string, state: 'merged' | 'mergeable' | 'separate' | 'single', missing: string[], remove: string[], why: string | null }` for an event of `ENTRY_SCRIPTS`.
    - *Wanted* halves: the event's halves, leaving out `lint-touched.mjs` unless `registeredHook` credits it or `hasLintScript(stack)`.
    - `merged`: `directRegistrations` finds the entry script on the event.
    - `single`: fewer than two wanted halves.
    - `separate`: some wanted half has a direct registration; `why` is `'its hooks are registered separately'`. (Task 7 narrows this.)
    - `mergeable`: otherwise; `missing` is every wanted half, `remove` is `[]`.
  - `entryProposals(event, plan, { kitVersion, reason }): Proposal[]` — `hookFiles(plan.entry, kitVersion)` followed by `{ kind: 'settings-hook', event, step: <the entry's HOOK_SCRIPTS step>, entry: execEntry(plan.entry), requiresFiles, reason }`, with no `matcher`.
- Generator rule: `toolGateProposal`, `sensorProposal` and `loopWatchProposal`, where they register their own script today, return `entryProposals(...)` instead when `mergePlan(event, ctx).state === 'mergeable'`. `sessionLogProposal` registers nothing on a missing event whose plan is `mergeable` (the other half's generator registers the entry there) and `session-log.mjs` itself on every other missing event.

- [ ] **Step 1: Write the failing tests**

`propose.test.mjs`. `freshArgs(overrides)` is `buildProposals`' arguments for a repository with no kit hook, its `checks` from a real `buildGaps` over that harness and stack; `lintStack` declares a `lint` script and `noLintStack` does not; `withRegistrations(byEvent)` is `bareHarness` with those `hookRegistrations`.
```js
test('on a repository with none of the kit\'s hooks, each tool-call event gets one registration: its entry script', () => {
  const hooks = buildProposals(freshArgs({ stack: lintStack })).filter(p => p.kind === 'settings-hook');
  const on = event => hooks.filter(p => p.event === event);
  for (const [event, path, checkId] of [['PreToolUse', DISPATCH_PRE_PATH, 'P5.toolgate'], ['PostToolUse', DISPATCH_POST_PATH, 'P2.sensor'], ['PostToolUseFailure', DISPATCH_FAILURE_PATH, 'P2.loopwatch']]) {
    assert.equal(on(event).length, 1, event);
    assert.deepEqual(on(event)[0].entry, execEntry(path));
    assert.equal(on(event)[0].checkId, checkId);
    assert.equal('matcher' in on(event)[0], false);
    assert.deepEqual(on(event)[0].requiresFiles.map(f => f.path), [path, ...everyLoadedSibling(path)]);
  }
  const direct = hooks.filter(p => p.entry.args[0].endsWith(SESSION_LOG_PATH)).map(p => p.event);
  assert.deepEqual(direct, LOGGED_EVENTS.filter(e => !Object.hasOwn(ENTRY_SCRIPTS, e)));
});
test('without a lint script PostToolUse gets session-log.mjs alone, and neither dispatch-post-tool.mjs nor lint-touched.mjs is written', () => {
  const ps = buildProposals(freshArgs({ stack: noLintStack }));
  assert.deepEqual(ps.filter(p => p.kind === 'settings-hook' && p.event === 'PostToolUse').map(p => p.entry), [execEntry(SESSION_LOG_PATH)]);
  for (const path of [DISPATCH_POST_PATH, LINT_TOUCHED_PATH]) assert.equal(ps.some(p => p.path === path), false, path);
});
test('an event that already holds one of its hooks separately gets the other separately, as before', () => {
  // a harness with session-log.mjs registered, by script, on all sixteen events
  const ps = buildProposals(freshArgs({ stack: lintStack, harness: loggedEverywhere })).filter(p => p.kind === 'settings-hook' && Object.hasOwn(ENTRY_SCRIPTS, p.event));
  assert.deepEqual(ps.map(p => `${p.event} ${p.entry.args[0].split('/').pop()} ${p.matcher}`).sort(), [
    `PostToolUse lint-touched.mjs ${SENSOR_MATCHER}`, 'PostToolUseFailure loop-watch.mjs undefined', 'PreToolUse tool-gate.mjs undefined',
  ]);
});
test('mergePlan: merged, single, separate and mergeable', () => {
  const ctx = h => ({ harness: h, manifest: null, root: undefined, stack: lintStack });
  assert.equal(mergePlan('PreToolUse', ctx(withRegistrations({ PreToolUse: [{ script: DISPATCH_PRE_PATH, matcher: null }] }))).state, 'merged');
  assert.equal(mergePlan('PostToolUse', { ...ctx(bareHarness), stack: noLintStack }).state, 'single');
  assert.deepEqual(mergePlan('PreToolUse', ctx(withRegistrations({ PreToolUse: [{ script: TOOL_GATE_PATH, matcher: null }] }))),
    { entry: DISPATCH_PRE_PATH, state: 'separate', missing: [], remove: [], why: 'its hooks are registered separately' });
  assert.deepEqual(mergePlan('PostToolUseFailure', ctx(bareHarness)),
    { entry: DISPATCH_FAILURE_PATH, state: 'mergeable', missing: [SESSION_LOG_PATH, LOOP_WATCH_PATH], remove: [], why: null });
});
```

`cli.test.mjs:176-195`, final form: run the generators over two harnesses, the fixture's own and one with `session-log.mjs` registered on all sixteen events, and assert the union of registered scripts equals `GENERATOR_SCRIPT_PATHS`; keep `GENERATOR_SCRIPT_PATHS.length - ENTRY_SCRIPT_PATHS.length === 7`; assert `/registers up to seven hook scripts/` and `/three entry scripts/`.

`lifecycle.test.mjs`, new:
```js
test('a fresh install starts one kh-harness process per tool-call event, and uninstall leaves none behind', () => {
  const d = fixtureWithLint();   // `fixture()` plus a `lint` script, committed
  const before = readFileSync(join(d, '.claude/settings.json'), 'utf8');
  run(APPLY, d, '--yes', '--allow-dirty');
  const kit = event => (settings(d).hooks[event] ?? []).flatMap(m => m.hooks).map(h => h.args?.[0]).filter(a => a?.includes('.claude/scripts/'));
  for (const [event, { path }] of Object.entries(ENTRY_SCRIPTS)) assert.deepEqual(kit(event), [`\${CLAUDE_PROJECT_DIR}/${path}`], event);
  const checks = JSON.parse(run(DETECT, d, '--json')).checks;
  for (const id of ['P5.toolgate', 'P2.sensor', 'P2.loopwatch', 'P5.sessionlog']) assert.equal(checks.find(c => c.id === id).state, 'declared', id);
  assert.deepEqual(JSON.parse(run(LOG, d, 'status', '--json')).hookEvents, { registered: LOGGED_EVENTS.length, logged: LOGGED_EVENTS.length });
  for (const h of runEveryRegisteredHook(d)) assert.notEqual(h.status, 1, `${h.script} on ${h.event}: ${h.stderr}`);
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
  run(UNINSTALL, d, '--yes');
  assert.deepEqual(existsSync(join(d, '.claude/scripts')) ? readdirSync(join(d, '.claude/scripts')) : [], []);
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), before);
});
```

Pins of the old layout, each changed to the new one. These are the expected failures; any other is a finding.
- `tool-gate.test.mjs:569`: the `PreToolUse` entry is `execEntry(DISPATCH_PRE_PATH)`. `loop-watch.test.mjs:427`: `execEntry(DISPATCH_FAILURE_PATH)`. These are the only edits to the four scripts' test files; both tests go on to run the installed single script directly and to uninstall, unchanged.
- `propose.test.mjs:1820-1822` (the gate hook's `entry` and `requiresFiles`), `:2025` (the logging hook is proposed on the thirteen other events), the `P2.sensor` and `P2.loopwatch` proposal tests that read `.entry` or `.matcher`, and `P5.sessionlog`'s proposal text.
- `lifecycle.test.mjs:211-214`: "our" `PostToolUse` entry is `dispatch-post-tool.mjs` and has no `matcher`. `:945-947` `loggingHookCounts`: count the entry named `loggingScript(d, event)`.
- `lifecycle-upgrade.test.mjs:99-101`: the logging hook is on `event` through `loggingScript(d, event)`.
- `learn-lifecycle.test.mjs:141-171`: `logged(event, …)` runs `loggingScript(d, event)`; `bash()` runs `dispatch-pre-tool.mjs` once and reads the decision from its output, and on a failure runs `dispatch-tool-failure.mjs` once and asserts it silent, in place of the two parallel runs each. `:707`: `gateOn` runs `dispatch-pre-tool.mjs`. `:253`: the installed scripts include the two entry scripts and `harness-dispatch.mjs`. `:258`: `['PreToolUse hook: .claude/scripts/tool-gate.mjs, run by .claude/scripts/dispatch-pre-tool.mjs']`.

- [ ] **Step 2: Run and confirm failure**
  Run: `node --test scripts/lib/propose.test.mjs scripts/lib/cli.test.mjs scripts/lib/lifecycle.test.mjs`
  Expected: FAIL — the generators still register the single scripts.

- [ ] **Step 3: Implement** `mergePlan`, `entryProposals` and the generator rule. `P5.sessionlog`'s full-install proposal (`gap-model.mjs:733`) ends `…and register it on the ${total} logged events, through the entry script on an event that has one — it records nothing until the log is enabled for this repository on this machine`. In `EXECUTION_DISCLOSURE` keep the first sentence and add, after the paragraph on the exec form:

```
  On PreToolUse and PostToolUseFailure, and on PostToolUse where the lint
  hook is installed, the two hooks of the event are started by one of three
  entry scripts (dispatch-pre-tool.mjs, dispatch-post-tool.mjs,
  dispatch-tool-failure.mjs), so the event starts one process, not two.
  Each hook does what is said for it here, in the same order every time.
```

Copy the block's new text to `README.md` and `docs/guide/commands.md`, which reproduce it.

- [ ] **Step 4: Run the tests**
  Run: `npm test`
  Expected: PASS. `lifecycle-kill.test.mjs` and `lifecycle-upgrade.test.mjs` pass with only the edit named above.

- [ ] **Step 5: Commit** the files this task names, as `feat(apply): a fresh install registers one entry script on each tool-call event`.

### Task 6: `apply` can replace registrations it recorded

**Files:**
- Modify: `scripts/lib/settings-merge.mjs`, `scripts/lib/apply-lib.mjs:555-567,617-633,780-809,861-884,929-937,954-962`, `scripts/apply.mjs:182-186,199,275`
- Test: `scripts/lib/settings-merge.test.mjs`, `scripts/lib/apply-lib.test.mjs`

**Interfaces:**
- Produces:
  - `settings-merge.mjs`: `replaceHookEntries(settings, event, remove, entry): { settings, patch: { container, entrySha256 }, removed: object[] } | null` — returns `null` unless every hash in `remove` is `matcherEntrySha256` of an element of `hooks[event]`; otherwise a clone with those elements taken out and `buildMatcherEntry(entry)` appended, and `removed`, the elements taken out in file order.
  - Proposal kind `settings-hook-replace`: `{ kind, event, step, entry, remove: string[], requiresFiles, reason, checkId }`.
  - `applyProposals`: stages it; `patched` gains `{ event, step, checkId, replaced: remove.length }`; `skipped` reasons are those of `settings-hook` plus `'registration-changed'` when `replaceHookEntries` returns `null`.
  - Manifest: the new record is `{ event, container, entrySha256, step, checkId, appliedAt }` as for `settings-hook`. The records whose `patchKey` is `` `/hooks/${event}\n${hash}` `` for each removed hash are filtered out of `nextManifest.settingsPatches` only after `replaceSettings` returns; the manifest handed to `persistManifest` before it still holds them.
  - `diffRenderer`: previews the kind (format below) and carries the replacement into what later previews see.
  - `scripts/apply.mjs`: label `` `.claude/settings.json (hook: ${p.event}, replacing ${n} registration${n === 1 ? '' : 's'})` ``; the disclosure is printed for this kind too; result line `` `patched    .claude/settings.json (${p.event}; ${p.replaced} separate registration${p.replaced === 1 ? '' : 's'} removed)` `` when `p.replaced` is set.

Preview, exactly:

```
--- a/.claude/settings.json
+++ b/.claude/settings.json
@@ hooks.<Event> @@
-<each line of JSON.stringify(element, null, 2), for each removed element in file order>
+<each line of JSON.stringify(buildMatcherEntry(entry), null, 2)>
(<K> other hooks.<Event> entr<y|ies> <is|are> left unchanged and not shown)          ← only when K > 0
(nothing else in .claude/settings.json is changed, or shown — it is yours, and it may hold credentials)
```

When `replaceHookEntries` returns `null`, the body between the `@@` line and the last line is the one line `(a registration kh-harness recorded on hooks.<Event> is no longer there as written — this replacement would be skipped)`. A removed element is printed only because its hash is one the caller supplied; Task 7 supplies only hashes of what the kit itself writes, so no owner text can appear.

- [ ] **Step 1: Write the failing tests**

`settings-merge.test.mjs`:
```js
const gate = { hooks: [execEntry(TOOL_GATE_PATH)] };
const log = { hooks: [execEntry(SESSION_LOG_PATH)] };
const theirs = { hooks: [{ type: 'command', command: 'node my-own.mjs' }] };
const sha = matcherEntrySha256;
test('replaceHookEntries takes out the named elements, appends the entry and leaves every other element where it was', () => {
  const before = { env: { A: '1' }, hooks: { PreToolUse: [gate, theirs, log], Stop: [theirs] } };
  const r = replaceHookEntries(before, 'PreToolUse', [sha(log), sha(gate)], execEntry(DISPATCH_PRE_PATH));
  assert.deepEqual(r.settings, { env: { A: '1' }, hooks: { PreToolUse: [theirs, { hooks: [execEntry(DISPATCH_PRE_PATH)] }], Stop: [theirs] } });
  assert.deepEqual(r.patch, { container: '/hooks/PreToolUse', entrySha256: hookEntrySha256(execEntry(DISPATCH_PRE_PATH)) });
  assert.deepEqual(r.removed, [gate, log]);
  assert.deepEqual(before.hooks.PreToolUse, [gate, theirs, log], 'the input is not changed');
});
test('replaceHookEntries changes nothing when a named element is not there as written', () => {
  const edited = { hooks: [{ ...execEntry(SESSION_LOG_PATH), timeout: 5 }] };
  assert.equal(replaceHookEntries({ hooks: { PreToolUse: [gate, edited] } }, 'PreToolUse', [sha(gate), sha(log)], execEntry(DISPATCH_PRE_PATH)), null);
  assert.equal(replaceHookEntries({}, 'PreToolUse', [sha(gate)], execEntry(DISPATCH_PRE_PATH)), null);
});
test('records a killed replacement left behind are gone to uninstall, and the entry script\'s registration is reverted', () => {
  const settings = { hooks: { PreToolUse: [{ hooks: [execEntry(DISPATCH_PRE_PATH)] }] } };
  const patch = (script) => ({ event: 'PreToolUse', container: '/hooks/PreToolUse', entrySha256: hookEntrySha256(execEntry(script)) });
  const r = revertPatches(settings, [patch(TOOL_GATE_PATH), patch(SESSION_LOG_PATH), patch(DISPATCH_PRE_PATH)], PRODUCIBLE);
  assert.deepEqual(r.settings, {});
  assert.deepEqual([r.reverted.length, r.gone.length, r.kept.length], [1, 2, 0]);
});
```

`apply-lib.test.mjs` (a repository whose settings hold `gate`, `theirs`, `log` on `PreToolUse`, a manifest recording the two kit patches, and the entry script's `requiresFiles` on disk; `replace` is the proposal):
```js
test('a replacement removes the recorded registrations, adds the entry script and swaps the records', () => {
  const r = applyProposals({ root: d, proposals: [replace], manifest, kitVersion: '0.2.0' });
  assert.deepEqual(readSettings(d).hooks.PreToolUse, [theirs, { hooks: [execEntry(DISPATCH_PRE_PATH)] }]);
  assert.deepEqual(r.patched, [{ event: 'PreToolUse', step: 30, checkId: 'P0.hookmerge', replaced: 2 }]);
  assert.deepEqual(r.manifest.settingsPatches.map(p => p.entrySha256), [hookEntrySha256(execEntry(DISPATCH_PRE_PATH))]);
  assert.deepEqual(Object.keys(r.manifest.settingsPatches[0]), ['event', 'container', 'entrySha256', 'step', 'checkId', 'appliedAt']);
});
test('the manifest written before the settings file still records the registrations about to be removed', () => {
  let persisted;
  applyProposals({ root: d, proposals: [replace], manifest, kitVersion: '0.2.0', persistManifest: m => { persisted = structuredClone(m); } });
  assert.equal(persisted.settingsPatches.length, 3);
});
test('a settings write that fails during a replacement leaves the manifest\'s records as they were', () => {
  const r = applyProposals({ root: d, proposals: [replace], manifest, kitVersion: '0.2.0', replaceSettings: () => { throw new Error('disk full'); } });
  assert.deepEqual(r.manifest.settingsPatches, manifest.settingsPatches);
  assert.equal(r.failed.length, 1);
  assert.deepEqual(readSettings(d).hooks.PreToolUse, [gate, theirs, log]);
});
test('a replacement is skipped whole when a registration it names is not there as recorded, is already made, or lacks a file', () => {
  // (a) the log element edited on disk            → skipped [{ path: SETTINGS_PATH, why: 'registration-changed', checkId }], file and manifest unchanged
  // (b) the entry script already on the event     → why 'unchanged'
  // (c) a requiresFiles path deleted              → why starts 'missing-dependency: '
});
test('the preview of a replacement shows the elements removed and the one added, and nothing else of the file', () => {
  assert.equal(renderDiff(d, replace), [
    '--- a/.claude/settings.json', '+++ b/.claude/settings.json', '@@ hooks.PreToolUse @@',
    ...JSON.stringify(gate, null, 2).split('\n').map(l => `-${l}`),
    ...JSON.stringify(log, null, 2).split('\n').map(l => `-${l}`),
    ...JSON.stringify({ hooks: [execEntry(DISPATCH_PRE_PATH)] }, null, 2).split('\n').map(l => `+${l}`),
    '(1 other hooks.PreToolUse entry is left unchanged and not shown)',
    '(nothing else in .claude/settings.json is changed, or shown — it is yours, and it may hold credentials)',
  ].join('\n'));
  assert.doesNotMatch(renderDiff(d, replace), /my-own/);
});
test('an unknown proposal kind still throws before anything is written', () => {
  // kind 'settings-hook-remove' → throws /unknown proposal kind/
});
```

- [ ] **Step 2: Run and confirm failure**
  Run: `node --test scripts/lib/settings-merge.test.mjs scripts/lib/apply-lib.test.mjs`
  Expected: FAIL — `replaceHookEntries` is not exported; `applyProposals` throws `unknown proposal kind: settings-hook-replace`. The `revertPatches` test passes already and stays as a pin.

- [ ] **Step 3: Implement.** `stageSettingsReplace({ root, proposal, batch, skipped })` follows `stageSettingsHook`'s order — `unmetDependencies`, `batch.read.ok`, `hasEquivalentHook` — then `replaceHookEntries`; it pushes the new record and the `patched` entry, and adds each removed patch key to `batch.dropped` (a `Set` opened with the batch). `writeSettingsBatch` filters `batch.dropped` out of `nextManifest.settingsPatches` after the settings write succeeds, and its comment states the invariant of Decision 15. `diffRenderer` gets its own branch for the kind before the deny fall-through.

- [ ] **Step 4: Run the tests**

Run the two files, then `npm test`.
  Expected: PASS. Nothing proposes the new kind yet.

- [ ] **Step 5: Commit** the files this task names, as `feat(apply): a proposal may replace registrations apply recorded with another, in one settings write`.

### Task 7: Existing installs are migrated: `P0.hookmerge`

**Files:**
- Modify: `scripts/lib/hook-evidence.mjs:33-35`, `scripts/lib/propose.mjs` (`mergePlan`, `entryProposals`, `sessionLogProposal`, `GENERATORS`, `buildProposals:1008`), `scripts/lib/gap-model.mjs` (new check before `P0.kitskew`), `scripts/lib/lifecycle-fixtures.mjs`
- Create: `scripts/lib/hook-merge-lifecycle.test.mjs`
- Test: `scripts/lib/propose.test.mjs`, `scripts/lib/gap-model.test.mjs`

**Interfaces:**
- Consumes: `settings-hook-replace` (Task 6); `mergePlan`, `entryProposals` (Task 5); `unlessHeld`.
- Produces:
  - `hook-evidence.mjs`: `kitEntryHashes(scriptPath, matcher): Set<string>` — `recordedHashes`, exported under that name.
  - `mergePlan`, final rules for `separate` and `mergeable`. *Recorded here* are the manifest's patches with `event` equal to the event and `entrySha256` in `kitEntryHashes(half, halfMatcher)` for one of the event's halves (`SENSOR_MATCHER` for the lint sensor, none otherwise).
    - `separate`, `why: 'a registration of <script> is not as kh-harness recorded it'`: a direct registration of a wanted half whose `entrySha256` is not recorded here.
    - `separate`, `why: 'a registration kh-harness recorded on <Event> is no longer there'`: a patch recorded here whose hash no registration on the event has.
    - `mergeable`: otherwise. `remove` is the hashes recorded here; `missing` is the wanted halves with no direct registration.
  - `entryProposals` returns a `settings-hook-replace` carrying `remove: plan.remove` when `plan.remove.length > 0`.
  - Which generator registers a mergeable event's entry: the non-logging half's when that half is in `missing`; else `sessionLogProposal` when `session-log.mjs` is in `missing`; else `GENERATORS['P0.hookmerge']`, with `reason` `` `${event} holds ${plan.remove.length} separate kh-harness registrations; ${plan.entry} runs the same hooks in one process` ``.
  - `buildProposals` drops a `settings-hook-replace` whose `requiresFiles` include a held script, as it does a `settings-hook`.
  - Check `P0.hookmerge`, `step: 2`, `phase: 0`, `lookedFor: ['the kh-harness hooks registered on PreToolUse, PostToolUse and PostToolUseFailure in .claude/settings.json, against the registrations .claude/kh-harness.manifest.json records']`. One evidence line per event:
    - merged: `` `${event}: one process — ${entry} runs its hooks` ``
    - mergeable with nothing missing: `` `${event}: ${n} kh-harness hooks are registered separately, one process each` ``
    - separate: `` `${event}: left on separate registrations — ${why}` ``
    - any other plan: no line (the half's own check speaks).
    - State `absent` with proposal `` `replace the separate kh-harness registrations on ${events.join(', ')} with one entry script each, so each of those events starts one process` `` when any event is mergeable with nothing missing, passed through `unlessHeld(result, <first such entry>, heldScript)`; else `declared` when there is any line; else `n/a` with `['no tool-call event holds two kh-harness hooks']`.
  - `lifecycle-fixtures.mjs`: `separateRegistrations(d): void` — on an installed repository, for each event of `ENTRY_SCRIPTS` whose entry script is registered, replaces that element in `.claude/settings.json` with one element per half (`execEntry(half)`, under `SENSOR_MATCHER` for the lint sensor) and the manifest's record with one per half (`checkId` `P5.sessionlog`, `P5.toolgate`, `P2.sensor` or `P2.loopwatch`; `step` that check's), leaving every file as installed. This is the layout the kit wrote before this plan.

- [ ] **Step 1: Write the failing tests**

`propose.test.mjs` / `gap-model.test.mjs` (registrations built with a real `entrySha256` through a helper `recorded(script, matcher)` returning `{ registration, patch }`):
```js
test('an event whose two hooks are both as recorded is replaceable, and P0.hookmerge proposes it', () => {
  const g = recorded(TOOL_GATE_PATH), l = recorded(SESSION_LOG_PATH);
  const ctx = { harness: withRegistrations({ PreToolUse: [g.registration, l.registration] }), manifest: manifestWith([g.patch, l.patch]), root: d, stack: lintStack };
  assert.deepEqual(mergePlan('PreToolUse', ctx), { entry: DISPATCH_PRE_PATH, state: 'mergeable', missing: [], remove: [g.patch.entrySha256, l.patch.entrySha256], why: null });
  const c = byId(gapsFor(ctx), 'P0.hookmerge');
  assert.equal(c.state, 'absent'); assert.equal(c.via, 'apply');
  assert.deepEqual(c.evidence, ['PreToolUse: 2 kh-harness hooks are registered separately, one process each']);
  const [replace] = buildProposals(argsFor(ctx)).filter(p => p.kind === 'settings-hook-replace');
  assert.deepEqual([replace.event, replace.checkId, replace.remove, replace.entry], ['PreToolUse', 'P0.hookmerge', [g.patch.entrySha256, l.patch.entrySha256], execEntry(DISPATCH_PRE_PATH)]);
});
test('a registration that is not the recorded one, or a recorded one that is gone, leaves the event separate, and the check says which', () => {
  // (a) tool-gate.mjs registered by script with a hash the manifest does not record
  //     → why 'a registration of .claude/scripts/tool-gate.mjs is not as kh-harness recorded it'
  // (b) both recorded, only the gate's registration present
  //     → why 'a registration kh-harness recorded on PreToolUse is no longer there'
  // each: P0.hookmerge is 'declared', evidence [`PreToolUse: left on separate registrations — ${why}`], and no settings-hook-replace is proposed
});
test('a stale record of the entry script itself does not make an event separate', () => {
  // manifest records gate, log and the entry script; only gate and log are registered → 'mergeable'
});
test('when one hook of an event is missing and the other is as recorded, the missing hook\'s check replaces the recorded one with the entry script', () => {
  // only lint-touched.mjs registered and recorded on PostToolUse → the proposal's checkId is 'P5.sessionlog', remove is [the lint hash]
  // only session-log.mjs registered and recorded on PreToolUse  → checkId 'P5.toolgate', remove [the log hash]
  // in both, P0.hookmerge proposes nothing for the event
});
test('P0.hookmerge is n/a on a repository with no kit hook, declared once merged, and proposes nothing while a script is held', () => {});
test('P0.hookmerge sits directly before P0.kitskew in the checks and in the generators', () => {});
```

The Task 5 `mergePlan` test's `separate` case changes with the rule: its `why` becomes `'a registration of .claude/scripts/tool-gate.mjs is not as kh-harness recorded it'`.

`scripts/lib/hook-merge-lifecycle.test.mjs` (each test: `fixtureWithLint()`, `apply --yes`, `separateRegistrations(d)`, commit). `kitEntriesOn(d, event)` is the `args[0]` of every hook on `event` that names `.claude/scripts/`; `checkOf(d, id)` is that check from `detect --json`:
```js
test('apply on an install with separate registrations proposes exactly one replacement per tool-call event, and a second apply proposes nothing', () => {
  const dry = run(APPLY, d);
  assert.match(dry, /^kh-harness: 3 actions to close 1 capability gap /m);
  for (const event of Object.keys(ENTRY_SCRIPTS)) assert.ok(dry.includes(`--- .claude/settings.json (hook: ${event}, replacing 2 registrations)  [P0.hookmerge]`), event);
  assert.match(dry, /^-\s+"\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/scripts\/tool-gate\.mjs"$/m);
  assert.match(dry, /^\+\s+"\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/scripts\/dispatch-pre-tool\.mjs"$/m);
  const out = run(APPLY, d, '--yes');
  for (const event of Object.keys(ENTRY_SCRIPTS)) assert.ok(out.includes(`patched    .claude/settings.json (${event}; 2 separate registrations removed)`), event);
  for (const [event, { path }] of Object.entries(ENTRY_SCRIPTS)) assert.deepEqual(kitEntriesOn(d, event), [`\${CLAUDE_PROJECT_DIR}/${path}`]);
  assert.equal(manifestOf(d).settingsPatches.filter(p => Object.hasOwn(ENTRY_SCRIPTS, p.event)).length, 3);
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
  assert.equal(checkOf(d, 'P0.hookmerge').state, 'declared');
});
test('log status on a migrated install still reports all sixteen events', () => {
  assert.deepEqual(JSON.parse(run(LOG, d, 'status', '--json')).hookEvents, { registered: 16, logged: 16 });
});
test('uninstall after the migration leaves no entry script and no registration behind', () => {
  // after the migrating apply: uninstall --yes; no .claude/scripts directory; settings.json byte-equal to the fixture's original;
  // `git status --porcelain` clean apart from DETECT_REPORT_PATH
});
test('an event with one registration changed by the owner is left alone, and the others are migrated', () => {
  // add `timeout: 5` to the tool-gate.mjs entry on PreToolUse, commit
  const dry = run(APPLY, d);
  assert.equal(dry.includes('(hook: PreToolUse'), false);
  run(APPLY, d, '--yes');
  assert.equal(settings(d).hooks.PreToolUse.length, 2, 'both separate registrations are still there');
  assert.deepEqual(kitEntriesOn(d, 'PostToolUse'), [`\${CLAUDE_PROJECT_DIR}/${DISPATCH_POST_PATH}`]);
  assert.deepEqual(kitEntriesOn(d, 'PostToolUseFailure'), [`\${CLAUDE_PROJECT_DIR}/${DISPATCH_FAILURE_PATH}`]);
  const merge = checkOf(d, 'P0.hookmerge');
  assert.equal(merge.state, 'declared');
  assert.ok(merge.evidence.includes('PreToolUse: left on separate registrations — a registration of .claude/scripts/tool-gate.mjs is not as kh-harness recorded it'));
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
});
test('an event from which the owner removed one hook is not merged; its own check proposes that hook again, separately', () => {
  // delete the session-log.mjs element from PostToolUseFailure
  const dry = run(APPLY, d);
  assert.ok(dry.includes('--- .claude/settings.json (hook: PostToolUseFailure)  [P5.sessionlog]'));
  assert.equal(dry.includes('(hook: PostToolUseFailure, replacing'), false);
});
test('the harness identity does not move across an apply that has nothing to do', () => {
  // after the migrating apply: harnessIdentity(d).base before and after a further `apply --yes --allow-dirty` are equal
});
test('a migration killed before its settings write is finished by the next apply, and uninstall removes everything either way', () => {
  // drive applyProposals as lifecycle-kill.test.mjs:60-80 does, with replaceSettings throwing and the manifest restored to what was on disk at the throw;
  // then (a) on one copy `uninstall --yes` leaves no kit script, entry or manifest; (b) on another `apply --yes` reaches the merged layout and a further apply says "no actions"
});
test('an install made by the kit at eead407 is merged by one apply', { skip }, () => {
  // old = kitAt('eead407'); old.apply --yes on fixtureWithLint(); commit; current apply --yes;
  // every event of ENTRY_SCRIPTS holds exactly its entry script; no check with a generator still proposes; a further apply says "no actions"
});
```

- [ ] **Step 2: Run and confirm failure**
  Run: `node --test scripts/lib/hook-merge-lifecycle.test.mjs scripts/lib/propose.test.mjs scripts/lib/gap-model.test.mjs`
  Expected: FAIL — there is no `P0.hookmerge`, and `apply` on the separate layout prints "no actions".

- [ ] **Step 3: Implement** the items of the Produces block. `GENERATORS['P0.hookmerge']` sits directly before `[KITSKEW_ID]` and returns `[]` without a manifest. `integrity-evidence.test.mjs:298-301`, `gap-model.test.mjs:65-66` and `propose.test.mjs:1793-1796,1985-1988` pin that `P0.kitskew` is last and must still pass unedited.

- [ ] **Step 4: Run the tests**
  Run: `npm test`
  Expected: PASS, with `lifecycle-kill.test.mjs` and `lifecycle-upgrade.test.mjs` unedited. A failure in either means a registration an earlier kit recorded is not being recognised by `kitEntryHashes`; report it.

- [ ] **Step 5: Commit** the files this task names, as `feat(apply): an install with two kit hooks on a tool-call event is moved to that event's entry script`.

### Task 8: Documentation

**Files:**
- Modify: `README.md:372` and its hook table, `docs/guide/how-it-works.md:112,124-151,270,377`, `docs/guide/commands.md:95` and the `apply` section, `docs/guide/troubleshooting.md:429`, `docs/guide/session-log.md:44`, `CHANGELOG.md` (`## Unreleased`)
- Test: `scripts/lib/cli.test.mjs`

- [ ] **Step 1: Write the failing test** in `cli.test.mjs`:
```js
test('the guide names the three entry scripts, the core and the merge check wherever it counts the kit\'s scripts or lists its checks', () => {
  const how = readFileSync(resolve(import.meta.dirname, '..', '..', 'docs/guide/how-it-works.md'), 'utf8');
  for (const name of ['dispatch-pre-tool.mjs', 'dispatch-post-tool.mjs', 'dispatch-tool-failure.mjs', 'harness-dispatch.mjs', 'P0.hookmerge']) assert.ok(how.includes(name), name);
  assert.match(how, /7 hook scripts, 3 entry scripts and 5 modules/);
  assert.doesNotMatch(how, /states no order between them/);
  assert.match(readFileSync(README, 'utf8'), /dispatch-pre-tool\.mjs/);
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `node --test scripts/lib/cli.test.mjs`. Expected: FAIL on the first missing name.

- [ ] **Step 3: Write the text.** Each statement below goes where the line reference points; wording is the writer's, facts are fixed.
  - `how-it-works.md:112` and `:270`: "seven hook scripts, three entry scripts and the five modules they load"; `:270` reads `7 hook scripts, 3 entry scripts and 5 modules`.
  - `how-it-works.md:124-151`: a row or paragraph per entry script — the event it is registered on, with no matcher; the hooks it runs and their order (gate then log; log then lint; log then loop warning); that `dispatch-post-tool.mjs` is installed only where the lint hook is; that `lint-touched.mjs` still runs only for `Write` and `Edit`. Replace "this page states no order between them" with the order. State that a failure in one hook does not stop the other, that the exit code is the highest either returned, and that when the lint hook reports (exit 2) a notice from the other hook is appended to what Claude is given. State that on an edit the process stays until the lint run ends (30 s bound), after the log line is written. Add `harness-dispatch.mjs` to the module list.
  - `how-it-works.md`, "How apply and uninstall stay safe": the replacement — when it is proposed (Decision 14), that it is shown in the dry run as removed and added entries, that the manifest keeps the old records until the settings file is written, and that an event the owner changed is left alone and named by `P0.hookmerge`.
  - `how-it-works.md:377` and `commands.md:95`: `P0.hookmerge` in the Phase 0 row ("kit hooks on a tool-call event against the manifest's records") and in the fresh-repository example (`[-] P0.hookmerge       n/a` / `no tool-call event holds two kh-harness hooks`).
  - `commands.md`, `apply`: the new dry-run label and `patched` line, and the skip reason `registration-changed`.
  - `troubleshooting.md:429`: an entry script beside a missing or older core or hook, with both fixed sentences from Task 2; and "to run only one hook of a merged event, replace the entry script's registration with that hook's own; `detect` accepts either, and `apply` will propose the other hook again".
  - `session-log.md:44`: `base` changes once when an install is merged, as it does with any kit update.
  - `README.md:372` and its table: the entry scripts, in two sentences.
  - `CHANGELOG.md`, Unreleased → Changed: one entry for the merge and one for the migration, each a sentence stating the behaviour.

- [ ] **Step 4: Run the tests.** Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** the files this task names, as `docs(guide): the entry scripts, the order their hooks run in, and how an install is moved to them`.

### Task 9: Execution log with before and after latency

**Files:**
- Create: `docs/plan-10-execution-log.md`

- [ ] **Step 1: Measure.** On a quiet machine, from the repository root:
```bash
node --input-type=module -e "
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedLatency } from './scripts/lib/latency-fixtures.mjs';
process.env.KH_DATA_DIR = mkdtempSync(join(tmpdir(), 'hk-measure-data-'));
process.env.HK_MARKER_DIR = mkdtempSync(join(tmpdir(), 'hk-measure-marks-'));
const { setEnabled } = await import('./assets/scripts/harness-log.mjs');
const root = mkdtempSync(join(tmpdir(), 'hk-measure-repo-'));
mkdirSync(join(root, '.git'));
setEnabled(root, true);
const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
const call = { session_id: 'measure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' };
const rows = [
  ['PreToolUse', 'tool-gate.mjs'], ['PreToolUse', 'session-log.mjs'], ['PreToolUse', 'dispatch-pre-tool.mjs'],
  ['PostToolUse', 'session-log.mjs'], ['PostToolUse', 'dispatch-post-tool.mjs'],
  ['PostToolUseFailure', 'loop-watch.mjs'], ['PostToolUseFailure', 'session-log.mjs'], ['PostToolUseFailure', 'dispatch-tool-failure.mjs'],
];
for (const [event, script] of rows) {
  const stdin = JSON.stringify({ ...call, hook_event_name: event, error: 'Exit code ' + Math.random() });
  const { summary } = addedLatency({ runHookOnce: () => spawnSync(process.execPath, ['assets/scripts/' + script], { input: stdin, env }), stdin, env, pairs: 40 });
  console.log(event, script, '—', summary);
}
"
```

  Expected: eight lines, each ending `over 40 interleaved pairs`.

- [ ] **Step 2: Write `docs/plan-10-execution-log.md`** in the form of `docs/plan-9-execution-log.md`: the plan and spec paths, the branch, one `Task N: complete (commits a..b, tests: <command> → duration)` line per task, any finding raised under the "stop and report" rule with its ruling, and a section `## Latency, before and after` holding the machine, OS, Node version and date, the eight lines verbatim, and a table per event of *before* (the sum of the fastest runs of its two single scripts) against *after* (the fastest run of its entry script), each also less one bare start. For `PostToolUse` state that the before figure for an edit is the log plus the lint hook's start, which the table does not measure because the lint run dominates it.

- [ ] **Step 3: Copy the measured figures into the dated comment** above the latency tests in `scripts/lib/harness-dispatch.test.mjs` (Task 3), if they differ from what was recorded there.

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** the files this task names, as `docs: plan 10 execution log, with hook latency before and after the merge`.

---

## Where each inventory fact is owned

| Fact (inventory summary) | Task |
|---|---|
| 1. One-argument exec registrations only | Global Constraints; Task 2 (`settings-merge.test.mjs` pins a second argument is kept) |
| 2. `scriptRunBy` / `producibleHookScripts` on uninstall | Task 2 (rows in `HOOK_SCRIPTS`; revert test); Tasks 5, 7 (lifecycle) |
| 3. No remove path in `apply` (`addHookEntry`, unknown kind throws, `diffRenderer`, `settingsHookPreview`) | Task 6 |
| 4. `hasEquivalentHook` / `registeredHook` semantics | Task 4 (`registeredHook`); Task 6 (`hasEquivalentHook` skip `unchanged`) |
| 5. No proposal on an existing install (`buildProposals`, `proposalVia`, early exit on zero proposals) | Task 7 (`P0.hookmerge` with a generator) |
| 6. Migrate only when every recorded patch for the event is present by `entrySha256` | Task 7 (`mergePlan`), Task 6 (`registration-changed`) |
| 7. `harnessIdentity().base` moves when `settingsPatches` change | Decision 16; Task 7 (stability test); Task 8 (`session-log.md`) |
| 8. `loadedSiblings` reads quoted `./name.mjs` | Decision 7; Task 2 (`propose.test.mjs`), Task 5 (no-lint install) |
| 9. `log status`, `rules-evidence.mjs`, lifecycle fixtures, `cli.test.mjs` count, docs counts, `latency-phase.test.mjs` | Tasks 4, 4, 4 and 5, 2 and 5, 5 and 8, 3 |
