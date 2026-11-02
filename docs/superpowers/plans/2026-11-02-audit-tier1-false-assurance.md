# Audit Tier 1 — False Assurance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four Tier 1 statements true — the credential sweep finds today's token shapes and every literal credential, the lint sensor keeps its diagnostics, the `apply` gates cannot be bypassed, and a CRLF checkout does not turn the kit's files into "user-modified" — plus the dry run no longer refuses.

**Architecture:** Five independent fixes in five existing modules, each with a reproducing test first. One new shared helper in the hook asset (`pathTokenExemptions`), one new function in `git-info.mjs` (`defaultBranches`), one new exported note in `detect-exposure.mjs` (`fixtureExposureNote`). No new files other than tests.

**Tech Stack:** Node 22+, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-02-audit-tier1-false-assurance-design.md`

## Global Constraints

- Zero runtime dependencies; Node `>=22`; `npm test` = `node --test "scripts/lib/**/*.test.mjs"`.
- No flag, ignore list, score or `--force` is added. A path role lowers severity, never visibility.
- Never print, log or write a credential VALUE; findings carry kind, location, severity and a line number only.
- Credential-shaped test fixtures are assembled at runtime, never committed as literals; the DOGFOOD test (`detect-exposure.test.mjs`) must stay green and is run after every detector change.
- Hook scripts import only `./harness-redact.mjs` and node builtins; installed hooks never write inside the repository.
- `apply`'s CLI contract is exit 0 / 2 / 3 only; a refusal names its waiver.
- Stale comments that a fix falsifies are rewritten in the same task (no dead text).
- Commit after each task on branch `fix/audit-findings`; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. An `.npmrc` whose `_authToken` line reads `${NPM_TOKEN}` must be a `reference`, never a literal finding — Task 1.
2. A live `sk-proj-` key under `tests/` must still make `P0.security` `failing` — Task 2.
3. Output of `eslint --config .eslintrc.cjs src` that mentions `.eslintrc.cjs` survives, while a `--token=…` fragment on the same run still drops — Task 3.
4. `apply --yes` when git cannot run must refuse (exit 3) naming both waivers and write nothing — Task 4.
5. A CRLF-converted kit file with one extra edited byte stays `ours-modified` — Task 5.

---

### Task 1: Credential sweep — shapes, every match, placeholders on values, line numbers

**Files:**
- Modify: `scripts/lib/detect-exposure.mjs` (TOKEN_PATTERNS, DB_CRED, classifyCredentialValue, scanFile)
- Modify: `assets/scripts/harness-redact.mjs:58` (restructure the `--api-key=` rule so no key sits against `=`)
- Modify: whichever test files the DOGFOOD run names (expected: `harness-redact.test.mjs`, `lint-touched.test.mjs`, `detect-exposure.test.mjs`, `eval-suite.test.mjs`, `detect-harness.test.mjs`)
- Test: `scripts/lib/detect-exposure.test.mjs`

**Interfaces:**
- Produces: findings gain `line: number` (1-based, first qualifying match). `classifyCredentialValue(value)` returns `'reference'` for `$VAR`, `${VAR}`, `%VAR%`, `${{ … }}`.

- [ ] **Step 1: Write the failing tests** (append to `detect-exposure.test.mjs`; every token assembled from parts):

```js
test('finds today\'s provider token shapes: OpenAI project, Anthropic, npm, fine-grained GitHub, Google', () => {
  const shapes = {
    'openai-project': ['sk-proj', 'A'.repeat(40)].join('-'),
    'anthropic': ['sk-ant-api03', 'B'.repeat(40)].join('-'),
    'npm': ['npm', 'C'.repeat(36)].join('_'),
    'github-fine-grained': ['github_pat', 'D'.repeat(30)].join('_'),
    'google': ['AIza', 'E'.repeat(35)].join(''),
  };
  for (const [name, token] of Object.entries(shapes)) {
    const d = repo();
    write(d, 'config.txt', `KEY=${token}\n`);
    assert.ok(run(d).some(e => e.kind === 'token-in-repo-file'), `${name} must be found`);
  }
});
test('a provider-token shape inside a longer word is not a token', () => {   // `desk-` + 25 chars → []
test('a Bearer placeholder is not a token finding', () => {                   // bearer('YOUR_TOKEN_HERE_PLEASE_X') → []
test('a literal credential after a placeholder in the same file is still reported as literal', () => {
  // credLine('your-password-here') + credLine('hunter2hunter2') → one credentials-in-doc, valueKind literal, line 2
test('a JSON-quoted credential key is found', () => {                        // a JSON object whose password key holds hunter2hunter2 → literal
test('an .npmrc _authToken reading an environment variable is a reference; a literal one is a token', () => {
  // the registry _authToken line set to ${NPM_TOKEN} → one credentials-in-doc, reference
  // the same line set to a real npm token → token-in-repo-file high
test('widened credential keys are found: api_key, client_secret, secret_key, access_token, auth_token', () => {
test('findings carry the line number of the first qualifying match', () => { // token on line 3 → line 3
test('classifyCredentialValue: environment interpolation is a reference', () => {
  for (const v of ['$DB_PASSWORD', '${DB_PASSWORD}', '%DB_PASSWORD%', '${{ secrets.DB_PASSWORD }}', '${DB_PASSWORD},'])
    assert.equal(classifyCredentialValue(v), 'reference', v);
});
```
Extend `NEVER returns the secret value` to also plant an `sk-proj` token and assert `serialised` contains neither it nor `sk-proj`.

- [ ] **Step 2: Run** `node --test scripts/lib/detect-exposure.test.mjs` — Expected: the new tests FAIL (shapes not found; placeholder-first hides the literal; JSON form not found; `${NPM_TOKEN}` classified literal; no `line`).

- [ ] **Step 3: Implement** in `detect-exposure.mjs`:
  - `TOKEN_PATTERNS` per spec D1 (global, `\b`-anchored, new shapes).
  - `const DB_CRED = /(?:password|passwd|pwd|api[_-]?key|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*(\S{8,})/gi;`
  - `const ENV_REFERENCE = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\}|\$\{\{[^}]*\}\}|%[A-Za-z_][A-Za-z0-9_]*%)[;,]?$/;` consulted in `classifyCredentialValue` before `REFERENCE_VALUE`.
  - `function lineOf(text, index)`; `function tokenFinding(text)` → `{ line } | null` iterating every pattern's `matchAll`, skipping `isPlaceholder(match.replace(/^Bearer\s+/i, ''))`; `function credentialFinding(text)` → `{ valueKind, line } | null` over `DB_CRED.matchAll`, placeholder tested on `m[1]`.
  - `scanFile` uses both; findings include `line`.
  - Rewrite the header comment on `DB_CRED`/placeholder to describe the new behaviour; delete the "first match" code path entirely.
- [ ] **Step 4: Run** `node --test scripts/lib/detect-exposure.test.mjs` — Expected: new tests PASS; `DOGFOOD` lists this repository's own files the widened keys now hit.
- [ ] **Step 5: Fix each DOGFOOD hit at the source**: restructure `CREDENTIAL_RULES[7]` only if the DOGFOOD run names it; assemble flag-and-value fixtures (`--auth-token`, `api_key`) with `join('=')`; reword any doc sentence. Re-run until DOGFOOD passes. Record every file touched in the ledger.
- [ ] **Step 6: Run the whole suite** `npm test` — Expected: all pass.
- [ ] **Step 7: Commit** `fix(security): find today's token shapes and every literal credential; line numbers, never values`

---

### Task 2: Path role — fixture credentials are listed low, never silently, and do not alone fail the check

**Files:**
- Modify: `scripts/lib/detect-exposure.mjs` (`pathRole`, `fixtureExposureNote`, severity in `scanFile`)
- Modify: `scripts/lib/gap-model.mjs` (`P0.security` check)
- Modify: `scripts/lib/report.mjs:102` (print `:line`)
- Modify: `README.md` (`P0.security` paragraph, lines ~99–114)
- Test: `detect-exposure.test.mjs`, `gap-model.test.mjs`, `report.test.mjs`

**Interfaces:**
- Produces: `export function pathRole(rel) → 'test' | null`; `export function fixtureExposureNote(count) → string`; a `credentials-in-doc` literal finding under a test path has `severity: 'low', pathRole: 'test'`.

- [ ] **Step 1: Failing tests**
```js
// detect-exposure.test.mjs
test('pathRole: test directories and test-named files are "test"; everything else is null', () => {
  for (const p of ['tests/db.json', 'src/__tests__/a.ts', 'spec/x.rb', 'fixtures/creds.yml', 'a/b/testdata/x', 'src/a.test.ts', 'src/a.spec.js', 'pkg/test_db.py', 'pkg/db_test.py', 'pkg/db_test.go'])
    assert.equal(pathRole(p), 'test', p);
  for (const p of ['src/db.ts', 'docs/testing.md', 'contest/x.ts', 'src/latest.ts', '.env'])
    assert.equal(pathRole(p), null, p);
});
test('a literal password under tests/ is reported at severity low with pathRole test — listed, never dropped', …)
test('a provider token under tests/ stays high — a live key is live wherever it sits', …)
test('fixtureExposureNote names the count, the severity and where to read them', …)
// gap-model.test.mjs
test('a repository whose only literal credential hits are in test paths is verified, and the fixture count is disclosed', …)
test('one literal credential outside a test path still fails the check even when fixture hits are present', …)
test('a token in a test path still fails the check', …)
// report.test.mjs
test('renderSummary prints the line number after the location when a finding carries one', …)  // 'credentials-in-doc at docs/real.md:7'
```
- [ ] **Step 2: Run the three files** — Expected: FAIL (`pathRole` not exported; state `failing`; no `:7`).
- [ ] **Step 3: Implement** per spec D2. `P0.security`: `const blocking = credentials.filter(e => e.severity !== 'low'); const fixtures = credentials.length - blocking.length;` failing iff `unreadable.length || blocking.length`; verified evidence = `[...(fixtures ? [fixtureExposureNote(fixtures)] : []), ...note]` or `[CLEAN_SWEEP_NOTE]` when both empty. Update the check's comment block (it currently says "Only the PROMINENT class may fail this check").
- [ ] **Step 4: Run the three files, then `npm test`** — Expected: PASS.
- [ ] **Step 5: README**: after "It never prints a value, only a location." add the line number and the test-path sentence: a `credentials-in-doc` literal in a test or fixture path is listed at severity `low` and does not by itself fail the check; a provider token is `high` wherever it sits; there is still no ignore list.
- [ ] **Step 6: Commit** `fix(security): fixture credentials are listed low, never silently; P0.security fails on what matters`

---

### Task 3: Redaction keeps path and config tokens

**Files:**
- Modify: `assets/scripts/harness-redact.mjs` (add `pathTokenExemptions` after `commandTokens`)
- Modify: `assets/scripts/lint-touched.mjs:507`, `assets/scripts/verify-touched.mjs:343`
- Test: `harness-redact.test.mjs`, `lint-touched.test.mjs`, `verify-touched.test.mjs`

**Interfaces:**
- Produces: `export function pathTokenExemptions(command, paths = []) → Set<string>`.

- [ ] **Step 1: Failing tests**
```js
// harness-redact.test.mjs
test('pathTokenExemptions: a directory prefix of a touched path is exempt', () =>
  assert.deepEqual([...pathTokenExemptions('eslint src/components --max-warnings 0', ['src/components/Button.tsx'])], ['src/components']));
test('pathTokenExemptions: a ./-prefixed directory and the path itself are exempt', …)   // './backend/app' for 'backend/app/x.py'
test('pathTokenExemptions: config-file-shaped tokens are exempt, attached to a flag or not', () =>
  deepEqual sorted(['.eslintrc.cjs', '--config=eslint.config.js', 'tsconfig.build.json']) from 'eslint -c .eslintrc.cjs --config=eslint.config.js . && tsc -p tsconfig.build.json');
test('pathTokenExemptions: a credential-shaped token is never exempt', () =>
  assert.equal(pathTokenExemptions('cli --token=abcdefghijkl src/components', ['src/components/a.ts']).has('--token=abcdefghijkl'), false));
// lint-touched.test.mjs (fixture: lint script `node -e "console.error('src/components/Button.tsx:1:1 error x'); process.exit(1)" -- src/components`)
test('a lint script that names the edited file\'s directory still reports its diagnostics', …)   // code 2, stderr matches /Button\.tsx:1:1/
// verify-touched.test.mjs (typecheck: `node -e "console.error('tsconfig.build.json: error TS5023'); process.exit(1)" -- tsconfig.build.json`)
test('a diagnostic naming a config file passed on the command line survives redaction', …)   // code 2, stderr matches /tsconfig\.build\.json/
```
- [ ] **Step 2: Run** — Expected: FAIL (`pathTokenExemptions` not exported; hooks exit 0 silently).
- [ ] **Step 3: Implement** `pathTokenExemptions` per spec D3 (`CONFIG_SHAPED = /(?:\.(?:json|ya?ml|toml|[cm]?[jt]s|cfg|ini|conf)|(?:^|[\/=])\.[\w-]+rc(?:\.\w+)?)$/i`; a prefix test over `paths` with `./` stripped from the token). Wire both hooks. Update `commandTokens`/`dropCommandFragments` header comments to mention the exemption source.
- [ ] **Step 4: Run the three files, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Commit** `fix(hooks): diagnostics naming a path or config file survive redaction`

---

### Task 4: Gates that cannot be bypassed; dry run never refused

**Files:**
- Modify: `scripts/lib/git-info.mjs` (rewrite `gitInfo`, add `defaultBranches`)
- Modify: `scripts/apply.mjs:23,43-52,120-147,285-289` (gates under `--yes` only; `hasTrackedChanges` → `{ dirty, error }`; dry-run notes)
- Modify: `scripts/detect.mjs:46` (stderr warning on `git.error`)
- Modify: `README.md` flag table (lines ~131–135) and the dry-run sentence
- Test: create `scripts/lib/git-info.test.mjs`, create `scripts/lib/apply-gates.test.mjs`

**Interfaces:**
- Produces: `gitInfo(root, { env } = {}) → { isRepo: boolean, branch: string|null, error: string|null }`; `defaultBranches(root) → string[]` (always contains `'main'`, `'master'`).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Failing tests** (`git-info.test.mjs`):
```js
test('gitInfo on a repository with no commits reports the unborn branch, not "not a repo"', …)        // git init -q; symbolic-ref → isRepo true, branch === current init.defaultBranch or 'master'
test('gitInfo on a detached HEAD reports branch null', …)
test('gitInfo outside any repository is isRepo false with no error', …)
test('gitInfo when git cannot run reports an error, never "not a repository"', …)                      // env: { PATH: '' } → error matches /git/
test('defaultBranches always includes main and master, plus init.defaultBranch and origin/HEAD', …)    // config init.defaultBranch=trunk; symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop
```
(`apply-gates.test.mjs`, fixtures as in `lifecycle.test.mjs` but minimal: `package.json`, `git init`):
```js
test('apply --yes refuses on a repository with no commits whose unborn branch is a default branch', …)   // git init with -b main; exit 3; HANDOFF.md absent
test('apply --yes refuses on the branch init.defaultBranch names', …)                                     // -c init.defaultBranch=trunk; checkout -b trunk; exit 3 naming "trunk"
test('a dry run on the default branch is not refused and notes what --yes would do', …)                   // exit 0; stdout matches /note:.*--yes.*default branch/
test('a dry run on a dirty tree is not refused', …)
test('apply --yes refuses, naming both waivers, when git cannot run', …)                                  // env PATH='' ; exit 3; stderr matches /--allow-default-branch/ and /--allow-dirty/; nothing written
test('apply --yes with both waivers proceeds when git cannot run', …)
```
- [ ] **Step 2: Run both files** — Expected: FAIL (unborn → isRepo false; `trunk` ungated; dry run exit 3; missing git → writes).
- [ ] **Step 3: Implement** per spec D4. In `apply.mjs`: compute `gateRefusals(flags)` → `[{ message }]` once; under `--yes` print the first and `exit(3)`; without `--yes` print each as `note: ` after the diffs, before "Dry run — nothing written". Rewrite the gate comments (the Task 9b note about ordering stays true). `detect.mjs`: `if (git.error) process.stderr.write(...)`.
- [ ] **Step 4: Run both files, then `npm test`** — Expected: PASS (the existing lifecycle gate tests still pass since they use `--yes`).
- [ ] **Step 5: README**: `--allow-default-branch` row → "`main`, `master`, the branch `init.defaultBranch` names, or the one `origin/HEAD` points at"; add a sentence that a dry run is never refused but says what `--yes` would refuse; note that when git cannot be consulted `--yes` requires both waivers.
- [ ] **Step 6: Commit** `fix(apply): gates hold on an unborn branch, a configured default branch and a git error; dry run never refused`

---

### Task 5: CRLF-tolerant classification

**Files:**
- Modify: `scripts/lib/manifest.mjs` (`normalizeLineEndings`, `classify`)
- Modify: `assets/scripts/rules-brief.mjs:51-57` (comment), `README.md:140`, `docs/harness/RULES.md` R6
- Test: `manifest.test.mjs`, `uninstall-lib.test.mjs`, `lifecycle.test.mjs`

**Interfaces:**
- Produces: `export function normalizeLineEndings(buf) → Buffer`.

- [ ] **Step 1: Failing tests**
```js
// manifest.test.mjs
test('classify: a file we wrote that a CRLF checkout rewrote is still ours-unmodified', …)   // manifest hash of 'a\nb\n', disk 'a\r\nb\r\n'
test('classify: a CRLF file with a real edit is ours-modified', …)                           // disk 'a\r\nb EDITED\r\n'
test('classify: normalisation runs one way only — an LF file never matches a CRLF hash', …)   // manifest hash of 'a\r\nb', disk 'a\nb' → ours-modified
// uninstall-lib.test.mjs
test('a scaffold the checkout converted to CRLF is still removed', …)                        // installed(); rewrite HANDOFF.md with \r\n; planUninstall remove includes it; runUninstall removes it
// lifecycle.test.mjs
test('apply after a CRLF conversion of the kit\'s own files reports no "kept (modified)"', …) // apply --yes; convert every manifest file to CRLF; apply --yes again; stdout has no /kept .*modified/
```
- [ ] **Step 2: Run** — Expected: FAIL (`ours-modified`; kept; `kept (modified)` printed).
- [ ] **Step 3: Implement** `normalizeLineEndings(buf)` (`Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')`), `classify` retry guarded by `current.includes(0x0d)`. Rewrite the `classify` doc comment to state the tolerance and why one-way.
- [ ] **Step 4: Run the three files, then `npm test`** — Expected: PASS.
- [ ] **Step 5: Docs**: README line 140 "the bytes on disk still match what was written" → "the content on disk still matches what was written (line endings aside)"; RULES.md R6 "byte-identical" → "identical up to line endings"; `rules-brief.mjs` comment drops the autocrlf clause, keeps the hand-edit one.
- [ ] **Step 6: Commit** `fix(manifest): a CRLF checkout no longer makes the kit's own files look user-modified`

---

### Task 6: Record what changed

**Files:**
- Modify: `docs/2026-11-02-audit-findings.md` (status line under each of findings 1–5)
- Create: `docs/plan-6-execution-log.md` (the ledger, per repository convention)

- [ ] **Step 1:** Add `*Status (2026-11-02): fixed on fix/audit-findings — <short description>, test <name>.*` under findings 1, 2, 3, 4 and 5.
- [ ] **Step 2:** Run `npm test` once more; Expected: all pass. Copy the ledger to `docs/plan-6-execution-log.md`.
- [ ] **Step 3: Commit** `docs: Tier 1 audit fixes — status in the findings report, Plan 6 ledger`
