import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGaps, STATES } from './gap-model.mjs';
import { selectProfile } from './profiles/index.mjs';
import { deriveCouldNotDerive } from './report.mjs';
import { listFiles } from './scan.mjs';
import { detectHarness } from './detect-harness.mjs';
import { LINT_TOUCHED_PATH, VERIFY_TOUCHED_PATH, BRIEF_PATH } from './propose.mjs';

const bareStack = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
  packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: [] }], ci: [] };
const bareHarness = {
  instructions: { path: null, lines: 0 }, agentsMd: null, reconPresent: false,
  claudeDir: { settings: false, localSettings: false, denyRules: 0, hooks: [], hookEvents: {}, agents: [], skills: [], commands: [], rules: [] },
  otherEditors: [], architecture: null, handoff: null, bootstrap: null, gitattributes: false, remotes: [],
};
const richHarness = {
  instructions: { path: 'CLAUDE.md', lines: 153 }, agentsMd: null, reconPresent: true,
  claudeDir: { settings: true, localSettings: true, denyRules: 2, hooks: ['.claude/scripts/lint-touched.mjs', '.claude/scripts/verify-touched.mjs', '.claude/scripts/session-brief.mjs'],
    // hookEvents entries are RESOLVED SCRIPT PATHS, never command strings.
    hookEvents: { PostToolUse: ['.claude/scripts/lint-touched.mjs'], Stop: ['.claude/scripts/verify-touched.mjs'], SessionStart: ['.claude/scripts/session-brief.mjs'] },
    agents: Array.from({ length: 13 }, (_, i) => `.claude/agents/c${i}.md`), skills: [], commands: [], rules: ['.claude/rules/api.md'] },
  otherEditors: [], architecture: 'docs/ARCHITECTURE.md', handoff: 'HANDOFF.md',
  bootstrap: 'scripts/bootstrap.sh', gitattributes: true, remotes: [{ name: 'origin', hasCredential: false }],
};
const fullStack = { ...bareStack, packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['lint', 'test', 'typecheck'] }] };

function gaps(stack, harness, exposures = [], git = { branch: 'main', isRepo: true }, files = [], root) {
  return buildGaps({ stack, harness, exposures, profile: selectProfile(stack), git, files, root });
}
const byId = (cs, id) => cs.find(c => c.id === id);

test('every check uses a legal state', () => {
  for (const c of gaps(bareStack, bareHarness)) assert.ok(STATES.includes(c.state), `${c.id} -> ${c.state}`);
});

// Review Minor: `files` used to default to `[]`, so a caller that forgot
// it silently flipped P2.protected to `n/a` — a wrong capability state,
// not just a missing optional detail. Required now, same precedent as
// propose.mjs's `buildProposals`: omitting it throws loudly instead.
test('buildGaps throws when `files` is omitted, rather than silently defaulting', () => {
  assert.throws(
    () => buildGaps({ stack: bareStack, harness: bareHarness, exposures: [], profile: selectProfile(bareStack), git: { branch: 'main', isRepo: true } }),
    /files/i,
  );
});

test('LOAD-BEARING: a fully harnessed repo yields zero proposals', () => {
  const cs = gaps(fullStack, richHarness);
  const proposals = cs.filter(c => c.proposal !== null);
  assert.deepEqual(proposals.map(p => p.id), [], 'a satisfied repo must be proposed nothing');
});

// Task 5b (coordinator-inserted correction): this used to also assert
// P2.sensor, P2.stopgate AND P2.protected for `bareStack` — a TypeScript
// stack with one package, empty scripts, and no `files` evidence (the
// `gaps()` helper defaults `files` to `[]`). That expectation was the
// defect written down: none of the three checks consulted the same
// evidence their own generator in propose.mjs requires, so all three
// advertised a proposal `apply` then silently declined to deliver — for
// `bareStack` specifically, no lint script (P2.sensor), no typecheck/test
// script (P2.stopgate), and no protected-path evidence at all
// (P2.protected). With the shared derivation now in place, P2.sensor and
// P2.stopgate correctly ask instead of propose (see the dedicated tests
// below), and P2.protected correctly reports `n/a` (nothing here to
// protect). Restoring the three to this list would restore the defect.
test('a bare repo yields proposals for the mechanical steps', () => {
  const ids = gaps(bareStack, bareHarness).filter(c => c.proposal).map(c => c.id);
  for (const id of ['P1.bootstrap', 'P1.instructions', 'P4.handoff', 'P4.sessionbrief']) {
    assert.ok(ids.includes(id), `expected a proposal for ${id}`);
  }
  for (const id of ['P2.sensor', 'P2.stopgate', 'P2.protected']) {
    assert.ok(!ids.includes(id), `${id} must not advertise a proposal its generator cannot fulfil for this fixture`);
  }
});

// --- Task 5b: P2.sensor, P2.stopgate, P2.protected must agree with their
// generators, exactly as P1.bootstrap now does. Driven from the real
// `buildGaps` path against realistic fixtures, not a hand-built check
// object — a hand-built check is what let the P1.bootstrap defect survive
// its own test the first time around.

function pythonPipFixture() {
  // scripts: [] is not a contrivance — detect-stack.mjs has no Python
  // script-name convention to read, so every real Python package reports
  // this. requirements.txt makes P1.bootstrap's install step derivable
  // (unrelated to what this fixture is actually exercising).
  //
  // Coordinator correction (post-review): this comment used to claim
  // requirements.txt alone was itself protected-path evidence via
  // python.mjs's `protectedGlobs()`, and that this fixture was therefore
  // deliberately unsuitable for testing P2.protected's n/a branch. That
  // was the bug: `requirements*.txt` is normally a HAND-EDITED manifest
  // (Python's analogue of package.json, which this project deliberately
  // does not protect — a deny rule there blocks "add a dependency", a
  // legitimate and frequent action), so it must not be protected
  // unconditionally. It is only protected when a `requirements*.in` file
  // is also present — the pip-tools convention under which
  // requirements*.txt is COMPILED output, not hand-maintained — see
  // protected-evidence.mjs's own comment. This fixture has no `.in` file,
  // so P2.protected now correctly reaches `n/a` for it too; see the
  // dedicated test below.
  const stack = { languages: ['python'], packageManager: 'pip', isWorkspace: false,
    packages: [{ name: 'root', dir: '.', manifestPath: 'requirements.txt', scripts: [] }], ci: [] };
  return { stack, harness: bareHarness, exposures: [], profile: selectProfile(stack),
    git: { branch: 'main', isRepo: true }, files: ['requirements.txt', 'app.py'] };
}

// requirements.in makes requirements*.txt COMPILED output under pip-tools,
// unlike pythonPipFixture() above — see protected-evidence.mjs.
function pythonPipCompiledFixture() {
  const stack = { languages: ['python'], packageManager: 'pip', isWorkspace: false,
    packages: [{ name: 'root', dir: '.', manifestPath: 'requirements.txt', scripts: [] }], ci: [] };
  return { stack, harness: bareHarness, exposures: [], profile: selectProfile(stack),
    git: { branch: 'main', isRepo: true }, files: ['requirements.in', 'requirements.txt', 'app.py'] };
}

