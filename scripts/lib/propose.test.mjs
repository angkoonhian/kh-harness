import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyManifest } from './manifest.mjs';
import { buildProposals, GENERATORS } from './propose.mjs';
import { buildGaps } from './gap-model.mjs';
import { selectProfile } from './profiles/index.mjs';

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

// --- P2.sensor: the per-edit lint hook, gated on an actual lint script ----

const lintStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['lint'] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
const noLintStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['test'] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
const sensorCheck = () => check({ id: 'P2.sensor', step: 9, proposal: 'install scripts/lint-touched.mjs and register a PostToolUse hook' });

test('P2.sensor proposes the script, the shared redaction asset, and a PostToolUse settings hook when a package declares a lint script', () => {
  const ps = buildProposals(args([sensorCheck()], { stack: lintStack }));
  const kinds = ps.map(p => p.kind).sort();
  assert.deepEqual(kinds, ['file', 'file', 'settings-hook']);
  const files = ps.filter(p => p.kind === 'file').map(p => p.path).sort();
  assert.deepEqual(files, ['.claude/scripts/harness-redact.mjs', '.claude/scripts/lint-touched.mjs']);
  const hook = ps.find(p => p.kind === 'settings-hook');
  assert.equal(hook.event, 'PostToolUse');
  assert.equal(hook.matcher, 'Write|Edit');
  assert.equal(hook.entry.command, 'node .claude/scripts/lint-touched.mjs');
});

test('P2.sensor proposes nothing when no package declares a lint script — a sensor with nothing to run is noise', () => {
  const ps = buildProposals(args([sensorCheck()], { stack: noLintStack }));
  assert.deepEqual(ps, []);
});

test('P2.sensor proposes nothing when stack.packages is empty (the default)', () => {
  const ps = buildProposals(args([sensorCheck()]));
  assert.deepEqual(ps, []);
});

test('a declared P2.sensor check yields no proposals, even with a lint script present', () => {
  const ps = buildProposals(args([check({ id: 'P2.sensor', step: 9, state: 'declared', proposal: null })], { stack: lintStack }));
  assert.deepEqual(ps, []);
});

// --- P2.stopgate: the Stop gate, gated on a typecheck or test script ------

const typecheckStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['typecheck'] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
const testOnlyStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['test'] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
const noVerifyStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build'] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
const stopgateCheck = () => check({ id: 'P2.stopgate', step: 10, proposal: 'install scripts/verify-touched.mjs and register a Stop hook' });

test('P2.stopgate proposes the script, the shared redaction asset, and a matcher-less Stop settings hook when a typecheck script exists', () => {
  const ps = buildProposals(args([stopgateCheck()], { stack: typecheckStack }));
  const kinds = ps.map(p => p.kind).sort();
  assert.deepEqual(kinds, ['file', 'file', 'settings-hook']);
  const files = ps.filter(p => p.kind === 'file').map(p => p.path).sort();
  assert.deepEqual(files, ['.claude/scripts/harness-redact.mjs', '.claude/scripts/verify-touched.mjs']);
  const hook = ps.find(p => p.kind === 'settings-hook');
  assert.equal(hook.event, 'Stop');
  assert.equal(hook.matcher, undefined, 'the Stop entry takes no matcher');
  assert.equal(hook.entry.command, 'node .claude/scripts/verify-touched.mjs');
});

test('P2.stopgate proposes the script when only a test script exists (typecheck absent)', () => {
  const ps = buildProposals(args([stopgateCheck()], { stack: testOnlyStack }));
  assert.ok(ps.some(p => p.kind === 'file' && p.path === '.claude/scripts/verify-touched.mjs'));
});

test('P2.stopgate\'s reason discloses the fallback-to-test cost plainly, without naming the command itself', () => {
  const ps = buildProposals(args([stopgateCheck()], { stack: testOnlyStack }));
  const hook = ps.find(p => p.kind === 'settings-hook');
  assert.match(hook.reason, /test/i);
  assert.match(hook.reason, /120s|every turn/i, 'the cost being accepted must be stated plainly');
});

test('P2.stopgate proposes nothing when neither a typecheck nor a test script exists', () => {
  const ps = buildProposals(args([stopgateCheck()], { stack: noVerifyStack }));
  assert.deepEqual(ps, []);
});

test('P2.stopgate proposes nothing when stack.packages is empty (the default)', () => {
  const ps = buildProposals(args([stopgateCheck()]));
  assert.deepEqual(ps, []);
});

// Coordinator finding: the gate used to accept a typecheck/test script
// declared by ANY package (the same loose shape as P2.sensor's own lint
// gate) — but verify-touched.mjs only ever reads CLAUDE_PROJECT_DIR's own
// (root) package.json, with no per-file owning-package resolution the way
// lint-touched.mjs has. A monorepo where only a NESTED package declares
// `typecheck`/`test` would otherwise get a gate that reports `declared`
// and a hook that silently finds nothing at root and exits 0 forever —
// false assurance: the capability installs, reports as present, and never
// fires.
test('P2.stopgate proposes nothing in a monorepo where only a NESTED package declares typecheck/test — the hook only ever reads the root manifest', () => {
  const monorepoNoRootVerify = {
    packages: [
      { name: 'root', dir: '.', manifestPath: 'package.json', scripts: ['build'] },
      { name: 'api', dir: 'packages/api', manifestPath: 'packages/api/package.json', scripts: ['typecheck', 'test'] },
    ],
    languages: ['typescript'], isWorkspace: true, packageManager: null, ci: [],
  };
  const ps = buildProposals(args([stopgateCheck()], { stack: monorepoNoRootVerify }));
  assert.deepEqual(ps, [], 'no root-level verification command exists, so the honest outcome is no proposal at all');
});

