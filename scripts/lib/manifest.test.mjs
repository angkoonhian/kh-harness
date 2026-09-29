import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, emptyManifest, readManifest, writeManifest, classify } from './manifest.mjs';

function repo() { return mkdtempSync(join(tmpdir(), 'hk-man-')); }
function write(d, rel, content) {
  const p = join(d, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

test('sha256 is stable and distinguishes content', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.notEqual(sha256('a'), sha256('b'));
  assert.match(sha256('a'), /^[0-9a-f]{64}$/);
});

test('readManifest returns null when absent', () => {
  assert.equal(readManifest(repo()), null);
});

test('a written manifest round-trips', () => {
  const d = repo();
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256('x'), step: 16, writtenAt: '2026-09-29T00:00:00Z' });
  writeManifest(d, m);
  const back = readManifest(d);
  assert.equal(back.schema, 1);
  assert.equal(back.files.length, 1);
  assert.equal(back.files[0].path, 'HANDOFF.md');
});

test('classify: a file we wrote and nobody touched', () => {
  const d = repo();
  write(d, 'HANDOFF.md', 'x');
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256('x'), step: 16, writtenAt: 'now' });
  assert.equal(classify(d, m, 'HANDOFF.md'), 'ours-unmodified');
});

test('classify: a file we wrote and the user edited', () => {
  const d = repo();
  write(d, 'HANDOFF.md', 'x EDITED');
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256('x'), step: 16, writtenAt: 'now' });
  assert.equal(classify(d, m, 'HANDOFF.md'), 'ours-modified');
});

test('classify: a file we never wrote is theirs', () => {
  const d = repo();
  write(d, 'CLAUDE.md', 'hand written');
  assert.equal(classify(d, emptyManifest('0.1.0'), 'CLAUDE.md'), 'theirs');
});

test('classify: a manifest entry whose file was deleted is ours-modified, not a throw', () => {
  const d = repo();
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256('x'), step: 16, writtenAt: 'now' });
  assert.equal(classify(d, m, 'HANDOFF.md'), 'ours-modified');
});

test('a corrupt manifest reads as null rather than throwing', () => {
  const d = repo();
  write(d, '.claude/harness-kit.manifest.json', '{ not json');
  assert.equal(readManifest(d), null);
});