function bareRepoFixture() {
  // Nothing here at all: no language, no package, no manifest, no
  // protected-path candidate anywhere in `files`. This is the one case
  // where the capability's SUBJECT (something worth protecting) genuinely
  // does not exist — see gap-model.mjs's own comment on P2.protected for
  // why that is `n/a` with no question, unlike the other two.
  const stack = { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] };
  return { stack, harness: bareHarness, exposures: [], profile: selectProfile(stack),
    git: { branch: 'main', isRepo: true }, files: ['README.md'] };
}

function typescriptFullFixture() {
  const stack = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['lint', 'typecheck', 'test'] }], ci: [] };
  return { stack, harness: bareHarness, exposures: [], profile: selectProfile(stack),
    git: { branch: 'main', isRepo: true }, files: ['package.json', 'package-lock.json', 'dist/index.js'] };
}

test('P2.sensor asks rather than proposes when no lint script is declared', () => {
  const checks = buildGaps(pythonPipFixture());
  const c = byId(checks, 'P2.sensor');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false);
  assert.equal(c.proposal, null);
  assert.match(c.question, /lint/i);
});

test('P2.stopgate asks rather than proposes when the root declares no typecheck or test', () => {
  const checks = buildGaps(pythonPipFixture());
  const c = byId(checks, 'P2.stopgate');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false);
  assert.equal(c.proposal, null);
  assert.match(c.question, /verif|typecheck|test/i);
});

test('P2.protected is n/a with no question when the repository holds nothing to protect', () => {
  // Fixture sanity: this must actually be empty, or the test below proves
  // nothing — see this task's test-quality instruction (a fixture whose
  // data never survives to the branch under test).
  const f = bareRepoFixture();
  assert.equal(f.files.length, 1, 'fixture sanity: no protected-path candidate may sneak into this fixture');
  const checks = buildGaps(f);
  const c = byId(checks, 'P2.protected');
  assert.equal(c.state, 'n/a');
  assert.equal(c.proposal, null);
  assert.equal(c.question, null, 'do not ask about protected paths that do not exist');
});

// Review Minor: the n/a reason used to claim repository-WIDE absence
// ("found in this repository"), but `files` is the TRACKED (or
// fallback-walk-visible) list from scan.mjs — a gitignored lockfile
// sitting on disk is invisible to it, so the old wording told a confident
// user a false thing. Same error class, same fix, as Task 2's deny-rule
// evidence filter (which could not match gitignored build output): say
// what was actually checked, not what is true everywhere. Pinned as its
// own test so the wording cannot silently regress back to the overclaim.
test('P2.protected\'s n/a reason says "tracked", not a repository-wide claim it cannot back', () => {
  const c = byId(buildGaps(bareRepoFixture()), 'P2.protected');
  assert.equal(c.state, 'n/a');
  assert.match(c.evidence.join(' '), /tracked/i, 'the n/a reason must name what was actually checked (tracked files), not claim repository-wide absence');
});

test('all three still propose when their evidence IS present', () => {
  const checks = buildGaps(typescriptFullFixture());
  for (const id of ['P2.sensor', 'P2.stopgate', 'P2.protected']) {
    const c = byId(checks, id);
    assert.ok(c.proposal, `${id} must still propose when its evidence exists`);
    assert.equal(c.decidable, true);
  }
});

// --- Coordinator correction: requirements*.txt is a hand-edited manifest,
// not a lockfile, unless a requirements*.in source backs it (pip-tools) —
// see protected-evidence.mjs. Protecting it unconditionally was itself a
// defect this task's own test code (pythonPipFixture, above) surfaced
// against this task's own prose.

test('P2.protected is n/a for a pip repo with requirements.txt but no requirements.in', () => {
  const f = pythonPipFixture();
  // Fixture sanity, per this task's own test-quality instruction: assert
  // the fixture actually CONTAINS requirements.txt, so this test cannot
  // pass merely because the fixture was empty.
  assert.ok(f.files.includes('requirements.txt'), 'fixture sanity: requirements.txt must actually be present');
  assert.ok(!f.files.some(x => /requirements.*\.in$/.test(x)), 'fixture sanity: no .in file may sneak in here');
  const c = byId(buildGaps(f), 'P2.protected');
  assert.equal(c.state, 'n/a', 'a hand-edited requirements.txt is not a lockfile — nothing here to protect');
  assert.equal(c.proposal, null);
  assert.equal(c.question, null);
});

test('P2.protected proposes for a pip repo with requirements.in AND requirements.txt (pip-tools compiled output)', () => {
  const f = pythonPipCompiledFixture();
  assert.ok(f.files.includes('requirements.in') && f.files.includes('requirements.txt'), 'fixture sanity');
  const c = byId(buildGaps(f), 'P2.protected');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true);
  assert.ok(c.proposal);
});

test('only absent carries a proposal', () => {
  for (const c of [...gaps(bareStack, bareHarness), ...gaps(fullStack, richHarness)]) {
    if (c.state !== 'absent') assert.equal(c.proposal, null, `${c.id} (${c.state}) must not propose`);
  }
});

test('a repo on main is still proposed nothing — branching is not a gap', () => {
  const cs = gaps(fullStack, richHarness, [], { branch: 'main', isRepo: true });
  assert.deepEqual(cs.filter(c => c.proposal).map(c => c.id), []);
});

test('an existing instruction file is declared, not absent', () => {
  const c = byId(gaps(fullStack, richHarness), 'P1.instructions');
  assert.equal(c.state, 'declared');
  assert.ok(c.evidence.some(e => e.includes('CLAUDE.md')));
});

test('an oversized instruction file is still declared but noted', () => {
  const h = { ...richHarness, instructions: { path: 'CLAUDE.md', lines: 420 } };
  const c = byId(gaps(fullStack, h), 'P1.instructions');
  assert.equal(c.state, 'declared');
  assert.ok(c.evidence.some(e => /420/.test(e)));
});

test('scripts present are declared; missing scripts are absent', () => {
  assert.equal(byId(gaps(fullStack, richHarness), 'P2.scripts').state, 'declared');
  assert.equal(byId(gaps(bareStack, bareHarness), 'P2.scripts').state, 'absent');
});

// --- P2.scripts: reported only — package.json is outside the write
// allowlist, so this capability is never applied, only advised. Ruling
// (coordinator, Task 7): the check keeps reporting `absent`, but carries
// `decidable: false` (so buildProposals' central gate never turns this into
// a write) plus an `advice` field naming the exact line to add, per
// package, per missing script — but only where a config file PROVES the
// tool is in use; see the check's own comment in gap-model.mjs.

