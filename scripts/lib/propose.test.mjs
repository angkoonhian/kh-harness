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

// --- root-anchored vs **-anchored forms must each cover their own case ----

const tsStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: [] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
const pyStack = { packages: [{ name: 'app', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], languages: ['python'], isWorkspace: false, packageManager: null, ci: [] };

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
  const stack = { languages: ['typescript'], packageManager: 'pnpm', isWorkspace: false,
    packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build', 'test'] }], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack }));
  const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
  assert.ok(b);
  assert.match(b.contents, /pnpm install/);
  assert.match(b.contents, /pnpm build/);
  assert.match(b.contents, /pnpm test/);
  assert.equal(/lint/.test(b.contents), false, 'no lint script was declared, so none is invented');
});

test('P1.bootstrap proposes nothing for a generic stack', () => {
  const stack = { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] };
  const ps = buildProposals(args([check({ id: 'P1.bootstrap', step: 5, decidable: false })], { stack }));
  assert.deepEqual(ps, [], 'an undecidable check proposes nothing');
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
const DETERMINISTIC = [
  ['npm', 'package-lock.json', 'npm ci'],
  ['pnpm', 'pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn', 'yarn.lock', 'yarn install --immutable'],
  ['bun', 'bun.lockb', 'bun install --frozen-lockfile'],
  ['poetry', 'poetry.lock', 'poetry install --sync'],
  ['uv', 'uv.lock', 'uv sync --frozen'],
];

for (const [pm, lockfile, command] of DETERMINISTIC) {
  test(`P1.bootstrap uses the reproducible install form verbatim for ${pm} when ${lockfile} is present`, () => {
    const stack = { languages: [], packageManager: pm, isWorkspace: false, packages: [], ci: [] };
    const ps = buildProposals(args([bootstrapCheck()], { stack, files: [lockfile] }));
    const b = ps.find(p => p.path === 'scripts/bootstrap.sh');
    assert.ok(b, `expected a bootstrap proposal for ${pm}`);
    assert.match(b.contents, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(b.contents.includes('No ' + lockfile + ' found'), false, 'the lockfile IS present, so no fallback comment is warranted');
  });
}

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

test('P1.bootstrap proposes nothing for pip — requirements.txt carries no frozen/plain distinction in the verbatim command list', () => {
  const stack = { languages: ['python'], packageManager: 'pip', isWorkspace: false,
    packages: [{ name: 'root', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] };
  const ps = buildProposals(args([bootstrapCheck()], { stack, files: ['requirements.txt'] }));
  assert.deepEqual(ps, [], 'pip has no verbatim reproducible form in this list, so nothing is guessed');
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
