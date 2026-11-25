// scripts/lib/harness-extensions.test.mjs
//
// The extensions file a pull request to the repository could plant, and each
// module it lists, judged without loading the module.
//
// Every test runs against a temporary KH_DATA_DIR and HK_MARKER_DIR.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { EXTENSIONS_PATH, EXTENSION_LIMITS, moduleSha256, moduleState, readExtensions } from '../../assets/scripts/harness-extensions.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

sandboxMarkerDir();
process.env.KH_DATA_DIR = tempDir('hk-ext-data-');

const writeAt = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const project = () => { const root = tempDir('hk-ext-repo-'); mkdirSync(join(root, '.git')); return root; };
const writeExtensions = (root, value) => writeAt(join(root, EXTENSIONS_PATH), typeof value === 'string' ? value : JSON.stringify(value));
/** Writes `.claude/ext/<id>.mjs` holding `source` and returns its entry. */
function extension(root, id, source, o = {}) {
  const module = `.claude/ext/${id}.mjs`;
  writeAt(join(root, module), source);
  return { id, version: '1.0.0', module, sha256: moduleSha256(Buffer.from(source)), onFailure: 'block', ...o };
}
const ALLOW = "export const preToolUse = () => ({ decision: 'allow' });\n";

/** Makes a link at `link` to `target`, or skips the test where this platform
 * cannot make one without elevation. Returns whether the link was made. */
function linkOrSkip(t, target, link, type) {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch (e) {
    t.skip(`this platform cannot create the link without elevation: ${e.message}`);
    return false;
  }
}

// --- readExtensions -------------------------------------------------------

test('no extensions file means no extensions', () => {
  assert.deepEqual(readExtensions(project()), { state: 'absent' });
});

test('a well-formed file yields its entries in order', () => {
  const root = project();
  const a = extension(root, 'a', ALLOW), b = extension(root, 'b', ALLOW, { onFailure: 'allow' });
  writeExtensions(root, [a, b]);
  assert.deepEqual(readExtensions(root), { state: 'ok', entries: [a, b] });
});

test('an empty list is well formed', () => {
  const root = project();
  writeExtensions(root, []);
  assert.deepEqual(readExtensions(root), { state: 'ok', entries: [] });
});

test('each entry is returned as a fresh object of the five fields', () => {
  const root = project();
  const a = extension(root, 'a', ALLOW);
  writeExtensions(root, `[{"id":"a","version":"1.0.0","module":"${a.module}","sha256":"${a.sha256}","onFailure":"block"}]`);
  const read = readExtensions(root);
  assert.deepEqual(Object.keys(read.entries[0]), ['id', 'version', 'module', 'sha256', 'onFailure']);
  assert.equal(Object.getPrototypeOf(read.entries[0]), Object.prototype);
});

