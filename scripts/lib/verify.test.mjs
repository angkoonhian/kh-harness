import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCommands, defaultRun } from './verify.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const stack = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false,
  packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['build', 'test'] }], ci: [] };
const profile = {
  id: 'typescript-single',
  commands: pkg => ({ install: 'npm ci', build: pkg.scripts.includes('build') ? 'npm run build' : null, test: pkg.scripts.includes('test') ? 'npm run test' : null, lint: null, typecheck: null }),
};

test('runs only the commands that exist', () => {
  const seen = [];
  const run = cmd => { seen.push(cmd); return { exitCode: 0, durationMs: 5 }; };
  const results = verifyCommands({ root: '/r', stack, profile, run });
  assert.deepEqual(seen.sort(), ['npm run test']);
  assert.equal(results.length, 1);
});

test('never runs install', () => {
  const seen = [];
  verifyCommands({ root: '/r', stack, profile, run: c => { seen.push(c); return { exitCode: 0, durationMs: 1 }; } });
  assert.equal(seen.includes('npm ci'), false);
});

test('records a non-zero exit without throwing', () => {
  const results = verifyCommands({ root: '/r', stack, profile, run: () => ({ exitCode: 1, durationMs: 9 }) });
  assert.equal(results.length, 1);
  assert.ok(results.every(r => r.exitCode === 1));
});

test('a throwing runner is recorded as exit 1, not propagated', () => {
  const results = verifyCommands({ root: '/r', stack, profile, run: () => { throw new Error('ENOENT'); } });
  assert.equal(results.length, 1);
  assert.ok(results.every(r => r.exitCode === 1));
});

test('defaultRun executes a command that exits 0', () => {
  const exitZeroFile = join(tmpdir(), `exit-0-${Date.now()}.mjs`);
  writeFileSync(exitZeroFile, 'process.exit(0)');
  try {
    // Quoted: TEMP contains a space on plenty of Windows installs.
    const result = defaultRun('.', '.', `node "${exitZeroFile}"`);
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
    const result = defaultRun('.', '.', `node "${exitThreeFile}"`);
    assert.equal(result.exitCode, 3);
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.durationMs >= 0);
  } finally {
    unlinkSync(exitThreeFile);
  }
});

// --- Audit Tier 2, finding 9: --verify mutated the tree it verified and
// --- hid what failed ----------------------------------------------------------
//
// `build` wrote 1,350 compiled files into a fixture's src/ (a tsconfig with
// no outDir); a timeout was recorded as a plain exit 1; and a watch-mode
// test runner could hang for the whole bound. build joins install on the
// never-run list, a timeout is recorded as one, and CI=1 is set.

test('never runs build — it writes into the tree', () => {
  const seen = [];
  verifyCommands({ root: '/r', stack, profile, run: c => { seen.push(c); return { exitCode: 0, durationMs: 1 }; } });
  assert.equal(seen.includes('npm run build'), false);
  assert.deepEqual(seen, ['npm run test'], 'test, lint and typecheck are the only kinds run');
});

test('every verification record carries timedOut, false when the runner did not say', () => {
  const results = verifyCommands({ root: '/r', stack, profile, run: () => ({ exitCode: 0, durationMs: 1 }) });
  assert.ok(results.length > 0);
  for (const r of results) assert.equal(r.timedOut, false);
  const timedOut = verifyCommands({ root: '/r', stack, profile, run: () => ({ exitCode: null, durationMs: 9, timedOut: true }) });
  assert.equal(timedOut[0].timedOut, true);
});

test('defaultRun marks a command killed by the timeout as timedOut', () => {
  const sleeper = join(tmpdir(), `sleep-${Date.now()}.mjs`);
  writeFileSync(sleeper, 'setTimeout(() => {}, 5000);');
  try {
    const result = defaultRun('.', '.', `node "${sleeper}"`, { timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null, 'a command that never exited has no exit code');
    assert.ok(result.durationMs < 4000, 'the bound, not the command, decided when this ended');
  } finally {
    unlinkSync(sleeper);
  }
});

test('defaultRun runs the command with CI=1 so watch modes do not hang', () => {
  const probe = join(tmpdir(), `ci-${Date.now()}.mjs`);
  writeFileSync(probe, "process.exit(process.env.CI === '1' ? 0 : 7);");
  try {
    const result = defaultRun('.', '.', `node "${probe}"`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  } finally {
    unlinkSync(probe);
  }
});
