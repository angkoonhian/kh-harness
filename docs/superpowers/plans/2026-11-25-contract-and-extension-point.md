# Contract and Extension Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a second plugin a published, tested contract with kh-harness: a `PreToolUse` extension point, a contract number installed in the repository, two additions to the rules registry format, and one function for appending to the session log.

**Architecture:** A new installed module, `harness-extensions.mjs`, reads `.claude/kh-harness/extensions.json`, checks each listed module's path and hash, loads it and calls its `preToolUse`; `dispatch-pre-tool.mjs` runs it as the half before the gate. Kit-side, two new `detect` checks report the extensions and the contract file, and a generator writes `.claude/kh-harness/contract.json` like any other kit file. `docs/CONTRACT.md` states each promise and `scripts/lib/contract.test.mjs` holds one fixture test per promise.

**Tech Stack:** Node 22+, ES modules, `node:test`, no runtime dependencies. Standard library only.

**Spec:** `docs/superpowers/specs/2026-11-25-hook-merge-design.md` (sections "Extensions", "The contract", "Detect and other readers", "Measured by") and `docs/superpowers/specs/2026-11-25-kh-orchestration-v1-design.md` (section "Stage 0: what changes in kh-harness"). This is part B of stage 0. Part A, "the merge", is a separate plan and must be finished first.

## What part A provides (check before Task 1)

This plan is written against these and nothing else of part A. Task 1 begins by confirming them; where part A chose a different name, use part A's name everywhere this plan uses the one below.

- A half result is `{ json: object | null, stderr: string, exitCode: 0 | 2 }`.
- `assets/scripts/harness-dispatch.mjs` exports `readPayload()`, `runHalves(payload, halves)`, `combine(event, results)` and `emit(combined)`. `halves` is an array of `{ name: string, run: (payload) => HalfResult | null | Promise<HalfResult | null> }`, each run in its own try/catch. `combine` lets a `deny` from any half win on `PreToolUse` and joins reasons, `systemMessage` texts and `additionalContext` texts in running order.
- `assets/scripts/dispatch-pre-tool.mjs` builds its halves as `[...preHalves, gateHalf, logHalf]`, with `preHalves` an empty array.
- `scripts/lib/propose.mjs` has a path constant for `.claude/scripts/dispatch-pre-tool.mjs`, called `DISPATCH_PRE_PATH` here, listed in `HOOK_SCRIPTS`; `harness-dispatch.mjs` is in `HOOK_MODULES`.

## Decisions made in this plan

Each is a choice the designs leave open. Strike any you disagree with before execution.

