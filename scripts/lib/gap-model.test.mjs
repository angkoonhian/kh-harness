import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGaps, STATES } from './gap-model.mjs';
import { selectProfile } from './profiles/index.mjs';

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
    hookEvents: { PostToolUse: ['node .claude/scripts/lint-touched.mjs'], Stop: ['node .claude/scripts/verify-touched.mjs'], SessionStart: ['node .claude/scripts/session-brief.mjs'] },
    agents: Array.from({ length: 13 }, (_, i) => `.claude/agents/c${i}.md`), skills: [], commands: [], rules: ['.claude/rules/api.md'] },
  otherEditors: [], architecture: 'docs/ARCHITECTURE.md', handoff: 'HANDOFF.md',
  bootstrap: 'scripts/bootstrap.sh', gitattributes: true, remotes: [{ name: 'origin', hasCredential: false }],
};
const fullStack = { ...bareStack, packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['lint', 'test', 'typecheck'] }] };

function gaps(stack, harness, exposures = [], git = { branch: 'main', isRepo: true }) {
  return buildGaps({ stack, harness, exposures, profile: selectProfile(stack), git });
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

test('a bare repo yields proposals for the mechanical steps', () => {
  const ids = gaps(bareStack, bareHarness).filter(c => c.proposal).map(c => c.id);
  for (const id of ['P1.bootstrap', 'P1.instructions', 'P2.sensor', 'P2.stopgate', 'P2.protected', 'P4.handoff', 'P4.sessionbrief']) {
    assert.ok(ids.includes(id), `expected a proposal for ${id}`);
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
  const h = { ...richHarness, claudeDir: { ...richHarness.claudeDir, denyRules: 0 } };
  const c = byId(gaps(fullStack, h), 'P2.protected');
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

// --- Hook checks read the registry, not the filenames ---
//
// .claude/settings.json records what is actually wired up. A hook script may
// live anywhere; a file under .claude/scripts/ that nothing registers does
// nothing. Both directions are pinned here because mutation testing showed
// this code had no net at all.

const withHooks = (hookEvents, hooks = []) => ({ ...bareHarness,
  claudeDir: { ...bareHarness.claudeDir, hooks, hookEvents } });

for (const [id, event, cmd] of [
  ['P2.sensor', 'PostToolUse', 'node tools/format-and-lint.js'],
  ['P2.stopgate', 'Stop', 'make verify'],
  ['P4.sessionbrief', 'SessionStart', 'node docs/agent-context/inject.js'],
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
  assert.equal(c.proposal, 'this must survive', 'a genuinely absent state must keep its proposal — the guard must not null everything');
});
