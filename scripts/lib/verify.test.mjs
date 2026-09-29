import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCommands, defaultRun } from './verify.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.exitCode === 1));
});

test('a throwing runner is recorded as exit 1, not propagated', () => {
  const results = verifyCommands({ root: '/r', stack, profile, run: () => { throw new Error('ENOENT'); } });
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.exitCode === 1));
});

test('defaultRun executes a command that exits 0', () => {
  const exitZeroFile = join(tmpdir(), `exit-0-${Date.now()}.mjs`);
  writeFileSync(exitZeroFile, 'process.exit(0)');
  try {
    const result = defaultRun('.', '.', `node ${exitZeroFile}`);
    assert.equal(result.exitCode, 0);
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.durationMs >= 0);
  } finally {
    unlinkSync(exitZeroFile);
  }
});

test('defaultRun captures the actual exit code, not flattened to 1', () => {
  const exitThreeFile = join(tmpdir(), `exit-3-${Date.now()}.mjs`);
  writeFileSync(exitThreeFile, 'process.exit(3)');
  try {
    const result = defaultRun('.', '.', `node ${exitThreeFile}`);
    assert.equal(result.exitCode, 3);
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.durationMs >= 0);
  } finally {
    unlinkSync(exitThreeFile);
  }
});
