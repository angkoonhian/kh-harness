// scripts/lib/harness-redact.test.mjs
//
// The shared asset both process-output hooks import is the security-
// critical module in this codebase (review finding 8): it is the one
// chokepoint every byte either hook writes to stderr passes through, and
// it now also owns the session-marker machinery both hooks' bounding
// relies on. Coverage via the two hooks' own suites is real (mutating
// either redaction layer there breaks tests in both), but a module this
// central deserves direct, local tests of its own rather than relying
// entirely on indirection through its two callers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

// Session markers go in a per-run directory that is removed afterwards, so
// this file leaves nothing in the real one. See test-marker-sandbox.mjs for
// the measurement that prompted it (8983 accumulated files).
sandboxMarkerDir();

import {
  boundReport,
  commandTokens,
  CREDENTIAL_RULES,
  dropCommandFragments,
  MAX_BLOCKS_PER_SESSION,
  MAX_REPORT_BYTES,
  MAX_REPORT_LINES,
  markerDir,
  markerPath,
  maskCredentials,
  readJSONMarker,
  rootTag,
  safeSessionId,
  signatureOf,
  writeJSONMarker,
} from '../../assets/scripts/harness-redact.mjs';

// --- commandTokens / dropCommandFragments (layer 1) -----------------------

test('commandTokens drops tokens shorter than 8 characters', () => {
  assert.deepEqual(commandTokens('a bb ccc dddddddd'), ['dddddddd']);
});

test('commandTokens strips surrounding quotes and dedupes', () => {
  assert.deepEqual(commandTokens(`"longtoken" 'longtoken' longtoken`), ['longtoken']);
});

test('commandTokens honours exemptions', () => {
  assert.deepEqual(commandTokens('src/file.ts anotherlongtoken', new Set(['src/file.ts'])), ['anotherlongtoken']);
});

test('dropCommandFragments removes a line matching the whole command string', () => {
  const lines = ['echo the-full-command-here', 'unrelated line'];
  const survived = dropCommandFragments(lines, ['echo the-full-command-here']);
  assert.deepEqual(survived, ['unrelated line']);
});

test('dropCommandFragments removes a line containing only a FRAGMENT of the command', () => {
  const lines = ['leaked-fragment-xyz appears here', 'clean line'];
  const survived = dropCommandFragments(lines, ['run leaked-fragment-xyz --flag']);
  assert.deepEqual(survived, ['clean line']);
});

test('dropCommandFragments never drops an exempted token even though it is part of the command', () => {
  const lines = ['src/long-file-name.ts:1 problem'];
  const survived = dropCommandFragments(lines, ['eslint src/long-file-name.ts'], new Set(['src/long-file-name.ts']));
  assert.deepEqual(survived, lines);
});

// --- maskCredentials / CREDENTIAL_RULES (layer 2) --------------------------

test('CREDENTIAL_RULES covers every documented vendor shape', () => {
  // Each sample's SENSITIVE portion (the part after any fixed vendor
  // prefix) must disappear — "Bearer" itself is not a secret, so only the
  // token after it is checked for that one case.
  // 'AKIA' + 16 and 'xoxb-' + 10 are the two samples long enough to trip
  // detect-exposure's own TOKEN_PATTERNS, so they are assembled rather than
  // written — see this file's header.
  const fullyMasked = ['sk-liveAAAAAAAAAA', 'glpat-AAAAAAAAAA', 'ghp_AAAAAAAAAAAA', 'github_pat_AAAAAAAAAAAA',
    'AKIA' + 'ABCDEFGHIJKLMNOP', 'xoxb-' + 'A'.repeat(10)];
  for (const s of fullyMasked) {
    assert.doesNotMatch(maskCredentials(s), new RegExp(s), `expected ${s} to be masked`);
  }
  assert.equal(maskCredentials('Bearer sometoken'), 'Bearer ***', 'the Bearer scheme word survives; only the token is masked');
});

test('maskCredentials masks --token=/--auth-token=/--api-key= by key shape', () => {
  assert.equal(maskCredentials('--token=secretvalue'), '--token=***');
  assert.equal(maskCredentials('--auth-token=secretvalue'), '--auth-token=***');
  assert.equal(maskCredentials('--api-key=secretvalue'), '--api-key=***');
});

