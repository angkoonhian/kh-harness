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
  // (unrelated to what this fixture is actually exercising) and, via
  // python.mjs's own `protectedGlobs()`, is itself protected-path
  // evidence — so this fixture is deliberately NOT used below to test
  // P2.protected's n/a branch (see bareRepoFixture for that).
  const stack = { languages: ['python'], packageManager: 'pip', isWorkspace: false,
    packages: [{ name: 'root', dir: '.', manifestPath: 'requirements.txt', scripts: [] }], ci: [] };
  return { stack, harness: bareHarness, exposures: [], profile: selectProfile(stack),
    git: { branch: 'main', isRepo: true }, files: ['requirements.txt', 'app.py'] };
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

test('all three still propose when their evidence IS present', () => {
  const checks = buildGaps(typescriptFullFixture());
  for (const id of ['P2.sensor', 'P2.stopgate', 'P2.protected']) {
    const c = byId(checks, id);
    assert.ok(c.proposal, `${id} must still propose when its evidence exists`);
    assert.equal(c.decidable, true);
  }
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

test('deny rules present make P2.protected declared', () => {
  const c = byId(gaps(fullStack, richHarness), 'P2.protected');
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
  assert.match(c.question, /4 documentation files/, 'the question must say how many were found');
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

// --- Hook checks read the registry, not the filenames ---
//
// .claude/settings.json records what is actually wired up. A hook script may
// live anywhere; a file under .claude/scripts/ that nothing registers does
// nothing. Both directions are pinned here because mutation testing showed
// this code had no net at all.

const withHooks = (hookEvents, hooks = []) => ({ ...bareHarness,
  claudeDir: { ...bareHarness.claudeDir, hooks, hookEvents } });

for (const [id, event, cmd] of [
  ['P2.sensor', 'PostToolUse', 'tools/format-and-lint.js'],
  ['P2.stopgate', 'Stop', 'tools/verify-all.js'],
  ['P4.sessionbrief', 'SessionStart', 'docs/agent-context/inject.js'],
]) {
  test(`${id} is declared by a registered ${event} hook living outside .claude/scripts/`, () => {
    const c = byId(gaps(fullStack, withHooks({ [event]: [cmd] })), id);
    assert.equal(c.state, 'declared');
    assert.equal(c.proposal, null);
    assert.ok(c.evidence.some(e => e.includes(cmd)), `evidence must name what was credited; got ${JSON.stringify(c.evidence)}`);
  });

  test(`${id} is absent when a suggestively named script is present but nothing registers a ${event} hook`, () => {
    const decoys = ['.claude/scripts/lint-touched.mjs', '.claude/scripts/verify-touched.mjs', '.claude/scripts/session-brief.mjs'];
    const c = byId(gaps(fullStack, withHooks({}, decoys)), id);
    assert.equal(c.state, 'absent', 'an unregistered file must not be credited');
    assert.ok(c.proposal);
  });
}

test('a registered hook whose command names no repository path is credited by event alone', () => {
  // The command resolved to nothing — a shell one-liner, or a path built from
  // an environment variable. It is still registered, so the capability is
  // still there; the evidence simply names less rather than risk naming an
  // argument.
  const c = byId(gaps(fullStack, withHooks({ Stop: [null] })), 'P2.stopgate');
  assert.equal(c.state, 'declared');
  assert.equal(c.proposal, null);
  assert.deepEqual(c.evidence, ['Stop hook registered']);
});

test('P4.handoff and P4.sessionbrief are independent — a working hook is not told to install one', () => {
  const hookOnly = { ...withHooks({ SessionStart: ['node docs/agent-context/inject.js'] }), handoff: null };
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
  return buildGaps({ stack: genericStack, harness: bareHarness, exposures: [], profile: genericProfile, git: rogueGit, checkDefs });
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
