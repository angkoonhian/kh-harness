import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, renderSummary, deriveCouldNotDerive } from './report.mjs';
import { buildGaps } from './gap-model.mjs';
import { selectProfile } from './profiles/index.mjs';

const stack = { languages: ['typescript'], packageManager: 'pnpm', isWorkspace: true,
  packages: Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, dir: `packages/p${i}`, manifestPath: `packages/p${i}/package.json`, scripts: [] })), ci: [] };
const checks = [
  { id: 'P1.bootstrap', step: 5, phase: 1, state: 'absent', lookedFor: [], evidence: [], proposal: 'create scripts/bootstrap.sh' },
  { id: 'P1.instructions', step: 6, phase: 1, state: 'declared', lookedFor: [], evidence: ['CLAUDE.md (28 lines)'], proposal: null },
  { id: 'P2.sensor', step: 9, phase: 2, state: 'n/a', lookedFor: [], evidence: [], proposal: null },
];
const base = { root: '/r', kitVersion: '0.1.0', git: { branch: 'main', isRepo: true },
  stack, harness: {}, exposures: [], profile: { id: 'typescript-workspace' }, checks };

test('report carries schema and kit version', () => {
  const r = buildReport(base);
  assert.equal(r.schema, 1);
  assert.equal(r.kitVersion, '0.1.0');
  assert.equal(r.profile, 'typescript-workspace');
});

test('report has an ISO timestamp', () => {
  assert.ok(!Number.isNaN(Date.parse(buildReport(base).generatedAt)));
});

test('summary names every phase and the counts', () => {
  const s = renderSummary(buildReport(base));
  assert.ok(s.includes('P1.bootstrap'));
  assert.ok(/absent/.test(s));
  assert.ok(/1 proposal/.test(s));
});

test('summary states plainly when nothing is proposed', () => {
  const r = buildReport({ ...base, checks: [checks[1]] });
  assert.ok(/no proposals/i.test(renderSummary(r)));
});

test('a large workspace raises the sensor-scope question', () => {
  const q = deriveCouldNotDerive({ stack, checks });
  assert.ok(q.some(s => /sensor/i.test(s) && /7/.test(s)));
});

test('a single-package repo raises no sensor-scope question', () => {
  const one = { ...stack, isWorkspace: false, packages: [stack.packages[0]] };
  assert.equal(deriveCouldNotDerive({ stack: one, checks }).some(s => /sensor/i.test(s)), false);
});

test('couldNotDerive is included in the report', () => {
  assert.ok(Array.isArray(buildReport(base).couldNotDerive));
});

test('deriveCouldNotDerive raises the nested-repository question when nested is non-empty', () => {
  const nested = [{ path: 'app', kind: 'submodule' }];
  const q = deriveCouldNotDerive({ stack, checks, nested });
  assert.ok(q.some(s => /nested repositor/i.test(s) && /app/.test(s)));
});

test('deriveCouldNotDerive does not raise the nested-repository question when nested is empty', () => {
  const q = deriveCouldNotDerive({ stack, checks, nested: [] });
  assert.equal(q.some(s => /nested repositor/i.test(s)), false);
});

test('renderSummary includes the nested disclosure block and places it before the exposures section', () => {
  const nested = [{ path: 'app', kind: 'submodule' }, { path: 'services/api', kind: 'nested-repo' }];
  const r = buildReport({ ...base, nested, exposures: [{ kind: 'token', location: '.env', severity: 'high' }] });
  const s = renderSummary(r);
  const nestedPos = s.indexOf('Nested repositories');
  const exposuresPos = s.indexOf('Exposures');
  assert.ok(nestedPos > -1);
  assert.ok(exposuresPos > -1);
  assert.ok(nestedPos < exposuresPos, 'nested block should come before exposures');
  assert.ok(s.includes('app (submodule)'));
  assert.ok(s.includes('services/api (nested-repo)'));
});

test('renderSummary omits the nested block entirely when nested is empty', () => {
  const r = buildReport(base);
  const s = renderSummary(r);
  assert.equal(s.includes('Nested repositories'), false);
});

test('deriveCouldNotDerive raises stack detection question when profile is generic', () => {
  const q = deriveCouldNotDerive({ stack, checks, profile: { id: 'generic' } });
  assert.ok(q.some(s => /stack/i.test(s) && /confidence/i.test(s)));
});

test('deriveCouldNotDerive does not raise stack question for non-generic profile', () => {
  const q = deriveCouldNotDerive({ stack, checks, profile: { id: 'typescript-workspace' } });
  assert.equal(q.some(s => /stack.*confidence/i.test(s)), false);
});

// --- Advice: distinct from proposals (Task 7) -------------------------------
//
// Ruling (coordinator): "the tool will do this" (a proposal) and "you
// should do this" (advice) must read as visibly different things — advice
// gets its own section, never folded into the `→` proposal lines.