test('P2.scripts is absent and decidable:false, never a proposal, when scripts are missing', () => {
  const c = byId(gaps(bareStack, bareHarness), 'P2.scripts');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false);
  assert.equal(c.proposal, null);
});

test('a package with both lint and typecheck produces neither advice nor a proposal', () => {
  const c = byId(gaps(fullStack, richHarness), 'P2.scripts');
  assert.equal(c.state, 'declared');
  assert.deepEqual(c.advice, []);
});

test('a package missing only lint produces advice naming the package and the script, and no proposal', () => {
  const stack = { ...bareStack, packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['typecheck'] }] };
  const c = byId(gaps(stack, bareHarness), 'P2.scripts');
  assert.equal(c.proposal, null);
  assert.ok(c.advice.some(a => a.includes('app') && a.includes('lint')), 'advice must name both the package and the missing script');
  assert.equal(c.advice.some(a => /typecheck/.test(a)), false, 'typecheck is already declared on this package — no advice for it');
});

test('lint advice names the derived eslint command, and package.json, only when an ESLint config is present — never an invented tool', () => {
  const stack = { ...bareStack, packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['typecheck'] }] };
  const withConfig = byId(gaps(stack, bareHarness, [], undefined, ['.eslintrc.json']), 'P2.scripts');
  assert.ok(withConfig.advice.some(a => a.includes('"lint": "eslint .') && a.includes('package.json')), 'a JS/TS package still names package.json as the script home');

  const withoutConfig = byId(gaps(stack, bareHarness, [], undefined, []), 'P2.scripts');
  const lintLine = withoutConfig.advice.find(a => /lint/.test(a));
  assert.ok(lintLine);
  // No COMMAND is fabricated — the line may say which tools were checked
  // for (that is honest disclosure, not a guess), but it must never read as
  // though a `"lint": "eslint ."`/`"lint": "ruff check ."` line was derived.
  assert.equal(/"lint":\s*"(eslint|ruff)/i.test(lintLine), false, 'no command is invented without config evidence');
  assert.match(lintLine, /cannot be derived/);
});

test('typecheck advice names tsc --noEmit only when tsconfig.json is present, for a JS/TS package', () => {
  const stack = { ...bareStack, packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['lint'] }] };
  const withTsconfig = byId(gaps(stack, bareHarness, [], undefined, ['tsconfig.json']), 'P2.scripts');
  assert.ok(withTsconfig.advice.some(a => a.includes('tsc --noEmit')));

  const withoutTsconfig = byId(gaps(stack, bareHarness, [], undefined, []), 'P2.scripts');
  const tcLine = withoutTsconfig.advice.find(a => /typecheck/.test(a));
  assert.ok(tcLine);
  // No COMMAND is fabricated (mentioning "tsconfig.json" itself, to explain
  // what was checked for and not found, is fine — it is "tsc" as a DERIVED
  // COMMAND that must never appear without real evidence).
  assert.equal(/"typecheck":\s*"tsc/i.test(tcLine), false);
  assert.match(tcLine, /cannot be derived/);
});

// Coordinator finding 2: pyproject.toml has no standard script table
// (`[tool.poetry.scripts]` is console entry points, `[tool.pdm.scripts]` is
// PDM-specific, neither is "a lint script") — so a Python package's advice
// must name the derived COMMAND only, never a file to add it to.
test('lint advice names the derived ruff command, and no file, from a [tool.ruff] table in pyproject.toml, read from the real filesystem', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-ruff-'));
  writeFileSync(join(d, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n');
  const stack = { languages: ['python'], packageManager: null, isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] };
  const c = byId(gaps(stack, bareHarness, [], undefined, ['pyproject.toml'], d), 'P2.scripts');
  const lintLine = c.advice.find(a => /ruff check/.test(a));
  assert.ok(lintLine, 'ruff check . is derived');
  assert.equal(lintLine.includes('pyproject.toml'), false, 'no file is named as a script home — pyproject.toml has no standard script table');
});

// Symmetric with the mypy/pyright "cannot be derived" case below: with no
// ruff config either, a Python package's lint fallback must still name no
// file and invent no command — the fallback shape, not only the derived one.
test('lint advice, with no ruff config, names no command and no file, for a Python package', () => {
  const stack = { languages: ['python'], packageManager: null, isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] };
  const c = byId(gaps(stack, bareHarness, [], undefined, ['pyproject.toml']), 'P2.scripts');
  const lintLine = c.advice.find(a => /lint/.test(a));
  assert.ok(lintLine);
  assert.equal(/ruff check/.test(lintLine), false, 'no command is invented without ruff config evidence');
  assert.equal(lintLine.includes('pyproject.toml'), false, 'pyproject.toml must not be named as a script home, even in the fallback');
  assert.match(lintLine, /cannot be derived/);
});

// Coordinator finding 1: typecheck advice must consult the package's OWN
// ecosystem's evidence, not TypeScript's — a Python repo must never be told
// its typecheck command "cannot be derived" because no tsconfig.json exists.
test('typecheck advice derives mypy . from a [tool.mypy] table in pyproject.toml, for a Python package, naming no file', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-mypy-'));
  writeFileSync(join(d, 'pyproject.toml'), '[tool.mypy]\nstrict = true\n');
  const stack = { languages: ['python'], packageManager: null, isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] };
  const c = byId(gaps(stack, bareHarness, [], undefined, ['pyproject.toml'], d), 'P2.scripts');
  const tcLine = c.advice.find(a => /mypy/.test(a));
  assert.ok(tcLine, 'mypy . is derived from the [tool.mypy] table');
  assert.match(tcLine, /mypy \./);
  assert.equal(tcLine.includes('pyproject.toml'), false, 'no file is named as a script home for a Python package');
});

test('typecheck advice derives pyright from pyrightconfig.json, for a Python package', () => {
  const stack = { languages: ['python'], packageManager: null, isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] };
  const c = byId(gaps(stack, bareHarness, [], undefined, ['pyproject.toml', 'pyrightconfig.json']), 'P2.scripts');
  assert.ok(c.advice.some(a => /\bpyright\b/.test(a)));
});

// The confidently-wrong sentence this finding exists to eliminate: citing
// TypeScript's own absent artefact as the reason a Python project has no
// typecheck command. With neither mypy nor pyright evidence, the fallback
// message must name NO TypeScript artefact at all.
test('typecheck advice, with neither mypy nor pyright config, mentions no TypeScript artefact for a Python package', () => {
  const stack = { languages: ['python'], packageManager: null, isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] };
  const c = byId(gaps(stack, bareHarness, [], undefined, ['pyproject.toml']), 'P2.scripts');
  const tcLine = c.advice.find(a => /typecheck|cannot be derived/.test(a));
  assert.ok(tcLine);
  assert.equal(/tsconfig|\btsc\b/i.test(tcLine), false, 'a Python repo must never cite a missing TypeScript artefact as the reason');
  assert.match(tcLine, /cannot be derived/);
  // Coordinator finding (round 3, test quality): this used to be a single
  // compound assertion (`tcLine.includes('pyproject.toml') && /missing a/
  // .test(tcLine)`) that could pass — for the wrong reason — even if
  // pyproject.toml WERE named as a script home in different wording (e.g.
  // "pyproject.toml has a script table"): the `&& /missing a/` half would
  // be false, making the whole AND false, satisfying `assert.equal(...,
  // false)` without the line actually being clean. Split into the one
  // assertion that is actually load-bearing: no file name at all.
  assert.equal(tcLine.includes('pyproject.toml'), false, 'pyproject.toml must not be named as a script home, even in the fallback');
});