// The title names the two keys in prose rather than joining them with a
// slash: that joined form is itself a DB_CRED match (a credential key,
// then `=`, then nine non-space characters), and it made this FILE a
// `credentials-in-doc` finding when harness-kit was run on its own repo.
// A comment is tracked text like any other — see this file's header.
test('maskCredentials masks a password or api_key assignment by key shape', () => {
  // Assembled: written out, the closing quote and comma push the value
  // past DB_CRED's eight-non-space-character threshold, so the LITERAL
  // would make this file a finding — see this file's header.
  const assign = (key, value) => [key, value].join('=');
  assert.equal(maskCredentials(assign('password', 'hunter2')), assign('password', '***'));
  assert.equal(maskCredentials(assign('api_key', 'hunter2')), assign('api_key', '***'));
});

test('maskCredentials never drops the line — only the value', () => {
  const masked = maskCredentials('found token sk-live-ABCDEFGHIJ in config');
  assert.match(masked, /found token/);
  assert.match(masked, /in config/);
  assert.doesNotMatch(masked, /sk-live-ABCDEFGHIJ/);
});

// --- boundReport -------------------------------------------------------

test('boundReport truncates past MAX_REPORT_LINES with a notice', () => {
  const lines = Array.from({ length: MAX_REPORT_LINES + 20 }, (_, i) => `line-${i}`);
  const report = boundReport(lines);
  const shown = report.split('\n').filter(l => !l.startsWith('---'));
  assert.equal(shown.length, MAX_REPORT_LINES);
  assert.match(report, /truncated: 20 more line\(s\)/);
});

test('boundReport includes the header in the byte budget', () => {
  const header = 'X'.repeat(MAX_REPORT_BYTES + 100);
  const report = boundReport(['short'], header);
  assert.ok(Buffer.byteLength(report, 'utf8') <= MAX_REPORT_BYTES + 100, 'a huge header must still trigger the byte bound');
  assert.match(report, /truncated: output exceeded the byte limit/);
});

// Whole-branch review, F3. The bound used to cut at exactly
// MAX_REPORT_BYTES and THEN append its own ~50-byte notice, so what this
// returned was ~10,050 bytes — over Claude Code's 10,000-character hook-
// output cap, which is the entire reason the constant has that value. A
// bound fifty bytes over the limit does not prevent the failure it exists
// to prevent: past the cap Claude Code replaces the output with a file path
// and does not ask Claude to read it.
test('F3: boundReport, PLUS the trailing newline every caller adds, never exceeds MAX_REPORT_BYTES', () => {
  for (const lines of [
    ['z'.repeat(MAX_REPORT_BYTES * 3)],
    Array.from({ length: MAX_REPORT_LINES * 3 }, () => 'y'.repeat(500)),
    Array.from({ length: 5 }, () => 'w'.repeat(MAX_REPORT_BYTES)),
  ]) {
    const written = boundReport(lines, 'HEADER\n') + '\n';
    assert.ok(Buffer.byteLength(written, 'utf8') <= MAX_REPORT_BYTES,
      `what is actually written must be within the cap, got ${Buffer.byteLength(written, 'utf8')}`);
    assert.match(written, /truncated: output exceeded the byte limit/);
  }
});

test('F3: the byte cut never leaves a half-character behind', () => {
  // A multi-byte character straddling the boundary used to decode to U+FFFD
  // — a corrupted last character in the one place a user reads for
  // information.
  const report = boundReport(['é'.repeat(MAX_REPORT_BYTES)], '');
  assert.equal(report.includes('�'), false, 'no replacement character may appear at the cut');
  assert.match(report, /truncated: output exceeded the byte limit/);
});

test('boundReport truncates a single line that alone exceeds MAX_REPORT_BYTES', () => {
  const huge = 'y'.repeat(MAX_REPORT_BYTES * 2);
  const report = boundReport([huge]);
  assert.ok(Buffer.byteLength(report, 'utf8') < Buffer.byteLength(huge, 'utf8'));
  assert.match(report, /truncated: output exceeded the byte limit/);
});

test('boundReport leaves small, in-budget output untouched apart from the header', () => {
  const report = boundReport(['one', 'two'], 'HEADER\n');
  assert.equal(report, 'HEADER\none\ntwo');
});

// --- safeSessionId -----------------------------------------------------

test('safeSessionId accepts an alphanumeric id with hyphens and underscores', () => {
  assert.equal(safeSessionId('abc-123_DEF'), 'abc-123_DEF');
});

