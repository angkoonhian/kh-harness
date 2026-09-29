import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCommands } from './verify.mjs';

const stack = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
  packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: { test: 'vitest', build: 'tsc' } }], ci: [] };
const profile = {
  id: 'typescript-single',
  commands: pkg => ({ install: 'npm ci', build: pkg.scripts.build ? 'npm run build' : null, test: pkg.scripts.test ? 'npm run test' : null, lint: null, typecheck: null }),
};

test('runs only the commands that exist', () => {
  const seen = [];
  const run = cmd => { seen.push(cmd); return { exitCode: 0, durationMs: 5 }; };
  const results = verifyCommands({ root: '/r', stack, profile, run });
  assert.deepEqual(seen.sort(), ['npm run build', 'npm run test']);
  assert.equal(results.length, 2);
});

test('never runs install', () => {
  const seen = [];
  verifyCommands({ root: '/r', stack, profile, run: c => { seen.push(c); return { exitCode: 0, durationMs: 1 }; } });
  assert.equal(seen.includes('npm ci'), false);
});

test('records a non-zero exit without throwing', () => {
  const results = verifyCommands({ root: '/r', stack, profile, run: () => ({ exitCode: 1, durationMs: 9 }) });
  assert.ok(results.every(r => r.exitCode === 1));
});

test('a throwing runner is recorded as exit 1, not propagated', () => {
  const results = verifyCommands({ root: '/r', stack, profile, run: () => { throw new Error('ENOENT'); } });
  assert.ok(results.every(r => r.exitCode === 1));
});