// SECRET (ruling 5): advice is derived from script NAMES and config-file
// PRESENCE only — it must never echo a script BODY, even one reachable on
// the stack object. Same defect shape as Plan 1's leaked sentry-cli token
// (see propose.test.mjs's matching P1.bootstrap test).
test('SECRET: a token-bearing script body reachable on the stack object never appears in P2.scripts advice', () => {
  const leakedToken = 'sentry-cli releases new --auth-token sk-leaked-TOKEN-should-never-appear';
  const stack = {
    languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
    packages: [{
      name: 'app', dir: '.', manifestPath: 'package.json', scripts: [],
      // Not a real field detect-stack.mjs produces — simulates the exact
      // leak shape Plan 1 shipped, to prove this check never reads it.
      scriptBodies: { build: leakedToken },
    }],
    ci: [],
  };
  assert.ok(JSON.stringify(stack).includes(leakedToken), 'fixture sanity: the token must actually be reachable on the stack object');
  const c = byId(gaps(stack, bareHarness), 'P2.scripts');
  assert.equal(JSON.stringify(c.advice).includes(leakedToken), false);
});

// Coordinator finding (round 2, comment corrected round 3): the "record it
// in CLAUDE.md, a Makefile, ..." explanation used to repeat verbatim on
// every derived Python advice line. The original comment here claimed
// "eight copies of the same paragraph on a four-package repo" — but
// detect-stack.mjs has NO Python workspace concept at all (its python
// fallback only ever produces a single root package; see its own
// comment), so a real four-package Python repo cannot be auto-detected and
// that scenario is UNREACHABLE through the real detection path today. This
// fixture's two-package `stack` is hand-built specifically to reach past
// that gap and pin the DEDUPE LOGIC itself in isolation — it is not, and
// was never meant to be, a claim about what `detect.mjs` can produce from
// a real repository. The REACHABLE case — one real, auto-detectable Python
// package whose own pyproject.toml carries both a ruff and a mypy table —
// is covered separately below, by a test that goes through the real CLI.
test('DEDUPE LOGIC (not a reachable detection shape): the Python command-home explanation appears only once, across a hand-built multi-package stack', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-py-multi-'));
  writeFileSync(join(d, 'pyproject.toml'), '[tool.ruff]\n');
  mkdirSync(join(d, 'pkg-b'), { recursive: true });
  writeFileSync(join(d, 'pkg-b', 'pyproject.toml'), '[tool.mypy]\n');
  const stack = {
    languages: ['python'], packageManager: null, isWorkspace: true,
    packages: [
      { name: 'a', dir: '.', manifestPath: 'pyproject.toml', scripts: [] },
      { name: 'b', dir: 'pkg-b', manifestPath: 'pkg-b/pyproject.toml', scripts: [] },
    ],
    ci: [],
  };
  const c = byId(gaps(stack, bareHarness, [], undefined, ['pyproject.toml', 'pkg-b/pyproject.toml'], d), 'P2.scripts');
  // Fixture sanity: at least two DERIVED lines must actually fire, or
  // "exactly once" would be true for the wrong reason (nothing to
  // deduplicate in the first place).
  const derivedLines = c.advice.filter(a => /->/.test(a));
  assert.ok(derivedLines.length >= 2, `fixture sanity: expected >=2 derived lines, got ${JSON.stringify(c.advice)}`);
  const explanationCount = c.advice.filter(a => /no standard script table/.test(a)).length;
  assert.equal(explanationCount, 1, 'the shared explanation must appear exactly once, not once per derived line');
});

// The REACHABLE case nothing covered before this fix: a single real Python
// package (the only shape detect-stack.mjs's Python fallback can produce)
// whose own pyproject.toml carries BOTH a ruff and a mypy table, so lint
// AND typecheck each derive a real command for the SAME package — two
// derived lines from ONE package, no hand-built multi-package stack
// required. This is also exercised end-to-end through the real CLI (see
// detect-cli.test.mjs's matching test).
test('DEDUPE, reachable case: one real package with both ruff and mypy config still gets the explanation only once', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-py-tworeal-'));
  writeFileSync(join(d, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n');
  const stack = { languages: ['python'], packageManager: null, isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] };
  const c = byId(gaps(stack, bareHarness, [], undefined, ['pyproject.toml'], d), 'P2.scripts');
  const derivedLines = c.advice.filter(a => /->/.test(a));
  assert.equal(derivedLines.length, 2, `fixture sanity: expected exactly 2 derived lines (lint and typecheck), got ${JSON.stringify(c.advice)}`);
  assert.ok(derivedLines.some(a => a.includes('ruff check .')));
  assert.ok(derivedLines.some(a => a.includes('mypy .')));
  const explanationCount = c.advice.filter(a => /no standard script table/.test(a)).length;
  assert.equal(explanationCount, 1, 'the shared explanation must appear exactly once, even though a single package derived two commands');
});

// Task 8b: the test this replaces, 'deny rules present make P2.protected
// declared', called gaps(fullStack, richHarness) with no `files` at all
// (defaulting to []) — so there was no protected-path EVIDENCE either, and
// it passed only because the OLD check keyed purely on `denyRules > 0`: ANY
// single deny rule, regardless of what it protected, satisfied this
// capability. That is the exact defect the coordinator found through the
// real CLI (a lockfile and migrations left unprotected while the report
// said "declared" because the user had denied edits to an unrelated
// secrets directory). The two tests below replace it, driven from a
// fixture with real protected-path evidence.

test('P2.protected is not satisfied by an unrelated deny rule (Task 8b)', () => {
  const f = typescriptFullFixture(); // real evidence: package-lock.json, tracked dist/
  const h = { ...bareHarness, claudeDir: { ...bareHarness.claudeDir, denyRules: 1, denyRuleList: ['Edit(secrets/**)'] } };
  const c = byId(buildGaps({ ...f, harness: h }), 'P2.protected');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal, 'their rule says nothing about our lockfile');
  assert.match(JSON.stringify(c.evidence), /secrets/, 'and we say what of theirs we found');
});

