# Stage 0 inventory (hook merge + contract) — kh-harness at eead407

Read-only inventory. Paths are relative to `/home/kinghian/projects/kh-harness`. Every line number was read from the file at commit `eead407` (working tree clean apart from untracked docs/reports). Nothing in the repository was edited.

---

## 1. The four hook scripts

### 1.1 `assets/scripts/tool-gate.mjs` (330 lines)

- Imports: `createHash` (`:53`), `readFileSync, realpathSync, statSync, writeFileSync` (`:54`), `join` (`:55`), `fileURLToPath` (`:56`). No static sibling import.
- Sibling loading: the `loadSiblings` pattern. Table `SIBLINGS` (`:62-66`), each row `[specifier, namesThisHookUses, namesLaterModulesNeed]`:
  - `['./harness-redact.mjs', ['markerPath', 'projectRoot', 'safeSessionId'], ['canonicalJson', 'maskText', 'SCRUB_MARK', 'stripUnsafe']]`
  - `['./harness-log.mjs', ['appendEvent', 'GATES_PATH', 'isEnabled', 'LOCAL_GATES_FILE', 'repoDataDir'], []]`
  - `['./harness-gates.mjs', ['gateSha256', 'matchGate', 'parseGates'], []]`
  - `async function loadSiblings()` (`:75-89`) returns `{ loaded }` or `{ loaded, problem }`; `problem` is `` `${shown} is missing or cannot be loaded` `` (`:83`) or `` `${shown} is older than this hook and lacks what it needs` `` (`:86`). Note: `problem` is `undefined` when fine (compare session-log, where it is `null`).
- Top-level side effects at import: `const siblings = await loadSiblings();` (`:91`, top-level await, three dynamic imports); `const lib = siblings.loaded;` (`:92`); `const canMark = MARKING.every(...)` (`:94`); `COMMITTED`/`LOCAL` label strings built from `GATES_PATH`/`LOCAL_GATES_FILE` (`:138-139`). Nothing is read from stdin or written at import.
- Constants: `MARKING` (`:67`), `REMEDY` (`:69`), `HOOK_EVENT = 'PreToolUse'` (`:99`), `GATE_FILE_MAX_BYTES = 1024 * 1024` (`:103`, exported), `ACTION_RANK` (`:105`), `GATE_TEXT_MAX_CHARS = 4000` (`:110`, exported), `STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000` (`:114`).
- stdin helper: `function readStdin(timeoutMs)` (`:116-136`), attaches `data`/`end`/`error` listeners to `process.stdin` and a `setTimeout`.
- `async function main()` (`:289-299`):
  1. `payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS))`; on throw `return` (`:291-295`).
  2. `if (!isToolCall(payload)) return;` (`:296`). `isToolCall` (`:301-302`): object, `payload.hook_event_name === HOOK_EVENT`, `typeof payload.tool_name === 'string'`.
  3. `const output = siblings.problem === undefined ? decide(lib.projectRoot(), payload) : siblingNotice(payload);` (`:297`).
  4. `if (output !== null) process.stdout.write(JSON.stringify(output) + '\n');` (`:298`) — trailing newline. Nothing ever goes to stderr.
- Pure core already exists: `function decide(root, payload)` (`:234-265`) returns the JSON output object or `null`, without writing or exiting. Shapes it returns:
  - `{ systemMessage: 'kh-harness: …' }` (`:250`), optionally with
  - block: `hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text }` (`:260`)
  - warn: `hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text }` (`:262`), no `permissionDecision` on purpose (`:261`).
  - `siblingNotice(payload)` (`:306-310`) returns `{ systemMessage: sentence }` or `null`.
- Side effects of `decide`: `firstTelling` creates marker files `tool-gate-notice-<tag>` (`:202-212`); `recordFiring` calls `lib.isEnabled(root)` then `lib.appendEvent(root, sessionId, { type: 'gate_firing', gateId, gateSha256, action, tool, tool_use_id, agent_id, session_id })` (`:214-231`).
- Entry guard: `function isEntryPoint()` (`:315-321`), `realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))`. Guarded block `:323-330`: `try { await main(); } catch {}` then `process.exit(0);` (`:329`) — the only `process.exit`.
- Exports: `GATES_PATH` (`:96`), `LOCAL_GATES_FILE` (`:97`) (both re-exported from `lib`, so `undefined` if harness-log failed to load), `GATE_FILE_MAX_BYTES` (`:103`), `GATE_TEXT_MAX_CHARS` (`:110`). No exported entry function.

### 1.2 `assets/scripts/session-log.mjs` (423 lines)

- Imports: `createHash` (`:34`), `realpathSync, rmSync, writeFileSync` (`:35`), `join` (`:36`), `fileURLToPath` (`:37`).
- Sibling loading: `loadSiblings` pattern, with a second, lazy table.
  - `SIBLINGS` (`:43-46`): `['./harness-redact.mjs', ['canonicalJson', 'markerPath', 'maskText', 'projectRoot', 'readJSONMarker', 'safeSessionId', 'writeJSONMarker'], ['SCRUB_MARK']]`, `['./harness-log.mjs', ['appendEvent', 'harnessIdentity', 'isEnabled', 'LAST_TICK_FILE', 'parsedObject', 'readConfig', 'readSmallFile', 'repoDataDir'], []]`.
  - `SEAL_SIBLINGS` (`:50-53`): harness-log probed for `['BLOBS_DIR', 'gunzipBounded', 'logDirProblem', 'maxLogFileBytes', 'parsedObject', 'readBounded', 'readConfig', 'repoDataDir', 'sessionFileName', 'SESSIONS_DIR']`, then `['./harness-seal.mjs', ['applyRetention', 'sealClosedSessions', 'sessionsSealedSince'], []]`. Loaded only inside `sessionStart` (`:321-333`), i.e. only on a `SessionStart` event.
  - `async function loadSibling([specifier, names, forLater])` (`:59-69`) returns `{ module, problem }`; `async function loadSiblings()` (`:75-83`) returns `{ loaded, problem }` with `problem: null` when fine.
- Top-level side effects at import: `const siblings = await loadSiblings();` (`:85`); destructuring of `siblings.loaded` into module-level names (`:86-89`); `canMark` (`:90`); `LOGGED_EVENTS` frozen (`:166`).
- `STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000` (`:365`); `function readStdin(timeoutMs)` (`:367-387`), a byte-for-byte copy of tool-gate's.
- `async function main()` (`:389-402`):
  1. `payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS))`; on throw `return`.
  2. `if (!isPlainObject(payload) || !isLoggedEvent(payload.hook_event_name)) return;` (`:396`).
  3. `const { context, notice } = siblings.problem === null ? await record(payload) : { context: null, notice: siblingNotice(payload) };` (`:397`).
  4. Builds `output = {}`; `if (notice !== null) output.systemMessage = notice;` (`:399`); `if (context !== null) output.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: context };` (`:400`).
  5. `if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));` (`:401`) — **no trailing newline** (tool-gate and loop-watch add one). Never writes stderr.
- Core: `async function record(payload)` (`:339-350`) returns `{ context, notice }` (`NOTHING` = both null, `:335`). It is **async** (awaits `sessionStart`, which dynamically imports the sealing module). Order inside: `safeSessionId` → `projectRoot()` → `isEnabled(root)` → `toLogEvent(payload)` → `appendEvent(root, sessionId, event)` → `recordHarness` (for `HARNESS_EVENTS`, `:228`) → `recordExternal` (for `EXTERNAL_TOOL_EVENTS` = `PostToolUse`, `PostToolUseFailure` when the tool is `WebFetch`/`WebSearch`/`mcp__*`, `:189-192`) → `sessionStart` only for `SessionStart`.
- For the three tool-call events, `record` always returns `NOTHING` when siblings load, so the log half's only possible output on those events is the sibling notice `{ systemMessage }`.
- Entry guard: `isEntryPoint()` (`:407-413`), same text as tool-gate. Guarded block `:415-423`: `try { await main(); } catch {}`, `process.exit(0);` (`:422`) with the comment "Not `exitCode`: a stdin the caller never closed would keep the process." (`:421`).
- Exports: `LOGGED_EVENTS` (`:166`, 16 names, the keys of `FIELDS_BY_EVENT` `:142-162`), `toLogEvent(payload)` (`:176`). `main`, `record` are not exported.
- Kit-side importers of this installed asset: `scripts/lib/propose.mjs:19`, `scripts/lib/gap-model.mjs:22`, `scripts/lib/log-lib.mjs` (uses `LOGGED_EVENTS`), tests.

### 1.3 `assets/scripts/lint-touched.mjs` (685 lines)

