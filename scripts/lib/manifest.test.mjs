import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256, emptyManifest, readManifest, readManifestResult, writeManifest, classify, normalizeLineEndings } from './manifest.mjs';

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

// --- readManifestResult: distinguishes "missing" from "corrupt" (Task 8b
// Major finding) — readManifest itself still collapses both to null, for
// detect.mjs (fails safe either way) and uninstall.mjs (already refuses on
// either); apply.mjs needs the distinction to refuse ONLY on the corrupt
// case, rather than silently starting over with an empty manifest.

test('readManifestResult: missing file', () => {
  assert.deepEqual(readManifestResult(repo()), { state: 'missing', manifest: null });
});

test('readManifestResult: a valid manifest reads back ok', () => {
  const d = repo();
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256('x'), step: 16, writtenAt: '2026-09-29T00:00:00Z' });
  writeManifest(d, m);
  const r = readManifestResult(d);
  assert.equal(r.state, 'ok');
  assert.equal(r.manifest.files.length, 1);
});

test('readManifestResult: unparseable JSON is corrupt, not missing', () => {
  const d = repo();
  write(d, '.claude/kh-harness.manifest.json', '{ not json');
  assert.deepEqual(readManifestResult(d), { state: 'corrupt', manifest: null });
});

test('readManifestResult: valid JSON but the wrong schema (e.g. an array, or missing `files`) is corrupt', () => {
  const d = repo();
  write(d, '.claude/kh-harness.manifest.json', JSON.stringify({ schema: 1 })); // no `files` array
  assert.deepEqual(readManifestResult(d), { state: 'corrupt', manifest: null });

  const d2 = repo();
  write(d2, '.claude/kh-harness.manifest.json', JSON.stringify([1, 2, 3]));
  assert.deepEqual(readManifestResult(d2), { state: 'corrupt', manifest: null });
});

test('readManifest and readManifestResult agree on every case', () => {
  // readManifest is defined IN TERMS OF readManifestResult now — pinned so
  // a future edit cannot let the two drift back apart silently.
  const missing = repo();
  assert.equal(readManifest(missing), readManifestResult(missing).manifest);

  const corrupt = repo();
  write(corrupt, '.claude/kh-harness.manifest.json', '{ not json');
  assert.equal(readManifest(corrupt), readManifestResult(corrupt).manifest);

  const ok = repo();
  writeManifest(ok, emptyManifest('0.1.0'));
  assert.deepEqual(readManifest(ok), readManifestResult(ok).manifest);
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

// Ruling: a repository's OWN scripts/bootstrap.sh is likely load-bearing —
// never assume the generic "theirs" mechanism covers this path; pin it
// explicitly so a future change to classify() cannot silently narrow what
// counts as "theirs" without this exact path still being caught.
test('classify: a repository\'s own scripts/bootstrap.sh is theirs, never ours', () => {
  const d = repo();
  write(d, 'scripts/bootstrap.sh', '#!/usr/bin/env bash\necho "the user\'s own bootstrap"\n');
  assert.equal(classify(d, emptyManifest('0.1.0'), 'scripts/bootstrap.sh'), 'theirs');
});

test('classify: a manifest entry whose file was deleted is ours-modified, not a throw', () => {
  const d = repo();
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256('x'), step: 16, writtenAt: 'now' });
  assert.equal(classify(d, m, 'HANDOFF.md'), 'ours-modified');
});

test('a corrupt manifest reads as null rather than throwing', () => {
  const d = repo();
  write(d, '.claude/kh-harness.manifest.json', '{ not json');
  assert.equal(readManifest(d), null);
});

test('sha256 distinguishes files with different bytes that decode to same UTF-8', () => {
  const buf1 = Buffer.from([0x41, 0xFF, 0x42]);
  const buf2 = Buffer.from([0x41, 0xFE, 0x42]);
  // Both decode to "A�B" as UTF-8, so UTF-8 decoding is lossy
  const decoded1 = buf1.toString('utf8');
  const decoded2 = buf2.toString('utf8');
  assert.equal(decoded1, decoded2);
  // But raw byte hashes must differ
  assert.notEqual(sha256(buf1), sha256(buf2));
});

test('classify with two files of different bytes but same UTF-8 decoding', () => {
  const d = repo();
  const buf1 = Buffer.from([0x41, 0xFF, 0x42]);
  const buf2 = Buffer.from([0x41, 0xFE, 0x42]);
  // Write buf1, manifest records its hash
  writeFileSync(join(d, 'test.dat'), buf1);
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'test.dat', sha256: sha256(buf1), step: 1, writtenAt: 'now' });
  // Verify it classifies as ours-unmodified when unchanged
  assert.equal(classify(d, m, 'test.dat'), 'ours-unmodified');
  // Write buf2 (different bytes, same UTF-8 decoding)
  writeFileSync(join(d, 'test.dat'), buf2);
  // Must classify as ours-modified, not ours-unmodified
  assert.equal(classify(d, m, 'test.dat'), 'ours-modified');
});

