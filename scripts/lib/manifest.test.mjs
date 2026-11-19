import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256, emptyManifest, readManifest, readManifestResult, writeManifest, classify, normalizeLineEndings, replaceFile, displayPath, MANIFEST_PATH } from './manifest.mjs';
import { APPLY, UNINSTALL, fixture, sandboxDataDir } from './lifecycle-fixtures.mjs';

sandboxDataDir();

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

// --- a manifest whose entries are not the shapes every reader assumes -----

const malformedManifests = [
  ['files:[null]', { files: [null] }],
  ['files:[{path:5}]', { files: [{ path: 5, sha256: sha256('x') }] }],
  ['a files entry with no sha256', { files: [{ path: 'HANDOFF.md' }] }],
  ['dirsCreated:[5]', { dirsCreated: [5] }],
  ['dirsCreated:"docs"', { dirsCreated: 'docs' }],
  ['settingsPatches:{}', { settingsPatches: {} }],
  ['settingsPatches:[null]', { settingsPatches: [null] }],
];
const manifestWith = override => JSON.stringify({ ...emptyManifest('0.1.0'), ...override });

for (const [label, override] of malformedManifests) {
  test(`a manifest with ${label} reads as corrupt`, () => {
    const d = repo();
    write(d, MANIFEST_PATH, manifestWith(override));
    assert.deepEqual(readManifestResult(d), { state: 'corrupt', manifest: null });
  });
}

test('a manifest with a BOM, and with dirsCreated absent or a list of paths, reads as ok', () => {
  for (const override of [{}, { dirsCreated: ['.claude', '.claude/scripts'] }]) {
    const d = repo();
    write(d, MANIFEST_PATH, '\uFEFF' + manifestWith({ files: [{ path: 'HANDOFF.md', sha256: sha256('x'), step: 16 }], ...override }));
    assert.equal(readManifestResult(d).state, 'ok', JSON.stringify(override));
  }
});

test('a manifest without a settingsPatches key reads as ok with an empty list', () => {
  const d = repo();
  write(d, MANIFEST_PATH, manifestWith({ settingsPatches: undefined }));
  const r = readManifestResult(d);
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.manifest.settingsPatches, []);
});

test('apply exits 3 and uninstall refuses on each', () => {
  const d = fixture();
  const cli = (script, ...a) => spawnSync(process.execPath, [script, d, ...a], { encoding: 'utf8' });
  for (const [label, override] of malformedManifests) {
    const text = manifestWith(override);
    write(d, MANIFEST_PATH, text);

    const a = cli(APPLY, '--yes');
    assert.equal(a.status, 3, `${label}: apply\n${a.stdout}\n${a.stderr}`);
    assert.match(a.stderr, /kh-harness\.manifest\.json exists but could not be read as a valid kh-harness manifest/, label);

    const u = cli(UNINSTALL, '--yes');
    assert.equal(u.status, 3, `${label}: uninstall\n${u.stdout}\n${u.stderr}`);
    assert.match(u.stderr, /kh-harness\.manifest\.json exists but could not be read as a valid kh-harness manifest/, label);

    assert.equal(readFileSync(join(d, MANIFEST_PATH), 'utf8'), text, `${label}: the manifest is left exactly as it was`);
    assert.equal(existsSync(join(d, 'HANDOFF.md')), false, `${label}: nothing is written`);
  }
});

// --- replaceFile: a repository file is the old one or the new one, whole ----

test('replaceFile writes the new content whole, leaves no temporary file, and creates the directory', () => {
  const d = repo();
  const target = join(d, 'a', 'settings.json');
  replaceFile(target, '{"a":1}\n');
  assert.equal(readFileSync(target, 'utf8'), '{"a":1}\n');
  replaceFile(target, '{"a":2}\n');
  assert.equal(readFileSync(target, 'utf8'), '{"a":2}\n');
  assert.deepEqual(readdirSync(join(d, 'a')), ['settings.json']);
});