test('P2.stopgate still proposes in a monorepo when the ROOT package itself declares typecheck, regardless of what nested packages declare', () => {
  const monorepoRootVerify = {
    packages: [
      { name: 'root', dir: '.', manifestPath: 'package.json', scripts: ['typecheck'] },
      { name: 'api', dir: 'packages/api', manifestPath: 'packages/api/package.json', scripts: [] },
    ],
    languages: ['typescript'], isWorkspace: true, packageManager: null, ci: [],
  };
  const ps = buildProposals(args([stopgateCheck()], { stack: monorepoRootVerify }));
  assert.ok(ps.some(p => p.kind === 'file' && p.path === '.claude/scripts/verify-touched.mjs'));
});

test('a declared P2.stopgate check yields no proposals, even with a typecheck script present', () => {
  const ps = buildProposals(args([check({ id: 'P2.stopgate', step: 10, state: 'declared', proposal: null })], { stack: typecheckStack }));
  assert.deepEqual(ps, []);
});

test('the shared redaction asset is proposed only once when both P2.sensor and P2.stopgate are absent in the same run', () => {
  const combinedStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['lint', 'typecheck'] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
  const ps = buildProposals(args([sensorCheck(), stopgateCheck()], { stack: combinedStack }));
  const redact = ps.filter(p => p.kind === 'file' && p.path === '.claude/scripts/harness-redact.mjs');
  assert.equal(redact.length, 1, 'the shared asset must not be proposed twice in a single batch');
  // Sanity: both generators genuinely fired (otherwise "proposed once"
  // would be true for the wrong reason — nobody but one generator ever
  // asked for it).
  assert.ok(ps.some(p => p.path === '.claude/scripts/lint-touched.mjs'));
  assert.ok(ps.some(p => p.path === '.claude/scripts/verify-touched.mjs'));
});