test('renderSummary prints advice in its own section, distinct from proposals', () => {
  const withAdvice = [
    ...checks,
    {
      id: 'P2.scripts', step: 8, phase: 2, state: 'absent', lookedFor: [], evidence: ['app: missing lint'],
      decidable: false, proposal: null,
      advice: ['app: add "lint": "eslint ." to package.json — derived from the ESLint config found in this repository'],
    },
  ];
  const s = renderSummary(buildReport({ ...base, checks: withAdvice }));
  assert.ok(s.includes('Advice'), 'an Advice section must exist');
  assert.ok(s.includes('app: add "lint"'));
  // Distinct from proposals: the advice text must never appear on a `→` line.
  assert.equal(/→.*add "lint"/.test(s), false, 'advice must not be rendered as though it were a proposal');
});

test('renderSummary omits the Advice section entirely when no check carries advice', () => {
  const s = renderSummary(buildReport(base));
  assert.equal(s.includes('Advice'), false);
});

// Whole-branch review, F13: a `SECRET: a token-bearing script body never
// reaches <X>` test used to sit here. It was unfalsifiable by construction —
// its fixture put the token in a `scriptBodies` field, and
// `grep -rn scriptBodies scripts/ assets/` finds ZERO production readers:
// `detectStack` never emits such a field and nothing consumes one. The test
// asserted that a token placed in a field no code reads does not come out of
// code that does not read it, and the `assert.ok(JSON.stringify(stack)
// .includes(leakedToken), 'fixture sanity: ...')` guard it carried made that
// harder to see, not easier — it proved the token was on the fixture object,
// never that it reached the function.
//
// Measured, not argued: making `detectStack` actually emit script BODIES —
// the only way a `scriptBodies` leak could ever happen — is killed by ONE
// test, and it is not any of the three carrying this label. It is
// `detect-cli.test.mjs`'s `SECURITY: a package.json script body never
// reaches stdout or detect.json`, which writes a real `package.json` with
// `sentry-cli --auth-token <marker>` in a script body, runs the real CLI,
// and checks stdout, detect.json AND the human summary — then asserts the
// script's PRESENCE still survives, so the fix cannot be "stop reporting
// scripts". That test holds this guarantee.
//
// Deleted rather than kept, per the rule this branch adopted: a test whose
// name claims a guarantee it does not provide is worse than no test, because
// it stops the next person looking. The one surface the real guard did NOT
// cover — the contents of the files the GENERATORS write — is now pinned by
// `SECURITY: no generated file contains a package.json script BODY` in
// propose.test.mjs, through real `detectStack` output from a real fixture.
test('exposures heading is self-contained and names nested count', () => {
  const nested = [{ path: 'app', kind: 'submodule' }, { path: 'vendor/toolA', kind: 'nested-repo' }];
  const r = buildReport({ ...base, nested, exposures: [{ kind: 'token', location: '.env', severity: 'high' }] });
  const s = renderSummary(r);
  assert.ok(s.includes('this repository only'));
  assert.ok(s.includes('2 nested repositories'));
  assert.ok(s.includes('not scanned'));
});

// --- Task 9b, finding 1: the exposure summary collapses reference-valued
// credentials-in-doc hits to a count, keeping literals (and every other
// kind) prominent and individually listed.

test('renderSummary shows a literal credentials-in-doc hit prominently and collapses reference-valued hits to one count line', () => {
  const exposures = [
    { kind: 'token-in-remote-url', location: 'git remote "origin"', severity: 'high' },
    { kind: 'credentials-in-doc', location: 'docs/real.md', severity: 'medium', valueKind: 'literal' },
    ...Array.from({ length: 62 }, (_, i) => ({ kind: 'credentials-in-doc', location: `src/f${i}.ts`, severity: 'medium', valueKind: 'reference' })),
  ];
  const checks = [{ id: 'P0.security', step: 3, phase: 0, state: 'failing', lookedFor: [], evidence: ['token-in-remote-url at git remote "origin"', 'credentials-in-doc at docs/real.md'], proposal: null }];
  const s = renderSummary(buildReport({ ...base, checks, exposures }));
  assert.ok(s.includes('Exposures (2)'), 'the heading must count only the prominent findings');
  assert.ok(s.includes('token-in-remote-url at git remote "origin"'));
  assert.ok(s.includes('credentials-in-doc at docs/real.md'));
  // None of the 62 reference-valued hits is printed as an individual line.
  assert.equal((s.match(/credentials-in-doc at src\/f/g) ?? []).length, 0);
  assert.ok(s.includes('62 credential-shaped'), 'the collapsed count must be disclosed');
  assert.ok(s.includes('not shown here'));
});

test('renderSummary omits the collapsed-count line entirely when there is nothing to collapse', () => {
  const r = buildReport({ ...base, exposures: [{ kind: 'token-in-remote-url', location: 'origin', severity: 'high' }] });
  assert.equal(renderSummary(r).includes('code reference'), false);
});