test('a file that cannot be used is malformed, with fixed text that quotes nothing from it', async (t) => {
  const ENTRY_1 = 'entry 1 is not an extension entry as docs/CONTRACT.md describes one';
  const valid = { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', sha256: moduleSha256(Buffer.from(ALLOW)), onFailure: 'block' };
  const changed = o => ({ ...valid, ...o });
  const { sha256: _sha256, ...withoutSha } = valid;
  const badEntries = [
    ['null in its place', null],
    ['an extra key', changed({ timeout: 5 })],
    ['sha256 removed', withoutSha],
    ['an upper-case id', changed({ id: 'A' })],
    ['an id with a space', changed({ id: 'a b' })],
    ['an id of 65 characters', changed({ id: 'a'.repeat(65) })],
    ['an empty version', changed({ version: '' })],
    ['a version with a line break', changed({ version: '1.0\n' })],
    ['a module outside .claude/', changed({ module: 'src/x.mjs' })],
    ['an absolute module', changed({ module: '/abs/x.mjs' })],
    ['a module with a .. segment', changed({ module: '.claude/../x.mjs' })],
    ['a module with a . segment', changed({ module: '.claude/./x.mjs' })],
    ['a module with an empty segment', changed({ module: '.claude//x.mjs' })],
    ['a module with a backslash', changed({ module: '.claude\\x.mjs' })],
    ['a module not ending .mjs', changed({ module: '.claude/x.js' })],
    ['a module of 201 characters', changed({ module: `.claude/${'a'.repeat(189)}.mjs` })],
    ['a short sha256', changed({ sha256: 'abc' })],
    ['an upper-case sha256', changed({ sha256: valid.sha256.toUpperCase() })],
    ['an unknown onFailure', changed({ onFailure: 'warn' })],
  ];
  const nine = Array.from({ length: 9 }, (_, i) => changed({ id: `e${i}` }));
  const rows = [
    ['a file over the bound', root => writeExtensions(root, 'x'.repeat(EXTENSION_LIMITS.fileMaxBytes + 1)), 'it is larger than 65536 bytes'],
    ['a directory at the path', root => mkdirSync(join(root, EXTENSIONS_PATH), { recursive: true }), 'it is not a regular file'],
    ['a link at the path', root => {
      writeAt(join(root, '.claude/kh-harness/real.json'), '[]');
      return linkOrSkip(t, join(root, '.claude/kh-harness/real.json'), join(root, EXTENSIONS_PATH), 'file');
    }, 'it is not a regular file'],
    ['not JSON', root => writeExtensions(root, '{ not json'), 'it is not JSON'],
    ['an object, not an array', root => writeExtensions(root, '{"extensions":[]}'), 'it is not a JSON array'],
    ['nine entries', root => writeExtensions(root, nine), 'it lists more than 8 extensions'],
    ['two entries with one id', root => writeExtensions(root, [valid, valid]), 'two entries share an id'],
    ...badEntries.map(([name, entry]) => [name, root => writeExtensions(root, [entry]), ENTRY_1]),
    ['a bad second entry', root => writeExtensions(root, [valid, changed({ id: 'b', onFailure: 'warn' })]), 'entry 2 is not an extension entry as docs/CONTRACT.md describes one'],
  ];
  for (const [name, setUp, problem] of rows) {
    await t.test(name, () => {
      const root = project();
      if (setUp(root) === false) return;
      assert.deepEqual(readExtensions(root), { state: 'malformed', problem });
    });
  }
  await t.test('the problem quotes no text taken from the file', () => {
    const root = project();
    writeExtensions(root, [changed({ id: 'a b' })]);
    const { problem } = readExtensions(root);
    assert.ok(!problem.includes('a b'));
  });
});

test('an extensions path that cannot be examined is malformed, not absent', () => {
  const root = project();
  // `.claude/kh-harness` a file: the path beneath it cannot be stat'd.
  writeAt(join(root, '.claude/kh-harness'), '');
  assert.deepEqual(readExtensions(root), { state: 'malformed', problem: 'it could not be read' });
});

// --- moduleState ----------------------------------------------------------

test('a module whose bytes hash to the recorded value matches, and the real path is returned', () => {
  const root = project(); const e = extension(root, 'a', ALLOW);
  assert.deepEqual(moduleState(root, e), { state: 'matches', path: realpathSync.native(join(root, e.module)) });
});

test('REVIEW FOCUS 2: the same module with CRLF line endings still matches', () => {
  const root = project(); const e = extension(root, 'a', ALLOW);
  writeFileSync(join(root, e.module), ALLOW.replace(/\n/g, '\r\n'));
  assert.equal(moduleState(root, e).state, 'matches');
});

test('the hash makes each CRLF an LF and leaves a lone CR', () => {
  assert.equal(moduleSha256(Buffer.from('a\r\nb\r\n')), moduleSha256(Buffer.from('a\nb\n')));
  assert.notEqual(moduleSha256(Buffer.from('a\rb')), moduleSha256(Buffer.from('a\nb')));
  assert.match(moduleSha256(Buffer.from(ALLOW)), /^[0-9a-f]{64}$/);
});

test('a changed module differs', () => {
  const root = project(); const e = extension(root, 'a', ALLOW);
  writeFileSync(join(root, e.module), ALLOW + '// x\n');
  assert.deepEqual(moduleState(root, e), { state: 'differs' });
});

test('a missing module is missing', () => {
  const root = project(); const e = extension(root, 'a', ALLOW);
  rmSync(join(root, e.module));
  assert.deepEqual(moduleState(root, e), { state: 'missing' });
});

test('a module over the size bound, or a directory at its path, is unreadable', () => {
  const root = project(); const e = extension(root, 'a', ALLOW);
  writeFileSync(join(root, e.module), 'x'.repeat(EXTENSION_LIMITS.moduleMaxBytes + 1));
  assert.deepEqual(moduleState(root, e), { state: 'unreadable' });
  rmSync(join(root, e.module));
  mkdirSync(join(root, e.module));
  assert.deepEqual(moduleState(root, e), { state: 'unreadable' });
});

test('a module that is a link to a file outside the repository is outside', (t) => {
  const root = project();
  const outsideFile = join(tempDir('hk-ext-outside-'), 'a.mjs');
  writeFileSync(outsideFile, ALLOW);
  const e = { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', sha256: moduleSha256(Buffer.from(ALLOW)), onFailure: 'block' };
  mkdirSync(join(root, '.claude/ext'), { recursive: true });
  if (!linkOrSkip(t, outsideFile, join(root, e.module), 'file')) return;
  assert.deepEqual(moduleState(root, e), { state: 'outside' });
});

test('a module under a .claude that is itself a link out of the repository is outside', (t) => {
  const root = project();
  const outside = tempDir('hk-ext-outside-');
  writeAt(join(outside, 'ext/a.mjs'), ALLOW);
  const e = { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', sha256: moduleSha256(Buffer.from(ALLOW)), onFailure: 'block' };
  if (!linkOrSkip(t, outside, join(root, '.claude'), 'junction')) return;
  assert.deepEqual(moduleState(root, e), { state: 'outside' });
});

test('a module that is a link to a file elsewhere in the repository, outside .claude, is outside', (t) => {
  const root = project();
  writeAt(join(root, 'src/a.mjs'), ALLOW);
  const e = { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', sha256: moduleSha256(Buffer.from(ALLOW)), onFailure: 'block' };
  mkdirSync(join(root, '.claude/ext'), { recursive: true });
  if (!linkOrSkip(t, join(root, 'src/a.mjs'), join(root, e.module), 'file')) return;
  assert.deepEqual(moduleState(root, e), { state: 'outside' });
});

test('a link inside .claude to another file inside .claude is followed', (t) => {
  const root = project();
  const target = extension(root, 'real', ALLOW);
  const e = { ...target, id: 'a', module: '.claude/ext/a.mjs' };
  if (!linkOrSkip(t, join(root, target.module), join(root, e.module), 'file')) return;
  assert.deepEqual(moduleState(root, e), { state: 'matches', path: realpathSync.native(join(root, target.module)) });
});

test('a module that is a dangling link is missing', (t) => {
  const root = project();
  const e = { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', sha256: moduleSha256(Buffer.from(ALLOW)), onFailure: 'block' };
  mkdirSync(join(root, '.claude/ext'), { recursive: true });
  if (!linkOrSkip(t, join(root, '.claude/ext/gone.mjs'), join(root, e.module), 'file')) return;
  assert.deepEqual(moduleState(root, e), { state: 'missing' });
});

test('moduleState never throws, whatever it is handed', () => {
  assert.deepEqual(moduleState(project(), { module: 7 }), { state: 'unreadable' });
  assert.deepEqual(moduleState(join(tmpdir(), 'hk-ext-no-such-root'), { module: '.claude/a.mjs' }), { state: 'missing' });
});