test('replaceFile that cannot rename over the target leaves it as it was and no temporary file', () => {
  const d = repo();
  const target = join(d, 'settings.json');
  // A directory at the path is one thing `rename` cannot replace.
  mkdirSync(target);
  assert.throws(() => replaceFile(target, 'new\n'));
  assert.equal(statSync(target).isDirectory(), true);
  assert.deepEqual(readdirSync(d), ['settings.json']);
});

test('replaceFile refuses a target the owner made read-only, as a write in place would', () => {
  const d = repo();
  const target = join(d, 'settings.json');
  writeFileSync(target, 'old\n');
  chmodSync(target, 0o444);
  assert.throws(() => writeFileSync(target, 'probe'), /EPERM|EACCES/, 'precondition: the OS refuses a write in place');
  assert.throws(() => replaceFile(target, 'new\n'), /EPERM|EACCES/);
  assert.equal(readFileSync(target, 'utf8'), 'old\n');
  assert.deepEqual(readdirSync(d), ['settings.json']);
});

test('replaceFile clears a temporary file an interrupted run left, and only its own', () => {
  const d = repo();
  const target = join(d, 'settings.json');
  writeFileSync(target, 'old\n');
  writeFileSync(`${target}.tmp-424242`, '{ "half":');
  writeFileSync(join(d, 'settings.json.bak'), 'the owner\'s own copy\n');
  // Its own temporary files end in a process id, and nothing else does.
  for (const name of ['settings.json.tmp-backup', 'settings.json.tmp-', 'settings.json.tmp-12a']) writeFileSync(join(d, name), 'the owner\'s own file\n');
  replaceFile(target, 'new\n');
  assert.deepEqual(readdirSync(d).sort(), ['settings.json', 'settings.json.bak', 'settings.json.tmp-', 'settings.json.tmp-12a', 'settings.json.tmp-backup']);
});

test('replaceFile keeps the file\'s permission bits, whatever the umask', { skip: process.platform === 'win32' && 'Windows reports no permission bits to keep' }, () => {
  const d = repo();
  const target = join(d, 'settings.json');
  writeFileSync(target, 'old\n');
  chmodSync(target, 0o600);
  replaceFile(target, 'new\n');
  assert.equal(statSync(target).mode & 0o777, 0o600);

  // A group-writable file under a umask that clears that bit on creation.
  chmodSync(target, 0o664);
  const umask = process.umask(0o022);
  try {
    replaceFile(target, 'newer\n');
  } finally {
    process.umask(umask);
  }
  assert.equal(statSync(target).mode & 0o777, 0o664);
});

test('replaceFile writes through a link at the path, leaving the link in place', (t) => {
  const d = repo();
  const real = join(d, 'real.json');
  const link = join(d, 'settings.json');
  writeFileSync(real, 'old\n');
  try {
    symlinkSync(real, link);
  } catch {
    t.skip('this account cannot create a symbolic link');
    return;
  }
  replaceFile(link, 'new\n');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(real, 'utf8'), 'new\n');
});

// --- displayPath: a path read from the manifest, made safe to print ---------

test('displayPath prints an ordinary path as it is', () => {
  for (const path of ['HANDOFF.md', '.claude/scripts/lint-touched.mjs', 'docs/harness/RULES.md', '.claude/rules/packages-api_v2.md']) {
    assert.equal(displayPath(path), path);
  }
});

test('displayPath quotes anything else and writes out every character a terminal could act on', () => {
  assert.equal(displayPath('docs/\u001b[31mred\nnext line.md'), '"docs/\\u{1b}[31mred\\u{a}next line.md"');
  assert.equal(displayPath('a"b\\c'), '"a\\u{22}b\\u{5c}c"');
  assert.equal(displayPath('docs/caf\u00e9.md'), '"docs/caf\\u{e9}.md"');
  assert.equal(displayPath(''), '""');
  const long = displayPath('x'.repeat(500));
  assert.ok(long.length < 220 && long.endsWith('..."'), 'and is cut to a length a line can hold');
  for (const hostile of ['\u001b]0;title\u0007', 'a\rb', 'tab\there', '\u202egnp.exe']) {
    assert.match(displayPath(hostile), /^"[\x20-\x7e]*"$/, JSON.stringify(hostile));
  }
});