test('classify rejects path traversal with ../outside.txt', () => {
  const d = repo();
  const m = emptyManifest('0.1.0');
  m.files.push({ path: '../outside.txt', sha256: sha256('x'), step: 1, writtenAt: 'now' });
  assert.equal(classify(d, m, '../outside.txt'), 'theirs');
});

test('classify rejects deeper path traversal', () => {
  const d = repo();
  const m = emptyManifest('0.1.0');
  m.files.push({ path: '../../outside.txt', sha256: sha256('x'), step: 1, writtenAt: 'now' });
  assert.equal(classify(d, m, '../../outside.txt'), 'theirs');
});

test('classify allows benign .. that stays inside the root', () => {
  const d = repo();
  write(d, 'HANDOFF.md', 'x');
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'docs/../HANDOFF.md', sha256: sha256('x'), step: 16, writtenAt: 'now' });
  assert.equal(classify(d, m, 'docs/../HANDOFF.md'), 'ours-unmodified');
});

// --- Audit Tier 1, finding 4: a CRLF checkout made the kit's own files look
// --- user-modified ----------------------------------------------------------
//
// With `core.autocrlf=true` (the Windows default) a checkout, `stash pop` or
// renormalise rewrites every installed file to CRLF. `classify` hashed raw
// bytes, so all of them read `ours-modified`: apply said `kept (modified)`
// for every file, uninstall kept every file, and the upgrade path never
// fired. Measured on a real repository. The manifest keeps recording LF
// hashes; the comparison tolerates the one transformation git makes.

test('classify: a file we wrote that a CRLF checkout rewrote is still ours-unmodified', () => {
  const d = repo();
  const written = '# Handoff\n\nline one\nline two\n';
  write(d, 'HANDOFF.md', written.replace(/\n/g, '\r\n'));
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256(written), step: 16, writtenAt: 'now' });
  assert.equal(classify(d, m, 'HANDOFF.md'), 'ours-unmodified');
});

test('classify: a CRLF file with a real edit is ours-modified', () => {
  const d = repo();
  const written = '# Handoff\n\nline one\nline two\n';
  write(d, 'HANDOFF.md', written.replace(/\n/g, '\r\n').replace('line two', 'line two EDITED'));
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256(written), step: 16, writtenAt: 'now' });
  assert.equal(classify(d, m, 'HANDOFF.md'), 'ours-modified');
});

test('classify: normalisation runs one way only — an LF file never matches a CRLF hash', () => {
  const d = repo();
  write(d, 'HANDOFF.md', 'a\nb\n');
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256('a\r\nb\r\n'), step: 16, writtenAt: 'now' });
  assert.equal(classify(d, m, 'HANDOFF.md'), 'ours-modified', 'the kit never writes CRLF, so a CRLF hash in the manifest is not ours to match');
});

test('normalizeLineEndings turns CRLF into LF and leaves everything else alone', () => {
  assert.equal(normalizeLineEndings(Buffer.from('a\r\nb\r\n')).toString('utf8'), 'a\nb\n');
  assert.equal(normalizeLineEndings(Buffer.from('a\nb\rc')).toString('utf8'), 'a\nb\rc', 'a lone CR is not a line ending git rewrites');
});

// --- Audit Tier 2, finding 8: the manifest was written in place, once, at
// --- the end of a run -------------------------------------------------------
//
// A kill between the write starting and finishing left a truncated manifest
// (read back as `corrupt`, so apply refused forever) or none; either way
// every file written that run was orphaned as `theirs`. Written to a
// temporary sibling and renamed into place: the old manifest is intact until
// the new one is whole.

test('writeManifest leaves no temporary file behind and the manifest reads back whole', () => {
  const d = repo();
  const m = emptyManifest('0.1.0');
  m.files.push({ path: 'HANDOFF.md', sha256: sha256('x'), step: 16, writtenAt: '2026-09-29T00:00:00Z' });
  writeManifest(d, m);
  assert.deepEqual(readdirSync(join(d, '.claude')), ['kh-harness.manifest.json']);
  assert.deepEqual(readManifest(d), m);
});

test('writeManifest that cannot replace the target leaves the previous state intact and no temporary file', () => {
  const d = repo();
  const target = join(d, '.claude', 'kh-harness.manifest.json');
  // A directory at the manifest's path is one thing `rename` cannot replace.
  mkdirSync(target, { recursive: true });
  assert.throws(() => writeManifest(d, emptyManifest('0.1.0')));
  assert.equal(statSync(target).isDirectory(), true, 'the target is untouched');
  assert.deepEqual(readdirSync(join(d, '.claude')), ['kh-harness.manifest.json'], 'no .tmp sibling is left behind');
});

// Tier 2 final review, Minor 5: a temporary file left by a hard kill between
// the write and the rename is unambiguously ours, and nothing else would ever
// remove it. The next write clears stale ones first.
test('writeManifest removes a stale temporary sibling left by an interrupted run', () => {
  const d = repo();
  write(d, '.claude/kh-harness.manifest.json.tmp-424242', '{ "schema": 1, "files": [');
  writeManifest(d, emptyManifest('0.1.0'));
  assert.deepEqual(readdirSync(join(d, '.claude')), ['kh-harness.manifest.json']);
});