for (const bad of ['../evil', '/etc/passwd', 'C:\\Windows\\evil', '', null, undefined, 'a'.repeat(300), 'has space']) {
  test(`safeSessionId rejects ${JSON.stringify(bad)}`, () => {
    assert.equal(safeSessionId(bad), null);
  });
}

// --- markerDir / markerPath / rootTag --------------------------------------

test('markerDir creates (or reuses) a directory under the OS temp directory', () => {
  const dir = markerDir();
  assert.ok(dir.startsWith(tmpdir()));
  assert.equal(existsSync(dir), true);
});

test('markerDir is idempotent and stable across calls', () => {
  assert.equal(markerDir(), markerDir());
});

test('rootTag is stable for the same root and differs for a different root', () => {
  const a = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  const b = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  assert.equal(rootTag(a), rootTag(a));
  assert.notEqual(rootTag(a), rootTag(b));
});

test('markerPath differs by namespace for the same root and session_id', () => {
  const root = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  const p1 = markerPath(root, 'session-1', 'stop');
  const p2 = markerPath(root, 'session-1', 'sensor');
  assert.notEqual(p1, p2, 'two different hooks sharing (root, session_id) must never collide on a marker path');
});

test('markerPath differs by root for the same session_id and namespace', () => {
  const a = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  const b = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  assert.notEqual(markerPath(a, 'same-session', 'stop'), markerPath(b, 'same-session', 'stop'));
});

// --- readJSONMarker / writeJSONMarker --------------------------------------

test('writeJSONMarker then readJSONMarker round-trips the exact state', () => {
  const root = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  const path = markerPath(root, 'rt-session', 'test');
  const ok = writeJSONMarker(path, { count: 2, lastSignature: 'abc' });
  assert.equal(ok, true);
  assert.deepEqual(readJSONMarker(path, { fallback: true }), { count: 2, lastSignature: 'abc' });
});

test('readJSONMarker returns the fallback for a missing marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  const path = markerPath(root, 'never-written', 'test');
  assert.deepEqual(readJSONMarker(path, { fallback: true }), { fallback: true });
});

test('readJSONMarker returns the fallback for a malformed marker, never throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  const path = markerPath(root, 'malformed-session', 'test');
  writeFileSync(path, '{ not valid json', 'utf8');
  let result;
  assert.doesNotThrow(() => { result = readJSONMarker(path, { fallback: true }); });
  assert.deepEqual(result, { fallback: true });
});

test('readJSONMarker returns the fallback when the marker is valid JSON but not an object', () => {
  const root = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  const path = markerPath(root, 'scalar-session', 'test');
  writeFileSync(path, '"just a string"', 'utf8');
  assert.deepEqual(readJSONMarker(path, { fallback: true }), { fallback: true });
});

test('writeJSONMarker returns false, never throws, when the target path is a directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'hk-redact-'));
  const path = markerPath(root, 'blocked-session', 'test');
  mkdirSync(path, { recursive: true });
  let ok;
  assert.doesNotThrow(() => { ok = writeJSONMarker(path, { count: 1 }); });
  assert.equal(ok, false);
});

// --- signatureOf -------------------------------------------------------

test('signatureOf is stable for identical input and differs for different input', () => {
  assert.equal(signatureOf(['a', 'b']), signatureOf(['a', 'b']));
  assert.notEqual(signatureOf(['a', 'b']), signatureOf(['a', 'c']));
});

test('signatureOf normalizes away an absolute path difference', () => {
  const a = signatureOf(['error at C:\\Users\\alice\\project\\src\\a.ts:1']);
  const b = signatureOf(['error at C:\\Users\\bob\\repos\\proj\\src\\a.ts:1']);
  assert.equal(a, b, 'two absolute paths pointing at conceptually the same file must normalize to the same signature');
});

test('signatureOf normalizes away an elapsed-time figure', () => {
  const a = signatureOf(['finished in 1.234s']);
  const b = signatureOf(['finished in 98.7s']);
  assert.equal(a, b, 'an elapsed-time figure must not make an otherwise-identical failure look different');
});

// --- MAX_BLOCKS_PER_SESSION -------------------------------------------

test('MAX_BLOCKS_PER_SESSION is the documented value of 3', () => {
  assert.equal(MAX_BLOCKS_PER_SESSION, 3);
});

// --- redactLines was removed (finding 8) -----------------------------

