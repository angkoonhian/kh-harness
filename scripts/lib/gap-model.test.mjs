import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGaps, STATES } from './gap-model.mjs';
import { selectProfile } from './profiles/index.mjs';

const bareStack = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
  packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: {} }], ci: [] };
const bareHarness = {
  instructions: { path: null, lines: 0 }, agentsMd: null, reconPresent: false,
  claudeDir: { settings: false, localSettings: false, hooks: [], agents: [], skills: [], commands: [], rules: [] },
  otherEditors: [], architecture: null, handoff: null, bootstrap: null, gitattributes: false, remotes: [],
};
const richHarness = {
  instructions: { path: 'CLAUDE.md', lines: 153 }, agentsMd: null, reconPresent: true,
  claudeDir: { settings: true, localSettings: true, hooks: ['.claude/scripts/lint-touched.mjs', '.claude/scripts/verify-touched.mjs', '.claude/scripts/session-brief.mjs'],
    agents: Array.from({ length: 13 }, (_, i) => `.claude/agents/c${i}.md`), skills: [], commands: [], rules: ['.claude/rules/api.md'] },
  otherEditors: [], architecture: 'docs/ARCHITECTURE.md', handoff: 'HANDOFF.md',
  bootstrap: 'scripts/bootstrap.sh', gitattributes: true, remotes: [{ name: 'origin', hasCredential: false }],
};
const fullStack = { ...bareStack, packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit' } }] };

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
  for (const id of ['P1.bootstrap', 'P1.instructions', 'P2.sensor', 'P2.stopgate', 'P4.continuity']) {
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