test('P2.protected IS satisfied when our own rules are present (Task 8b)', () => {
  const f = typescriptFullFixture();
  // Exactly what protectedPathCandidates derives for this fixture's files,
  // wrapped as Edit(...) — the same shape protectedPathProposal writes.
  const h = { ...bareHarness, claudeDir: { ...bareHarness.claudeDir, denyRules: 2, denyRuleList: ['Edit(*-lock.json)', 'Edit(dist/**)'] } };
  const c = byId(buildGaps({ ...f, harness: h }), 'P2.protected');
  assert.equal(c.state, 'declared');
  assert.equal(c.proposal, null);
});

test('a settings.json with zero deny rules is absent, not declared — existence alone is not enough', () => {
  // Task 5b: this used to call `gaps(fullStack, h)` with no `files` at
  // all — defaulting to `[]`, so there was no protected-path EVIDENCE
  // either, and the test passed only because the old check keyed purely
  // on `denyRules`, never on evidence (exactly the defect this task
  // fixes). A real lockfile is what actually licenses the proposal now —
  // see the test-quality instruction on fixtures whose data never
  // survives to the branch under test.
  const h = { ...richHarness, claudeDir: { ...richHarness.claudeDir, denyRules: 0 } };
  const c = byId(gaps(fullStack, h, [], undefined, ['package-lock.json']), 'P2.protected');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal);
});

test('P2.langserver is n/a, not declared — it is machine state the tool cannot observe', () => {
  const c = byId(gaps(fullStack, richHarness), 'P2.langserver');
  assert.equal(c.state, 'n/a');
  assert.equal(c.proposal, null);
});

test('steps outside the profile are n/a', () => {
  const nothing = { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] };
  const c = byId(gaps(nothing, bareHarness), 'P2.sensor');
  assert.equal(c.state, 'n/a');
  assert.equal(c.proposal, null);
});

// --- P1.bootstrap: the three-way split, not two ----------------------------
//
// Coordinator finding: this check used to decide `absent` + a proposal
// purely from `harness.bootstrap` being falsy, never looking at whether an
// install command was actually derivable — while propose.mjs's generator
// (correctly) looked at the real evidence and produced nothing for a
// pyproject-only Python repo. Detect advertised a proposal; apply produced
// nothing. The check must now share the SAME derivation
// (installCommand from bootstrap-install.mjs) that the generator uses, so
// the two cannot drift again.
//
// The three outcomes, and this is the one axis `profile.appliesToSteps()`
// does not by itself distinguish:
//   generic, nothing to install anywhere           -> n/a
//   a stack IS detected, install command derivable  -> absent + proposal
//   a stack IS detected, install command NOT derivable -> absent + decidable:false + question
test('P1.bootstrap: a detected stack with a derivable install command is absent + proposal', () => {
  const pipStack = { languages: ['python'], packageManager: 'pip', isWorkspace: false,
    packages: [{ name: 'root', dir: '.', manifestPath: 'requirements.txt', scripts: [] }], ci: [] };
  const c = byId(gaps(pipStack, bareHarness, [], undefined, ['requirements.txt']), 'P1.bootstrap');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true);
  assert.ok(c.proposal);
  assert.equal(c.question, null);
});

test('P1.bootstrap: a detected stack with NO derivable install command is absent + decidable:false + a question, never a proposal', () => {
  // Same shape as a pyproject-only Python repo: python IS the profile
  // (packages.length > 0), but no lockfile backs ANY package manager —
  // packageManager is null. A bootstrap script plainly applies here (n/a
  // would be a lie), but detection cannot derive the steps (a proposal
  // would also be a lie).
  const pyprojectOnlyStack = { languages: ['python'], packageManager: null, isWorkspace: false,
    packages: [{ name: 'root', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] };
  const c = byId(gaps(pyprojectOnlyStack, bareHarness, [], undefined, ['pyproject.toml']), 'P1.bootstrap');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false);
  assert.equal(c.proposal, null, 'an undecidable absent must never propose — enforced centrally, but pinned here too');
  assert.ok(c.question, 'the missing fact must be asked, not silently dropped');
  assert.match(c.question, /install/i);
});

test('P1.bootstrap: a pip stack with NO requirements.txt evidence is also undecidable, not a guess', () => {
  const pipNoEvidence = { languages: ['python'], packageManager: 'pip', isWorkspace: false,
    packages: [{ name: 'root', dir: '.', manifestPath: 'requirements.txt', scripts: [] }], ci: [] };
  const c = byId(gaps(pipNoEvidence, bareHarness, [], undefined, []), 'P1.bootstrap');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false);
  assert.equal(c.proposal, null);
});

// Coordinator finding (Minor, now fixed): the `n/a` branch used to key
// PURELY on `profile.appliesToSteps()`, never consulting `installCommand` —
// so a repository whose confidence fell below the profile threshold (e.g.
// a config-only repo with a tracked package-lock.json but no .js/.ts
// source file, so `languages()` is empty and `typescriptSingle.confidence()`
// is 0) got `n/a` even though `npm ci` is plainly derivable from the
// lockfile alone. `n/a` was not a LIE there (the profile genuinely does not
// cover it), but it was a missed proposal the shared derivation could have
// proven. P1.bootstrap now defers to `installCommand` even on a nominally
// `generic` profile, falling through to `n/a` only when it has nothing
// either.
test('P1.bootstrap defers to installCommand even on a generic profile, when a lockfile is genuinely present', () => {
  const configOnlyStack = { languages: [], packageManager: 'npm', isWorkspace: false, packages: [], ci: [] };
  const c = byId(gaps(configOnlyStack, bareHarness, [], undefined, ['package-lock.json']), 'P1.bootstrap');
  assert.equal(selectProfile(configOnlyStack).id, 'generic', 'fixture sanity: this really does fall back to the generic profile');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true);
  assert.ok(c.proposal, 'npm ci is derivable from package-lock.json alone, even though the profile is generic');
});

test('P1.bootstrap stays n/a on a generic profile when no lockfile backs it either', () => {
  const nothing = { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] };
  const c = byId(gaps(nothing, bareHarness, [], undefined, []), 'P1.bootstrap');
  assert.equal(c.state, 'n/a');
  assert.equal(c.proposal, null);
});

// Review Minor: P1.bootstrap, P2.sensor and P2.stopgate each ask a
// question about a declared SCRIPT (or lockfile/package-manager) source,
// but `lookedFor` used to name only the other evidence location (the file
// path / hook registry) — a check reporting it looked in one place while
// asking about another makes the question read as arbitrary. `lookedFor`
// must name the script/lockfile source too, for all three.
test('lookedFor names the script/lockfile source the question actually asks about, for P1.bootstrap, P2.sensor and P2.stopgate', () => {
  const checks = gaps(bareStack, bareHarness);
  const named = (id, re) => assert.match(byId(checks, id).lookedFor.join(' | '), re, `${id}.lookedFor must name what the question asks about`);
  named('P1.bootstrap', /lockfile|package manager/i);
  named('P2.sensor', /lint script/i);
  named('P2.stopgate', /typecheck|test script/i);
});