- Imports: `createHash` (`:25`), `existsSync, readFileSync, statSync, writeFileSync` (`:26`), path helpers (`:27`).
- Sibling loading: neither static import nor `loadSiblings`; an inline probe. `NEEDED` (`:37-41`): `'boundReport', 'dropCommandFragments', 'markerPath', 'maskText', 'MAX_REPORTS_SINCE_CLEAN', 'pathTokenExemptions', 'projectRoot', 'readJSONMarker', 'runBounded', 'safeSessionId', 'signatureOf', 'stripUnsafe', 'writeJSONMarker'`. `MARKING` (`:42`). `let asset = {}; let assetProblem = null;` then `asset = await import('./harness-redact.mjs')` in try/catch (`:44-51`), destructured at `:52-55`.
- Top-level side effects at import: the top-level await above, **and the script runs**: the IIFE at `:677-685` calls `main()` (reads stdin) and ends with `process.exit(code)` (`:684`). **No `isEntryPoint` guard.** Importing it today consumes stdin and exits the importing process.
- Constants: `LINT_TIMEOUT_MS = Number(process.env.HK_LINT_TIMEOUT_MS) || 30_000` (`:80`), `STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000` (`:87`), `LINT_MAX_BUFFER = Number(process.env.HK_LINT_MAX_BUFFER) || 10 * 1024 * 1024` (`:94`), `SAFE_RELATIVE_PATH` (`:117`), `JS_EXTENSIONS` (`:123`), `PY_EXTENSIONS` (`:124`).
- stdin helper: `function readStdin(timeoutMs)` (`:130-150`), same body as the others.
- `async function main()` (`:524-675`) **returns the exit code** (0 or 2). Flow:
  1. parse stdin, `return 0` on failure (`:526-530`); `if (!payload || typeof payload !== 'object') return 0;` (`:531`).
  2. `const filePath = payload?.tool_input?.file_path;` not a non-empty string → `return 0` (`:533-534`); `hasDotDotSegment` → 0 (`:535`); extension not in JS/PY sets → 0 (`:537-540`).
  3. `if (assetProblem !== null) return assetNotice(payload.session_id);` (`:541`).
  4. containment (`isContained`, `:548`), owner lookup (`findLintOwner`, `:571-574`), command build (`:597-599`).
  5. `result = await runBounded(fullCommand, { cwd: ownerDir, timeoutMs: LINT_TIMEOUT_MS, maxBuffer: LINT_MAX_BUFFER, env: { ...process.env, PATH } })` (`:612-617`).
  6. outcome branches, see below.
- **It never checks `hook_event_name` or `tool_name`.** The `Write|Edit` restriction is entirely the registration's `matcher` (`SENSOR_MATCHER`, propose.mjs:113). A dispatcher registered without a matcher must apply that test itself.
- How the exit code is chosen: every path returns 0 except `writeReport(lines)` (`:394-397`), which returns 2. `writeReport` is reached for: file modified by the lint script (`:638-642`), a terse repeat/over-cap notice (`:672`), a full report (`:674`). `notConfirmedClean` (`:510-522`) and `assetNotice` (`:60-76`) return 0. The IIFE turns a throw into 0 (`:681-683`).
- stderr vs stdout — the helpers write directly, they do not return text:
  - stderr: one site, `process.stderr.write(boundReport(lines) + '\n');` inside `writeReport` (`:395`), always paired with exit 2. The comment at `:385` states this is "the ONLY `process.stderr.write` in this file".
  - stdout (always exit 0): `assetNotice` writes `JSON.stringify({ systemMessage: sentence }) + '\n'` (`:74`); `notConfirmedClean` writes `JSON.stringify({ systemMessage: sentence, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: sentence } }) + '\n'` (`:517-520`).
  - So today a run produces either stdout JSON with exit 0, or stderr text with exit 2, never both.
- Child processes: yes, one, **asynchronously**. `runBounded` is `export function runBounded(command, { cwd, env, timeoutMs, maxBuffer, killGraceMs = 5_000 })` in `assets/scripts/harness-redact.mjs:986`, built on `spawn` (`:1007`) with `detached` + `killTree` (`:961`); it resolves to a `spawnSync`-shaped result (`status`, `signal`, `error`, `timedOut`, `stdout`, `stderr`). `spawnSync` is used only for `taskkill` on win32 (`harness-redact.mjs:965`).
- Marker state it writes: `sensor` (`:449`, `:489`), `sensor-unchecked` (`:511`), `lint-touched-notice-<tag>` (`:65`).
- Exports: none.

### 1.4 `assets/scripts/loop-watch.mjs` (213 lines)

- Imports: `createHash, randomBytes` (`:42`), `closeSync, constants, fstatSync, readSync, writeFileSync, writeSync` (`:43`).
- Sibling loading: inline probe like lint-touched. `NEEDED = ['canonicalJson', 'markerPath', 'openMarker', 'projectRoot', 'safeSessionId', 'stripAnsi']` (`:53`), `MARKING` (`:54`), `REMEDY` (`:55`), `asset = await import('./harness-redact.mjs')` (`:58-63`), destructure (`:64`).
- Top-level side effects at import: the top-level await, **and the script runs**: IIFE `:206-213` calls `main()` then `process.exit(0)` (`:212`). **No `isEntryPoint` guard.**
- Constants: `WARN_AT = 3` (`:66`), `WARNING` (`:68`), `NONCE_BYTES = 16` (`:70`), `RECORD` (`:71`), `TAIL_BYTES = 4096` (`:75`), `MAX_READ_BYTES = 64 * 1024` (`:79`), `STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000` (`:83`).
- stdin helper: `function readStdin(timeoutMs)` (`:85-105`).
- `async function main()` (`:168-204`):
  1. parse stdin, `return` on failure; `if (!payload || typeof payload !== 'object') return;` (`:175`).
  2. `if (typeof toolName !== 'string' || typeof error !== 'string') return;` (`:177`). **No `hook_event_name` check.**
  3. `assetProblem !== null` → `process.stdout.write(JSON.stringify({ systemMessage: sentence }) + '\n')` when `firstTelling` (`:178-182`).
  4. `safeSessionId`, `agentKey` (`:120-124`), marker `loop-watch` + `.${agent}` opened `O_RDWR | O_APPEND | O_CREAT` (`:186-190`), append one record, `runEndingAt` (`:129-147`).
  5. `if (count !== WARN_AT) return;` then `process.stdout.write(JSON.stringify({ systemMessage: WARNING, hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: WARNING } }) + '\n');` (`:199-203`).
- Never writes stderr. Only exit: `process.exit(0)` (`:212`). The body is synchronous apart from the stdin read. Exports: none.

### 1.5 State that collides or is shared when all four are imported into one process

- Each file defines its own module-scoped `readStdin`, `STDIN_TIMEOUT_MS`, `firstTelling`, `REMEDY`, `MARKING`, `isEntryPoint` (two of them), `main`. ES module scope keeps these apart; none is a global. The collision is behavioural: each `readStdin` adds listeners to the one `process.stdin`, so only one reader can get the payload — the design's "reads standard input once" is required, not optional.
- `firstTelling` is three different functions with three signatures: tool-gate `(root, sessionId, sentence)` (`:202`), session-log `(root, sessionId, sentence)` (`:306`), loop-watch `(rawSessionId, sentence)` (`:154`); lint-touched inlines the same logic in `assetNotice` (`:60`). Marker namespaces differ (`tool-gate-notice-`, `session-log-notice-`, `loop-watch-notice-`, `lint-touched-notice-`). The comment at session-log `:302-304` says the copies are deliberate: "the only module the three could share is harness-redact.mjs, the one a notice may be about."
- `REMEDY` wording differs: "update the shared modules" (tool-gate `:69`, session-log `:56`) vs "update the shared asset" (lint-touched `:43`, loop-watch `:55`).
- Four top-level awaits of `./harness-redact.mjs` (and two of `./harness-log.mjs`) resolve to one module instance each in a shared process; a dispatcher's static `import` of a hook module would wait on them.
- `process.exit` calls: tool-gate `:329`, session-log `:422` (both guarded), lint-touched `:684`, loop-watch `:212` (both unguarded). No timers outlive `readStdin`'s `clearTimeout`. lint-touched's `runBounded` keeps a child and timers alive until the linter ends (bounded at `LINT_TIMEOUT_MS` 30 s + `killGraceMs` 5 s).
- Problem-sentinel inconsistency: tool-gate tests `siblings.problem === undefined` (`:297`), session-log `siblings.problem === null` (`:397`), lint/loop `assetProblem !== null`.
- Output framing differs: session-log writes JSON with no newline (`:401`); the other three append `'\n'`.

---

## 2. Their tests

All four test files run the hook as a **child process** (`spawnSync`/`spawn` of `process.execPath` with the asset path); none calls a hook's `main` in-process.

| File | Tests | How the hook is invoked | Imports from the hook asset |
|---|---|---|---|
| `scripts/lib/tool-gate.test.mjs` (594 lines) | 34 | `runHook(root, stdin, { nodeArgs, env, script = HOOK })` `:116-117`, `spawnSync(process.execPath, [...nodeArgs, script], …)`; `installedCopy(present)` `:463` builds a directory of copied assets | `import { GATES_PATH, LOCAL_GATES_FILE } from '../../assets/scripts/tool-gate.mjs'` `:50` |
| `scripts/lib/session-log.test.mjs` (824 lines) | 53 | `runHook(root, stdin, { nodeArgs, env })` `:53-59`; `spawn` for concurrency `:177`; `installedHook` `:735`, `runInstalled` `:745` | `import { LOGGED_EVENTS, toLogEvent } from '../../assets/scripts/session-log.mjs'` `:17` |
| `scripts/lib/lint-touched.test.mjs` (1366 lines) | 77 | `run(cwd, payload, extraEnv)` `:19-25`, returns `{ code, stdout, stderr }`; `spawn` at `:832` | none (only `markerPath` from harness-redact `:7`) |
| `scripts/lib/loop-watch.test.mjs` (446 lines) | 21 | `runHook(root, stdin, { nodeArgs, env, script = HOOK })` `:100-101`; `installedCopy(asset)` `:327`; 10 parallel `spawn`s `:365-366`; lifecycle run of the installed copy `:432` | none |

