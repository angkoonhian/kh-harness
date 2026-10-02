import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProfile } from './index.mjs';

const tsSingle = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
  packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['test'] }], ci: [] };
const tsWorkspace = { ...tsSingle, packageManager: 'pnpm', isWorkspace: true,
  packages: [tsSingle.packages[0], { name: 'b', dir: 'packages/b', manifestPath: 'packages/b/package.json', scripts: [] }] };
const py = { languages: ['python'], packageManager: 'uv', isWorkspace: false,
  packages: [{ name: 'svc', dir: '.', manifestPath: 'pyproject.toml', scripts: [] }], ci: [] };
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

test('python profile returns null for guessable commands', () => {
  const p = selectProfile(py);
  const c = p.commands(py.packages[0]);
  assert.ok(c.install !== null); // install is evidence-based from lockfile
  assert.equal(c.build, null);
  assert.equal(c.test, null);
  assert.equal(c.lint, null);
  assert.equal(c.typecheck, null);
});

test('generic declares a reduced step set', () => {
  const steps = selectProfile(nothing).appliesToSteps();
  assert.equal(steps.includes(9), false);   // no per-edit sensor without a stack
  assert.ok(steps.includes(6));             // instruction file still applies
});

test('no profile encodes a framework or database opinion', () => {
  const forbidden = /react|postgres|tailwind|next|django|migrations|migrate|src\/|app\/|lib\/|components|models|controllers/i;
  for (const s of [tsSingle, tsWorkspace, py, nothing]) {
    const profile = selectProfile(s);
    // Check all output surfaces for structural or product opinions
    const surfaces = [
      JSON.stringify(profile.protectedGlobs()),
      JSON.stringify(profile.commands({ name: 'test', dir: '.', manifestPath: 'package.json', scripts: [] })),
    ];
    for (const surface of surfaces) {
      assert.equal(forbidden.test(surface), false, `Profile ${profile.id} contains forbidden pattern in: ${surface.substring(0, 100)}`);
    }
  }
});