test('the shared redaction asset is not re-proposed when a prior run already recorded it in the manifest', () => {
  const manifest = { ...emptyManifest('0.2.0'), files: [{ path: '.claude/scripts/harness-redact.mjs', sha256: 'x', step: 9, writtenAt: new Date().toISOString() }] };
  const ps = buildProposals({ ...args([stopgateCheck()], { stack: typecheckStack }), manifest });
  assert.equal(ps.some(p => p.path === '.claude/scripts/harness-redact.mjs'), false);
  assert.ok(ps.some(p => p.path === '.claude/scripts/verify-touched.mjs'), 'the hook script itself is still proposed');
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

// --- P1.pathrules: globs from the workspace layout, bodies left empty -----

const fourPkgStack = {
  packages: [
    { name: 'root', dir: '.', manifestPath: 'package.json', scripts: [] },
    { name: '@acme/a', dir: 'packages/a', manifestPath: 'packages/a/package.json', scripts: [] },
    { name: '@acme/b', dir: 'packages/b', manifestPath: 'packages/b/package.json', scripts: [] },
    { name: '@acme/c', dir: 'packages/c', manifestPath: 'packages/c/package.json', scripts: [] },
    { name: '@acme/d', dir: 'packages/d', manifestPath: 'packages/d/package.json', scripts: [] },
  ],
  languages: ['typescript'], isWorkspace: true, packageManager: 'npm', ci: [],
};
const singlePkgStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: [] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
const pathrulesCheck = () => check({ id: 'P1.pathrules', step: 7, proposal: 'scaffold .claude/rules/ with globs derived from the workspace layout' });

test('P1.pathrules proposes one rule file per NON-ROOT package in a four-package workspace', () => {
  const ps = buildProposals(args([pathrulesCheck()], { stack: fourPkgStack }));
  assert.equal(ps.length, 4, 'the root package itself does not get its own rule file — it spans the whole repo, which CLAUDE.md already covers');
  assert.ok(ps.every(p => p.kind === 'file'));
  const paths = ps.map(p => p.path).sort();
  assert.deepEqual(paths, [
    '.claude/rules/packages-a.md',
    '.claude/rules/packages-b.md',
    '.claude/rules/packages-c.md',
    '.claude/rules/packages-d.md',
  ]);
});

test('each path-rule file carries the derived glob in its frontmatter paths: field', () => {
  const ps = buildProposals(args([pathrulesCheck()], { stack: fourPkgStack }));
  const a = ps.find(p => p.path === '.claude/rules/packages-a.md');
  assert.match(a.contents, /^---/, 'frontmatter must open the file');
  assert.match(a.contents, /paths:\s*\n\s*-\s*"packages\/a\/\*\*\/\*"/);
});

test('each path-rule file carries the package name as a heading and the compaction warning', () => {
  const ps = buildProposals(args([pathrulesCheck()], { stack: fourPkgStack }));
  const a = ps.find(p => p.path === '.claude/rules/packages-a.md');
  assert.match(a.contents, /^#\s+@acme\/a\s*$/m, 'the package name is a real heading');
  assert.match(a.contents, /compact/i, 'the compaction warning must be present');
  assert.match(a.contents, /CLAUDE\.md/, 'the warning must say where to put things that must survive compaction instead');
});

test('a path-rule file invents no rule content — everything past the heading is an HTML comment', () => {
  const ps = buildProposals(args([pathrulesCheck()], { stack: fourPkgStack }));
  const a = ps.find(p => p.path === '.claude/rules/packages-a.md');
  const afterHeading = a.contents.slice(a.contents.search(/^#\s+@acme\/a\s*$/m)).replace(/^#.*$/m, '').trim();
  assert.match(afterHeading, /^<!--[\s\S]*-->$/, 'nothing after the heading may read as a loadable instruction — comment, not content');
});

test('P1.pathrules proposes nothing for a single-package repository — no meaningful path split to scaffold', () => {
  const ps = buildProposals(args([pathrulesCheck()], { stack: singlePkgStack }));
  assert.deepEqual(ps, []);
});

test('P1.pathrules proposes nothing when stack.packages is empty (the default)', () => {
  const ps = buildProposals(args([pathrulesCheck()]));
  assert.deepEqual(ps, []);
});

test('a declared P1.pathrules check yields no proposals, even in a four-package workspace', () => {
  const ps = buildProposals(args([check({ id: 'P1.pathrules', step: 7, state: 'declared', proposal: null })], { stack: fourPkgStack }));
  assert.deepEqual(ps, []);
});

test('P1.pathrules version-stamps each generated file', () => {
  const ps = buildProposals(args([pathrulesCheck()], { stack: fourPkgStack }));
  for (const p of ps) assert.match(p.contents, /harness-kit 0\.2\.0/);
});

// --- root-anchored vs **-anchored forms must each cover their own case ----

const tsStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: [] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
const pyStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], languages: ['python'], isWorkspace: false, packageManager: null, ci: [] };

// --- Coordinator correction: requirements*.txt is a hand-edited manifest
// (Python's analogue of package.json, which this project deliberately does
// not protect — a deny rule there blocks "add a dependency", a legitimate,
// frequent action), not a lockfile, UNLESS a requirements*.in source backs
// it. pip-tools compiles requirements*.txt FROM requirements*.in, and a
// hand edit to the compiled file is silently lost on the next
// `pip-compile` — protecting it is correct in that case. See
// protected-evidence.mjs's own comment for the full rationale. This was
// itself a coherence defect of a different shape than the others: check
// and generator agreed with each other (both protected it
// unconditionally), but the rule they agreed on was wrong.

test('P2.protected does not propose a deny rule for requirements.txt without a requirements.in source', () => {
  const files = ['requirements.txt'];
  const ps = buildProposals(args([protectedCheck()], { files, stack: pyStack }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.equal(deny, undefined, 'a hand-edited requirements.txt is not a lockfile — no evidence, no proposal');
});

test('P2.protected proposes and delivers Edit(requirements.txt) — the literal filename — when its own requirements.in sibling is present', () => {
  const files = ['requirements.in', 'requirements.txt'];
  const ps = buildProposals(args([protectedCheck()], { files, stack: pyStack }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'requirements.in is evidence that requirements.txt is compiled output, not hand-edited');
  assert.ok(deny.globs.includes('Edit(requirements.txt)'));
});

// Coordinator correction, round 2: a glob-level gate ("does ANY
// requirements*.in exist") reintroduced the original defect on a narrower
// path — it protected requirements-dev.txt even with no
// requirements-dev.in of its own, which is exactly the false friction on a
// hand-edited file this whole fix exists to remove. The rule is now
// PER FILE: for each requirements*.txt the repository actually contains,
// swap .txt for .in and protect that exact file only if ITS OWN sibling
// exists. This is the discrimination test — both outcomes asserted
// together so the discrimination itself, not just one half of it, is the
// subject.
test('DISCRIMINATION: requirements.txt is protected but a sibling requirements-dev.txt with no .in of its own is not', () => {
  const files = ['requirements.in', 'requirements.txt', 'requirements-dev.txt'];
  // Fixture sanity: the file this test asserts is UNPROTECTED must
  // actually be present, or the assertion below passes on an empty
  // fixture rather than on a real discrimination — see this task's
  // test-quality instruction.
  assert.ok(files.includes('requirements-dev.txt'), 'fixture sanity: requirements-dev.txt must actually be present');
  const ps = buildProposals(args([protectedCheck()], { files, stack: pyStack }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'requirements.txt pairs with requirements.in and is protected');
  assert.ok(deny.globs.includes('Edit(requirements.txt)'), 'requirements.txt has its own .in sibling');
  assert.equal(deny.globs.includes('Edit(requirements-dev.txt)'), false, 'requirements-dev.txt has NO requirements-dev.in of its own — it must stay hand-editable');
  assert.equal(deny.globs.some(g => g.includes('requirements*')), false, 'no wildcard form may reappear and sweep requirements-dev.txt back in');
});

test('a requirements/ directory layout pairs the same way: requirements/base.in protects requirements/base.txt', () => {
  const files = ['requirements/base.in', 'requirements/base.txt'];
  const ps = buildProposals(args([protectedCheck()], { files, stack: pyStack }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'requirements/base.in is evidence that requirements/base.txt is compiled output');
  assert.ok(deny.globs.includes('Edit(requirements/base.txt)'));
});

test('P2.protected matches a root-level build output directory (dist/)', () => {
  // `**/dist/**` cannot match `dist/index.js` — `**` requires a literal `/`
  // before the final segment, so a root-level `dist/` (the only case a
  // single-package project ever has) would otherwise match nothing while
  // *looking* protected.
  const files = ['package.json', 'dist/index.js'];
  const ps = buildProposals(args([protectedCheck()], { files, stack: tsStack }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'a deny proposal is made');
  assert.ok(deny.globs.includes('Edit(dist/**)'), 'the root-level dist/ is matched by the root-anchored form');
});

test('P2.protected still matches a nested build output directory (build/) after the root-anchor fix', () => {
  const files = ['package.json', 'packages/api/build/out.js'];
  const ps = buildProposals(args([protectedCheck()], { files, stack: tsStack }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'a deny proposal is made');
  assert.ok(deny.globs.includes('Edit(**/build/**)'), 'the nested build/ is matched by the **-anchored form');
  assert.equal(deny.globs.includes('Edit(build/**)'), false, 'no root-level build/ exists, so that form finds no evidence');
});

test('P2.protected matches a root-level __pycache__ directory', () => {
  const files = ['pyproject.toml', '__pycache__/m.pyc'];
  const ps = buildProposals(args([protectedCheck()], { files, stack: pyStack }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'a deny proposal is made');
  assert.ok(deny.globs.includes('Edit(__pycache__/**)'), 'the root-level __pycache__/ is matched by the root-anchored form');
});

test('P2.protected still matches a nested __pycache__ directory after the root-anchor fix', () => {
  const files = ['pyproject.toml', 'pkg/sub/__pycache__/n.pyc'];
  const ps = buildProposals(args([protectedCheck()], { files, stack: pyStack }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'a deny proposal is made');
  assert.ok(deny.globs.includes('Edit(**/__pycache__/**)'), 'the nested __pycache__/ is matched by the **-anchored form');
  assert.equal(deny.globs.includes('Edit(__pycache__/**)'), false, 'no root-level __pycache__/ exists, so that form finds no evidence');
});

test('P2.protected matches root-level generated-output candidates, not only nested ones', () => {
  // The same root-anchor gap found in dist/build/__pycache__ also applies
  // to __generated__/ and *.generated.* — found by checking, not assumed.
  const files = ['package.json', '__generated__/x.ts', 'foo.generated.ts'];
  const ps = buildProposals(args([protectedCheck()], { files }));
  const deny = ps.find(p => p.kind === 'settings-deny');
  assert.ok(deny, 'a deny proposal is made');
  assert.ok(deny.globs.includes('Edit(__generated__/**)'), 'root-level __generated__/ is matched');
  assert.ok(deny.globs.includes('Edit(*.generated.*)'), 'root-level foo.generated.ts is matched');
});

test('buildProposals requires files explicitly — a caller that omits it gets a loud error, not a silent empty result', () => {
  // `files` has no default (see propose.mjs's comment on buildProposals).
  // Before this, omitting `files` silently resolved to `[]`, which made
  // P2.protected's evidence filter find nothing to propose for EVERY
  // candidate — indistinguishable from "this repository has nothing to
  // protect." That is exactly the silent-failure shape this task's fix
  // exists to eliminate, one level up from the glob matching itself.
  const { files, ...rest } = args([protectedCheck()], { files: ['pnpm-lock.yaml'] });
  assert.throws(() => buildProposals(rest), /Cannot read properties of undefined|files is not defined|undefined/);
});

// --- P1.bootstrap: the bootstrap script, from PROVEN steps only ------------
//
// Decidability is the point of this generator: it may only ever write what
// detection proved — the install command from the lockfile's own presence,
// and build/test lines from declared script NAMES. Everything else (a
// generic stack, no install command derivable at all) must yield no
// proposal, not a guessed one — see gap-model.mjs's own comment on why
// `absent` and `decidable` are two separate axes.
const bootstrapCheck = () => check({ id: 'P1.bootstrap', step: 5, proposal: 'create bootstrap' });

test('P1.bootstrap writes only steps detection proved', () => {
  // `files: ['pnpm-lock.yaml']` added (coordinator finding): without it
  // this exercised the PLAIN fallback (`pnpm install`, from `args()`'s
  // default `files: []`), not the deterministic form the brief's test
  // names — a casual reader would assume `pnpm install` here means the
  // frozen form. The parameterised `DETERMINISTIC` loop above already
  // covers the frozen form properly; this fixture now reads the way it
  // looks too.
  const stack = { languages: ['typescript'], packageManager: 'pnpm', isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build', 'test'] }], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['pnpm-lock.yaml'] }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.match(b.contents, /pnpm install --frozen-lockfile/);
  assert.match(b.contents, /pnpm build/);
  assert.match(b.contents, /pnpm test/);
  assert.equal(/lint/.test(b.contents), false, 'no lint script was declared, so none is invented');
});

// UNIT-LEVEL GUARD ONLY, and the fixture is chosen deliberately (coordinator
// finding): `packageManager: 'npm'` + `files: ['package-lock.json']` means
// `installCommand` WOULD succeed and `bootstrapProposal` WOULD return a
// proposal if the central `decidable === false` gate in `buildProposals`
// were not there — so this pins THAT gate for real, not the generator's own
// separate, internal "no install command derivable" guard (which an earlier
// version of this fixture — `packageManager: null` — could not distinguish
// from: removing the central gate left the generator's own guard still
// returning `[]`, so the test passed for the wrong reason). It does NOT
// exercise the real detection path: gap-model.mjs's actual check for a
// generic stack reports `state: 'n/a'`, never `absent` + `decidable: false`
// — see its own comment on why `n/a` is the more honest answer there, and
// the end-to-end test in detect-cli.test.mjs that pins THAT behaviour
// through the real CLI. This test is kept because the generator-level gate
// it pins is still real: a future caller (or a future check definition)
// COULD pass `decidable: false`, and this proves buildProposals honours it
// correctly even when the generator underneath it has every piece of
// evidence it needs.
test('UNIT: buildProposals\' central decidable:false gate proposes nothing, even though the generator could otherwise succeed', () => {
  const stack = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: [] }], ci: [] };
  const ps = buildProposals(args([check({ id: 'P1.bootstrap', step: 5, decidable: false })], { stack, files: ['package-lock.json'] }));
  assert.deepEqual(ps, [], 'the central decidable:false gate must short-circuit before the generator is ever called');
});

test('the generated script carries a version stamp and is executable shell', () => {
  const stack = { languages: ['typescript'], packageManager: 'pnpm', isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build', 'test'] }], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.match(b.contents, /^#!\/usr\/bin\/env bash\n/, 'the shebang must be the very first line');
  assert.match(b.contents, /^set -euo pipefail$/m);
  assert.match(b.contents, /harness-kit 0\.2\.0/, 'carries the version stamp');
  assert.match(b.contents, /runbook step 5/);
});

// Coordinator finding (Major): the "question, not a TODO" ruling — four
// review rounds settled it — had ZERO test coverage. Replacing the
// template's trailing question with `# TODO: add migrations, seed data,
// environment files` left 474/474 passing. A ruling with no test is a
// preference, not a constraint.
test('the generated script carries a commented QUESTION, never a TODO', () => {
  const stack = { languages: ['typescript'], packageManager: 'pnpm', isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build', 'test'] }], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['pnpm-lock.yaml'] }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.equal(/TODO/.test(b.contents), false, 'a TODO is an instruction to the agent; this must stay a question to the human');
  assert.match(b.contents, /^#.*\?$/m, 'the commented question must survive rendering');
});

// Ruling 1: CRLF silently destroys this deliverable (bad interpreter:
// /usr/bin/env bash^M at runtime) and the binary-file guard (glob.test.mjs)
// does not catch it — CR is not NUL. This must be asserted directly.
test('CRLF: the generated bootstrap script contains no CR bytes at all', () => {
  const stack = { languages: ['typescript'], packageManager: 'pnpm', isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build', 'test'] }], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.equal(b.contents.includes('\r'), false, 'a CRLF script fails at runtime with "bad interpreter" and is invisible to the NUL guard');
});

// Ruling 2: the deterministic, reproducible form is used verbatim whenever
// the lockfile that proves it is actually among `files` — never derived
// from `stack.packageManager` alone, because a bootstrap script exists for
// reproducibility and a form that can silently rewrite the lockfile from a
// clean checkout is a defect, not a convenience.
// `yarn` is deliberately NOT in this table — see the dedicated yarn tests
// immediately below it, and bootstrap-install.mjs's own comment, for why
// its frozen form cannot be a fixed string the way every other entry's is.
//
// `bun` contributes TWO rows (coordinator finding): Bun wrote `bun.lockb`
// (binary) through 1.1 and writes `bun.lock` (text) by default from 1.2
// onward, verified against Bun 1.4.2 — both must independently prove the
// same command.
//
// `poetry`'s form is plain `poetry install`, not `poetry install --sync`
// (coordinator correction): `--sync` is deprecated (Poetry 2.5.1) and was
// never load-bearing here — it only prunes packages installed but absent
// from the lockfile, and a clean checkout has nothing installed to prune.
const DETERMINISTIC = [
  ['npm', 'package-lock.json', 'npm ci'],
  ['pnpm', 'pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['bun', 'bun.lock', 'bun install --frozen-lockfile'],
  ['bun', 'bun.lockb', 'bun install --frozen-lockfile'],
  ['poetry', 'poetry.lock', 'poetry install'],
  ['uv', 'uv.lock', 'uv sync --frozen'],
  // pip is not a "frozen vs plain" pair the way the other entries are —
  // there is no `pip install --frozen` form — but `pip install -r
  // requirements.txt` IS derivable verbatim from requirements.txt's own
  // presence, which is exactly the evidence this table requires. See the
  // dedicated pip tests below for the no-requirements.txt case, which this
  // loop does not cover.
  ['pip', 'requirements.txt', 'pip install -r requirements.txt'],
];

for (const [pm, lockfile, command] of DETERMINISTIC) {
  test(`P1.bootstrap uses the reproducible install form verbatim for ${pm} when ${lockfile} is present`, () => {
    const stack = { languages: [], packageManager: pm, isWorkspace: false, packages: [], ci: [] };
    const ps = buildProposals(args([bootstrapCheck()], { stack, files: [lockfile] }));
    const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
    assert.ok(b, `expected a bootstrap proposal for ${pm}`);
    assert.match(b.contents, new RegExp('^' + command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));
    assert.equal(b.contents.includes('No ' + lockfile + ' found'), false, 'the lockfile IS present, so no fallback comment is warranted');
  });
}

// Yarn's frozen form depends on the lockfile's OWN CONTENT (Classic v1 vs
// Berry), not just its presence (coordinator Major): `--immutable` is
// Berry-only syntax, and Yarn 1.22.5 silently IGNORES the unknown flag and
// rewrites the lockfile anyway on drift — the exact failure the flag
// exists to prevent, verified by actually running it. `args()`'s `root()`
// creates a real directory but writes nothing into it, so these tests
// write the lockfile content themselves before calling buildProposals.
test('P1.bootstrap emits yarn install --frozen-lockfile for a Yarn Classic (v1) lockfile', () => {
  const d = root();
  writeFileSync(join(d, 'yarn.lock'),
    '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n' +
    '# yarn lockfile v1\n\n\nleft-pad@^1.3.0:\n  version "1.3.0"\n' +
    '  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz"\n');
  const stack = { languages: [], packageManager: 'yarn', isWorkspace: false, packages: [], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['yarn.lock'], root: d }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.match(b.contents, /yarn install --frozen-lockfile/);
  assert.equal(/--immutable/.test(b.contents), false,
    'Yarn Classic silently ignores --immutable and rewrites the lockfile on drift — verified against 1.22.5');
});

test('P1.bootstrap emits yarn install --immutable for a Yarn Berry lockfile', () => {
  const d = root();
  writeFileSync(join(d, 'yarn.lock'),
    '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n' +
    '"left-pad@npm:1.3.0":\n  version: 1.3.0\n  resolution: "left-pad@npm:1.3.0"\n');
  const stack = { languages: [], packageManager: 'yarn', isWorkspace: false, packages: [], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['yarn.lock'], root: d }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.match(b.contents, /yarn install --immutable/);
  assert.equal(/--frozen-lockfile/.test(b.contents), false);
});

test('P1.bootstrap falls back to plain yarn install when the lockfile\'s version cannot be read', () => {
  // `root` deliberately omitted: `files` says yarn.lock exists, but there
  // is no way to read its header, so this must never GUESS between the
  // two version-specific flags.
  const stack = { languages: [], packageManager: 'yarn', isWorkspace: false, packages: [], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['yarn.lock'] }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.match(b.contents, /^yarn install$/m);
  assert.equal(/--immutable|--frozen-lockfile/.test(b.contents), false);
});

test('P1.bootstrap falls back to the plain install form, with a comment, when no lockfile backs the detected package manager', () => {
  // `files` is deliberately empty: this is the one piece of evidence that
  // licenses the deterministic form, and it is independent of
  // `stack.packageManager` (a detection fact and a file-list fact, checked
  // separately on purpose — see propose.mjs's installCommand comment).
  const stack = { languages: [], packageManager: 'npm', isWorkspace: false, packages: [], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: [] }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.match(b.contents, /npm install/);
  assert.equal(/npm ci/.test(b.contents), false, 'npm ci is a lie without package-lock.json as evidence');
  assert.match(b.contents, /#.*package-lock\.json/, 'the fallback is disclosed in a comment, not silently swapped in');
});

test('P1.bootstrap proposes nothing when no install command is derivable, even though the check itself is decidable', () => {
  // This is the generator's OWN defensive gate, independent of the check's
  // `decidable` flag (exercised separately above) — belt-and-suspenders for
  // exactly the case the brief calls out: "no install command is derivable".
  const stack = { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack }));
  assert.deepEqual(ps, []);
});

// Coordinator finding: the original ruling's six-command list omitted pip
// entirely, and this generator correctly refused to invent a seventh form —
// but the ruling's list, not the refusal, was the defect. `pip install -r
// requirements.txt` IS derivable: requirements.txt's own presence is the
// evidence, exactly like every other lockfile in this table. There is no
// frozen/plain PAIR for pip (no `pip install --frozen`), so the gate is
// simply "does requirements.txt exist", not "is it the reproducible form".
test('P1.bootstrap proposes pip install -r requirements.txt when requirements.txt is present', () => {
  const stack = { languages: ['python'], packageManager: 'pip', isWorkspace: false,
    packages: [{ name: 'root', dir: '.', manifestPath: 'requirements.txt', scripts: [] }], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['requirements.txt'] }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b, 'requirements.txt is present, so the install command is derivable');
  assert.match(b.contents, /pip install -r requirements\.txt/);
});

// pip has no plain fallback: without requirements.txt there is no evidence
// at all for what to install (unlike npm/pnpm/etc, where the PLAIN form is
// still a reasonable guess even without the lockfile). `pip install -e .`
// from a bare pyproject.toml would be a guess about library-vs-application
// intent — exactly what this generator exists to refuse. The commented
// question in the generated template is what covers this case honestly.
test('P1.bootstrap proposes nothing for pip when requirements.txt is absent — there is no evidence-based form to fall back to', () => {
  const stack = { languages: ['python'], packageManager: 'pip', isWorkspace: false, packages: [], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: [] }));
  assert.deepEqual(ps, [], 'no requirements.txt means no evidence for any install form, frozen or plain');
});

test('P1.bootstrap derives build/test only from the ROOT package — a nested package\'s scripts are not the repository\'s own bootstrap', () => {
  // Same reasoning as P2.stopgate's own monorepo test above: a bootstrap
  // script is not tied to any one file, so there is no owning package to
  // resolve other than the root.
  const stack = {
    languages: ['typescript'], packageManager: 'npm', isWorkspace: true,
    packages: [
      { name: 'root', dir: '.', manifestPath: 'package.json', scripts: [] },
      { name: 'api', dir: 'packages/api', manifestPath: 'packages/api/package.json', scripts: ['build', 'test'] },
    ],
    ci: [],
  };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['package-lock.json'] }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b, 'install is still derivable from the lockfile alone');
  assert.match(b.contents, /npm ci/);
  assert.equal(/build/.test(b.contents), false, 'the nested package\'s build script is not the root\'s own bootstrap step');
  assert.equal(/\btest\b/.test(b.contents), false, 'the nested package\'s test script is not the root\'s own bootstrap step either');
});

test('P1.bootstrap never invents a lint step even when one IS declared on the root package', () => {
  const stack = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build', 'lint', 'test'] }], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['package-lock.json'] }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.match(b.contents, /npm run build/);
  assert.match(b.contents, /npm run test/);
  assert.equal(/lint/.test(b.contents), false, 'lint is declared but is still never written — only build/test are proven bootstrap steps');
});

// Ruling 4: Plan 1 shipped a Critical where package.json script BODIES were
// copied into generated output and leaked a credential. This generator only
// ever sees script NAMES (detect-stack.mjs strips bodies before the stack
// object exists at all), but this test proves it directly: even when a
// token-bearing body is reachable on the stack object (simulating a future
// detection regression), it never reaches the generated script.
test('SECRET: a token-bearing script body reachable on the stack object never appears in the generated bootstrap script', () => {
  const leakedToken = 'sentry-cli releases new --auth-token sk-leaked-TOKEN-should-never-appear';
  const stack = {
    languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
    packages: [{
      name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build', 'test'],
      // Not a real field detect-stack.mjs produces — simulates the exact
      // leak shape Plan 1 shipped, to prove this generator never reads it.
      scriptBodies: { build: leakedToken },
    }],
    ci: [],
  };
  // Sanity first: the fixture must actually carry the token somewhere
  // reachable, or "it never appears in output" would be true for the wrong
  // reason (the fixture never crossed the branch under test).
  assert.ok(JSON.stringify(stack).includes(leakedToken), 'fixture sanity: the token must actually be reachable on the stack object');
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['package-lock.json'] }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.equal(b.contents.includes(leakedToken), false, 'a script BODY must never be copied into generated output — names only');
  assert.equal(b.contents.includes('auth-token'), false);
});

test('a declared P1.bootstrap check yields no proposals, even with a full stack present', () => {
  const stack = { languages: ['typescript'], packageManager: 'pnpm', isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build', 'test'] }], ci: [] };
  const ps = buildProposals(args([check({ id: 'P1.bootstrap', step: 5, state: 'declared', proposal: null })], { stack, files: ['pnpm-lock.yaml'] }));
  assert.deepEqual(ps, []);
});

// --- P2.scripts: no generator exists, by construction -----------------------
//
// Ruling (coordinator, Task 7, step 4 — "the most valuable step in either
// task"): adding a missing lint/typecheck script means writing to
// package.json, deliberately outside apply-lib.mjs's write allowlist. The
// FIRST guard is gap-model.mjs always reporting P2.scripts as
// `decidable: false` (buildProposals' central gate never proposes it). This
// test defeats that guard ON PURPOSE — forcing `state: 'absent'` AND
// `decidable: true` — to prove a SECOND, independent guard still holds: no
// entry for 'P2.scripts' is registered in GENERATORS at all. The write
// allowlist must not be the only thing standing between this check and the
// user's package.json, the file a user is most likely to have hand-tuned.
test('SECRET: P2.scripts has no registered generator — forcing state absent and decidable:true still yields nothing', () => {
  assert.equal('P2.scripts' in GENERATORS, false, 'no generator may ever be registered for P2.scripts');
  const forced = check({ id: 'P2.scripts', step: 8, state: 'absent', decidable: true, proposal: 'add lint/typecheck scripts to 1 package(s)' });
  const ps = buildProposals(args([forced]));
  assert.deepEqual(ps, [], 'package.json must never be written, even when the decidability gate is forced open');
});

// --- COHERENCE: detect and propose must agree ------------------------------
//
// Major, caught by a coordinator review: gap-model.mjs's P1.bootstrap check
// used to advertise a proposal purely from `harness.bootstrap` being falsy,
// never checking whether its own generator could actually produce
// anything — so a pyproject-only Python repo got `absent` + a proposal from
// `detect`, and silently NOTHING from `apply`. Sharing the derivation
// (bootstrap-install.mjs) fixes THIS instance. This test guards the CLASS:
// run the REAL detection path (buildGaps, not a hand-built check object) on
// a handful of fixtures, and for every check it produces that advertises a
// proposal AND has a generator registered for its id (`GENERATORS`, read
// from propose.mjs — not a list this test maintains itself), applying that
// single check must yield at least one proposal. A future check/generator
// pair that drifts the same way fails this without anyone having to
// remember to add a case for it. Checks with no registered generator (e.g.
// P0.recon, P4.remote — prompt-only steps apply.mjs cannot act on, see
// lifecycle.test.mjs's own comment on P4.remote) are correctly skipped,
// not a false failure.
const harnessFixture = (overrides = {}) => ({
  instructions: { path: null, lines: 0 }, agentsMd: null, reconPresent: false,
  claudeDir: { settings: false, localSettings: false, denyRules: 0, hooks: [], hookEvents: {}, agents: [], skills: [], commands: [], rules: [] },
  otherEditors: [], architecture: null, handoff: null, bootstrap: null, gitattributes: false, remotes: [],
  ...overrides,
});

const COHERENCE_FIXTURES = [
  {
    name: 'TypeScript single package, nothing harnessed',
    stack: { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
      packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['lint', 'typecheck', 'test'] }], ci: [] },
    files: ['package.json', 'package-lock.json', 'tsconfig.json', 'src/index.ts'],
    harness: harnessFixture(),
  },
  {
    name: 'pnpm workspace, root declares lint/typecheck/test/build',
    stack: {
      languages: ['typescript'], packageManager: 'pnpm', isWorkspace: true,
      packages: [
        { name: 'root', dir: '.', manifestPath: 'package.json', scripts: ['lint', 'typecheck', 'test', 'build'] },
        { name: 'api', dir: 'packages/api', manifestPath: 'packages/api/package.json', scripts: [] },
      ],
      ci: [],
    },
    files: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/api/package.json'],
    harness: harnessFixture(),
  },
  {
    // Task 5b: this fixture used to pre-register PostToolUse/Stop and set
    // denyRules: 1, deliberately SIDESTEPPING P2.sensor, P2.stopgate and
    // P2.protected (reported `declared` regardless of real evidence) — see
    // the note this used to carry, preserved in git history, on the three
    // coherence gaps that writing this test first surfaced. Those sidesteps
    // existed only because the defect existed; now that the checks consult
    // the same evidence their generators do, this fixture exercises all
    // five generator-backed checks for a real pip python stack on their own
    // merits: P1.bootstrap proposes and delivers (requirements.txt is real
    // install evidence), and P2.sensor/P2.stopgate/P2.protected are all
    // correctly undecidable or n/a here — no lint/typecheck/test script
    // (Python has no script-name convention), and no requirements*.in, so
    // requirements.txt alone is a hand-edited manifest, not protected-path
    // evidence (see protected-evidence.mjs) — and so none of the three ever
    // reaches this test's loop at all.
    name: 'pip python repo with requirements.txt',
    stack: { languages: ['python'], packageManager: 'pip', isWorkspace: false,
      packages: [{ name: 'root', dir: '.', manifestPath: 'requirements.txt', scripts: [] }], ci: [] },
    files: ['requirements.txt', 'app.py'],
    harness: harnessFixture(),
  },
  {
    // This fixture is the regression itself: before the fix, this reported
    // `absent` + a proposal for P1.bootstrap with no generator able to
    // fulfil it. After the fix, decidable:false means NO proposal is
    // advertised here at all — so it contributes nothing to this test's
    // loop, by design, but is kept in the set as a living pin against the
    // defect recurring silently (a mutation reverting the gap-model.mjs fix
    // would make this fixture start advertising a proposal again, and this
    // test would catch it the moment that proposal's generator failed to
    // fulfil it). Task 5b removed this fixture's own PostToolUse/Stop/
    // denyRules sidesteps for the same reason as the fixture above — P2.sensor
    // and P2.stopgate are undecidable here too (no lint/typecheck/test
    // script), and P2.protected is correctly `n/a` (no requirements.txt, no
    // lockfile, nothing here to protect), so none of the three ever reaches
    // this test's loop either.
    name: 'pyproject-only python repo (no requirements.txt, no lockfile)',
    stack: { languages: ['python'], packageManager: null, isWorkspace: false,
      packages: [{ name: 'root', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] },
    files: ['pyproject.toml', 'app.py'],
    harness: harnessFixture(),
  },
];

test('COHERENCE: every check that advertises a proposal, and has a registered generator, actually yields one when applied', () => {
  let sawAtLeastOneGeneratedCheck = false;
  for (const { name, stack, files, harness } of COHERENCE_FIXTURES) {
    const profile = selectProfile(stack);
    const checks = buildGaps({ stack, harness, exposures: [], profile, git: { branch: 'main', isRepo: true }, files });
    for (const c of checks) {
      if (!c.proposal) continue;
      if (!(c.id in GENERATORS)) continue;
      sawAtLeastOneGeneratedCheck = true;
      const ps = buildProposals({
        checks: [c], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0',
        harness, root: root(), stack, files,
      });
      assert.ok(
        ps.some(p => p.checkId === c.id),
        `fixture "${name}": ${c.id} advertised a proposal ("${c.proposal}") but its own generator produced nothing when applied`,
      );
    }
  }
  // Sanity: the fixtures above must actually exercise at least one
  // generator-backed check, or this test would pass vacuously — exactly the
  // test-quality failure mode this project has caught multiple times before
  // (a fixture whose data never survives to the branch under test).
  assert.ok(sawAtLeastOneGeneratedCheck, 'fixture sanity: no check with a registered generator ever advertised a proposal — this test checked nothing');
});