- `HOOK` constant in each: `resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', '<name>.mjs')` (tool-gate `:58`, session-log `:22`, lint-touched `:17`, loop-watch `:43`).
- Fixture/helper modules: `scripts/lib/latency-fixtures.mjs` (`addedLatency`), `scripts/lib/canary-fixtures.mjs` (`writeCanary`, `recordedPids`, `assertNoSurvivor`, `killRecorded`; used by lint-touched.test `:8`), `scripts/lib/test-marker-sandbox.mjs` (`sandboxMarkerDir()` `:46`, sets `HK_MARKER_DIR`), `scripts/lib/log-fixtures.mjs` (`treeSnapshot` etc.), `scripts/lib/lifecycle-fixtures.mjs` (`APPLY, DETECT, UNINSTALL, git, run, settings, hooksBesideLog, sandboxDataDir, runRegisteredHook, runEveryRegisteredHook, kitAt, manifestOf, fixture`), CJS preloads `scripts/lib/session-log-forbid-spawn.cjs`, `scripts/lib/session-log-probes.cjs`, `scripts/lib/tool-gate-probes.cjs` (passed with `--require`).
- Test env knobs: `KH_DATA_DIR` (temp, e.g. session-log.test `:37`), `HK_MARKER_DIR`, `CLAUDE_PROJECT_DIR` (set per run), `HK_STDIN_TIMEOUT_MS`, `HK_LINT_TIMEOUT_MS`, `HK_LINT_MAX_BUFFER`.
- Cross-hook test: `scripts/lib/hook-skew.test.mjs` copies **every** file in `assets/scripts/` into a temp dir (`installed(replaced)` `:56-65`, `readdirSync(ASSETS)` `:59`) and runs each hook named in its `PAYLOADS` table (`:67-75`, seven hooks) beside old/missing siblings; `said()` (`:89-102`) asserts exit 0, empty stderr, one stdout line, and JSON keys exactly `['systemMessage']`. A new `harness-dispatch.mjs` is copied by `installed()` automatically but is exercised only if added to `PAYLOADS`.
- Lifecycle fixtures that run registered hooks ignore arguments: `runRegisteredHook(d, event, script, payload)` (`lifecycle-fixtures.mjs:53-66`) requires `h.command === 'node' && h.args?.[0] === arg` and spawns `[arg…]` only; `runEveryRegisteredHook(d)` (`:252-266`) regex-extracts `/\.claude\/scripts\/([\w.-]+\.mjs)/` from `hook.args?.[0] ?? hook.command` and spawns that script with **no further arguments**. `hooksBesideLog(s, event)` (`:76`) filters out entries whose `h.args?.[0] === LOGGING_HOOK_ARG` (the session-log exec arg) — after the merge the dispatcher entry would not be filtered.

### Latency budget tests

- `package.json` `scripts.test` (one line): `node --test --test-skip-pattern="^latency budget: " "scripts/lib/**/*.test.mjs" && node --test --test-concurrency=1 --test-name-pattern="^latency budget: " scripts/lib/session-log.test.mjs scripts/lib/tool-gate.test.mjs`
- Two tests exist, with the **same name**: `'latency budget: the fastest of 40 interleaved runs adds no more than the budget recorded in the test to a bare node start'`
  - `scripts/lib/tool-gate.test.mjs:529-543`; budget `const ADDED_LATENCY_BUDGET_MS = 100;` (`:526`), `const LATENCY_PAIRS = 40;` (`:527`); fixture: `GATE_LIMITS.gatesMax` gates, none matching, input of `GATE_LIMITS.inputMax` chars; asserts `runHook(root, stdin)` is `null`. Measurement comment `:520-525` (win32, Node 24, 2026-11-19: "adds about 38 to 45 ms").
  - `scripts/lib/session-log.test.mjs:812-824`; `ADDED_LATENCY_BUDGET_MS = 100` (`:809`), `LATENCY_PAIRS = 40` (`:810`); payload `toolPayload('PostToolUse', 'latency-1', { tool_response: { stdout: 'x'.repeat(4096) }, duration_ms: 10 })` on an enabled project; also asserts `events(root, 'latency-1').length === LATENCY_PAIRS`. Comment `:803-808` ("adds about 30 ms").
- The budget number is a module constant in each test file plus a dated measurement comment above it; the assertion is `assert.ok(added <= ADDED_LATENCY_BUDGET_MS, `${summary}; budget for the difference ${ADDED_LATENCY_BUDGET_MS} ms`)`.
- `addedLatency({ runHookOnce, stdin, env, pairs })` (`latency-fixtures.mjs:37-54`) returns `{ added, summary }`: fastest hook run minus fastest bare `node -e 0` over `pairs` interleaved pairs.
- `scripts/lib/latency-phase.test.mjs:25-35` pins the wiring: the script must be exactly two `&&`-joined runs; the first includes `--test-skip-pattern="^latency budget: "`; the second includes `--test-concurrency=1` and `--test-name-pattern="^latency budget: "`; and the `.test.mjs` files named in the second run must **equal** the set of test files whose text contains `test('latency budget: `. A dispatcher latency test in a new file therefore requires adding that file to `package.json`. A second test (`:54-69`) ties the flags to the README sentence `**\`npm test\` needs Node X.Y or later**` through `FLAG_SINCE` (`:41-45`).

---

## 3. Hook registration in `scripts/lib/propose.mjs`

### Path constants (`:28-39`)

`SCRIPTS_DIR = '.claude/scripts/'`, `BRIEF_PATH`, `LINT_TOUCHED_PATH = '.claude/scripts/lint-touched.mjs'`, `VERIFY_TOUCHED_PATH`, `REDACT_PATH = '.claude/scripts/harness-redact.mjs'`, `RULES_BRIEF_PATH`, `LOOP_WATCH_PATH = '.claude/scripts/loop-watch.mjs'`, `SESSION_LOG_PATH = '.claude/scripts/session-log.mjs'`, `TOOL_GATE_PATH = '.claude/scripts/tool-gate.mjs'`, `HARNESS_GATES_PATH`, `HARNESS_LOG_PATH`, `HARNESS_SEAL_PATH`. Exported together at `:1033`.

### Shape of a `settings-hook` action

```js
{
  kind: 'settings-hook', event: '<Event>', step: <number>,
  matcher: 'Write|Edit',            // only the sensor sets it; omitted otherwise
  entry: execEntry(<SCRIPT_PATH>),
  requiresFiles: requiredFiles(files),   // [{ path, sha256 }]
  reason: hookRegistrationReason('<Event>', check),
}
```
`buildProposals` adds `checkId: c.id` (`:1021`). `requiredFiles` (`:720`) maps `hookFiles(...)` output to `{ path: f.path, sha256: sha256(f.contents) }`.

### The exact entry written into settings.json