test('redactLines no longer exists — use dropCommandFragments + maskCredentials explicitly at the call site', async () => {
  const mod = await import('../../assets/scripts/harness-redact.mjs');
  assert.equal('redactLines' in mod, false);
});

// --- Coordinator ruling (post-review): the marker directory is overridable,
// --- and sharded by repository ---------------------------------------------
//
// Both changes exist because of one measurement. `markerDir()` was a single
// fixed directory shared by every run of every hook on a machine, with
// nothing to isolate it and nothing to remove what it accumulated. On the
// development machine, from this project's own test runs alone:
//
//     <tmpdir>/harness-kit-stop-28d5673005cc744e: 8983 entries
//
// That is a credible mechanism for a rare, unattributable failure in a suite
// where several tests set sub-second bounds, and a suite that leaves durable
// state outside its own fixtures has no business being surprised by one.

test('MARKER DIR: HK_MARKER_DIR overrides the location, following the HK_* convention', () => {
  const sandbox = process.env.HK_MARKER_DIR;
  assert.ok(sandbox, 'fixture sanity: this file sandboxes the marker dir at import');
  assert.equal(markerDir(), sandbox, 'the override must be honoured verbatim');
  assert.ok(existsSync(sandbox), 'and the directory must exist afterwards');
});

test('MARKER DIR: an empty HK_MARKER_DIR falls back to the per-user default, never to an empty path', () => {
  const saved = process.env.HK_MARKER_DIR;
  try {
    process.env.HK_MARKER_DIR = '';
    const fallback = markerDir();
    assert.notEqual(fallback, '', 'an empty override must not become an empty path');
    assert.ok(fallback.includes('harness-kit-stop-'), `expected the per-user default, got ${fallback}`);
  } finally {
    process.env.HK_MARKER_DIR = saved;
  }
});

test('MARKER PATH: sharded by repository — two repositories in ONE session get two directories, not two files', () => {
  // The bound that matters: entries per directory now grow with sessions
  // PER REPOSITORY rather than with sessions globally.
  const session = 'shard-probe-1';
  const a = mkdtempSync(join(tmpdir(), 'hk-shard-a-'));
  const b = mkdtempSync(join(tmpdir(), 'hk-shard-b-'));

  const pa = markerPath(a, session, 'stop');
  const pb = markerPath(b, session, 'stop');
  assert.notEqual(pa, pb, 'two repositories must never share a marker');

  // Each path's PARENT is the repo shard; the filename no longer carries the
  // root tag at all.
  assert.equal(basename(dirname(pa)), rootTag(a));
  assert.equal(basename(dirname(pb)), rootTag(b));
  assert.equal(basename(pa), `stop-${session}`, 'the filename is namespace + session only');
  assert.equal(basename(pb), `stop-${session}`);
  assert.equal(dirname(dirname(pa)), markerDir(), 'the shard sits directly under the marker directory');

  // The directories are created eagerly, so a caller only has to write.
  assert.ok(existsSync(dirname(pa)));
  assert.ok(existsSync(dirname(pb)));
  writeFileSync(pa, '{}');
  writeFileSync(pb, '{}');
  assert.deepEqual(readdirSync(dirname(pa)), [`stop-${session}`]);
  assert.deepEqual(readdirSync(dirname(pb)), [`stop-${session}`]);
  assert.equal(readdirSync(markerDir(), { withFileTypes: true }).some(e => e.isFile()), false,
    'nothing may land flat in the marker directory any more — that was the old layout');
});

test('MARKER PATH: the identity is still (root, namespace, session) — sharding moved the path, not the key', () => {
  // If this ever stops holding, the sharding changed collision behaviour
  // rather than just the layout, which is the one thing it must not do.
  const d = mkdtempSync(join(tmpdir(), 'hk-shard-id-'));
  assert.equal(markerPath(d, 's1', 'stop'), markerPath(d, 's1', 'stop'), 'same triple, same path');
  assert.notEqual(markerPath(d, 's1', 'stop'), markerPath(d, 's1', 'lint'), 'namespace still separates');
  assert.notEqual(markerPath(d, 's1', 'stop'), markerPath(d, 's2', 'stop'), 'session still separates');
  // Two namespaces for one repo share the shard and differ by filename.
  assert.equal(dirname(markerPath(d, 's1', 'stop')), dirname(markerPath(d, 's1', 'lint')));
});