test('exposures make the security check failing, never absent', () => {
  const c = byId(gaps(bareStack, bareHarness, [{ kind: 'token-in-remote-url', location: 'origin', severity: 'high' }]), 'P0.security');
  assert.equal(c.state, 'failing');
  assert.equal(c.proposal, null);
});

test('a clean security sweep is verified', () => {
  assert.equal(byId(gaps(bareStack, bareHarness, []), 'P0.security').state, 'verified');
});

test('a missing git remote is absent', () => {
  assert.equal(byId(gaps(bareStack, bareHarness), 'P4.remote').state, 'absent');
  assert.equal(byId(gaps(fullStack, richHarness), 'P4.remote').state, 'declared');
});

// --- P1.pathrules: decidable only for a genuine workspace ------------------
//
// Ruling (coordinator, Task 6): a single-package repository has no
// meaningful path split to scaffold a rule file for, so the check must ASK
// rather than propose one. `pathRuleTargets` (pathrules-evidence.mjs) is
// the SAME derivation propose.mjs's generator uses to build the actual
// files — not a second independent guess at "is this a workspace worth
// scaffolding".

const workspaceStack = {
  packages: [
    { name: 'root', dir: '.', manifestPath: 'package.json', scripts: [] },
    { name: 'api', dir: 'packages/api', manifestPath: 'packages/api/package.json', scripts: [] },
    { name: 'web', dir: 'packages/web', manifestPath: 'packages/web/package.json', scripts: [] },
  ],
  languages: ['typescript'], packageManager: 'npm', isWorkspace: true, ci: [],
};

test('P1.pathrules proposes when the repository is a genuine workspace with no .claude/rules/ yet', () => {
  const c = byId(gaps(workspaceStack, bareHarness), 'P1.pathrules');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true);
  assert.ok(c.proposal);
});

// Coordinator finding (round 3): "ship it, but say so" — the reviewer's
// verdict was that these near-identical stubs still earn their place, but
// a reader skimming the summary (or /context, once applied) could mistake
// N listed rules files for N files that already hold real conventions.
// renderSummary prints `c.proposal` verbatim after the `→` (see
// report.mjs), so the disclosure belongs in the proposal text itself.
test('P1.pathrules\' proposal text discloses plainly that the generated files are empty', () => {
  const c = byId(gaps(workspaceStack, bareHarness), 'P1.pathrules');
  assert.match(c.proposal, /empty/i);
});

test('P1.pathrules asks, and proposes nothing, for a single-package repository', () => {
  const c = byId(gaps(bareStack, bareHarness), 'P1.pathrules');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false);
  assert.equal(c.proposal, null);
  assert.ok(c.question, 'the honest answer for a single package is a question, not silence');
});

// Task 8b: the test this replaces asserted `declared` from `bareStack`
// (NOT a workspace at all) purely because `.claude/rules/` was non-empty —
// "workspace or not" was the defect's own title: `.claude/rules/` is a
// directory that can hold rule files for many unrelated packages, and a
// user's own file for some OTHER project satisfied this check for a
// workspace that does not even have a target yet. `declared` now means
// every target THIS workspace's own layout calls for (`pathRuleTargets`)
// is actually present.

test('P1.pathrules is declared when .claude/rules/ holds OUR OWN file for every workspace member (Task 8b)', () => {
  const ours = { ...bareHarness, claudeDir: { ...bareHarness.claudeDir, rules: ['.claude/rules/packages-api.md', '.claude/rules/packages-web.md'] } };
  const c = byId(gaps(workspaceStack, ours), 'P1.pathrules');
  assert.equal(c.state, 'declared');
  assert.deepEqual(c.evidence, ['.claude/rules/packages-api.md', '.claude/rules/packages-web.md']);
});

test('P1.pathrules is NOT satisfied by an unrelated rule file for a package this workspace does not have (Task 8b)', () => {
  const theirs = { ...bareHarness, claudeDir: { ...bareHarness.claudeDir, rules: ['.claude/rules/some-other-thing.md'] } };
  const c = byId(gaps(workspaceStack, theirs), 'P1.pathrules');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal, 'their rule file says nothing about this workspace\'s own layout');
  assert.ok(c.evidence.some(e => e.includes('some-other-thing.md')), `evidence must name what of theirs was found; got ${JSON.stringify(c.evidence)}`);
});

test('lookedFor names both the rules directory and the workspace layout for P1.pathrules', () => {
  const lf = byId(gaps(bareStack, bareHarness), 'P1.pathrules').lookedFor.join(' | ');
  assert.match(lf, /\.claude\/rules/);
  assert.match(lf, /workspace/i);
});

// Coordinator finding (round 3, Minor): same mutation guard as
// propose.test.mjs's — this check ALSO consults `pathRuleTargets`, whose
// `isWorkspace` gate every existing fixture reaching the question branch
// happened to satisfy some OTHER way too (no non-root package at all), so
// removing the gate would not have failed any test above. This fixture
// isolates it on the check side: a non-root package with isWorkspace:false
// must still be undecidable, not a proposal.
test('MUTATION GUARD: P1.pathrules\' decidability consults stack.isWorkspace explicitly, not just "any non-root package"', () => {
  const stack = {
    packages: [{ name: 'api', dir: 'packages/api', manifestPath: 'packages/api/package.json', scripts: [] }],
    languages: ['typescript'], packageManager: null, isWorkspace: false, ci: [],
  };
  const c = byId(gaps(stack, bareHarness), 'P1.pathrules');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false, 'isWorkspace is false, so this must stay undecidable even though a non-root package exists');
  assert.equal(c.proposal, null);
});

// --- P1.architecture: the repository's own pointer, and decidability ---

test('P1.architecture is declared when the instruction file points at documentation', () => {
  const h = { ...bareHarness, instructions: { path: 'CLAUDE.md', lines: 16 },
    architecture: null, docPointers: ['docs/wiki/README.md', 'docs/wiki/services.md'], projectDocs: ['docs/wiki/README.md', 'docs/wiki/services.md'] };
  const c = byId(gaps(fullStack, h), 'P1.architecture');
  assert.equal(c.state, 'declared');
  assert.equal(c.proposal, null);
  assert.ok(c.evidence.some(e => e.includes('docs/wiki/README.md')), `evidence must name what was credited; got ${JSON.stringify(c.evidence)}`);
});

test('P1.architecture yields no proposal but a question when docs/ holds markdown nothing points at', () => {
  const h = { ...bareHarness, instructions: { path: 'CLAUDE.md', lines: 16 },
    architecture: null, docPointers: [], projectDocs: ['docs/wiki/README.md', 'docs/wiki/services.md', 'docs/ops.md', 'docs/api.md'] };
  const c = byId(gaps(fullStack, h), 'P1.architecture');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false, 'three filenames is not an enumeration of the space');
  assert.equal(c.proposal, null, 'an undecidable absent must not propose');
  assert.ok(c.question, 'it must ask instead');
  assert.match(c.question, /4 files with a documentation-shaped name/, 'the question must say how many were found, and say "shaped", not assert they ARE documentation');
  assert.match(c.question, /docs\/wiki\/README\.md/, 'and name them');
  assert.match(c.question, /…/, 'eliding the tail of a long list');
});