`export const execEntry = scriptPath => ({ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${scriptPath}`] });` (`scripts/lib/hook-evidence.mjs:25`). Written through `buildMatcherEntry(entry, matcher)` (`settings-merge.mjs:23-25`): `{ hooks: [entry] }`, or `{ matcher, hooks: [entry] }`. So on disk:

- session-log, each of 16 events: `{ "hooks": [ { "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/scripts/session-log.mjs"] } ] }`
- tool gate, `PreToolUse`: same with `.claude/scripts/tool-gate.mjs`
- lint sensor, `PostToolUse`: `{ "matcher": "Write|Edit", "hooks": [ { …, "args": ["${CLAUDE_PROJECT_DIR}/.claude/scripts/lint-touched.mjs"] } ] }`
- loop warning, `PostToolUseFailure`: same shape as session-log with `.claude/scripts/loop-watch.mjs`

This is **exec form with exactly one argument**. No entry carries a `timeout`. The older shell form the kit once wrote is `shellEntry = scriptPath => ({ type: 'command', command: `node ${scriptPath}` })` (`hook-evidence.mjs:28`), still recognised.

### Generators and conditions

| Generator | Lines | Check id (table `GENERATORS` `:915-948`) | Event / step / matcher | Proposed when |
|---|---|---|---|---|
| `sensorProposal({ kitVersion, stack, check })` | `:115-128` | `'P2.sensor'` | `PostToolUse`, step `9`, `matcher: SENSOR_MATCHER` | `hasLintScript(stack)` (`sensor-evidence.mjs:20`), else `[]` |
| `loopWatchProposal({ kitVersion, check })` | `:192-200` | `'P2.loopwatch'` | `PostToolUseFailure`, `LOOP_WATCH_STEP = 13` (`:183`), no matcher | always |
| `sessionLogProposal({ kitVersion, harness, manifest, root })` | `:222-231` | `'P5.sessionlog'` | one action per **missing** event, `SESSION_LOG_STEP = 31` (`:202`), no matcher | always; events from `sessionLogRegistrations(...)` filtered `r.state !== 'declared'` |
| `toolGateProposal({ kitVersion, check, harness, manifest, root })` | `:321-336` | `'P5.toolgate'` | `PreToolUse`, `TOOL_GATE_STEP = 30` (`:233`, exported), no matcher; plus a `settings-deny` action | hook action unless `toolGateHookRegistered(...)`; deny action when `missingToolGateDenyRules(harness)` non-empty |

- `SENSOR_MATCHER = 'Write|Edit'` (`:113`).
- `export function sessionLogRegistrations(harness, { manifest, root } = {})` (`:211-213`): `LOGGED_EVENTS.map(event => ({ event, ...registeredHook(harness, event, SESSION_LOG_PATH, null, { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS }) }))`.
- `export const toolGateHookRegistered = ({ harness, manifest, root }) => registeredHook(harness, 'PreToolUse', TOOL_GATE_PATH, '', { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS }).state === 'declared';` (`:309-310`).
- `export function toolGateDenyRules()` (`:254-257`): `[`${SCRIPTS_DIR}**`, `${dirname(GATES_PATH)}/**`, MANIFEST_PATH, LEARNED_PATH].map(p => `Edit(/${p})`)` + `'Edit(~/.claude/kh-harness/**)'` + `commandDenyRules()`. With `GATES_PATH = '.claude/kh-harness/gates.json'` (`harness-log.mjs:27`) this includes **`Edit(/.claude/kh-harness/**)`**, which already covers `.claude/kh-harness/extensions.json`, and `Edit(/.claude/scripts/**)`, which covers a new `harness-dispatch.mjs`. `missingToolGateDenyRules(harness)` `:302-305`; `commandDenyRules()` `:296-298`.
- `hookRegistrationReason(event, check)` (`:50-53`): the check's evidence joined with `'; '`, or `` `no ${event} hook registered in .claude/settings.json` ``.
- Proposals are generated **only** for a check with `state === 'absent'` and `decidable !== false` that has a generator (`buildProposals` `:1001-1005`). Held scripts suppress both the file and the hook action (`:1007-1008`).

### The asset table (`:624-653`)

```js
const HOOK_SCRIPTS = Object.freeze({
  [LINT_TOUCHED_PATH]:   { asset: 'scripts/lint-touched.mjs',   step: 9,  reason: 'no PostToolUse hook registered' },
  [VERIFY_TOUCHED_PATH]: { asset: 'scripts/verify-touched.mjs', step: 10, reason: 'no Stop hook registered' },
  [BRIEF_PATH]:          { asset: 'scripts/session-brief.mjs',  step: 16, reason: 'no SessionStart brief hook registered' },
  [RULES_BRIEF_PATH]:    { asset: 'scripts/rules-brief.mjs',    step: REINJECT_STEP, reason: 'no UserPromptSubmit re-injection hook registered' },
  [LOOP_WATCH_PATH]:     { asset: 'scripts/loop-watch.mjs',     step: LOOP_WATCH_STEP, reason: 'no PostToolUseFailure loop-warning hook registered' },
  [SESSION_LOG_PATH]:    { asset: 'scripts/session-log.mjs',    step: SESSION_LOG_STEP, reason: 'no session-log hook registered' },
  [TOOL_GATE_PATH]:      { asset: 'scripts/tool-gate.mjs',      step: TOOL_GATE_STEP, reason: 'no PreToolUse gate hook registered' },
});
const GENERATOR_SCRIPT_PATHS = Object.freeze(Object.keys(HOOK_SCRIPTS));          // :633
const HOOK_MODULES = Object.freeze({ HARNESS_GATES_PATH, HARNESS_LOG_PATH, HARNESS_SEAL_PATH, REDACT_PATH … }); // :642-647
const HOOK_MODULE_PATHS = Object.freeze(Object.keys(HOOK_MODULES));                // :648
const INSTALLED_SCRIPTS = Object.freeze({ ...HOOK_SCRIPTS, ...HOOK_MODULES });     // :652
const INSTALLED_SCRIPT_PATHS = Object.freeze(Object.keys(INSTALLED_SCRIPTS));      // :653
```
The comment at `:616-623` is a rule: "a hook script a generator registers must be listed here or neither its registration nor its file can ever be removed."

- `export function loadedSiblings(path)` (`:665-677`): scans the asset's text with `/(['"])\.\/([\w.-]+\.mjs)\1/g`; **every quoted `./name.mjs`** counts (static import, dynamic import, table, even a comment), and a name not in `INSTALLED_SCRIPTS` **throws** `` `assets/${asset} names ./${name}, which the kit does not install` ``.
- `export function everyLoadedSibling(path)` (`:681-692`), `installedScriptProposal(path, kitVersion)` (`:697-703`, a hook script gets `machineryStamp(kitVersion, `runbook step ${step}`, '//')` after the shebang; a module gets the stamp first), `hookFiles(scriptPath, kitVersion)` (`:713-715`).
- `versionUnits()` (`:779-793`) and `export function heldScripts(root, manifest, kitVersion)` (`:831-843`): scripts that load one another form one unit, written at one kit version or not at all. Every hook already loads `harness-redact.mjs`, so all installed scripts are already one unit.
- `kitSkew(...)` (`:883-904`) updates only files the manifest already records; `currentKitFiles` (`:728-738`) knows every `INSTALLED_SCRIPT_PATHS` entry.

---

## 4. How apply writes and records registrations; removal

### Record shape in the manifest

Hook patch, built in `stageSettingsHook` (`scripts/lib/apply-lib.mjs:800-807`):
```js
{ event: proposal.event, container: patch.container /* `/hooks/${event}` */, entrySha256: patch.entrySha256,
  step: proposal.step, checkId: proposal.checkId, appliedAt: new Date().toISOString() }
```
Deny patch (`:827-835`): `{ event: 'permissions.deny', container: '/permissions/deny', entrySha256, rules, step, checkId, appliedAt }`.

- `entrySha256` for a hook = `hookEntrySha256(entry, matcher)` = `sha256(canonicalJson(buildMatcherEntry(entry, matcher)))` (`settings-merge.mjs:31-38`): a hash of the **whole `hooks.<event>` array element**, matcher included. The record does not store the script path, the entry or the matcher; the script is identified only through the hash. `checkId` (`P5.sessionlog`, `P5.toolgate`, `P2.sensor`, `P2.loopwatch`) is the only plain statement of which hook a patch is.
- Patch identity: `const patchKey = patch => `${patch.container}\n${patch.entrySha256}`;` (`apply-lib.mjs:840`).

### Adding a registration

- `addHookEntry(settings, event, entry, matcher)` (`settings-merge.mjs:40-49`): clones, `next.hooks[event].push(buildMatcherEntry(entry, matcher))`, returns `{ settings, patch: { container, entrySha256 } }`. **Append only.**
- `stageSettingsHook({ root, proposal, batch, skipped })` (`apply-lib.mjs:780-809`), in order: `unmetDependencies(root, proposal)` (`:752-767`, reasons `` `missing-dependency: …` `` / `` `dependency-not-this-kit-version: …` ``) → `batch.read.ok` else skipped `'unparseable'` → `hasEquivalentHook(batch.settings, proposal.event, proposal.entry, proposal.matcher)` → skipped `'unchanged'` → `addHookEntry`.
- `hasEquivalentHook` (`settings-merge.mjs:152-158`) uses `sameHook` (`:135-142`), which compares **only the script** (`hookScriptOf` = `args[0]` normalised, `:124-126`); other arguments are ignored. Two entries for the same script with different extra arguments are "the same hook".
- One write per run: `openSettingsBatch` (`:775-778`), `writeSettingsBatch` (`:861-884`): `nextManifest.settingsPatches = [...held.filter(patch => !staged.has(patchKey(patch))), ...batch.records]`, then `persistManifest(nextManifest)` **before** `replaceSettings(join(root, SETTINGS_PATH), serializeSettings(batch.settings, batch.read.raw))`; `nextManifest.settingsCreated = true` when the file was absent (`:882`).
- `applyProposals({ root, proposals, manifest, kitVersion, chmod, replaceSettings, persistManifest })` (`:912-976`) returns `{ written, patched, skipped, failed, manifest }`. Pass 1 **throws** `` `apply: unknown proposal kind: ${proposal.kind}` `` for any kind other than `'file'`, `'settings-hook'`, `'settings-deny'` (`:936`). `nextManifest.kitVersion = kitVersion` only when something was written or patched (`:973`).
- Write allowlist: `ALLOWED_EXACT` (`:211`), `ALLOWED_PREFIXES = ['docs/harness/', '.claude/', 'scripts/']` (`:212`); `assertAllowed` (`:215`), `assertContained` (`:292`). **`docs/CONTRACT.md` is a kit file, not a target-repo file, so the allowlist does not apply to it.**

### Does anything today remove or replace a registration during `apply`?

**No.** `apply` only appends. The single removal path is uninstall's `revertPatch`.

- `export function revertPatch(settings, patch, { producibleHookScripts, producibleDenyRules })` (`settings-merge.mjs:238-299`), returns `{ settings, kept: [{ patch, reason }], gone }`. For a hook patch: finds the element by `list.findIndex(m => matcherEntrySha256(m) === patch.entrySha256)` (`:285`); not found → `'patch-modified'` if a kit hook remains on the event (`hookPathTokens(h).some(token => producibleHookScripts.has(token))`, `:287-289`) else `gone`; found → removed only when `hooks.every(h => producibleHookScripts.has(scriptRunBy(h)))` (`:292`), else kept as `'not-generator-producible'`. Empty event arrays and an empty `hooks` object are pruned (`:296-297`).
- **`scriptRunBy(entry)` (`:205-211`) accepts the exec form only as `entry.command === 'node' && entry.args.length === 1`.** Its doc comment: "Anything else (another runtime, an extra argument, a shell string doing more) is the user's."
- `export function revertPatches(settings, patches, producible)` (`:310-328`) returns `{ settings, reverted, gone, kept }`; unfound patches are re-judged after the others.
- Uninstall: `producibleSettings(root)` (`uninstall-lib.mjs:80-87`) = `{ producibleHookScripts: new Set(GENERATOR_SCRIPT_PATHS), producibleDenyRules: new Set([...protectedDenyRules({ stack, files }), ...toolGateDenyRules()]) }`. `planUninstall({ root, manifest })` (`:539-604`) simulates the same revert and returns `{ remove, keep, gone, revert, keepPatches, gonePatches, removeSettingsFile, removeDirs, leftInPlace, sessionLog }`; `runUninstall({ root, manifest, plan })` (`:606-800`) re-derives from the manifest (`:625-661`) and writes settings only when `r.reverted.length > 0` (`:637`).
- `scriptsStillRegistered(validated, settings)` (`:512-527`) keeps every installed script a remaining entry names (`hookPathTokens(hook).filter(token => GENERATOR_SCRIPT_PATHS.includes(token))`) plus `everyLoadedSibling(script)`; reason `STILL_REGISTERED = 'hook-still-registered'` (`:498`).
- File removability: `GENERATOR_PRODUCIBLE_EXACT` (`:148-165`) spreads `GENERATOR_SCRIPT_PATHS` and `HOOK_MODULE_PATHS`.
- `scripts/uninstall.mjs`: reads `readManifestResult(root)` (`:43`), `planUninstall` (`:57`), reasons rendered by `keptWhy` (`:61`) and `patchWhy` (`:77`), `patchLabel` (`:88`).

### "ours-unmodified" for a settings patch

There is no `classify` for patches (`classify(root, manifest, relPath)` in `manifest.mjs:152-174` is files only: `'ours-unmodified' | 'ours-modified' | 'theirs'`). The existing equivalents are:
1. Exact-hash presence: an element of `hooks.<event>` whose `matcherEntrySha256(m)` equals the record's `entrySha256` (`settings-merge.mjs:285`). Any owner change to that element (a `timeout`, a second hook merged into it, a matcher edit, shell form) changes the hash.
2. `registeredHook`'s manifest branch (`hook-evidence.mjs:111-115`): `recordedHashes(scriptPath, matcher)` = hashes of `execEntry` and `shellEntry` forms; credited when a registration with `script === null` has `entrySha256` in the recorded set and the file exists.
The design's migration test ("every registration the kit made on it is still exactly as `settingsPatches` recorded") maps onto (1) per patch whose `event` is the event being migrated.

### Dry-run reporting (`scripts/apply.mjs`)

- Header: `` `kh-harness: ${proposals.length} action${…} to close ${gapCount} capability gap${…} for ${root}` `` (`:165-169`); `gapCount` = distinct `checkId`s.
- Per action (`:182-190`): label `p.path` | `'.claude/settings.json (deny rules)'` | `` `.claude/settings.json (hook: ${p.event})` ``; line `` `--- ${label}  [${p.checkId}]` ``; `` `    ${p.reason}` ``; then `preview(p)` (file diffs only without `--yes`).
- `diffRenderer(root)` (`apply-lib.mjs:617-633`): `'file'` → `fileDiff`; `'settings-hook'` → `settingsHookPreview` (`:555-567`, prints only the added element and "(appended after N existing … entries, which are left unchanged and not shown)"); **anything else is treated as a deny proposal** (`:628`). No preview exists for a removal or replacement.
- `if (proposals.length === 0)` → prints `` `kh-harness: no actions for ${root} — nothing apply can write; …` `` and `process.exit(0)` (`:155-159`) **before any manifest write**.
- Dry run ends with `EXECUTION_DISCLOSURE` when any `settings-hook` is proposed (`:199`), drift lines, `note: --yes would be refused — …`, `'Dry run — nothing written. Re-run with --yes to apply.'` (`:204`).
- After `--yes`: `wrote      <path>`, `patched    .claude/settings.json (<event>)`, `skipped    <path> (<why>)`, `failed     …` (`:268-281`).

---

## 5. Detect checks

### `registeredHook`

`export function registeredHook(harness, event, ourPath, proposal, { manifest, root, matcher, kitScripts })` (`scripts/lib/hook-evidence.mjs:74-125`). Throws `TypeError` when `kitScripts` is not an array (`:75`). Reads `harness.claudeDir.hookRegistrations?.[event]`. Returns one of:
- `{ state: 'declared', evidence: [`${event} hook: ${ourPath}`] }` (`:87`)
- `{ state: 'declared', evidence: [`${event} hook: ${ourPath} (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)`] }` (`:114`)
- `{ state: 'absent', proposal, evidence: [ … ] }` with the matcher-mismatch line (`:82-85`), `[]` (`:116`), or occupant lines (`:117-124`): `` `${event} already holds another kh-harness hook: ${s}` `` when `kitScripts.includes(s)`, `` `… a hook that is not this kit's: ${s}` ``, or the unresolved-script line.
- Helper `export function runsKitScript(registration, scriptPath, matcher)` (`:41-44`).

