import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, renderSummary, deriveCouldNotDerive } from './report.mjs';

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

test('exposures heading is self-contained and names nested count', () => {
  const nested = [{ path: 'app', kind: 'submodule' }, { path: 'vendor/toolA', kind: 'nested-repo' }];
  const r = buildReport({ ...base, nested, exposures: [{ kind: 'token', location: '.env', severity: 'high' }] });
  const s = renderSummary(r);
  assert.ok(s.includes('this repository only'));
  assert.ok(s.includes('2 nested repositories'));
  assert.ok(s.includes('not scanned'));
});