test('P1.architecture proposes when there is genuinely no documentation at all', () => {
  const h = { ...bareHarness, architecture: null, docPointers: [], projectDocs: [] };
  const c = byId(gaps(fullStack, h), 'P1.architecture');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true);
  assert.ok(c.proposal, 'nothing to be uncertain about — the space is empty');
  assert.equal(c.question, null);
});

test('a canonical architecture path still wins outright', () => {
  const c = byId(gaps(fullStack, richHarness), 'P1.architecture');
  assert.equal(c.state, 'declared');
  assert.ok(c.evidence.includes('docs/ARCHITECTURE.md'));
});

// --- F1: decidability must follow projectDocs wherever it actually finds
// documentation, not just docs/*.md. See detect-harness.test.mjs for the
// widened collection itself.

test('architecture is undecidable when docs live outside docs/', () => {
  const h = { ...bareHarness, projectDocs: ['wiki/overview.md', 'wiki/api.md'] };
  const c = byId(gaps(fullStack, h), 'P1.architecture');
  assert.equal(c.state, 'absent');
  assert.equal(c.proposal, null, 'must not propose when documentation exists elsewhere');
  assert.equal(c.decidable, false);
});

test('architecture is undecidable for non-markdown documentation', () => {
  const h = { ...bareHarness, projectDocs: ['docs/index.rst', 'docs/api.rst'] };
  const c = byId(gaps(fullStack, h), 'P1.architecture');
  assert.equal(c.proposal, null);
  assert.equal(c.decidable, false);
});

test('architecture is decidable only when the repo has no documentation at all', () => {
  const h = { ...bareHarness, projectDocs: [] };
  const c = byId(gaps(fullStack, h), 'P1.architecture');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true);
  assert.ok(c.proposal, 'a repo with no docs anywhere can be told to write one');
});

// The tests above hand-build a harness fixture, which only proves gap-model's
// OWN decidability policy is correct. The reported defect lived one layer
// down, in detect-harness.mjs's projectDocs collection — so these two run the
// real detector end to end, against real files, to prove the whole pipeline.

function tmpRepo() { return mkdtempSync(join(tmpdir(), 'hk-gapmodel-')); }
function writeFile(d, rel, content) {
  const p = join(d, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

test('F1 end-to-end: a repo documented under wiki/ is not proposed an architecture doc', () => {
  const d = tmpRepo();
  writeFile(d, 'wiki/overview.md', '# overview\n');
  writeFile(d, 'wiki/services.md', '# services\n');
  const harness = detectHarness(d, listFiles(d).files);
  const c = byId(gaps(fullStack, harness), 'P1.architecture');
  assert.equal(c.state, 'absent');
  assert.equal(c.proposal, null, 'documentation exists under wiki/; must not be told it has none');
  assert.equal(c.decidable, false);
});

test('F1 end-to-end: a repo documented in .rst is not proposed an architecture doc', () => {
  const d = tmpRepo();
  writeFile(d, 'docs/index.rst', 'index\n');
  const harness = detectHarness(d, listFiles(d).files);
  const c = byId(gaps(fullStack, harness), 'P1.architecture');
  assert.equal(c.proposal, null, 'documentation exists as .rst; must not be told it has none');
  assert.equal(c.decidable, false);
});

// --- Hook checks read the registry, not the filenames — but crediting
// requires OUR OWN script, not merely something registered (Task 8b) ---
//
// .claude/settings.json records what is actually wired up, and a hook
// script may live anywhere — that half of the original comment here still
// holds, and is still pinned below (OUR OWN script, living outside
// .claude/scripts/, is still credited). What changed: a file under
// .claude/scripts/ that nothing registers still does nothing (unchanged),
// and NOW a hook that IS registered, but is not OUR resolved script, also
// does nothing for this capability — see registeredHook's own comment in
// gap-model.mjs. The coordinator found this exact shape live, through the
// real CLI, while this plan's own lifecycle test was being written: a
// user's single unrelated PostToolUse hook used to satisfy P2.sensor
// outright.

const withHooks = (hookEvents, hooks = []) => ({ ...bareHarness,
  claudeDir: { ...bareHarness.claudeDir, hooks, hookEvents } });

const OUR_HOOK_PATH = { PostToolUse: LINT_TOUCHED_PATH, Stop: VERIFY_TOUCHED_PATH, SessionStart: BRIEF_PATH };

for (const [id, event] of [
  ['P2.sensor', 'PostToolUse'],
  ['P2.stopgate', 'Stop'],
  ['P4.sessionbrief', 'SessionStart'],
]) {
  test(`${id} is declared by OUR OWN registered ${event} hook, wherever its script lives`, () => {
    // "wherever its script lives" still holds — crediting is by the
    // resolved PATH recorded in the registry, not a filename under
    // .claude/scripts/. The path simply has to be ours.
    const ourPath = OUR_HOOK_PATH[event];
    const c = byId(gaps(fullStack, withHooks({ [event]: [ourPath] })), id);
    assert.equal(c.state, 'declared');
    assert.equal(c.proposal, null);
    assert.ok(c.evidence.some(e => e.includes(ourPath)), `evidence must name what was credited; got ${JSON.stringify(c.evidence)}`);
  });

  test(`${id} is NOT satisfied by someone else's registered ${event} hook (Task 8b) — it stays absent, proposed, and names what it found`, () => {
    // This is the exact defect the coordinator found through the real CLI.
    // Before Task 8b this asserted `declared` here — pinning the old
    // "is there anything on this event" behaviour as correct. An unrelated
    // script on the SAME event tells this capability nothing about whether
    // OUR sensor/gate/brief is wired up, and the proposal must not be
    // suppressed because the coordinator's ruling: their hook may do
    // something unrelated, and deciding for them is not this tool's place.
    const cmd = 'tools/unrelated-automation.js';
    const c = byId(gaps(fullStack, withHooks({ [event]: [cmd] })), id);
    assert.equal(c.state, 'absent', 'an unrelated hook on the same event must not satisfy this capability');
    assert.ok(c.proposal, 'their hook says nothing about ours; the proposal must still be made');
    assert.ok(c.evidence.some(e => e.includes(cmd)), `evidence must name what of theirs was found; got ${JSON.stringify(c.evidence)}`);
  });

  test(`${id} is absent when a suggestively named script is present but nothing registers a ${event} hook`, () => {
    const decoys = ['.claude/scripts/lint-touched.mjs', '.claude/scripts/verify-touched.mjs', '.claude/scripts/session-brief.mjs'];
    const c = byId(gaps(fullStack, withHooks({}, decoys)), id);
    assert.equal(c.state, 'absent', 'an unregistered file must not be credited');
    assert.ok(c.proposal);
  });
}

test('a registered hook whose command names no repository path is NOT assumed to be ours (Task 8b)', () => {
  // Previously this asserted `declared` here: "the command resolved to
  // nothing ... it is still registered, so the capability is still there"
  // was exactly the mere-occupancy reasoning Task 8b removes. An
  // unresolvable command cannot be verified as OURS either — the safe
  // default is to still propose, not to assume it.
  const c = byId(gaps(fullStack, withHooks({ Stop: [null] })), 'P2.stopgate');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal);
  assert.deepEqual(c.evidence, ['Stop hook already registered, but not ours (its script could not be resolved)']);
});

test('P4.handoff and P4.sessionbrief are independent — a working hook is not told to install one', () => {
  const hookOnly = { ...withHooks({ SessionStart: [BRIEF_PATH] }), handoff: null };
  const cs = gaps(fullStack, hookOnly);
  assert.equal(byId(cs, 'P4.sessionbrief').state, 'declared');
  assert.equal(byId(cs, 'P4.handoff').state, 'absent');
  assert.equal(byId(cs, 'P4.handoff').proposal, 'create HANDOFF.md from template');

  const handoffOnly = { ...withHooks({}), handoff: 'HANDOFF.md' };
  const cs2 = gaps(fullStack, handoffOnly);
  assert.equal(byId(cs2, 'P4.handoff').state, 'declared');
  assert.equal(byId(cs2, 'P4.sessionbrief').state, 'absent');
  // The conflated check used to propose both at once. Neither proposal may
  // mention the other capability now.
  assert.equal(/HANDOFF/i.test(byId(cs2, 'P4.sessionbrief').proposal), false);
});

// --- The invariant itself, not just the current checks' compliance with it. ---
//
// The tests above only ever exercise the real CHECKS array, and every entry in
// it happens to return a proposal exclusively when its own state is 'absent'.
// That means those tests can all pass even if the central guard in buildGaps
// were deleted outright — nothing observable would change. These tests close
// that hole by injecting a rogue check definition through buildGaps'
// `checkDefs` override and proving the guard, not the checks, does the work.

const genericStack = { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] };
const genericProfile = selectProfile(genericStack);
const ROGUE_STEP = 6;
const rogueGit = { branch: 'main', isRepo: true };