What it reads: `hookRegistrations(root, files)` in `scripts/lib/detect-harness.mjs:206-230` yields, per registered hook, `{ script, matcher }` plus a **non-enumerable** `entrySha256`. `script` comes from `commandScript(entry, files)` (`:171-180`), the first `hookPathTokens(entry)` token that is a file in the scan list; **arguments after `args[0]` are never recorded**, deliberately ("The command string itself is never recorded", `:194-195`) because `harness` is serialised into the committed `docs/harness/detect.json`. It reads both `SETTINGS_FILES = [SETTINGS_PATH, LOCAL_SETTINGS_PATH]` (`:43`).

### Check result shape

A check's `check(ctx)` returns `{ state, evidence?, proposal?, decidable?, question?, advice? }`. `buildGaps` (`scripts/lib/gap-model.mjs:1074-1157`) normalises to `{ id, step, phase, state, lookedFor, evidence, decidable, question, advice, proposal, via }` (`:1139-1153`); `proposal` survives only for a decidable `absent` (`:1138`); `via` comes from `proposalVia(def)` (`:57-61`), which is `'apply'` exactly when `GENERATORS` has the id, and **throws** for a proposing check with neither a generator nor `viaWithoutGenerator`. `STATES = ['absent', 'declared', 'verified', 'failing', 'n/a']` (`:30`). Check context: `{ stack, harness, exposures, profile, git, files, root, manifest, kitVersion, checks, heldScript }` (`:1128`). `unlessHeld(hook, scriptPath, heldScript)` (`:82-87`).

### The four checks

- **(a) `P5.sessionlog`** (`gap-model.mjs:709-741`), step 31. `lookedFor: [`a hook running ${SESSION_LOG_PATH} on each of the ${LOGGED_EVENTS.length} logged events in .claude/settings.json`]`. Uses `sessionLogRegistrations(harness, { manifest, root })`. Declared evidence: `` `${SESSION_LOG_PATH} is registered on all ${total} logged events: ${LOGGED_EVENTS.join(', ')}` `` (`:723`). Partial: `` `${SESSION_LOG_PATH} is registered on ${total - n} of the ${total} logged events; ${n} … missing: …` `` with proposal `` `register ${SESSION_LOG_PATH} on the ${n} logged event${…} it is missing` `` (`:735-739`).
- **(b) `P5.toolgate`** (`:742-765`), step 30. `registeredHook(harness, 'PreToolUse', TOOL_GATE_PATH, '<long proposal text>', { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS })`, then `missingToolGateDenyRules(harness)`.
- **(c) `P2.sensor`** (`:851-882`), step 9. `registeredHook(harness, 'PostToolUse', LINT_TOUCHED_PATH, 'install scripts/lint-touched.mjs and register a PostToolUse hook', { manifest, root, matcher: SENSOR_MATCHER, kitScripts: GENERATOR_SCRIPT_PATHS })`; without a lint script → `decidable: false` with the question at `:879`.
- **(d) `P2.loopwatch`** (`:905-913`), step 13. `unlessHeld(registeredHook(harness, 'PostToolUseFailure', LOOP_WATCH_PATH, '…', { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS }), LOOP_WATCH_PATH, heldScript)`.

### Other readers of "is the hook registered" that the design does not mention

- `scripts/lib/log-lib.mjs:105-116` `hookRegistration(root)`: `log status` counts the logged events whose settings entry satisfies `hookPathTokens(entry).includes(SESSION_LOG_SCRIPT)`; returns `{ registered, events: { registered, logged }, problem }`. Pinned in `scripts/lib/log-cli.test.mjs:80-94`.
- `scripts/lib/rules-evidence.mjs:65-66`: a `settings:hooks.<Event>` rule pointer resolves when some registration on the event is not the logging hook: `registrations.some(r => !runsKitScript(r, SESSION_LOG_PATH, undefined))`.
- `scripts/lib/integrity-evidence.mjs:74-93` `machinery(...)` (check `P5.integrity`, `gap-model.mjs:767`): compares recorded files under `.claude/scripts/` with the manifest.
- `assets/scripts/harness-log.mjs:298-307` `baseHash`: the session's `harness.base` hashes the recorded `.claude/scripts/` files **and `manifest.settingsPatches` minus `appliedAt`**, so a migration changes `base` for every later session.

---

## 6. Manifest (`scripts/lib/manifest.mjs`)

- `MANIFEST_PATH = '.claude/kh-harness.manifest.json'` (`:7`, exported `:207`).
- `export const KIT_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;` (`:11`); `package.json` version is `0.2.0`.
- `export function emptyManifest(kitVersion) { return { schema: 1, kitVersion, installedAt: new Date().toISOString(), files: [], settingsPatches: [] }; }` (`:22-24`).
- `function isWellFormedManifest(m)` (`:61-68`, not exported): `isPlainObject(m) && m.schema === 1`, `files` array of `{ path: string, sha256: string }`, optional `settingsPatches` (array of plain objects), optional `dirsCreated` (array of strings), optional `learnings` (array of `isLearningRecord`, `:51-52`). **Unknown top-level fields are accepted**, so a `contract` field passes today unvalidated; a numeric check must be added here to refuse a malformed one.
- Other top-level fields written elsewhere: `settingsCreated` (`apply-lib.mjs:882`, `uninstall-lib.mjs:769`), `dirsCreated` (`recordCreatedDirs`, `apply-lib.mjs:690`), `learnings` (`learn-land.mjs`).
- `export function readManifestResult(root)` (`:39-45`) → `{ state: 'missing' | 'corrupt' | 'ok', manifest }`; `readManifest(root)` (`:70-72`).
- `export function writeManifest(root, manifest)` (`:125-127`): `replaceFile(join(root, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + '\n')`.
- Where a manifest is built or written:
  - `scripts/apply.mjs:87` `const manifest = manifestResult.manifest ?? emptyManifest(KIT_VERSION);`; `:242` `persistManifest: staged => writeManifest(root, staged)`; `:263` `writeManifest(root, result.manifest)`. Not reached when `proposals.length === 0` (`:155-159`) or on a dry run (`:196-206`).
  - `scripts/lib/apply-lib.mjs:945` `structuredClone(manifest ?? emptyManifest(kitVersion))`; `:973` sets `kitVersion`.
  - `scripts/lib/learn-land.mjs:419` (`emptyManifest(KIT_VERSION)` when there is none), `:638`, `:797` (`writeManifest`), spreading `{ ...manifest }` so unknown fields survive.
  - `scripts/lib/uninstall-lib.mjs:764-775`: `{ ...manifest, files, settingsPatches, dirsCreated, settingsCreated }` — unknown fields survive.
