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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const fullyMasked = ['sk-liveAAAAAAAAAA', 'glpat-AAAAAAAAAA', 'ghp_AAAAAAAAAAAA', 'github_pat_AAAAAAAAAAAA', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-AAAAAAAAAA'];
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

test('maskCredentials masks password=/api_key= by key shape', () => {
  assert.equal(maskCredentials('password=hunter2'), 'password=***');
  assert.equal(maskCredentials('api_key=hunter2'), 'api_key=***');
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