function buildRogueGaps(checkDefs) {
  // Fail loudly if the fixture's assumption stops holding, rather than
  // silently passing because the rogue step was filtered to n/a before the
  // guard ever ran.
  assert.ok(
    genericProfile.appliesToSteps().includes(ROGUE_STEP),
    `fixture assumes step ${ROGUE_STEP} is applicable to profile ${genericProfile.id}; ` +
      `appliesToSteps() reports ${JSON.stringify(genericProfile.appliesToSteps())}`
  );
  // `files` is required (see buildGaps' own header comment) even though
  // none of this file's rogue checks ever reads it — an empty array, not
  // an omission, is how a caller says "there really are none."
  return buildGaps({ stack: genericStack, harness: bareHarness, exposures: [], profile: genericProfile, git: rogueGit, files: [], checkDefs });
}

test('the guard strips a proposal a rogue check attaches to state "declared"', () => {
  const cs = buildRogueGaps([{
    id: 'ROGUE.declared', step: ROGUE_STEP, phase: 9,
    lookedFor: ['a rogue check that misbehaves'],
    check: () => ({ state: 'declared', evidence: ['rogue'], proposal: 'this must never survive' }),
  }]);
  const c = byId(cs, 'ROGUE.declared');
  assert.equal(c.state, 'declared', 'the guard must not rewrite the state');
  assert.equal(c.proposal, null, 'the guard must strip a proposal from a non-absent state');
});

test('the guard strips a proposal a rogue check attaches to state "verified"', () => {
  const cs = buildRogueGaps([{
    id: 'ROGUE.verified', step: ROGUE_STEP, phase: 9,
    lookedFor: ['a rogue check that misbehaves'],
    check: () => ({ state: 'verified', evidence: ['rogue'], proposal: 'this must never survive' }),
  }]);
  const c = byId(cs, 'ROGUE.verified');
  assert.equal(c.state, 'verified', 'the guard must not rewrite the state');
  assert.equal(c.proposal, null, 'the guard must strip a proposal from a non-absent state');
});

test('the guard keeps a proposal when the rogue check\'s state genuinely is "absent"', () => {
  const cs = buildRogueGaps([{
    id: 'ROGUE.absent', step: ROGUE_STEP, phase: 9,
    lookedFor: ['a rogue check that behaves correctly'],
    check: () => ({ state: 'absent', evidence: ['rogue'], proposal: 'this must survive' }),
  }]);
  const c = byId(cs, 'ROGUE.absent');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true, 'decidability defaults to true, so existing checks are unaffected');
  assert.equal(c.proposal, 'this must survive', 'a genuinely absent state must keep its proposal — the guard must not null everything');
});

// The same hole, one axis over. `absent` means two incompatible things: "I
// enumerated the complete space and it is not there" and "I checked a handful
// of names I happen to know". Only the first may propose. The check declares
// which it is; the wrapper — not the check — does the dropping, exactly as it
// does for the proposal guard.

test('the guard strips a proposal a rogue check attaches to an UNDECIDABLE "absent", and routes its question', () => {
  const cs = buildRogueGaps([{
    id: 'ROGUE.undecidable', step: ROGUE_STEP, phase: 9,
    lookedFor: ['a rogue check that cannot enumerate its space'],
    check: () => ({ state: 'absent', evidence: ['rogue'], decidable: false,
      proposal: 'this must never survive', question: 'this must be routed instead' }),
  }]);
  const c = byId(cs, 'ROGUE.undecidable');
  assert.equal(c.state, 'absent', 'the guard must not rewrite the state');
  assert.equal(c.decidable, false);
  assert.equal(c.proposal, null, 'an undecidable absent must never propose');
  assert.equal(c.question, 'this must be routed instead');
  assert.ok(deriveCouldNotDerive({ stack: genericStack, checks: cs }).includes('this must be routed instead'),
    'the question must reach couldNotDerive, not vanish');
});

test('a question from a DECIDABLE check is not routed — the axis is what carries questions', () => {
  const cs = buildRogueGaps([{
    id: 'ROGUE.chatty', step: ROGUE_STEP, phase: 9,
    lookedFor: ['a rogue check that asks without admitting uncertainty'],
    check: () => ({ state: 'absent', evidence: ['rogue'], proposal: 'kept', question: 'this must not be routed' }),
  }]);
  const c = byId(cs, 'ROGUE.chatty');
  assert.equal(c.proposal, 'kept');
  assert.equal(c.question, null);
});