- A second, installed-side validator exists: `readInstalledManifest(root)` in `assets/scripts/harness-log.mjs:278-286` (`schema !== 1`, `files` array, `settingsPatches`, every path inside root). It also tolerates unknown fields.
- `scripts/session-nudge.mjs:35,101` reads `found.manifest.kitVersion` through `readManifestResult`.
- Manifest prose that would need the new field: `MANIFEST_NOTE` (`scripts/lib/cli.mjs:185-191`), `docs/guide/how-it-works.md:289` and `:449-450`.

---

## 7. Session log append (`assets/scripts/harness-log.mjs`)

- `export function dataRoot()` (`:86-89`): `KH_DATA_DIR` when absolute, else `join(homedir(), '.claude', 'kh-harness')`.
- `export function repoKey(root)` (`:154-157`): first 16 hex of SHA-256 over the git common dir (or root). `export function repoDataDir(root)` (`:159-161`): `join(dataRoot(), repoKey(root))`. Every worktree shares one directory.
- `export function isEnabled(root)` (`:186-189`): true only when `<repoDataDir>/enabled.json` (`ENABLED_FILE`, `:33`) parses to `{ enabled: true }`. `setEnabled(root, enabled)` (`:204-218`), `LINK_REFUSED = 'EKHLINK'` (`:192`).
- `export function readConfig(root)` (`:235-247`): `DEFAULT_CONFIG = { contentRetentionDays: 90, inlineCapBytes: 65536, autodraft: false }` (`:36`).
- `export function sessionFileName(sessionId)` (`:538-541`): `` `s-${id}.jsonl` `` or `null` when `safeSessionId` refuses. `SESSIONS_DIR = 'sessions'` (`:344`), `BLOBS_DIR = 'blobs'` (`:345`), `LOG_SCHEMA = 1` (`:341`).
- `export function appendEvent(root, sessionId, event)` (`:561-586`) → `{ written: true }` or `{ written: false, reason }`; never throws. Reasons: `'unsafe session id'`, `'event is not an object'`, `'event is not serialisable'`, `'the log directory, its sessions directory or the session file is a link'`, `` `write failed: ${code}` ``. Behaviour: JSON round-trip; `scrubWith(body, s => inlineOrBlob(root, s, capBytes))`; strips any `schema`/`ts`/`pid` the event carries and writes `{ schema: LOG_SCHEMA, ts, pid, ...fields }` + `'\n'` in one `appendFileSync(path, line, { flag: 'a', mode: 0o600 })`; creates the sessions dir `0o700`.
  - **`appendEvent` does not call `isEnabled`**; each caller does (session-log `:343`, tool-gate `:217`).
  - **`appendEvent` requires a session id.** There is no API for an event outside a session.
  - **No size bound is applied on append.** The bounds that exist: per-leaf `inlineCapBytes` (a longer string leaf becomes `{ blob, bytes, truncated: true }`, `:527-531`) and the read bound `MAX_LOG_FILE_BYTES = 256 * 1024 * 1024` / `maxLogFileBytes()` (`:43-47`); a session file over it is "not read, sealed or expired" (`:38-42`). `MAX_SMALL_FILE_BYTES = 1024 * 1024` (`:51`) bounds records/config.
- Redaction: `scrubWith(value, onString, hidden = false)` (`:445-459`) masks every key and string leaf with `maskText` (`harness-redact.mjs:369`, signature `maskText(text, options)`), and replaces every scalar under a credential-named key with `SCRUB_MARK = '***'` (`harness-redact.mjs:319`); `scrubArray` (`:417`) handles a value after a credential flag. Other redact exports used around the log: `canonicalJson(value)` (`:405`), `safeSessionId(sessionId)` (`:738`, `/^[A-Za-z0-9_-]+$/`, ≤ 200 chars), `stripUnsafe` (`:308`), `maskCredentials(line, options)` (`:352`).
- `export function readEvents(root, sessionId)` (`:607-637`) → `{ events, unparseable, unreadable, overLimit }`.

### Who enumerates the data directory

- Sessions: the one enumerator is `export function listSessionFiles(root)` (`assets/scripts/harness-seal.mjs:250-266`): `readdirSync(<repoDataDir>/sessions)`, keeps only names matching `SESSION_ENTRY` = `^s-([^.]+)\.jsonl(\.gz|\.sealing|\.gz\.tmp)?$` (`:133-134`) whose id passes `safeSessionId`. Everything else in `sessions/` is ignored. `scripts/lib/recurrence.mjs:140,151` (`listSessions`, `sessionIds`) and sealing/retention (`harness-seal.mjs:270-276`) go through it.
  - Consequence: a per-repository file placed in `sessions/` under a name like `s-<word>.jsonl` **would be treated as a session** (sealed after `SEAL_IDLE_MS = 10 * 60_000` idle, `:53`; counted by `sessionIds`; read by recurrence). Placed at the top level of `repoDataDir`, or in `sessions/` under a name that does not match `SESSION_ENTRY`, it is invisible to sealing, retention, recurrence and `learn`.
- Top level of `repoDataDir`: fixed names read directly — `enabled.json`, `config.json`, `last-tick.json` (`LAST_TICK_FILE`), `gates.local.json` (`LOCAL_GATES_FILE`), `index.jsonl`, `index.jsonl.lock`, `verified.json` (`harness-seal.mjs:112-114`), `ledger.jsonl` (`ledger.mjs:23`), `policy.json` (`policy.mjs:16`), `learning-ids.json` (`learn-lib.mjs:156`), the learnings dir (`learn-lib.mjs:182`). The only top-level `readdirSync` are: `writeVerified` (`harness-seal.mjs:814`, filters `verified.json.*.tmp`), `purgeTarget` (`log-purge.mjs:54`, lists **every** entry by name and size in the purge plan), `diskUsage(dir)` (`log-lib.mjs:120-146`, sums everything), uninstall's `sessionLogUsage(root)` (`uninstall-lib.mjs:34-66`, sums regular files). A new top-level file is counted and listed by those and breaks none. `log purge --yes` removes the whole directory.
- Blobs: `readdirSync(<repoDataDir>/blobs)` in `harness-seal.mjs:769` and `log-maintain.mjs:22`. The blob sweep removes blobs no session references; a blob referenced only from a non-session file would be swept.
- Retention by event type: `KEPT_FIELDS` (`harness-seal.mjs:71-91`) and `CONTENT_FIELDS` (`:99-105`); `contentFieldsOf(type)` (`:681-684`) returns `UNKNOWN_TYPE_CONTENT = ['input', 'output', 'prompt']` (`:107`) for a type `KEPT_FIELDS` does not name. A new event type carrying a `data` field would therefore **keep `data` past retention** unless the type is added to both tables. Tests import both tables (`tool-gate.test.mjs:49`, `session-log.test.mjs:15`).
- `scripts/log.mjs` (110 lines) and `scripts/learn.mjs` (233 lines) are thin CLIs over `log-lib.mjs`, `log-report.mjs`, `log-maintain.mjs`, `log-purge.mjs`, `learn-cli.mjs`.

---

## 8. Rules registry parsing

All in `assets/scripts/harness-redact.mjs` (an **installed** asset, so any change alters its bytes and triggers a kit-skew update on every install):

