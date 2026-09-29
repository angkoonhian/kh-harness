import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProfile } from './index.mjs';

const tsSingle = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
  packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: { test: 'vitest' } }], ci: [] };
const tsWorkspace = { ...tsSingle, packageManager: 'pnpm', isWorkspace: true,
  packages: [tsSingle.packages[0], { name: 'b', dir: 'packages/b', manifestPath: 'packages/b/package.json', scripts: {} }] };
const py = { languages: ['python'], packageManager: 'uv', isWorkspace: false,
  packages: [{ name: 'svc', dir: '.', manifestPath: 'pyproject.toml', scripts: {} }], ci: [] };
const nothing = { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] };

test('selects typescript-single', () => {
  assert.equal(selectProfile(tsSingle).id, 'typescript-single');
});

test('selects typescript-workspace', () => {
  assert.equal(selectProfile(tsWorkspace).id, 'typescript-workspace');
});

test('selects python', () => {
  assert.equal(selectProfile(py).id, 'python');
});

test('falls back to generic below 0.5 confidence', () => {
  assert.equal(selectProfile(nothing).id, 'generic');
});

test('commands use the detected package manager', () => {
  const p = selectProfile(tsWorkspace);
  const c = p.commands(tsWorkspace.packages[1]);
  assert.ok(c.install.startsWith('pnpm'));
});

test('a missing script yields null, never a guess', () => {
  const p = selectProfile(tsSingle);
  const c = p.commands(tsSingle.packages[0]);
  assert.equal(c.test, 'npm run test');
  assert.equal(c.lint, null);
  assert.equal(c.typecheck, null);
});

test('generic declares a reduced step set', () => {
  const steps = selectProfile(nothing).appliesToSteps();
  assert.equal(steps.includes(9), false);   // no per-edit sensor without a stack
  assert.ok(steps.includes(6));             // instruction file still applies
});

test('no profile encodes a framework or database opinion', () => {
  for (const s of [tsSingle, tsWorkspace, py, nothing]) {
    const blob = JSON.stringify(selectProfile(s).protectedGlobs());
    assert.equal(/react|postgres|tailwind|next|django/i.test(blob), false);
  }
});
