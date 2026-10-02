// scripts/lib/bootstrap-target-evidence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTargetEvidence, SETUP_TARGET_NAMES } from './bootstrap-target-evidence.mjs';

function repo() { return mkdtempSync(join(tmpdir(), 'hk-bte-')); }
function write(d, rel, content) { writeFileSync(join(d, rel), content); }

test('SETUP_TARGET_NAMES is exactly the four well-known convention names, in priority order', () => {
  assert.deepEqual(SETUP_TARGET_NAMES, ['setup', 'bootstrap', 'init', 'install']);
});

test('finds a bare "setup:" target in a Makefile', () => {
  const d = repo();
  write(d, 'Makefile', 'build:\n\ttsc\n\nsetup:\n\tnpm install\n');
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: true, target: 'setup' });
});

test('a build-only Makefile declares no setup-shaped target (the exact live defect this fixes)', () => {
  const d = repo();
  write(d, 'Makefile', 'build:\n\ttsc\n\ntest:\n\tjest\n');
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: false, target: null });
});

test('finds "install:" when it is the only one of the four names present', () => {
  const d = repo();
  write(d, 'Makefile', 'install:\n\tpip install -r requirements.txt\n');
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: true, target: 'install' });
});

test('when more than one of the four names is present, returns the one earliest in SETUP_TARGET_NAMES order', () => {
  const d = repo();
  write(d, 'Makefile', 'install:\n\techo installed\n\nbootstrap:\n\techo hi\n');
  // "bootstrap" sorts before "install" in SETUP_TARGET_NAMES.
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: true, target: 'bootstrap' });
});

test('a target mentioned only inside a comment is not credited', () => {
  const d = repo();
  write(d, 'Makefile', '# run `setup:` by hand if this ever gets a real target\nbuild:\n\ttsc\n');
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: false, target: null });
});

test('a trailing comment after a real line does not create a false match either way', () => {
  const d = repo();
  write(d, 'Makefile', 'build: # not setup, just has the word in a comment\n\ttsc\n');
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: false, target: null });
});

test('a Makefile VARIABLE named "setup" is not mistaken for a target (the := guard)', () => {
  const d = repo();
  write(d, 'Makefile', 'setup := not-a-target\nbuild:\n\ttsc\n');
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: false, target: null });
});

test('a Makefile variable using plain "=" is not mistaken for a target either', () => {
  const d = repo();
  write(d, 'Makefile', 'setup = not-a-target\n');
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: false, target: null });
});

test('a double-colon Makefile rule is recognised', () => {
  const d = repo();
  write(d, 'Makefile', 'setup::\n\tnpm install\n');
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: true, target: 'setup' });
});

test('finds a bare "setup:" recipe in a justfile', () => {
  const d = repo();
  write(d, 'justfile', 'build:\n    tsc\n\nsetup:\n    npm install\n');
  assert.deepEqual(setupTargetEvidence(d, 'justfile', 'just'), { found: true, target: 'setup' });
});

test('finds a justfile recipe with a bare (non-defaulted) parameter', () => {
  const d = repo();
  write(d, 'justfile', 'setup env:\n    npm install\n');
  assert.deepEqual(setupTargetEvidence(d, 'justfile', 'just'), { found: true, target: 'setup' });
});

test('a justfile VARIABLE named "setup" is not mistaken for a recipe', () => {
  const d = repo();
  write(d, 'justfile', "setup := 'not-a-recipe'\n");
  assert.deepEqual(setupTargetEvidence(d, 'justfile', 'just'), { found: false, target: null });
});

test('a build-only justfile declares no setup-shaped recipe', () => {
  const d = repo();
  write(d, 'justfile', 'build:\n    tsc\n');
  assert.deepEqual(setupTargetEvidence(d, 'justfile', 'just'), { found: false, target: null });
});

// --- Awkward inputs: never throw, never report found:true from a bad read ---

test('a missing Makefile is simply not found, never a throw', () => {
  const d = repo();
  assert.doesNotThrow(() => setupTargetEvidence(d, 'Makefile', 'make'));
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: false, target: null });
});

test('a Makefile that is actually a directory is not found, never a throw', () => {
  const d = repo();
  mkdirSync(join(d, 'Makefile'));
  assert.doesNotThrow(() => setupTargetEvidence(d, 'Makefile', 'make'));
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: false, target: null });
});

test('an empty Makefile is not found, never a throw', () => {
  const d = repo();
  write(d, 'Makefile', '');
  assert.doesNotThrow(() => setupTargetEvidence(d, 'Makefile', 'make'));
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: false, target: null });
});

test('a binary Makefile is not found, never a throw', () => {
  const d = repo();
  writeFileSync(join(d, 'Makefile'), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x00, 0x7f]));
  assert.doesNotThrow(() => setupTargetEvidence(d, 'Makefile', 'make'));
  assert.deepEqual(setupTargetEvidence(d, 'Makefile', 'make'), { found: false, target: null });
});