- `export const RULES_PATH = 'docs/harness/RULES.md';` (`:565`), `export const LEARNED_PATH = 'docs/harness/LEARNED.md';` (`:566`).
- `export const ENFORCERS = Object.freeze(['deny', 'hook', 'lint', 'test', 'critic', 'ci', 'review', 'none']);` (`:571`). **`officer` is not in it.**
- `export const APPROVED_ACTIONS = Object.freeze(['observe', 'warn', 'block']);` (`:575`); `heldByBlockingGate` (`:585`); `findRules(root)` (`:587`), `findLearned(root)` (`:591`).
- `export const RULE_HEADING = /^##\s+([A-Za-z][\w.-]*)(?:\s+[—–-]+\s+|\s+)(\S.*)$/;` (`:600`), `export const ANY_H2 = /^##(\s|$)/;` (`:601`), `const KEY_LINE = /^\s*[-*]\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/;` (`:602`).
- `function fieldFor(key)` (`:606-614`): lowercases and strips `-`/`_`; accepted keys → fields: `enforced-by`→`enforcedBy`, `last-verified`→`lastVerified`, `approved-sha256`→`approvedSha256`, `approved-action`→`approvedAction`, and `why`, `pointer`, `verify`, `priority`, `status`, `origin`, `evidence`. **Unknown key → `return null`, silently ignored** (`:613`, "unknown keys are ignored, as Claude Code ignores unknown frontmatter"; the parser does `if (!field) continue;` at `:688`). So an `approval:` line is already accepted and ignored, with no problem reported and no field on the rule object.
- `export function registryLines(text)` (`:621-623`); `export function parseRules(text)` (`:650-713`) → `{ rules, problems }`. Rule object: `{ id, rule, why, enforcedBy, pointer, verify, priority, status, lastVerified, origin, evidence, approvedSha256, approvedAction, line }` (`:681`).
- Unknown `enforced-by` value (`:690-693`): `problems.push(`${current.id}: enforced-by "${v}" is not one of ${ENFORCERS.join('/')} — recorded as none`); current.enforcedBy = 'none';`. Missing line (`:659-662`): `` `${current.id}: no enforced-by line — recorded as none` ``. So today `enforced-by: officer` is reported as a problem and counted as `none`.
- Pointer existence, kit side: `scripts/lib/rules-evidence.mjs`. `POINTERLESS = new Set(['none', 'review'])` (`:36`); `SETTINGS_POINTER = /^settings:(permissions\.deny|hooks\.([A-Za-z]+))$/` (`:38`); `function pointerResolves(root, harness, pointer)` (`:58-72`): settings forms, else a repository-relative path (absolute or any `..` segment refused) checked with `existsSync(join(root, p))`. `fileEvidence` (`:82-111`) pushes `{ id, pointer }` to `missingPointers` for every active rule whose enforcer is not pointerless. `export function rulesRegistryEvidence(root, harness)` (`:129-139`). Once `officer` is in `ENFORCERS`, an officer rule's missing path pointer is reported by this existing code with no further change.
- Rendering in detect: `P3.rules` (`gap-model.mjs:589-651`): `` `${m.id}: pointer ${m.pointer} does not exist` `` / `` `${m.id}: enforced-by names a mechanism but no pointer says where it is` `` (`:632-634`), per-enforcer counts (`:627-629`).
- `assets/scripts/rules-brief.mjs`: probes `NEEDED = ['escapeDelimiters', 'findLearned', 'findRules', 'heldByBlockingGate', 'maskText', 'parseRules', 'projectRoot', 'stripUnsafe']` (`:66`); `parseRules(readFileSync(join(root, rel), 'utf8')).rules.filter(r => r.status !== 'superseded')` (`:150`); prints each rule as `` `- ${r.id}: … [enforced-by: ${r.enforcedBy}]` `` (`:187`). It does not check pointers. An officer rule would be printed as `[enforced-by: officer]`.
- Other users of `ENFORCERS`: `scripts/lib/learned-registry.mjs:39,127` (a learned entry's `enforcedBy` must be in `ENFORCERS`); other `parseRules` callers: `integrity-evidence.mjs:143`, `learn-land.mjs:507,516`, `uninstall-lib.mjs:375`.
- Tests: `scripts/lib/rules-registry.test.mjs` (233 lines), `scripts/lib/rules-evidence.test.mjs` (299), `scripts/lib/rules-brief.test.mjs` (440). The scaffold is `assets/templates/RULES.md.tmpl` (referenced at `uninstall-lib.mjs:289`).

---

## 9. Docs and conventions

- `docs/guide/` (5 files):
  - `commands.md` (1175 lines) — every command, subcommand and flag; reproduces the `--help` text (the `WHAT THE HOOKS EXECUTE` block at `:221`).
  - `how-it-works.md` (665 lines) — the machinery: `## The pieces`, `## What runs when` (the per-script hook table `:124-132`, the 16 events `:134-138`, a mermaid sequence), `## Where everything lives` (`:259-298`), `## How detect decides`, `## How apply and uninstall stay safe`, `## How a failure becomes a gate`, `## What the guarantees are, and are not`.
  - `learning-loop.md` (444 lines) — learnings, states, replay, approval, policy, tick, landing, reverting.
  - `session-log.md` (248 lines) — what the log stores, where, the scrub, retention, sealing, cost.
  - `troubleshooting.md` (530 lines) — refusals and notices quoted from code.
- Existing place for installed-file formats: **none dedicated.** The closest is `docs/guide/how-it-works.md` `## Where everything lives` (a tree at `:263-281` and a table at `:286-297` that says who writes each path, not its schema) and `docs/guide/session-log.md` `## What it stores`. `docs/CONTRACT.md` does not exist. The manifest's fields are described only in prose (`MANIFEST_NOTE`, `how-it-works.md:449-450`).
- Contributor rules: no `CLAUDE.md`, `AGENTS.md` or `CONTRIBUTING*` in the repository (root holds `assets CHANGELOG.md docs evals hooks package.json README.md reports research_notes scripts skills`; `.claude/` holds only `scheduled_tasks.lock`). The repository's own rules are `docs/harness/RULES.md` (R1–R14, 129 lines). Those most relevant here, quoted:
  - `## R5 — Every installed hook's output is bounded in time and bytes and passes one shared redaction chokepoint` (`:48`)
  - `## R6 — Uninstall removes only what the manifest records, identical up to line endings and stamped, and never a user-authored body` (`:56`)
  - `## R9 — No `--force`, no ignore list, no readiness score, no opinions about frameworks or layouts` (`:80`, `enforced-by: review`)
  - `## R10 — Every generated file carries the `Generated by kh-harness` stamp` (`:87`)
  - `## R11 — A learned enforcer is data, never code` (`:95`)
  - `## R14 — Unattended, the loop writes nothing inside the repository and never alters a rule it did not learn` (`:122`)
  The standing constraints are also restated in the latest plan's `## Global Constraints` (below), e.g. "Installed hook scripts import only Node built-ins and sibling files in `.claude/scripts/`. Kit-side code may import from `assets/scripts/`, never the reverse." and "No dead code, no speculative options, no comment that narrates history; a comment states a constraint the code cannot."
- Commit style (`git log --oneline -15`): conventional type and scope, then a full declarative sentence in lower case stating the behaviour:
  ```
  eead407 Merge remote-tracking branch 'origin/feat/self-update'
  5a3ea66 feat(plugin): the plugin keeps its own checkout at its upstream
  c6c60d3 Merge remote-tracking branch 'origin/master'
  8ac3024 feat(plugin): a start-of-session notice says whether the repository has the harness
  dd58047 fix(hooks): a Python member's lint command may live in the package.json beside its pyproject.toml
  81569de feat(detect): name a uv workspace beside a TypeScript profile, and ask about the install step
  ac10561 fix(scan): a linked worktree of this repository is not a nested repository
  ce1d09d fix(exposure): ordinary code is not a credential literal
  f2bfc06 docs(readme): How it works names the three kinds of part and the hook table, and links the new page
  14c610d docs(guide): a page that explains how the kit works, part by part
  971161c docs(guide): a land or revert finishes its own stopped step only for a file the ledger vouches for
  27d1daf docs(readme): the Limits name the package-script spelling the deny rules do not match
  63431a9 docs: the CI comment and the README say which Node releases are run, and that 22.0 is not
  132336f docs(skill): detect.md says which files hold the hook scripts back
  e70e950 refactor(apply): ALLOWED_EXACT is no longer exported, since nothing imports it
  ```
- Latest plan: `docs/superpowers/plans/2026-11-19-session-log-and-learning-loop.md`. Header format (first ~40 lines): `# <Title> Implementation Plan`; a blockquote `> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans … Steps use checkbox (`- [ ]`) syntax for tracking.`; then `**Goal:**`, `**Architecture:**`, `**Tech Stack:**` ("Node 22+, ES modules, `node:test`, no runtime dependencies…"), `**Spec:**`; `## Global Constraints` (bullets, including "Exit codes are 0, 2 and 3 only", "Commit after every task on the current branch. Never push. End each commit message with `Co-Authored-By: …`", "Before writing code that depends on a Claude Code hook event name, payload field, output shape or permission-rule syntax, read the current reference at `https://code.claude.com/docs/en/hooks` or `/permissions` and pin what was read in a test."); then "**Every task follows the same cycle,**" (1 failing tests, 2 confirm failure, 3 implement, 4 task tests then `npm test`, 5 commit); then `## Review Focus` (numbered risks, each naming the task that pins it). Execution logs live at `docs/plan-N-execution-log.md` (plans 1–9 exist). `CHANGELOG.md` uses Keep a Changelog with an `## Unreleased` section.
- How tests run: `package.json` `scripts`: `test` (quoted in section 2), `detect`, `log`, `learn`. `engines.node` `>=22`; the README states the Node release `npm test` needs (pinned by `latency-phase.test.mjs:54-69`).
- `npm test`, run once on this machine (Node v26.13.1, Linux): **exit 0, 54.1 s wall**. First run: 2294 tests, 2290 pass, 0 fail, 4 skipped, `duration_ms` 48791. Second run (latency): 2 tests, 2 pass, `duration_ms` 5162 (tool-gate 2070 ms, session-log 2996 ms for 40 pairs each). `git status --porcelain` was identical before and after the run.
- Doc and test text that states a hook-script count or the per-event hook layout (each needs an edit if a script is added to `HOOK_SCRIPTS`): `scripts/lib/cli.mjs:89` ("registers up to seven hook scripts") and `:107` ("The other five run nothing"); pinned by `scripts/lib/cli.test.mjs:192-193` (`assert.equal(GENERATOR_SCRIPT_PATHS.length, 7, …)`) and `:213`; the same block copied in `README.md:213` and `docs/guide/commands.md:221`; `README.md:372`; `docs/guide/how-it-works.md:112`, `:143`, `:270` ("7 hook scripts and 4 modules"); `docs/guide/troubleshooting.md:429` ("Each of the seven hooks"). `scripts/lib/cli.test.mjs:176-195` also asserts that the set of scripts in generated `settings-hook` entries (`p.entry.args[0]`) equals `GENERATOR_SCRIPT_PATHS`.
- Plugin-side guard: `scripts/lib/plugin-manifest.test.mjs:18-28` asserts `hooks/hooks.json` names no file in `assets/scripts/`.

---

## 10. Contradictions with the designs, and things they do not account for

1. **Registration form.** The hook-merge design's example is the shell string `node .claude/scripts/harness-dispatch.mjs PreToolUse gate,log`. The kit writes only exec form, `{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/<script>'] }` (`hook-evidence.mjs:25`), and tells users so (`cli.mjs:110-114`). The dispatcher registration would be exec form with **three** `args`, which no existing code produces or expects.

2. **Uninstall will not remove a registration that has extra arguments.** `scriptRunBy` (`settings-merge.mjs:205-211`) treats an exec entry as the kit's only when `entry.args.length === 1`; otherwise `revertPatch` keeps it as `'not-generator-producible'` (`:292-294`). The design's "`uninstall` removes the dispatcher registration like any other recorded patch" is false until this is changed, and the dispatcher must also be in `GENERATOR_SCRIPT_PATHS` (`propose.mjs:616-623` says so).

3. **Dedupe ignores arguments.** `sameHook`/`hasEquivalentHook` (`settings-merge.mjs:135-158`) compare only `args[0]`. Once a dispatcher entry exists on an event, a proposal to register the dispatcher with a different half list is skipped as `'unchanged'` (`apply-lib.mjs:793-795`). Adding a half later (e.g. a lint script appears, so `lint` should join `PostToolUse`) cannot be done by appending; it needs a replace.

4. **Detect cannot see which halves a registration names.** `hookRegistrations` records `{ script, matcher }` and a non-enumerable hash only (`detect-harness.mjs:206-230`); arguments are dropped on purpose because `harness` is committed in `detect.json`. `registeredHook` therefore cannot tell `harness-dispatch.mjs PreToolUse gate` from `… gate,log`. The design's "accept the dispatcher the same way" needs a new, safe representation of the half list (it is a fixed vocabulary, so it can be validated rather than echoed). `recordedHashes` (`hook-evidence.mjs:33-35`) also only knows the one-argument forms.

5. **Nothing in `apply` removes or replaces a settings entry, and the pipeline has no place for it.** `addHookEntry` appends; `applyProposals` throws on an unknown `kind` (`apply-lib.mjs:936`); `diffRenderer` treats any non-file, non-`settings-hook` proposal as a deny patch (`:628`); `settingsHookPreview` says existing entries "are left unchanged" (`:563`). A migration needs a new proposal kind end to end (validation, staging, manifest record removal, preview, the label at `apply.mjs:183-185`, the `patched` line). Removal of the old records from `settingsPatches` also changes `harnessIdentity().base` (`harness-log.mjs:305-306`).

6. **No proposal is generated when every hook is already registered.** `buildProposals` acts only on `absent`, decidable checks with a generator (`propose.mjs:1001-1005`). On an existing install `P5.sessionlog`, `P5.toolgate`, `P2.sensor`, `P2.loopwatch` are all `declared`, so the migration needs its own check (or those checks must go `absent`), and a new proposing check must have a generator or `proposalVia` throws (`gap-model.mjs:57-61`).

7. **`contract` is never written on an install with nothing to do.** `apply.mjs:155-159` exits before any manifest write when `proposals.length === 0`, and a dry run writes nothing. "`apply` writes the `contract` number into the manifest" therefore needs the write to be an action of its own (shown in the dry run) or to ride on the migration; otherwise an up-to-date install keeps a manifest "older than the contract" and kh-orchestration's `apply` refuses it. `emptyManifest` is also called by `learn land` (`learn-land.mjs:419`).

8. **`lint-touched.mjs` cannot "return its result without writing or exiting" by adding a guard alone.** Its helpers write directly: `process.stderr.write` in `writeReport` (`:395`), `process.stdout.write` in `assetNotice` (`:74`) and `notConfirmedClean` (`:517`); `main` returns only the exit code. `loop-watch.mjs` writes inside `main` (`:180`, `:200`). Both need restructuring so the exported function returns `{ exitCode, stdout JSON, stderr text }`, while the 77 + 21 process-level tests must keep passing unchanged. `tool-gate.mjs` already has the pure `decide(root, payload)` (`:234`); `session-log.mjs` has `record(payload)` (`:339`) but it is async and its sibling-notice branch lives in `main`.

9. **The lint and loop halves do not check the event or the tool.** `lint-touched` reads only `tool_input.file_path` (`:533`) and relies on the registration's `matcher: 'Write|Edit'`; `loop-watch` checks only `tool_name` and `error` (`:177`). The design covers the lint case ("only when the tool is `Write` or `Edit`"); the dispatcher must also be the one to enforce it, since its own registration on `PostToolUse` carries no matcher (the log half needs every tool). Related: an existing sensor registration under a wider owner-chosen matcher is credited today through `matcherCovers` (`settings-merge.mjs:80-90`); the design's "exactly as recorded" test would leave such an event unmigrated.

10. **Installing the dispatcher installs all four hook scripts.** `loadedSiblings` (`propose.mjs:665-677`) treats every quoted `./name.mjs` in an asset as a dependency, and `requiresFiles` makes the registration conditional on each being on disk with this kit's bytes. A dispatcher that names `./lint-touched.mjs` forces `lint-touched.mjs` onto installs with no lint script (it was conditional until now, `sensorProposal` `:116`), and a name not in `INSTALLED_SCRIPTS` makes `loadedSiblings` throw. The design's "the lint half only where the lint sensor is installed" describes the registration, not the files; the plan has to say which it means.

11. **`log status` will under-count after migration.** `hookRegistration(root)` (`log-lib.mjs:105-116`) counts events whose entry runs `SESSION_LOG_SCRIPT`; the three migrated events would no longer match, giving "registered on 13 of the 16 logged events" (wording pinned in `log-cli.test.mjs:89-94`). The design's Detect section names only the four detect checks. `rules-evidence.mjs:66` (a `settings:hooks.<Event>` pointer resolves when a non-logging hook is on the event) would also start treating a log-only dispatcher registration as an enforcer.

12. **Test fixtures run registered hooks without their arguments.** `runEveryRegisteredHook` and `runRegisteredHook` (`lifecycle-fixtures.mjs:53-66`, `:252-266`) spawn `args[0]` alone, and `hooksBesideLog` (`:76`) filters by the session-log arg. Lifecycle tests would run the dispatcher with no event or halves. "Every existing test of the four scripts passes unchanged" holds for the four per-script files, but lifecycle, cli, log-cli, detect-cli and hook-skew tests pin the current registration layout and must change.

13. **Hook-script count is pinned in code, tests and five documents.** `cli.test.mjs:192` asserts `GENERATOR_SCRIPT_PATHS.length === 7` and the disclosure wording; see the list at the end of section 9. The design's file list does not mention the disclosure, the README or the guide.

14. **`recordExternalEvent` versus what `appendEvent` offers.** The orchestration design promises "the same size bounds and redaction" and a `{ recorded: false }` return when the log is disabled. Today: `appendEvent` has **no** append-size bound (only the per-leaf inline cap and a 256 MiB read bound), does **not** check `isEnabled`, returns `{ written, reason }` not `{ recorded }`, and cannot write without a session id. A per-repository file needs a location decision with real consequences (section 7): inside `sessions/` under an `s-*.jsonl` name it becomes a session to sealing and recurrence; elsewhere it is never sealed, never expired by retention, and blobs it references are swept. A new event type also keeps its `data` field past retention unless added to `KEPT_FIELDS`/`CONTENT_FIELDS` (`harness-seal.mjs:71-107`). The function must live in an installed asset (`harness-log.mjs` is the natural one), and another plugin importing it relies on `.claude/scripts/` being present and on `harness-log.mjs`'s static import of `./harness-redact.mjs` (`:20`).

15. **`approval` and `officer`.** The `approval` key needs no parser change to be "accepted and otherwise ignored" (`fieldFor` returns `null`, `harness-redact.mjs:613`), so the only work is a fixture test and documentation — unless the contract wants the value exposed on the rule object. `officer` needs adding to `ENFORCERS` (`:571`); the pointer check then works unchanged (`rules-evidence.mjs:94-96`). Side effects: the "is not one of deny/hook/…" problem sentence changes (`:693`), `learned-registry.mjs:127` starts accepting `officer` for learned entries, `rules-brief.mjs:187` prints it, and `harness-redact.mjs` changes bytes, so every install gets a kit-skew update of the shared module.

16. **The deny rules already cover the extensions file.** `toolGateDenyRules()` includes `Edit(/.claude/kh-harness/**)` (`propose.mjs:255`), so an agent cannot edit `.claude/kh-harness/extensions.json` in an installed repository; another plugin's installer must write it from a process, not through Claude's Edit tool. `.claude/kh-harness/` may not exist before a gate has landed; nothing in kh-harness creates it at `apply` time, and uninstall removes only directories listed in its own `dirsCreated`.

17. **Detect's report is committed.** `detect` writes `docs/harness/detect.json` (`scripts/detect.mjs:72-76`), and strings read from repository files are sanitised before printing (`displayPath`, `manifest.mjs:197-205`; "never a rule's own text", `harness-redact.mjs:626-632`). Listing "each extension, its version, its hash state and its `onFailure`" puts `id` and `version` strings from a repository-controlled JSON file into that report and onto a terminal; they need the same treatment. Extension state also is not part of `harnessIdentity().base` (`harness-log.mjs:298-307`), so a session's recorded harness identity will not show that an extension was loaded.

18. **Hooks on one event stop running in parallel.** `lifecycle-fixtures.mjs:49-50` notes Claude Code runs the hooks of one event in parallel; `how-it-works.md:144-145` says "this page states no order between them". Merged, the halves run in sequence in one process, and on `PostToolUse` for an edit the process stays alive for the lint run (up to `LINT_TIMEOUT_MS` 30 s). The log half is listed first, so its write is not delayed, but the design's latency claim applies to the non-lint case only. Output framing also has to be normalised (session-log emits JSON without a trailing newline, `:401`).

19. **Small factual check that holds:** `LOGGED_EVENTS` has 16 names (`session-log.mjs:142-166`), so "the other thirteen" is right; `tool-gate.mjs` and `session-log.mjs` do have `isEntryPoint` guards and `lint-touched.mjs`/`loop-watch.mjs` do not, as the design says; all four exit 0 on their own failures.