1. **`extensionsHalf` is `async`.** An extension is loaded with `await import()`. `require()` of an ES module needs a flag on Node 22.0 to 22.11 and refuses a module with top-level await, and the kit's floor is Node 22.0. `runHalves` accepts a promise. The extension's own `preToolUse` stays synchronous: a returned promise is a malformed result and is not awaited.
2. **`extensions.json` is a JSON array at the top level,** at most 8 entries and 65,536 bytes. One bad entry makes the whole file malformed, and so do two entries with one id. The design says "a list of entries" and "a malformed file blocks".
3. **Entry fields have fixed character sets,** because `id`, `version` and `module` are printed into hook output and into the committed `docs/harness/detect.json`: `id` is `/^[a-z][a-z0-9-]{0,63}$/`, `version` is `/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/`, `module` is `.claude/` followed by letters, digits, `.`, `_`, `/`, `-`, ending `.mjs`, at most 200 characters, with no empty, `.` or `..` segment.
4. **`sha256` is the SHA-256 of the module's bytes with each CRLF made LF,** as the manifest's hashes are compared, so a Windows checkout with `core.autocrlf` does not fail every extension.
5. **A module reached through a link is refused unless its real path is under the real `<root>/.claude/`.** A link at `extensions.json` itself makes the file malformed.
6. **Every extension runs, even after one blocks,** so one refusal names every extension that refused. With 8 entries of at most 300 characters the joined text stays under the 4,000 characters `tool-gate.mjs` allows itself.
7. **An extension's block message must be a non-empty string of at most 300 characters** (`GATE_LIMITS.messageMax`); anything else is a malformed result. A message that passes is then stripped with `stripUnsafe`, has line breaks made spaces, `<` and `>` escaped, and is masked with `maskText(…, { floors: 'sweep' })`. Gate messages are rejected for these at load time; an extension's is produced at call time, so it is cleaned instead.
8. **A result is exactly `{ decision: 'allow' }` or `{ decision: 'block', message }`.** Any other key is a malformed result.
9. **While an extension is imported and called, `process.stdout.write` and `process.stderr.write` write nothing and `process.exit` throws.** A stray `console.log` would otherwise corrupt the hook's one JSON line and lose a block.
10. **Each extension gets its own `structuredClone` of the payload,** so none can change what the next extension, the gate or the log sees.
11. **A failure with `onFailure: 'allow'` is told once per session** through a marker, as the gate hook's notices are. A block is told on every call.
12. **When `harness-extensions.mjs` itself cannot be loaded, `dispatch-pre-tool.mjs` blocks if `extensions.json` exists and says nothing if it does not.** The loader is imported dynamically inside the half, so the gate and log halves still run either way.
13. **`P0.kitskew` also proposes a sibling an updated script newly loads.** Today an update is proposed only for files the manifest records. An install whose `dispatch-pre-tool.mjs` predates this plan would be updated to import a `harness-extensions.mjs` nothing writes. See "Found while checking the designs".
14. **`contract.json` holds `{ "contract": 1, "generatedBy": "Generated by kh-harness <version> (…). Do not edit: …" }`,** not `{ "contract": 1 }` alone. RULES.md R10 and `uninstall`'s stamp check require the marker, and `gates.json` already carries it this way. The promise is that `contract` is an integer; other keys may appear.
15. **`contract.json` belongs to a new check `P5.contract` at step 30,** the gate hook's step, so no profile or skill phase table changes. The extensions report is `P5.extensions` at step 32, the advise step. Both follow `P5.integrity`, which a test requires to follow `P5.toolgate` directly.
16. **Both checks read from the harness object** (`harness.contract`, `harness.extensions`), set by `detectHarness`. A harness built without the key reports `n/a`, "not read", so hand-built test fixtures do not start proposing.
17. **`detect` never loads an extension module.** It hashes the file and reports `matches`, `differs`, `missing`, `outside` or `unreadable`.
18. **An `officer` rule's pointer must be a repository path.** A `settings:` pointer on an officer rule is reported as not existing.
19. **The `approval` key is not put on the parsed rule object.** `fieldFor` already ignores it; the work is a fixture test and documentation.
20. **`recordExternalEvent` writes an event of type `plugin_event`** with `source`, `kind` (the caller's `type`) and `data`. Not `external_…`: `external_content` already marks a session that read untrusted content.
21. **`source` and `kind` are kept by retention; `data` is content and expires with it.** `data` is free-form, and content is what retention exists to remove.
22. **"Bounded" means `data` over 16,384 bytes of JSON is refused,** not truncated: `{ recorded: false, reason }`. Under the 65,536-byte inline cap no blob is ever written for it.
23. **`recordExternalEvent` returns `{ recorded: false, reason }`.** The contract promises `recorded`; `reason` is fixed text for the caller's own report.

## Found while checking the designs

- **`{ "contract": 1 }` cannot be the whole file** (decision 14).
- **A recorded script that gains a new sibling is updated without it** (decision 13). This is true of the kit today for any such change; this plan fixes it because it would otherwise create the case.
- **Extensions make the `PreToolUse` hook run repository code.** `EXECUTION_DISCLOSURE` says the hooks other than lint and typecheck "run nothing of this repository's". Task 2 changes that sentence and its copies.
- **`appendEvent` has no size bound and does not check `isEnabled`,** so `recordExternalEvent` cannot be a rename of it (decisions 21 to 23).
- **The hook-merge design's "Measured by" asks for a malformed-file test "for both `onFailure` values".** A malformed file has no entry and so no `onFailure`; it always blocks. The tests cover it once.
- **Extension state is not part of `harnessIdentity().base`,** so a session's recorded harness identity does not show which extensions ran. Not changed here; `docs/CONTRACT.md` says so.

## Global Constraints

- Zero runtime dependencies. Node 22 and later, Windows and POSIX. No shell required by any hook.
- Installed scripts import only Node built-ins and sibling files in `.claude/scripts/`. Kit-side code may import from `assets/scripts/`, never the reverse.
- Every installed script is listed in `HOOK_SCRIPTS` or `HOOK_MODULES` in `scripts/lib/propose.mjs`. `loadedSiblings` counts every quoted `./name.mjs` in an asset, comments included, and throws for a name the kit does not install.
- Every file a hook reads is read through a bound (`readBounded` in `harness-log.mjs`).
- A message built from a repository file is fixed text. It never quotes the file's content. The only values echoed are an extension's `id`, `version` and `module`, which pass decision 3's character sets first.
- A hook exits 0 on its own failures and never writes to standard error, except the lint half's exit 2.
- Every generated file carries `STAMP_MARKER` (`scripts/lib/render.mjs`).
- A check never reports `verified` without execution.
- `assets/scripts/harness-redact.mjs` is changed in Task 5 only, by one word. Any change to it makes `P0.kitskew` propose an update on every install.
- No fixture or test file holds a literal that the kit's own credential sweep matches; build such a value at run time. The sweep runs over this repository inside `npm test` (`detect-exposure.test.mjs`).
- No dead code, no speculative options, no comment that narrates history; a comment states a constraint the code cannot.
- Tests run a hook as a child process (`spawnSync(process.execPath, [script], …)`) with `CLAUDE_PROJECT_DIR`, a temporary `KH_DATA_DIR` and `sandboxMarkerDir()`.
- Commit after every task on the current branch. Never push. Message style: `type(scope): a full sentence stating the behaviour`. End each message with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

**Every task follows the same cycle,** written once here and ticked per task:

1. Write the failing tests named in the task.
2. Run them and confirm they fail for the stated reason.
3. Implement.
4. Run the task's tests, then `npm test`; both pass.
5. Commit.

## Review Focus

Inputs the designs imply and no listed measure covers; each is pinned by a test in the task named.

1. **An extension that prints or exits.** A `console.log` in `preToolUse`, or a `process.exit(0)`, must not lose that extension's block or another's. (Task 2)
2. **A CRLF checkout.** The same module checked out with CRLF line endings still matches its recorded hash. (Task 1)
3. **An install from part A alone.** Its recorded `dispatch-pre-tool.mjs` is updated by `apply`; `harness-extensions.mjs` must arrive in the same run. (Task 2)
4. **An extension that changes its payload.** The gate half and the log half still see what Claude Code sent. (Task 2)
5. **A session holding a plugin event.** It is sealed, its index verifies, retention removes `data` and keeps the rest, and `log report` still runs. (Task 6)

---

### Task 1: The extensions file and its modules are read, bounded and judged

**Files:**
- Create: `assets/scripts/harness-extensions.mjs`
- Modify: `scripts/lib/propose.mjs` (path constants near `:28-39`, `HOOK_MODULES` near `:642-647`, the export list at the end)
- Modify: `scripts/lib/propose.test.mjs` (the `HOOK_MODULE_PATHS` assertion near `:1829`)
- Test: `scripts/lib/harness-extensions.test.mjs` (create)

**Interfaces:**
- Consumes: `readBounded(path, maxBytes)` from `./harness-log.mjs`.
- Produces, from `assets/scripts/harness-extensions.mjs`:
  - `EXTENSIONS_PATH = '.claude/kh-harness/extensions.json'`
  - `EXTENSION_LIMITS = Object.freeze({ fileMaxBytes: 65536, entriesMax: 8, moduleMaxBytes: 1024 * 1024, messageMax: 300 })`
  - `readExtensions(root): { state: 'absent' } | { state: 'malformed', problem: string } | { state: 'ok', entries: Entry[] }`, never throws. `Entry` is `{ id, version, module, sha256, onFailure }`, all strings, `onFailure` being `'block'` or `'allow'`.
  - `moduleState(root, entry): { state: 'matches', path: string } | { state: 'differs' | 'missing' | 'outside' | 'unreadable' }`, never throws. `path` is the module's real absolute path.
  - `moduleSha256(bytes: Buffer): string`, the hash of decision 4, for tests and for another plugin's installer to copy.
- Produces, from `scripts/lib/propose.mjs`: `HARNESS_EXTENSIONS_PATH = '.claude/scripts/harness-extensions.mjs'`, exported.

- [ ] **Step 0: Confirm part A's interface**

Run: `grep -n "preHalves" assets/scripts/dispatch-pre-tool.mjs && grep -n "export" assets/scripts/harness-dispatch.mjs && grep -n "dispatch-pre-tool" scripts/lib/propose.mjs`
Expected: `preHalves` declared as an empty array and spread first into the halves; `readPayload`, `runHalves`, `combine`, `emit` exported; a path constant for the entry script in `HOOK_SCRIPTS`. Note the constant's real name. If any is missing, stop: part A is not finished.

- [ ] **Step 1: Write the failing tests**

Test file header as `scripts/lib/tool-gate.test.mjs` has it: `tempDir`, `after` cleanup, `writeAt(path, text)`, `sandboxMarkerDir()`, `process.env.KH_DATA_DIR = tempDir(…)`. Helpers this file defines and Task 2 reuses:

```js
const project = () => { const root = tempDir('hk-ext-repo-'); mkdirSync(join(root, '.git')); return root; };
const writeExtensions = (root, value) => writeAt(join(root, EXTENSIONS_PATH), typeof value === 'string' ? value : JSON.stringify(value));
/** Writes `.claude/ext/<id>.mjs` holding `source` and returns its entry. */
function extension(root, id, source, o = {}) {
  const module = `.claude/ext/${id}.mjs`;
  writeAt(join(root, module), source);
  return { id, version: '1.0.0', module, sha256: moduleSha256(Buffer.from(source)), onFailure: 'block', ...o };
}
const ALLOW = "export const preToolUse = () => ({ decision: 'allow' });\n";
```

`readExtensions`:

```js
test('no extensions file means no extensions', () => {
  assert.deepEqual(readExtensions(project()), { state: 'absent' });
});
test('a well-formed file yields its entries in order', () => {
  const root = project();
  const a = extension(root, 'a', ALLOW), b = extension(root, 'b', ALLOW, { onFailure: 'allow' });
  writeExtensions(root, [a, b]);
  assert.deepEqual(readExtensions(root), { state: 'ok', entries: [a, b] });
});
test('an empty list is well formed', () => { /* [] → { state: 'ok', entries: [] } */ });
```

One table test, `a file that cannot be used is malformed, with fixed text that quotes nothing from it`. Each row is a file body and the exact `problem`:

| File | `problem` |
|---|---|
| `'x'.repeat(65537)` | `it is larger than 65536 bytes` |
| a directory at the path | `it is not a regular file` |
| a symbolic link to a valid file (skip where links cannot be made) | `it is not a regular file` |
| `{ not json` | `it is not JSON` |
| `{"extensions":[]}` | `it is not a JSON array` |
| nine valid entries | `it lists more than 8 extensions` |
| `[a, a]` | `two entries share an id` |
| each bad entry below, alone | `entry 1 is not an extension entry as docs/CONTRACT.md describes one` |

Bad entries, each a valid entry with one change: `null` in its place; an extra key `timeout: 5`; `sha256` removed; `id: 'A'`; `id: 'a b'`; `id` of 65 characters; `version: ''`; `version: '1.0\n'`; `module: 'src/x.mjs'`; `module: '/abs/x.mjs'`; `module: '.claude/../x.mjs'`; `module: '.claude/./x.mjs'`; `module: '.claude//x.mjs'`; `module: '.claude\\x.mjs'`; `module: '.claude/x.js'`; `module` of 201 characters; `sha256: 'abc'`; `sha256` in upper case; `onFailure: 'warn'`. For the second bad entry of two, the text says `entry 2`. Every row also asserts `!problem.includes(<any string taken from the file>)` for the `id: 'a b'` row.

`moduleState`:

```js
test('a module whose bytes hash to the recorded value matches, and the real path is returned', () => {
  const root = project(); const e = extension(root, 'a', ALLOW);
  assert.deepEqual(moduleState(root, e), { state: 'matches', path: realpathSync.native(join(root, e.module)) });
});
test('REVIEW FOCUS 2: the same module with CRLF line endings still matches', () => {
  const root = project(); const e = extension(root, 'a', ALLOW);
  writeFileSync(join(root, e.module), ALLOW.replace(/\n/g, '\r\n'));
  assert.equal(moduleState(root, e).state, 'matches');
});
test('a changed module differs', () => { /* append '// x\n' → { state: 'differs' } */ });
test('a missing module is missing', () => { /* rmSync → { state: 'missing' } */ });
test('a module over the size bound, or a directory at its path, is unreadable', () => { /* 1 MiB + 1 byte; mkdir → { state: 'unreadable' } */ });
test('a module that is a link to a file outside the repository is outside', () => {
  // outside = tempDir(); write ALLOW there; symlinkSync(outsideFile, join(root, '.claude/ext/a.mjs')); sha256 of ALLOW
  // → { state: 'outside' }; skip where links cannot be made
});
test('a module under a .claude that is itself a link out of the repository is outside', () => { /* → 'outside' */ });
test('a link inside .claude to another file inside .claude is followed', () => { /* → 'matches' */ });
```

And in `scripts/lib/propose.test.mjs`, extend the `HOOK_MODULE_PATHS` assertion so its expected list ends with `HARNESS_EXTENSIONS_PATH`.

- [ ] **Step 2: Run them**

Run: `node --test scripts/lib/harness-extensions.test.mjs scripts/lib/propose.test.mjs`
Expected: FAIL, `Cannot find module …/harness-extensions.mjs`; the propose test fails on the missing constant.

- [ ] **Step 3: Implement `readExtensions`, `moduleState` and `moduleSha256` in `assets/scripts/harness-extensions.mjs`**

Static imports: Node built-ins and `import { readBounded } from './harness-log.mjs';`. Name no other `./*.mjs` in this task, in code or comment.

`readExtensions`: `lstatSync` the path (absent → `absent`; not a regular file → malformed); `readBounded(path, EXTENSION_LIMITS.fileMaxBytes)` (over the bound → malformed); `JSON.parse`; the checks of decisions 2 and 3 in the table's order; each entry returned as a fresh object of exactly the five keys. Any throw not named above → `{ state: 'malformed', problem: 'it could not be read' }`.

`moduleState`, in this order, because the order decides which state a doubly wrong module reports:

1. `real = realpathSync.native(join(root, entry.module))`; `ENOENT` is `missing`, any other throw `unreadable`.
2. `base = realpathSync.native(join(realRoot, '.claude')) + sep`, with `realRoot = realpathSync.native(root)`. `outside` unless `base` starts with `realRoot + sep` and `real` starts with `base`: `.claude` must itself resolve inside the repository, and the module inside `.claude`.
3. `readBounded(real, EXTENSION_LIMITS.moduleMaxBytes)`; any throw is `unreadable`.
4. `moduleSha256(bytes) === entry.sha256` is `{ state: 'matches', path: real }`, otherwise `differs`.

`moduleSha256`: CRLF to LF on the bytes through `latin1`, as `lfNormalised` in `harness-log.mjs:262` does, then SHA-256 hex.

- [ ] **Step 4: Add the module to the kit's tables in `scripts/lib/propose.mjs`**

`const HARNESS_EXTENSIONS_PATH = '.claude/scripts/harness-extensions.mjs';` beside the other path constants; as the last entry of `HOOK_MODULES`:

```js
[HARNESS_EXTENSIONS_PATH]: { asset: 'scripts/harness-extensions.mjs', step: TOOL_GATE_STEP, reason: 'the loader for the PreToolUse extensions another plugin registers' },
```

and `HARNESS_EXTENSIONS_PATH` in the export list. `uninstall` needs no edit: `GENERATOR_PRODUCIBLE_EXACT` spreads `HOOK_MODULE_PATHS`.

- [ ] **Step 5: Run the task's tests, then `npm test`**

Run: `node --test scripts/lib/harness-extensions.test.mjs scripts/lib/propose.test.mjs && npm test`
Expected: PASS. `every script the kit ships under assets/scripts/ is one it installs` passes because of Step 4.

- [ ] **Step 6: Commit**

```bash
git add assets/scripts/harness-extensions.mjs scripts/lib/harness-extensions.test.mjs scripts/lib/propose.mjs scripts/lib/propose.test.mjs
git commit -m "feat(hooks): the extensions file and each module it lists are read within bounds and judged by path and hash"
```

---

### Task 2: `dispatch-pre-tool.mjs` runs each extension before the gate

**Files:**
- Modify: `assets/scripts/harness-extensions.mjs`
- Modify: `assets/scripts/dispatch-pre-tool.mjs` (the `preHalves` declaration)
- Modify: `scripts/lib/propose.mjs` (`kitSkew` near `:883-904`, the `P0.kitskew` generator near `:938`)
- Modify: `scripts/lib/gap-model.mjs` (`P0.kitskew` evidence near `:1044-1051`)
- Modify: `scripts/lib/cli.mjs` (`EXECUTION_DISCLOSURE`, the `PreToolUse` entry and the "run nothing of this repository's" sentence), and its copies in `README.md` and `docs/guide/commands.md`
- Test: `scripts/lib/harness-extensions.test.mjs`, `scripts/lib/propose.test.mjs`, `scripts/lib/cli.test.mjs`, `scripts/lib/lifecycle-upgrade.test.mjs`

**Interfaces:**
- Consumes: Task 1's `readExtensions`, `moduleState`; part A's `preHalves` and half result; from `./harness-redact.mjs`: `escapeDelimiters`, `markerPath`, `maskText`, `projectRoot`, `safeSessionId`, `stripUnsafe`.
- Produces: `export async function extensionsHalf(payload): Promise<HalfResult | null>` from `assets/scripts/harness-extensions.mjs`. It never throws. `kitSkew(...)` gains `added: Proposal[]`.

Fixed texts, used verbatim by code and tests. `<id>` is the entry's id.

| Case | Text |
|---|---|
| an extension blocks | `kh-harness extension <id>: <cleaned message>` |
| a failure, `onFailure: 'block'` | `kh-harness extension <id>: <reason>, so this call is blocked (onFailure: block). Reinstall the plugin that registered it, or remove its entry from .claude/kh-harness/extensions.json outside this session.` |
| a failure, `onFailure: 'allow'` | `kh-harness extension <id>: <reason>, so it checks no call (onFailure: allow).` |
| a malformed file | `kh-harness: .claude/kh-harness/extensions.json cannot be used (<problem>), so every tool call is blocked. Repair or remove the file outside this session.` |
| the loader cannot be loaded | `kh-harness: .claude/scripts/harness-extensions.mjs is missing or cannot be loaded while .claude/kh-harness/extensions.json exists, so every tool call is blocked. Run kh-harness apply --yes, or remove the extensions file, outside this session.` |

`<reason>` is one of eight fixed texts, each given once in the failure table of Step 1.

- [ ] **Step 1: Write the failing tests** in `scripts/lib/harness-extensions.test.mjs`

```js
const ENTRY = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'dispatch-pre-tool.mjs');
const call = (session, o = {}) => ({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1', ...o });
/** The entry script's stdout, parsed, or null; asserts exit 0 and empty stderr. */
function runEntry(root, stdin, { script = ENTRY } = {}) { /* as tool-gate.test.mjs's runHook */ }
const denial = text => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } });
const block = message => `export const preToolUse = () => ({ decision: 'block', message: ${JSON.stringify(message)} });\n`;
const FAIL_BLOCK = (id, reason) => `kh-harness extension ${id}: ${reason}, so this call is blocked (onFailure: block). Reinstall the plugin that registered it, or remove its entry from .claude/kh-harness/extensions.json outside this session.`;
const FAIL_ALLOW = (id, reason) => `kh-harness extension ${id}: ${reason}, so it checks no call (onFailure: allow).`;
```

Behaviour:

```js
test('with no extensions file the entry says nothing', () => {
  assert.equal(runEntry(project(), call('none-1')), null);
});
test('an extension that allows says nothing', () => { /* [extension(root,'a',ALLOW)] → null */ });
test('an extension that blocks denies the call with its id and message', () => {
  // [extension(root, 'guard', block('Use the commit command.'))]
  assert.deepEqual(runEntry(root, call('block-1')), denial('kh-harness extension guard: Use the commit command.'));
});
test('every extension runs, and each block is one line in file order', () => {
  // [a blocks 'A.', b allows, c blocks 'C.'] → denial('kh-harness extension a: A.\nkh-harness extension c: C.')
});
test('the extension is given the payload Claude Code sent', () => {
  // source blocks with message `${p.hook_event_name} ${p.tool_name} ${p.tool_input.command}` → '… PreToolUse Bash npm test'
});
test('an event other than PreToolUse, or a payload with no tool name, runs no extension', () => {
  // a blocking extension; call('x', { hook_event_name: 'PostToolUse' }) and a payload without tool_name: no deny in the output
});
```

Failures, one table test per `onFailure` value: `each failure with onFailure block denies the call with fixed text` and `each failure with onFailure allow lets the call run and says so once per session`. Rows (the extension's source, or what is done to it after `extension()` computed its hash) and the `<reason>` expected:

| Row | `<reason>` |
|---|---|
| the module file is deleted | `its module file is missing` |
| `'\n// changed\n'` appended to the module | `its module file does not match the sha256 recorded for it` |
| the module is a link to a file outside the repository | `its module is not a file under .claude/ in this repository` |
| the module path is a directory | `its module file could not be read` |
| source `throw new Error('secret-from-import');` | `its module could not be loaded` |
| source `export const other = 1;` | `its module exports no preToolUse function` |
| source `export const preToolUse = () => { throw new Error('secret-from-call'); };` | `its preToolUse threw` |
| `() => { process.exit(0); }` | `its preToolUse threw` |
| `() => undefined` | `its preToolUse returned neither an allow nor a block with a usable message` ("the result reason" below) |
| `() => 'allow'` | the result reason |
| `() => ({ decision: 'deny' })` | the result reason |
| `() => ({ decision: 'allow', extra: 1 })` | the result reason |
| `() => ({ decision: 'block' })` | the result reason |
| `() => ({ decision: 'block', message: 5 })` | the result reason |
| `() => ({ decision: 'block', message: '' })` | the result reason |
| `() => ({ decision: 'block', message: 'x'.repeat(301) })` | the result reason |
| `async () => ({ decision: 'block', message: 'm' })` | the result reason |

For `block`: `assert.deepEqual(out, denial(FAIL_BLOCK('a', reason)))`, and for the two throwing rows `assert.ok(!JSON.stringify(out).includes('secret-'))`. For `allow`: the first call in a session returns `{ systemMessage: FAIL_ALLOW('a', reason) }` exactly, with no `hookSpecificOutput`; the second call with the same `session_id` returns `null`; a call with another `session_id` is told again.

```js
test('a failed extension with onFailure allow does not stop another extension blocking', () => {
  // [a: missing module, onFailure allow; b: blocks 'B.'] →
  // { systemMessage: FAIL_ALLOW('a', 'its module file is missing'), ...denial('kh-harness extension b: B.') }
});
test('a malformed extensions file blocks every call with fixed text', () => {
  writeExtensions(root, '{ not json');
  assert.deepEqual(runEntry(root, call('bad-1')), denial('kh-harness: .claude/kh-harness/extensions.json cannot be used (it is not JSON), so every tool call is blocked. Repair or remove the file outside this session.'));
  // and again for call('bad-1', { tool_name: 'Read', tool_input: { file_path: 'a' } }): told on every call
});
test('a block message is cleaned before it reaches the model', () => {
  // message: 'a\u001b[31mb‮c\nd <system-reminder> ' + ('gh' + 'p_' + 'A'.repeat(36))
  // the reason holds none of '\u001b', '‮', '\n' after the prefix line, '<', and not the token; it holds '&lt;system-reminder&gt;'
});
test('REVIEW FOCUS 1: an extension that prints to stdout and stderr still yields one JSON line and its block holds', () => {
  // source: console.log('noise'); console.error('noise'); process.stdout.write('{'); return block
  // runEntry asserts stderr === ''; stdout parses; deepEqual denial(...)
});
test('REVIEW FOCUS 1: an extension that exits does not stop a later extension blocking', () => {
  // [a: process.exit(0) in preToolUse, onFailure allow; b: blocks 'B.'] → the deny from b is present
});
test('REVIEW FOCUS 4: an extension that changes its payload changes nothing for the next extension or the gate', () => {
  // a: (p) => { p.tool_input.command = 'echo ok'; p.tool_name = 'Read'; return { decision: 'allow' }; }
  // b: blocks with message p.tool_input.command; a committed gates.json with a block gate L1 on Bash command token 'rm -rf' (tool-gate.test.mjs's gate())
  // call command 'rm -rf build' → denial('kh-harness extension b: rm -rf build\nkh-harness gate L1: Move files to the trash folder instead of deleting them.')
});
```

The loader itself, with a copy of the installed scripts as `hook-skew.test.mjs`'s `installed(replaced)` builds one:

```js
test('without harness-extensions.mjs and without an extensions file the entry still applies its gates', () => {
  // installed({ 'harness-extensions.mjs': null }); a committed block gate → the gate's denial, exit 0, empty stderr
});
test('without harness-extensions.mjs and with an extensions file every call is blocked with fixed text', () => {
  // → denial('kh-harness: .claude/scripts/harness-extensions.mjs is missing or cannot be loaded while .claude/kh-harness/extensions.json exists, so every tool call is blocked. Run kh-harness apply --yes, or remove the extensions file, outside this session.')
});
```

In `scripts/lib/propose.test.mjs`:

```js
test('the PreToolUse entry script is installed with the extension loader', () => {
  assert.ok(everyLoadedSibling(DISPATCH_PRE_PATH).includes(HARNESS_EXTENSIONS_PATH));
});
test('REVIEW FOCUS 3: an update to a recorded script proposes a sibling it loads that is neither recorded nor on disk', () => {
  // a temp root whose manifest records DISPATCH_PRE_PATH (stamped, old bytes) and every sibling it loads
  // except HARNESS_EXTENSIONS_PATH, each written as the kit writes it at an older kitVersion
  const skew = kitSkew({ kitVersion, harness, root, stack, checks: [], files: [], manifest });
  assert.deepEqual(skew.added.map(p => p.path), [HARNESS_EXTENSIONS_PATH]);
  assert.equal(skew.added[0].reason, `${HARNESS_EXTENSIONS_PATH} is loaded by an installed script this kit updates`);
});
test('a sibling that is on disk and not recorded holds the unit instead of being added', () => { /* skew.added is [], skew.heldBack names the recorded scripts */ });
```

In `scripts/lib/lifecycle-upgrade.test.mjs`, with `kitAt(<the commit HEAD names before this task's first commit>)` (record the hash in a constant with a comment naming it "part A's last commit"; skip when the checkout does not hold it, as the file's other tests do):

```js
test('REVIEW FOCUS 3: an install made before the extension loader existed gets it with the entry script that loads it', { skip }, () => {
  // apply --yes with the older kit; then current apply --yes
  assert.ok(existsSync(join(d, HARNESS_EXTENSIONS_PATH)));
  assert.ok(manifestOf(d).files.some(f => f.path === HARNESS_EXTENSIONS_PATH));
  for (const r of runEveryRegisteredHook(d)) assert.equal(r.status, 0, `${r.script}: ${r.stderr}`);
  assert.match(run(APPLY, d), /no actions for/);
});
```

In `scripts/lib/cli.test.mjs`:

```js
test('the execution disclosure says the PreToolUse hook loads the modules an extensions file lists', () => {
  const entry = /PreToolUse \(per tool call\) (.*?) (?=Session log \(per event\))/.exec(disclosed)?.[1] ?? '';
  assert.match(entry, /\.claude\/kh-harness\/extensions\.json/);
  assert.match(entry, /loads and runs each module that file lists/);
  assert.match(entry, /kh-harness never writes that file/);
  assert.doesNotMatch(disclosed, /The other \w+ run nothing of this repository's\. Each reads what is said\s+below and executes no command\./);
});
```

- [ ] **Step 2: Run them**

Run: `node --test scripts/lib/harness-extensions.test.mjs scripts/lib/propose.test.mjs scripts/lib/cli.test.mjs scripts/lib/lifecycle-upgrade.test.mjs`
Expected: FAIL. The behaviour tests fail with `null` where a deny is expected, since `preHalves` is empty.

- [ ] **Step 3: Implement `extensionsHalf` in `assets/scripts/harness-extensions.mjs`**

Add `import { escapeDelimiters, markerPath, maskText, projectRoot, safeSessionId, stripUnsafe } from './harness-redact.mjs';`. The flow, which the tests do not fully order:

```js
export async function extensionsHalf(payload) {
  if (!isToolCall(payload)) return null;               // object, hook_event_name 'PreToolUse', string tool_name
  const root = projectRoot();
  const file = readExtensions(root);
  if (file.state === 'absent') return null;
  if (file.state === 'malformed') return half({ blocks: [malformedText(file.problem)], notices: [] });
  const blocks = [];
  const notices = [];
  for (const entry of file.entries) {
    const outcome = await runExtension(root, entry, payload);   // never throws
    if (outcome.kind === 'block') blocks.push(`kh-harness extension ${entry.id}: ${outcome.message}`);
    else if (outcome.kind === 'failed' && entry.onFailure === 'block') blocks.push(failBlock(entry.id, outcome.reason));
    else if (outcome.kind === 'failed') notices.push(failAllow(entry.id, outcome.reason));
  }
  const sessionId = safeSessionId(payload.session_id);
  return half({ blocks, notices: notices.filter(s => firstTelling(root, sessionId, s)) });
}
```

- `half({ blocks, notices })` returns `null` when both are empty, else `{ json, stderr: '', exitCode: 0 }` where `json` has `systemMessage: notices.join(' ')` when there is a notice and the deny object with `blocks.join('\n')` when there is a block.
- `runExtension(root, entry, payload)` returns `{ kind: 'allow' }`, `{ kind: 'block', message }` or `{ kind: 'failed', reason }`: `moduleState`; then, inside `quietly`, `await import(pathToFileURL(state.path).href)` and `preToolUse(structuredClone(payload))`; then the result check of decisions 7 and 8. Reading the result's keys happens inside the same try as the call, so a throwing getter is `its preToolUse threw`.
- `quietly(fn)` (decision 9) replaces `process.stdout.write` and `process.stderr.write` with functions that return `true`, and `process.exit` with one that throws, runs `await fn()`, and restores all three in `finally`.
- `firstTelling(root, sessionId, sentence)` is the marker pattern of `tool-gate.mjs:202-212` with the namespace `extensions-notice-<tag>`.
- Message cleaning (decision 7): `maskText(escapeDelimiters(stripUnsafe(message).replace(LINE_BREAK_ALL, ' ')), { floors: 'sweep' })` with `LINE_BREAK_ALL = /[\r\n\p{Zl}\p{Zp}]+/gu`; an empty result after `trim()` is a malformed result.

- [ ] **Step 4: Fill `preHalves` in `assets/scripts/dispatch-pre-tool.mjs`**

```js
const EXTENSIONS_FILE = '.claude/kh-harness/extensions.json';
const LOADER_MISSING = 'kh-harness: .claude/scripts/harness-extensions.mjs is missing or cannot be loaded while .claude/kh-harness/extensions.json exists, so every tool call is blocked. Run kh-harness apply --yes, or remove the extensions file, outside this session.';

/** The extensions half. The loader is imported here, not at the top, so a
 * loader that cannot be loaded leaves the gate and the log running; with an
 * extensions file present nothing can vouch for the call, so it is refused. */
async function extensions(payload) {
  let loader;
  try {
    loader = await import('./harness-extensions.mjs');
  } catch {
    if (!existsSync(join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), EXTENSIONS_FILE))) return null;
    return { json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOADER_MISSING } }, stderr: '', exitCode: 0 };
  }
  return loader.extensionsHalf(payload);
}

const preHalves = [{ name: 'extensions', run: extensions }];
```

The root is read from the environment here, not from `projectRoot()`, because the module that exports it may be the one that failed to load. The quoted `'./harness-extensions.mjs'` is what makes `loadedSiblings` install the loader with the entry script.

- [ ] **Step 5: Make `kitSkew` add a newly loaded sibling** in `scripts/lib/propose.mjs`

`skew` gains `added: []`. After the loop over `manifest.files`: for each proposal in `skew.updates` whose path is in `INSTALLED_SCRIPTS`, for each path of `everyLoadedSibling(thatPath)` that is not recorded in `manifest.files`, not on disk (`!existsSync(join(root, path))`), not in `held` and not already added, push `{ ...installedScriptProposal(path, kitVersion), reason: `${path} is loaded by an installed script this kit updates` }`. The generator becomes `[KITSKEW_ID]: ctx => { const skew = kitSkew(ctx); return [...skew.updates, ...skew.added]; }`. In `gap-model.mjs`, `P0.kitskew`'s evidence gains `...skew.added.map(p => `missing: ${displayPath(p.path)} (an updated script loads it)`)` after the `out of date` lines; the state and the proposal's count stay decided by `skew.updates` alone, since nothing is added without an update.

- [ ] **Step 6: Change the disclosure** in `scripts/lib/cli.mjs`

In the `PreToolUse (per tool call)` entry, replace "It executes nothing, and no gate exists until one is learned and promoted, so until then it does nothing." with: "No gate exists until one is learned and promoted. It also reads .claude/kh-harness/extensions.json when another plugin has written one, and loads and runs each module that file lists from under .claude/, checked against the hash the file records; such a module can BLOCK a call. kh-harness never writes that file, and without it the hook executes nothing." Keep the entry's column layout. Change "The other <N> run nothing of this repository's. Each reads what is said below and executes no command." to "The other <N> run no script of this repository's. Each reads what is said below, and only the PreToolUse hook can load code: the modules an extensions file lists." with part A's `<N>`. Copy both changes into `README.md` and `docs/guide/commands.md`, where the block is reproduced (`grep -n "WHAT THE HOOKS EXECUTE" README.md docs/guide/commands.md`). Update any existing `cli.test.mjs` assertion that quotes the replaced sentences.

- [ ] **Step 7: Run the task's tests, then `npm test`**

Run: `node --test scripts/lib/harness-extensions.test.mjs scripts/lib/propose.test.mjs scripts/lib/cli.test.mjs scripts/lib/lifecycle-upgrade.test.mjs scripts/lib/hook-skew.test.mjs && npm test`
Expected: PASS, including part A's latency budget test for `dispatch-pre-tool.mjs`: with no extensions file the half costs one dynamic import and one `lstat`.

- [ ] **Step 8: Commit**

```bash
git add assets/scripts/harness-extensions.mjs assets/scripts/dispatch-pre-tool.mjs scripts/lib/propose.mjs scripts/lib/gap-model.mjs scripts/lib/cli.mjs README.md docs/guide/commands.md scripts/lib/harness-extensions.test.mjs scripts/lib/propose.test.mjs scripts/lib/cli.test.mjs scripts/lib/lifecycle-upgrade.test.mjs
git commit -m "feat(hooks): the PreToolUse entry script runs each registered extension before the gate, and applies its onFailure when it cannot"
```

---

### Task 3: `detect` lists each extension with its version, hash state and `onFailure`

**Files:**
- Create: `scripts/lib/extensions-evidence.mjs`
- Modify: `scripts/lib/detect-harness.mjs` (after `harness.failures = …`, near `:447`)
- Modify: `scripts/lib/gap-model.mjs` (a check after `P5.integrity`)
- Test: `scripts/lib/extensions-evidence.test.mjs` (create), `scripts/lib/gap-model.test.mjs`, `scripts/lib/detect-cli.test.mjs`

**Interfaces:**
- Consumes: `readExtensions`, `moduleState`, `EXTENSIONS_PATH` (Task 1); `registeredHook`; `DISPATCH_PRE_PATH`.
- Produces: `extensionsEvidence(root): { state: 'absent' } | { state: 'malformed', problem: string } | { state: 'ok', extensions: Array<{ id, version, module, onFailure, hash: 'matches' | 'differs' | 'missing' | 'outside' | 'unreadable' }> }`; `harness.extensions` holding it; check `P5.extensions`.

- [ ] **Step 1: Write the failing tests**

`scripts/lib/extensions-evidence.test.mjs`:

```js
test('no file is absent, a bad file is malformed with the loader\'s own problem text', () => { /* 'it is not JSON' */ });
test('each extension is listed with its hash state, and its recorded sha256 is not', () => {
  // a matches, b changed after hashing, c deleted
  assert.deepEqual(extensionsEvidence(root), { state: 'ok', extensions: [
    { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', onFailure: 'block', hash: 'matches' },
    { id: 'b', version: '1.0.0', module: '.claude/ext/b.mjs', onFailure: 'allow', hash: 'differs' },
    { id: 'c', version: '1.0.0', module: '.claude/ext/c.mjs', onFailure: 'block', hash: 'missing' },
  ] });
});
test('listing an extension does not load it', () => {
  // module source writes a marker file at import; after extensionsEvidence(root) the marker does not exist
});
```

`scripts/lib/gap-model.test.mjs`, with `check = harness => buildGaps({ …, harness }).find(c => c.id === 'P5.extensions')` and `registered` a harness whose `claudeDir.hookRegistrations.PreToolUse` holds `{ script: DISPATCH_PRE_PATH }`:

```js
test('P5.extensions is n/a when the harness object carries no extensions reading, and when there is no file', () => {
  assert.deepEqual([check(bareHarness).state, check(bareHarness).evidence], ['n/a', ['the extensions file was not read']]);
  assert.deepEqual(check({ ...registered, extensions: { state: 'absent' } }).evidence, ['no .claude/kh-harness/extensions.json: no plugin has registered an extension']);
});
test('P5.extensions is declared when every listed module matches, one line per extension', () => {
  // extensions: [a matches block, b matches allow]
  assert.deepEqual(c.evidence, [
    '.claude/kh-harness/extensions.json lists 2 extensions, run by .claude/scripts/dispatch-pre-tool.mjs before every tool call',
    'a 1.0.0: .claude/ext/a.mjs matches its recorded sha256; onFailure block',
    'b 1.0.0: .claude/ext/b.mjs matches its recorded sha256; onFailure allow',
  ]);
});
test('P5.extensions is failing when a module does not match, and says what the hook then does', () => {
  // differs + block → 'a 1.0.0: .claude/ext/a.mjs does not match its recorded sha256; onFailure block, so every tool call is blocked'
  // missing + allow → 'b 1.0.0: .claude/ext/b.mjs is missing; onFailure allow, so it checks no call'
});
test('P5.extensions is failing for a malformed file', () => {
  // ['.claude/kh-harness/extensions.json cannot be used (it is not JSON), so every tool call is blocked']
});
test('P5.extensions is failing when extensions are listed and the entry script is not registered on PreToolUse', () => {
  // first line: '.claude/kh-harness/extensions.json lists 1 extension, and none runs: .claude/scripts/dispatch-pre-tool.mjs is not registered on PreToolUse'
});
test('P5.extensions never proposes and is never verified', () => { /* proposal === null in every case above */ });
```

Hash-state wording: `matches its recorded sha256`, `does not match its recorded sha256`, `is missing`, `is not a file under .claude/ in this repository`, `could not be read`.

`scripts/lib/detect-cli.test.mjs`: `detect --json on a repository with an extensions file reports P5.extensions and writes the same lines to detect.json` (a real temp repository with one matching extension; assert the check's state and that `docs/harness/detect.json` holds `harness.extensions.extensions[0].id === 'a'` and no `sha256` key).

- [ ] **Step 2: Run them**

Run: `node --test scripts/lib/extensions-evidence.test.mjs scripts/lib/gap-model.test.mjs scripts/lib/detect-cli.test.mjs`
Expected: FAIL, module not found and `P5.extensions` undefined.

- [ ] **Step 3: Implement**

- `extensionsEvidence(root)` in `scripts/lib/extensions-evidence.mjs`: `readExtensions`, then `moduleState(root, entry).state` per entry as `hash`.
- `harness.extensions = extensionsEvidence(root);` in `detectHarness`.
- The check, placed directly after `P5.integrity`: `{ id: 'P5.extensions', step: 32, phase: 5, lookedFor: [EXTENSIONS_PATH, 'each listed module against the sha256 recorded for it', `a PreToolUse hook running ${DISPATCH_PRE_PATH}`], check: ({ harness, manifest, root }) => … }`. Registration is `registeredHook(harness, 'PreToolUse', DISPATCH_PRE_PATH, null, { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS }).state === 'declared'`. States as the tests give them; `failing` wins over `declared`.

- [ ] **Step 4: Run the task's tests, then `npm test`**

Expected: PASS. If a test that lists every check id in order fails, add `P5.extensions` after `P5.integrity` there.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/extensions-evidence.mjs scripts/lib/extensions-evidence.test.mjs scripts/lib/detect-harness.mjs scripts/lib/gap-model.mjs scripts/lib/gap-model.test.mjs scripts/lib/detect-cli.test.mjs
git commit -m "feat(detect): each registered extension is listed with its version, whether its module matches its hash, and its onFailure"
```

---

### Task 4: The contract number is an installed file

**Files:**
- Create: `scripts/lib/contract.mjs`
- Modify: `scripts/lib/propose.mjs` (`GENERATORS`), `scripts/lib/gap-model.mjs` (a check after `P5.integrity`, before `P5.extensions`), `scripts/lib/detect-harness.mjs`, `scripts/lib/uninstall-lib.mjs` (`GENERATOR_PRODUCIBLE_EXACT`, `:148-165`)
- Test: `scripts/lib/contract.test.mjs` (create), `scripts/lib/gap-model.test.mjs`, `scripts/lib/propose.test.mjs`, `scripts/lib/lifecycle.test.mjs`

**Interfaces:**
- Produces, from `scripts/lib/contract.mjs`:
  - `CONTRACT = 1`
  - `CONTRACT_PATH = '.claude/kh-harness/contract.json'`
  - `contractFileText(kitVersion: string): string`, which is `JSON.stringify({ contract: CONTRACT, generatedBy: `${STAMP_MARKER} ${kitVersion} (the contract number another plugin reads). Do not edit: kh-harness stops updating an edited copy and keeps it on uninstall.` }, null, 2) + '\n'`. The version is followed by a space so `stampVersion` reads it, which `gates.json`'s `generatedBy` does not allow
  - `contractEvidence(root): { state: 'absent' } | { state: 'unreadable' } | { state: 'ok', contract: number }`
- Produces: `harness.contract`; check `P5.contract`; generator `GENERATORS['P5.contract']`.

- [ ] **Step 1: Write the failing tests**

`scripts/lib/contract.test.mjs`:

```js
test('the contract file holds the contract number and the kit stamp', () => {
  const file = JSON.parse(contractFileText('0.2.0'));
  assert.deepEqual(Object.keys(file), ['contract', 'generatedBy']);
  assert.equal(file.contract, 1);
  assert.ok(file.generatedBy.startsWith('Generated by kh-harness 0.2.0 ('));
  assert.equal(stampVersion(contractFileText('0.2.0')), '0.2.0');
});
test('contractEvidence reads the number, and calls anything else unreadable', () => {
  // none → absent; contractFileText → { state: 'ok', contract: 1 }; '{ "contract": 2 }' → ok 2
  // '{ not json', '[]', '{}', '{"contract":"1"}', '{"contract":1.5}', '{"contract":0}', a 2 MiB file, a directory → unreadable
});
```

`scripts/lib/gap-model.test.mjs`:

```js
test('P5.contract: n/a unread, absent with a proposal, declared with the number, failing when unreadable', () => {
  // no key            → n/a, ['the contract file was not read']
  // { state:'absent' }→ absent, proposal 'write .claude/kh-harness/contract.json, which tells another plugin which kh-harness contract this install honours', via 'apply'
  // ok 1              → declared, ['.claude/kh-harness/contract.json: contract 1']
  // ok 2              → declared, ['.claude/kh-harness/contract.json: contract 2 (this kit honours contract 1)']
  // unreadable        → failing, ['.claude/kh-harness/contract.json exists and holds no contract number'], proposal null
});
```

`scripts/lib/propose.test.mjs`: `the gate hook's deny rules cover the contract file and the extensions file` (`toolGateDenyRules()` includes `'Edit(/.claude/kh-harness/**)'`, and both `CONTRACT_PATH` and `EXTENSIONS_PATH` start with `.claude/kh-harness/`; it passes already and pins what `docs/CONTRACT.md` will say), and `the contract generator writes one stamped file at step 30` (`GENERATORS['P5.contract']({ kitVersion: '0.2.0' })` deep-equals `[{ kind: 'file', path: CONTRACT_PATH, step: 30, contents: contractFileText('0.2.0'), reason: 'no contract file found' }]`).

`scripts/lib/lifecycle.test.mjs`, on `fixture()`:

```js
test('apply installs the contract file, a second apply proposes nothing, and uninstall removes it and its directory', () => {
  run(APPLY, d, '--yes');
  assert.equal(JSON.parse(readFileSync(join(d, '.claude/kh-harness/contract.json'), 'utf8')).contract, 1);
  assert.match(run(APPLY, d), /no actions for/);
  run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, '.claude/kh-harness')), false);
});
test('an install without the contract file is proposed exactly that file', () => {
  // apply --yes; delete the file AND its entry from manifest.files (an install made before the contract)
  const out = run(APPLY, d);
  assert.match(out, /1 action to close 1 capability gap/);
  assert.match(out, /--- \.claude\/kh-harness\/contract\.json {2}\[P5\.contract\]/);
});
test('a contract file the owner deleted is not written again', () => {
  // apply --yes; delete the file only → run(APPLY, d) matches /no actions for/
});
test('a contract file written by an older kit version is updated by apply', () => {
  // apply --yes; rewrite the file as contractFileText('0.1.0') and set its manifest sha256 to match
  // → the dry run names '[P0.kitskew]' and the file; after --yes the file equals contractFileText(KIT_VERSION)
});
test('uninstall leaves .claude/kh-harness in place while another plugin\'s extensions file is in it', () => {
  // apply --yes; write extensions.json '[]'; uninstall --yes exits 0; contract.json is gone, extensions.json and the directory remain
});
```

- [ ] **Step 2: Run them**

Run: `node --test scripts/lib/contract.test.mjs scripts/lib/gap-model.test.mjs scripts/lib/propose.test.mjs scripts/lib/lifecycle.test.mjs`
Expected: FAIL, `Cannot find module …/contract.mjs`.

- [ ] **Step 3: Implement**

- `scripts/lib/contract.mjs` as the Interfaces block gives it. `contractEvidence` reads with `readSmallFile` (from `assets/scripts/harness-log.mjs`); `ok` needs a plain object whose `contract` is an integer of 1 or more.
- `harness.contract = contractEvidence(root);` in `detectHarness`.
- `GENERATORS['P5.contract'] = ({ kitVersion }) => [{ kind: 'file', path: CONTRACT_PATH, step: TOOL_GATE_STEP, contents: contractFileText(kitVersion), reason: 'no contract file found' }]`. Nothing else is needed for updates: `currentKitFiles` calls every generator, so `kitSkew` already knows the path.
- The check `{ id: 'P5.contract', step: 30, phase: 5, lookedFor: [CONTRACT_PATH], check: ({ harness }) => … }` directly after `P5.integrity`.
- `CONTRACT_PATH` added to `GENERATOR_PRODUCIBLE_EXACT` with the comment `// The contract number another plugin reads; stamped through its generatedBy key.`

- [ ] **Step 4: Run the task's tests, then `npm test`, and repair counts that moved**

A fresh `apply` now has one more action and one more gap. Tests that hard-code either number fail here; raise each by one. Tests that list the files a full `apply` writes gain `.claude/kh-harness/contract.json`, and those that list `dirsCreated` gain `.claude/kh-harness`. Do not weaken an assertion to a pattern.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/contract.mjs scripts/lib/contract.test.mjs scripts/lib/propose.mjs scripts/lib/gap-model.mjs scripts/lib/detect-harness.mjs scripts/lib/uninstall-lib.mjs scripts/lib/gap-model.test.mjs scripts/lib/propose.test.mjs scripts/lib/lifecycle.test.mjs
git commit -m "feat(apply): the contract number is an installed file that apply writes and updates and uninstall removes"
```

---

### Task 5: The registry accepts `enforced-by: officer` and ignores an `approval` key

**Files:**
- Modify: `assets/scripts/harness-redact.mjs:571` (`ENFORCERS`)
- Modify: `scripts/lib/rules-evidence.mjs` (`pointerResolves` `:58-72`, its call in `fileEvidence` `:96`)
- Modify: `assets/templates/RULES.md.tmpl` (lines 12, 24, 25 and the optional keys)
- Test: `scripts/lib/rules-registry.test.mjs`, `scripts/lib/rules-evidence.test.mjs`, `scripts/lib/propose.test.mjs` (`:1364-1366`), `scripts/lib/rules-brief.test.mjs`

**Interfaces:**
- Produces: `ENFORCERS` is `['deny', 'hook', 'lint', 'test', 'critic', 'ci', 'review', 'officer', 'none']`. `parseRules` is otherwise unchanged; the rule object gains no field.

- [ ] **Step 1: Write the failing tests**

`scripts/lib/rules-registry.test.mjs`:

```js
test('enforced-by: officer is an enforcer, not a problem', () => {
  const { rules, problems } = parseRules('## V8 — Screens use the design tokens\n- enforced-by: officer\n- pointer: tools/officers/v8.mjs\n');
  assert.deepEqual([rules[0].enforcedBy, rules[0].pointer, problems], ['officer', 'tools/officers/v8.mjs', []]);
});
test('an approval key is accepted and ignored, whatever its value', () => {
  for (const value of ['owner', 'agent', 'someone else']) {
    const { rules, problems } = parseRules(`## R1 — A rule\n- approval: ${value}\n- enforced-by: none\n`);
    assert.deepEqual(problems, []);
    assert.equal(Object.hasOwn(rules[0], 'approval'), false);
    assert.equal(rules[0].enforcedBy, 'none');
  }
});
test('the problem for an unknown enforcer names officer among the choices', () => {
  assert.deepEqual(parseRules('## R1 — A rule\n- enforced-by: robot\n').problems,
    ['R1: enforced-by "robot" is not one of deny/hook/lint/test/critic/ci/review/officer/none — recorded as none']);
});
```

`scripts/lib/rules-evidence.test.mjs` (a temp repository with `docs/harness/RULES.md`):

```js
test('an officer rule whose pointer exists is counted under officer and reported as held', () => {
  // tools/officers/v8.mjs exists → byEnforcer.officer === 1, missingPointers === []
});
test('an officer rule whose pointer does not exist is a missing pointer', () => {
  // → missingPointers deepEqual [{ id: 'V8', pointer: 'tools/officers/v8.mjs' }]
});
test('an officer rule with no pointer, or a settings: pointer, is a missing pointer', () => {
  // no pointer line → [{ id: 'V8', pointer: null }]
  // 'settings:hooks.PreToolUse' with a PreToolUse hook registered that would satisfy a hook rule → [{ id: 'V8', pointer: 'settings:hooks.PreToolUse' }]
});
```

`scripts/lib/gap-model.test.mjs`: `P3.rules prints an officer rule's dead pointer` (evidence includes `V8: pointer tools/officers/v8.mjs does not exist`). `scripts/lib/propose.test.mjs:1366`: replace the literal list with `for (const e of ENFORCERS)`, and add `assert.match(p.contents, /approval: owner \| agent/)`. `scripts/lib/rules-brief.test.mjs`: `an officer rule is re-told with its enforcer` (output holds `[enforced-by: officer]`).

- [ ] **Step 2: Run them**

Run: `node --test scripts/lib/rules-registry.test.mjs scripts/lib/rules-evidence.test.mjs scripts/lib/gap-model.test.mjs scripts/lib/propose.test.mjs scripts/lib/rules-brief.test.mjs`
Expected: FAIL with `'none'` where `'officer'` is expected and the problem line `enforced-by "officer" is not one of …`. The `approval` test passes already; it pins behaviour the contract now promises.

- [ ] **Step 3: Implement**

- Insert `'officer'` before `'none'` in `ENFORCERS`, and add one sentence to its comment: `officer` means a check another tool runs, whose `pointer` is that check's repository path. This is the only edit to `harness-redact.mjs` in the plan.
- `pointerResolves(root, harness, pointer, { pathOnly = false } = {})`: when `pathOnly`, a pointer matching `SETTINGS_POINTER` returns `false`. `fileEvidence` passes `{ pathOnly: r.enforcedBy === 'officer' }`. Extend the function's comment with the officer case.
- `RULES.md.tmpl`: line 12 becomes `(deny/hook/lint/test/critic/ci/review/officer)`; the `enforced-by:` format line gains `| officer` before `| none`; after the `pointer:` line add `(for officer: the repository path of the check)` in the same comment style; among the optional keys add `- approval: owner | agent          (optional; read by other plugins, ignored by kh-harness)`.

- [ ] **Step 4: Run the task's tests, then `npm test`**

Expected: PASS, `hook-skew.test.mjs` included: the 0.1.0 fixture of `harness-redact.mjs` is unaffected.

- [ ] **Step 5: Commit**

```bash
git add assets/scripts/harness-redact.mjs assets/templates/RULES.md.tmpl scripts/lib/rules-evidence.mjs scripts/lib/rules-registry.test.mjs scripts/lib/rules-evidence.test.mjs scripts/lib/gap-model.test.mjs scripts/lib/propose.test.mjs scripts/lib/rules-brief.test.mjs
git commit -m "feat(rules): the registry takes enforced-by officer with a repository path as its pointer, and ignores an approval key"
```

---

### Task 6: `recordExternalEvent` appends one bounded, redacted event to a session's log

**Files:**
- Modify: `assets/scripts/harness-log.mjs` (after `appendEvent`, `:586`)
- Modify: `assets/scripts/harness-seal.mjs` (`KEPT_FIELDS` `:71-91`, `CONTENT_FIELDS` `:99-105`)
- Test: `scripts/lib/harness-log.test.mjs`, `scripts/lib/harness-seal.test.mjs`, `scripts/lib/session-log.test.mjs` (`:523`), `scripts/lib/log-cli.test.mjs`

**Interfaces:**
- Consumes: `appendEvent`, `isEnabled`, `safeSessionId` (already in `harness-log.mjs`).
- Produces, from `assets/scripts/harness-log.mjs`:
  - `EXTERNAL_DATA_MAX_BYTES = 16384`
  - `recordExternalEvent(root: string, sessionId: unknown, event: { source: string, type: string, data: object }): { recorded: true } | { recorded: false, reason: string }`, never throws.
  - The line written: `{ schema, ts, pid, type: 'plugin_event', session_id, source, kind, data }`, `kind` being the caller's `type`.
- Produces, from `harness-seal.mjs`: `KEPT_FIELDS.plugin_event = [...IDENTITY, 'source', 'kind']`, `CONTENT_FIELDS.plugin_event = ['data']`.

`reason` values, fixed: `no safe session id`; `the session log is not enabled for this repository`; `source must be lower-case letters, digits and hyphens, starting with a letter, at most 64 characters`; `type must be letters, digits, dot, underscore and hyphen, starting with a letter, at most 64 characters`; `data must be a JSON object`; `data is larger than 16384 bytes`; `the event could not be written`.

- [ ] **Step 1: Write the failing tests**

`scripts/lib/harness-log.test.mjs` (each test: `const root = gitRepo(); setEnabled(root, true);` unless it says otherwise):

```js
const EVENT = { source: 'kh-orchestration', type: 'officers.run', data: { passed: 3, failed: ['V8'] } };

test('recordExternalEvent appends one plugin_event line to that session', () => {
  assert.deepEqual(recordExternalEvent(root, 's1', EVENT), { recorded: true });
  const [e] = readEvents(root, 's1').events;
  const { ts, pid, ...rest } = e;
  assert.deepEqual(rest, { schema: LOG_SCHEMA, type: 'plugin_event', session_id: 's1', source: 'kh-orchestration', kind: 'officers.run', data: { passed: 3, failed: ['V8'] } });
});
test('with the log not enabled nothing is written, not even the directory', () => {
  const root = gitRepo();
  assert.deepEqual(recordExternalEvent(root, 's1', EVENT), { recorded: false, reason: 'the session log is not enabled for this repository' });
  assert.equal(existsSync(join(repoDataDir(root), 'sessions')), false);
});
test('without a safe session id nothing is written', () => {
  for (const id of [undefined, null, '', '../x', 'a/b', 'x'.repeat(201), 5]) {
    assert.deepEqual(recordExternalEvent(root, id, EVENT), { recorded: false, reason: 'no safe session id' });
  }
  assert.equal(existsSync(join(repoDataDir(root), 'sessions')), false);
});
test('a source, type or data of the wrong shape is refused with fixed text and nothing is written', () => {
  // source: 'Bad', '', 'a b', 5, 65 chars → the source reason
  // type: '', '1x', 'a b', 'a\nb', 65 chars → the type reason
  // data: undefined, null, 'text', [1], a BigInt-holding object → 'data must be a JSON object'
  // event itself null or a string → 'data must be a JSON object'
});
test('data over the bound is refused, and data at the bound is recorded', () => {
  // { text: 'x'.repeat(n) } with JSON length 16384 → recorded; 16385 → 'data is larger than 16384 bytes'; no blob directory exists afterwards
});
test('a credential in data is masked, and a value under a credential-named key is hidden whole', () => {
  const token = 'gh' + 'p_' + 'A'.repeat(36);
  recordExternalEvent(root, 's2', { ...EVENT, data: { note: `pushed with ${token}`, password: 'hunter2' } });
  const [e] = readEvents(root, 's2').events;
  assert.ok(!JSON.stringify(e).includes(token));
  assert.equal(e.data.password, SCRUB_MARK);
});
test('data cannot set the envelope or the event type', () => {
  // data: { type: 'PreToolUse', schema: 9 } stays nested under data; the line's type is 'plugin_event'
});
test('when the session file is a link nothing is written and nothing is thrown', () => {
  // → { recorded: false, reason: 'the event could not be written' }
});
```

`scripts/lib/session-log.test.mjs:523`: the expected `KEPT_FIELDS` keys gain `'plugin_event'`.

`scripts/lib/harness-seal.test.mjs`:

```js
test('REVIEW FOCUS 5: a session holding a plugin event is sealed and verified, and retention removes its data alone', () => {
  const root = tempDir('hk-log-plugin-');
  setEnabled(root, true);
  appendEvent(root, 'p', { type: 'Stop', stopHookActive: false });
  assert.equal(recordExternalEvent(root, 'p', { source: 'kh-orchestration', type: 'officers.run', data: { failed: ['V8'] } }).recorded, true);
  seal(root);
  assert.deepEqual(verifyIndex(root), INTACT);
  assert.equal(indexLines(root)[0].external, false, 'a plugin event is not outside content');
  assert.equal(applyRetention(root, { now: Date.now() + 91 * DAY_MS }).contentRemoved, 1);
  const [, plugin] = eventsOf(root, 'p');
  assert.deepEqual([plugin.type, plugin.source, plugin.kind, plugin.contentExpired, Object.hasOwn(plugin, 'data')], ['plugin_event', 'kh-orchestration', 'officers.run', true, false]);
});
```

`scripts/lib/log-cli.test.mjs`: `REVIEW FOCUS 5: log report and log status run over a session that holds a plugin event` (enable, `appendEvent` one `Stop` event and record one plugin event in the same session; `runLog(root, 'report', '--json')` and `runLog(root, 'status')` exit 0, and the report's JSON parses).

- [ ] **Step 2: Run them**

Run: `node --test scripts/lib/harness-log.test.mjs scripts/lib/harness-seal.test.mjs scripts/lib/session-log.test.mjs scripts/lib/log-cli.test.mjs`
Expected: FAIL, `recordExternalEvent is not a function` (an import error for the whole file).

- [ ] **Step 3: Implement**

`recordExternalEvent` in `harness-log.mjs`, checks in this order: session id, `isEnabled(root)`, event shape and `source`, `type`, `data` plain object, `JSON.stringify(data)` in a try (a throw is `data must be a JSON object`), byte length against `EXTERNAL_DATA_MAX_BYTES`, then `appendEvent(root, id, { type: 'plugin_event', session_id: id, source, kind: type, data })`; `written: false` becomes `the event could not be written`. The whole body sits in one try whose catch returns that same reason. Its doc comment states that this is the function `docs/CONTRACT.md` promises and that its signature and the line's field names change only with the contract number.

Add the two table rows in `harness-seal.mjs` and extend the `KEPT_FIELDS` comment with one clause: a plugin event keeps who wrote it and what kind it is.

- [ ] **Step 4: Run the task's tests, then `npm test`**

Expected: PASS. Both files are installed assets, so `P0.kitskew` will propose them on every install; that is expected and goes in the changelog in Task 7.

- [ ] **Step 5: Commit**

```bash
git add assets/scripts/harness-log.mjs assets/scripts/harness-seal.mjs scripts/lib/harness-log.test.mjs scripts/lib/harness-seal.test.mjs scripts/lib/session-log.test.mjs scripts/lib/log-cli.test.mjs
git commit -m "feat(log): another plugin can append one bounded, scrubbed event to a session's log through recordExternalEvent"
```

---

### Task 7: `docs/CONTRACT.md`, a fixture for each promise, and the guide

**Files:**
- Create: `docs/CONTRACT.md`
- Create: `scripts/lib/fixtures/contract-1/RULES.md`, `scripts/lib/fixtures/contract-1/manifest.json`, `scripts/lib/fixtures/contract-1/extensions.json`, `scripts/lib/fixtures/contract-1/extension.mjs`, `scripts/lib/fixtures/contract-1/contract.json`, `scripts/lib/fixtures/contract-1/plugin-event.json`
- Modify: `scripts/lib/contract.test.mjs`
- Modify: `docs/guide/how-it-works.md` (`## What runs when`, `## Where everything lives` `:259-298`, the checks table `:382`), `docs/guide/session-log.md` (`## What it stores`), `docs/guide/troubleshooting.md` (a section under `## detect` and one beside `### A notice from the gate hook`), `docs/guide/commands.md` (the `detect` and dry-run examples near `:113-118` and `:197`), `skills/harness-init/references/phase-5-learning.md` (steps 30 and 32), `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything Tasks 1 to 6 produce.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the fixtures and the failing fixture tests**

Each fixture is the format as another plugin would write or read it. The test fails if kh-harness stops accepting or producing it.

| Fixture | Holds |
|---|---|
| `RULES.md` | three rules: `R1` with every documented key (`why`, `enforced-by: test`, `pointer`, `verify`, `priority: high`, `status`, `last-verified`) and `approval: owner`; `V8` with `enforced-by: officer`, `pointer: tools/officers/v8.mjs`, `approval: agent`; `R3` with `enforced-by: none` and an em-dash heading |
| `manifest.json` | `{ schema: 1, kitVersion, installedAt, files: [{ path, sha256, step, writtenAt }], settingsPatches: [{ event, container, entrySha256, step, checkId, appliedAt }], dirsCreated: [...], settingsCreated: true }` |
| `extension.mjs` | `export function preToolUse(payload) { return payload.tool_name === 'Bash' ? { decision: 'block', message: 'Fixture block.' } : { decision: 'allow' }; }` |
| `extensions.json` | `[{ "id": "fixture", "version": "1.0.0", "module": ".claude/fixture/extension.mjs", "sha256": "<the hash of extension.mjs>", "onFailure": "block" }]` |
| `contract.json` | `contractFileText('0.2.0')` as written, so a change of shape is a diff to this file |
| `plugin-event.json` | `{ "schema": 1, "type": "plugin_event", "session_id": "fixture", "source": "kh-orchestration", "kind": "officers.run", "data": { "failed": ["V8"] } }` |

Tests added to `scripts/lib/contract.test.mjs`, each named `contract 1: …`:

```js
test('contract 1: the rules registry fixture parses to these rules', () => {
  const { rules, problems } = parseRules(read('RULES.md'));
  assert.deepEqual(problems, []);
  assert.deepEqual(rules.map(({ line, ...r }) => r), [ /* the three rule objects, every field written out */ ]);
});
test('contract 1: an officer rule\'s pointer is checked as a repository path', () => {
  // the fixture copied into a temp repository without tools/officers/v8.mjs → rulesRegistryEvidence(...).missingPointers deepEqual [{ id: 'V8', pointer: 'tools/officers/v8.mjs' }]
});
test('contract 1: the manifest is at .claude/kh-harness.manifest.json and the fixture reads as schema 1', () => {
  assert.equal(MANIFEST_PATH, '.claude/kh-harness.manifest.json');
  // fixture copied to that path in a temp repository → readManifestResult(root).state === 'ok', manifest.schema === 1
});
test('contract 1: a manifest apply writes has only the documented keys', () => {
  // apply --yes on lifecycle-fixtures' fixture(); top-level keys ⊆ ['schema','kitVersion','installedAt','files','settingsPatches','dirsCreated','settingsCreated','learnings'];
  // every files entry has exactly path, sha256, step, writtenAt; schema === 1
});
test('contract 1: the extensions fixture is read, its recorded hash is the hash of its module, and its block reaches Claude Code', () => {
  // fixture files copied to .claude/kh-harness/extensions.json and .claude/fixture/extension.mjs in a temp repository
  // readExtensions(root).state === 'ok'; moduleState(...).state === 'matches' (this pins the hash algorithm against a recorded value)
  // the entry script run with a Bash call → denial('kh-harness extension fixture: Fixture block.'); with a Read call → null
});
test('contract 1: the contract file fixture is what apply writes, and its number is 1', () => {
  assert.equal(read('contract.json'), contractFileText('0.2.0'));
  assert.equal(CONTRACT, 1);
  assert.equal(CONTRACT_PATH, '.claude/kh-harness/contract.json');
});
test('contract 1: recordExternalEvent writes the fixture\'s line', () => {
  // enabled temp repository; recordExternalEvent(root, 'fixture', { source: 'kh-orchestration', type: 'officers.run', data: { failed: ['V8'] } })
  // the one event minus ts and pid deepEquals JSON.parse(read('plugin-event.json'))
  // and from a copy of the installed scripts: (await import(pathToFileURL(join(dir, 'harness-log.mjs')).href)).recordExternalEvent is a function
});
test('contract 1: docs/CONTRACT.md states the number and names every promise', () => {
  const doc = readFileSync(new URL('../../docs/CONTRACT.md', import.meta.url), 'utf8');
  assert.match(doc, /^Contract number: 1$/m);
  for (const needle of ['docs/harness/RULES.md', 'approval', 'officer', '.claude/kh-harness.manifest.json', '.claude/kh-harness/extensions.json', 'preToolUse', 'onFailure', 'recordExternalEvent', '.claude/kh-harness/contract.json', 'plugin_event']) assert.ok(doc.includes(needle), needle);
});
```

- [ ] **Step 2: Run them**

Run: `node --test scripts/lib/contract.test.mjs`
Expected: the last test FAILS with `ENOENT … docs/CONTRACT.md`. The others pass; they are regression fixtures for behaviour Tasks 1 to 6 built, and each must be seen to fail once by breaking what it pins (for example, rename `kind` in a scratch edit, run, and revert).

- [ ] **Step 3: Write `docs/CONTRACT.md`**

Plain reference prose, no history. Sections, in order, each holding these facts and nothing kh-harness does not test:

1. **Header.** The line `Contract number: 1`, alone. What the number means; that a promised format changes only with a new number; that `scripts/lib/contract.test.mjs` and `scripts/lib/fixtures/contract-1/` hold one fixture per promise.
2. **Reading the contract of an install.** `.claude/kh-harness/contract.json`; a JSON object whose `contract` is an integer; other keys may be present; no file means an install older than the contract; `apply` writes and updates it, `uninstall` removes it. Read-only to others.
3. **The rules registry.** `docs/harness/RULES.md`; one level-2 heading per rule (`## <id> — <rule>`, the id one token); `key: value` bullets; the keys kh-harness reads and their values; unknown keys ignored; `approval: owner | agent` accepted and ignored; `enforced-by: officer` with a repository-path `pointer`, reported by `detect` when the path does not exist. HTML comments are not read.
4. **The manifest.** `.claude/kh-harness.manifest.json`, `schema: 1`, the top-level keys and the entry shapes of the fixture. Read-only to others: a plugin records its own files in its own manifest.
5. **The `PreToolUse` extension point.** Where the file is, that kh-harness never writes it, and that the kit's deny rule `Edit(/.claude/kh-harness/**)` stops an agent editing it, so an installer writes it from a process. The entry shape with decision 3's character sets, the limits of decision 2, the hash of decision 4, the module path rule of decision 5. `preToolUse(payload)`: synchronous, given a copy of the hook payload, returns exactly one of the two shapes; message limits and cleaning (decision 7); what is silenced during the call (decision 9); it may read small files and must not start a process, wait, write to standard output, or exit. No time limit; Claude Code's hook timeout ends a hang. `onFailure` and the table of failures. A malformed file blocks every call. Extensions run in file order, all of them, before the gate; only where `dispatch-pre-tool.mjs` is registered on `PreToolUse`, which the plugin must check. `detect` lists each extension and never loads one. Not a defence against an agent that edits both files. Not part of the session's recorded harness identity.
6. **Appending to the session log.** Import `recordExternalEvent` from `.claude/scripts/harness-log.mjs`; the signature; the line written; the `source` and `type` character sets; the 16,384-byte bound; the scrub; `{ recorded: false, reason }` and when; retention keeps `source` and `kind` and removes `data` after the content retention period; the log is off by default.
7. **What is not promised.** Everything else: other files under `.claude/scripts/`, hook output wording, `detect.json`'s shape, the data directory layout.

- [ ] **Step 4: Update the guide, the skill reference, the README and the changelog**

- `docs/guide/how-it-works.md`, `## What runs when`: one paragraph after the hook table saying extensions run first on `PreToolUse`, linking `../CONTRACT.md`. `## Where everything lives`: in the tree add `kh-harness/contract.json       the contract number other plugins read` and `kh-harness/extensions.json     written by another plugin, never by the kit`, and raise the module count in the `scripts/` line by one from what part A left; in the table add a row for each (`contract.json`: written by `apply`, removed by `uninstall`; `extensions.json`: written by another plugin's installer, read by the `PreToolUse` entry script and by `detect`, left by `uninstall`). The checks table at `:382`: add `P5.contract` and `P5.extensions` and "the contract file, registered extensions against their hashes".
- `docs/guide/session-log.md`, `## What it stores`: the `plugin_event` line, who writes it, and that its `data` is content.
- `docs/guide/troubleshooting.md`: `### Every tool call is blocked by the extensions file` (the malformed-file and missing-loader texts verbatim, and the fix outside the session); `### An extension says it checks no call` (the `onFailure: allow` text); `### P5.extensions is failing` under `## detect`.
- `docs/guide/commands.md`: in the `detect` example add the `P5.contract` (absent, with its proposal) and `P5.extensions` (`n/a`) rows after `P5.integrity` and raise "proposals" and "apply can write" by one each; in the dry-run example raise the action and gap counts by one each from what part A left.
- `skills/harness-init/references/phase-5-learning.md`: under step 30, one sentence that `apply` also writes `.claude/kh-harness/contract.json`; under step 32, one that `detect` lists registered extensions and writes nothing. Run `node --test scripts/lib/skill-phases.test.mjs scripts/lib/skill-links.test.mjs`.
- `README.md`: one line linking `docs/CONTRACT.md` where the guide pages are linked.
- `CHANGELOG.md`, `## Unreleased`, `### Added`: the extension point; `docs/CONTRACT.md` and the contract file; `enforced-by: officer` and the `approval` key; `recordExternalEvent`. `### Changed`: `harness-redact.mjs`, `harness-log.mjs` and `harness-seal.mjs` changed, so `apply` proposes an update of the installed scripts on every existing install; `P0.kitskew` now adds a module an updated script newly loads.

- [ ] **Step 5: Run the task's tests, then `npm test`**

Run: `node --test scripts/lib/contract.test.mjs && npm test`
Expected: PASS, the kit's own credential sweep included. If the sweep flags a fixture's hash, build that value at run time in the test instead of storing it, except `extensions.json`'s `sha256`, which must stay a recorded value; if that one is flagged, stop and report it.

- [ ] **Step 6: Commit**

```bash
git add docs/CONTRACT.md scripts/lib/fixtures/contract-1 scripts/lib/contract.test.mjs docs/guide skills/harness-init/references/phase-5-learning.md README.md CHANGELOG.md
git commit -m "docs(contract): CONTRACT.md states what another plugin may rely on, with a fixture test for each promise"
```

