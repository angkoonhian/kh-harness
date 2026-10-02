import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyManifest } from './manifest.mjs';
import { buildProposals } from './propose.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'hk-prop-'));
const check = (o) => ({ id: 'P4.handoff', step: 16, phase: 4, state: 'absent', decidable: true, evidence: [], proposal: 'create HANDOFF.md', ...o });
// `languages: []` (not merely omitted) matters: selectProfile's confidence()
// functions call `stack.languages.includes(...)` unconditionally, so an
// incomplete stack object throws rather than falling back to generic.
const args = (checks, extra = {}) => ({
  root: root(), checks, manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0', harness: { claudeDir: {} },
  stack: { packages: [], languages: [], isWorkspace: false, packageManager: null, ci: [] },
  files: [],
  ...extra,
});

test('an absent decidable check yields a proposal', () => {
  const ps = buildProposals(args([check({})]));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].path, 'HANDOFF.md');
  assert.ok(ps[0].contents.includes('Handoff'));
});

test('generated contents carry a version stamp', () => {
  const ps = buildProposals(args([check({})]));
  assert.match(ps[0].contents, /harness-kit 0\.2\.0/);
});

test('a declared check yields nothing', () => {
  assert.deepEqual(buildProposals(args([check({ state: 'declared', proposal: null })])), []);
});

test('an UNDECIDABLE absent check yields nothing, even with a proposal string', () => {
  const ps = buildProposals(args([check({ decidable: false })]));
  assert.deepEqual(ps, [], 'decidability is the second gate and propose must honour it');
});

test('a file already in the manifest is not re-proposed', () => {
  const m = emptyManifest('0.2.0');
  m.files.push({ path: 'HANDOFF.md', sha256: 'x', step: 16, writtenAt: 'now' });
  assert.deepEqual(buildProposals(args([check({})], { manifest: m })), []);
});

test('the session-brief check proposes both a script and a settings hook', () => {
  const ps = buildProposals(args([check({ id: 'P4.sessionbrief', proposal: 'install session brief' })]));
  const kinds = ps.map(p => p.kind).sort();
  assert.deepEqual(kinds, ['file', 'settings-hook']);
  assert.equal(ps.find(p => p.kind === 'file').path, '.claude/scripts/session-brief.mjs');
});

test('a declared session-brief check yields no proposals (hook already registered)', () => {
  const ps = buildProposals(args([check({ id: 'P4.sessionbrief', state: 'declared' })]));
  assert.deepEqual(ps, []);
});

test('a check with no registered generator is skipped without throwing', () => {
  assert.doesNotThrow(() => buildProposals(args([check({ id: 'P9.unknown', step: 99 })])));
  assert.deepEqual(buildProposals(args([check({ id: 'P9.unknown', step: 99 })])), []);
});

test('a generator receives the full context including stack, root, and checks', () => {
  // TEST.contextcheck is not in the production table (it proposed a path
  // assertAllowed refuses) — it is injected here via `generators`, which
  // exists precisely so a probe like this never has to live in production.
  const contextcheck = ({ kitVersion, harness, root, stack, checks }) => {
    if (typeof root !== 'string' && typeof root !== 'undefined') return [];
    if (!Array.isArray(stack?.packages ?? [])) return [];
    if (!Array.isArray(checks)) return [];
    return [{ kind: 'file', path: '.context-verified', step: 99, contents: 'ok', reason: 'test' }];
  };
  const checks = [check({ id: 'TEST.contextcheck' })];
  const ps = buildProposals(args(checks, { generators: { 'TEST.contextcheck': contextcheck } }));
  assert.equal(ps.length, 1, 'generator received full context and returned a proposal');
  assert.equal(ps[0].path, '.context-verified', 'generator verified stack, root, and checks were passed');
});

test('a generator id with no production entry and no injected override is skipped without throwing', () => {
  const checks = [check({ id: 'TEST.contextcheck' })];
  assert.doesNotThrow(() => buildProposals(args(checks)));
  assert.deepEqual(buildProposals(args(checks)), [], 'the removed production entry must not silently resurface');
});

// --- P2.protected: deny rules from evidence --------------------------------

const protectedCheck = () => check({ id: 'P2.protected', step: 11, proposal: 'add deny rules' });

test('P2.protected proposes deny rules only for paths that exist', () => {
  const files = ['package.json', 'pnpm-lock.yaml', 'prisma/migrations/001_init.sql', 'src/app.ts'];
  const ps = buildProposals(args([protectedCheck()], { files }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'a deny proposal is made');
  assert.ok(deny.globs.some(g => g.includes('migrations')), 'the migrations dir exists, so it is proposed');
  assert.ok(deny.globs.some(g => g.includes('lock')), 'the lockfile exists, so it is proposed');
  assert.equal(deny.globs.some(g => g.includes('__pycache__')), false, 'nothing python here');
});

test('P2.protected proposes nothing when no protected path exists', () => {
  const files = ['README.md', 'src/app.ts'];
  const ps = buildProposals(args([protectedCheck()], { files }));
  assert.equal(ps.some(p => p.kind === 'settings-deny'), false, 'no evidence, no proposal');
});

test('P2.protected omits a candidate that matches nothing even when another candidate matches', () => {
  // Migrations exist; no lockfile does. This is the existence filter's
  // actual job — proving it is selective, not all-or-nothing, which the two
  // tests above cannot distinguish from a filter that is simply never
  // engaged (the first repo has evidence for everything it asserts; the
  // second has evidence for nothing).
  const files = ['package.json', 'prisma/migrations/001_init.sql', 'src/app.ts'];
  const ps = buildProposals(args([protectedCheck()], { files }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'a deny proposal is made because the migrations dir exists');
  assert.ok(deny.globs.some(g => g.includes('migrations')), 'the migrations dir exists, so it is proposed');
  assert.equal(deny.globs.some(g => g.includes('lock')), false, 'no lockfile exists in this repository, so no lock rule is proposed');
  assert.ok(
    deny.globs.every(g => g.startsWith('Edit(') && g.endsWith(')')),
    'every proposed rule is wrapped as a Claude Code Edit(...) permission pattern',
  );
});

test('a declared P2.protected check yields no proposals', () => {
  const files = ['pnpm-lock.yaml'];
  const ps = buildProposals(args([check({ id: 'P2.protected', step: 11, state: 'declared', proposal: null })], { files }));
  assert.deepEqual(ps, []);
});
