// scripts/lib/harness-extensions.test.mjs
//
// The extensions file a pull request to the repository could plant, and each
// module it lists, judged without loading the module.
//
// Every test runs against a temporary KH_DATA_DIR and HK_MARKER_DIR.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { constants, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EXTENSIONS_PATH, EXTENSION_LIMITS, moduleSha256, moduleState, readExtensions } from '../../assets/scripts/harness-extensions.mjs';
import { lfSha256 } from '../../assets/scripts/harness-log.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const EXTENSIONS_MODULE = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'harness-extensions.mjs');

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

/** The plain SHA-256 of `bytes`, with no line endings changed. */
const plainSha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** A `matches` state hands on exactly the bytes whose hash the entry records. */
function assertMatchesWhatWasHashed(state, entry) {
  assert.equal(state.state, 'matches');
  assert.equal(plainSha256(state.bytes), entry.sha256, 'the bytes handed on are the bytes the entry approved');
}

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
  const NOT_A_DIRECTORY = '.claude or .claude/kh-harness is a link or not a directory';
  const LINKED_CLAUDE = '.claude is a link, and an extensions file must be a file of the repository itself';
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
    ['a module segment ending in a dot', changed({ module: '.claude/ext./x.mjs' })],
    ['a module segment ending in a space', changed({ module: '.claude/ext /x.mjs' })],
  ];
  const UNDER_SCRIPTS = 'entry 1 names a module under .claude/scripts/, where the kit keeps its own hooks';
  const nine = Array.from({ length: 9 }, (_, i) => changed({ id: `e${i}` }));
  const rows = [
    ['a file over the bound', root => writeExtensions(root, 'x'.repeat(EXTENSION_LIMITS.fileMaxBytes + 1)), 'it is larger than 65536 bytes'],
    ['a directory at the path', root => mkdirSync(join(root, EXTENSIONS_PATH), { recursive: true }), 'it is not a regular file'],
    ['a link at the path', (root, st) => {
      writeAt(join(root, '.claude/kh-harness/real.json'), '[]');
      return linkOrSkip(st, join(root, '.claude/kh-harness/real.json'), join(root, EXTENSIONS_PATH), 'file');
    }, 'it is not a regular file'],
    ['.claude/kh-harness a file', root => writeAt(join(root, '.claude/kh-harness'), ''), NOT_A_DIRECTORY],
    ['.claude a file', root => writeAt(join(root, '.claude'), ''), NOT_A_DIRECTORY],
    ['.claude/kh-harness a link to a directory outside the repository', (root, st) => {
      const outside = tempDir('hk-ext-outside-');
      writeAt(join(outside, 'extensions.json'), '[]');
      mkdirSync(join(root, '.claude'));
      return linkOrSkip(st, outside, join(root, '.claude/kh-harness'), 'junction');
    }, NOT_A_DIRECTORY],
    ['.claude/kh-harness a dangling link', (root, st) => {
      mkdirSync(join(root, '.claude'));
      return linkOrSkip(st, join(root, 'gone'), join(root, '.claude/kh-harness'), 'junction');
    }, NOT_A_DIRECTORY],
    ['.claude a link to a directory inside the repository that holds an extensions file', (root, st) => {
      writeAt(join(root, 'elsewhere/kh-harness/extensions.json'), '[]');
      return linkOrSkip(st, join(root, 'elsewhere'), join(root, '.claude'), 'junction');
    }, LINKED_CLAUDE],
    ['.claude a link to a directory outside the repository that holds an extensions file', (root, st) => {
      const outside = tempDir('hk-ext-outside-');
      writeAt(join(outside, 'kh-harness/extensions.json'), '[]');
      return linkOrSkip(st, outside, join(root, '.claude'), 'junction');
    }, LINKED_CLAUDE],
    ['.claude a link through which a directory sits at the extensions path', (root, st) => {
      const outside = tempDir('hk-ext-outside-');
      mkdirSync(join(outside, 'kh-harness/extensions.json'), { recursive: true });
      return linkOrSkip(st, outside, join(root, '.claude'), 'junction');
    }, LINKED_CLAUDE],
    ['not JSON', root => writeExtensions(root, '{ not json'), 'it is not JSON'],
    ['an object, not an array', root => writeExtensions(root, '{"extensions":[]}'), 'it is not a JSON array'],
    ['nine entries', root => writeExtensions(root, nine), 'it lists more than 8 extensions'],
    ['two entries with one id', root => writeExtensions(root, [valid, valid]), 'two entries share an id'],
    ['two entries with one module', root => writeExtensions(root, [valid, changed({ id: 'b' })]), 'two entries share a module'],
    ['two entries whose modules differ only in case', root => writeExtensions(root, [valid, changed({ id: 'b', module: '.claude/EXT/a.mjs' })]), 'two entries share a module'],
    ['a __proto__ key', root => writeExtensions(root, JSON.stringify([valid]).replace('{', '{"__proto__":{},')), ENTRY_1],
    ['a constructor key', root => writeExtensions(root, JSON.stringify([valid]).replace('{', '{"constructor":"x",')), ENTRY_1],
    ['a __proto__ key in place of sha256', root => writeExtensions(root, JSON.stringify([withoutSha]).replace('{', '{"__proto__":"x",')), ENTRY_1],
    ['a module under .claude/scripts/', root => writeExtensions(root, [changed({ module: '.claude/scripts/dispatch-pre-tool.mjs' })]), UNDER_SCRIPTS],
    ['a module under .claude/Scripts/', root => writeExtensions(root, [changed({ module: '.claude/Scripts/x.mjs' })]), UNDER_SCRIPTS],
    ...badEntries.map(([name, entry]) => [name, root => writeExtensions(root, [entry]), ENTRY_1]),
    ['a bad second entry', root => writeExtensions(root, [valid, changed({ id: 'b', module: '.claude/ext/b.mjs', onFailure: 'warn' })]), 'entry 2 is not an extension entry as docs/CONTRACT.md describes one'],
  ];
  for (const [name, setUp, problem] of rows) {
    await t.test(name, (st) => {
      const root = project();
      if (setUp(root, st) === false) return;
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

test('a link swapped in at the file after it was examined is not followed', (t) => {
  if (constants.O_NOFOLLOW === undefined) {
    t.skip('this platform has no O_NOFOLLOW; win32 needs elevation to make the link');
    return;
  }
  const root = project();
  const outside = tempDir('hk-ext-outside-');
  const e = extension(root, 'a', ALLOW);
  writeAt(join(outside, 'extensions.json'), JSON.stringify([e]));
  const path = join(root, EXTENSIONS_PATH);
  writeAt(path, '[]');
  // The swap happens between the file's lstat and its read, as a concurrent
  // writer would make it.
  const lstat = fs.lstatSync;
  t.after(() => { fs.lstatSync = lstat; syncBuiltinESMExports(); });
  fs.lstatSync = (p, ...rest) => {
    const st = lstat(p, ...rest);
    if (p === path) { unlinkSync(path); symlinkSync(join(outside, 'extensions.json'), path, 'file'); }
    return st;
  };
  syncBuiltinESMExports();
  assert.deepEqual(readExtensions(root), { state: 'malformed', problem: 'it could not be read' });
});

test('a .claude that is a link through which no extensions file is reached means no extensions', async (t) => {
  const rows = [
    ['a link to an empty directory outside the repository', () => tempDir('hk-ext-outside-')],
    ['a link to a directory holding the kit\'s scripts and gates but no extensions file', () => {
      const outside = tempDir('hk-ext-outside-');
      writeAt(join(outside, 'scripts/dispatch-pre-tool.mjs'), ALLOW);
      writeAt(join(outside, 'kh-harness/gates.json'), '{}');
      return outside;
    }],
    ['a link whose kh-harness is a file', () => {
      const outside = tempDir('hk-ext-outside-');
      writeAt(join(outside, 'kh-harness'), '');
      return outside;
    }],
    ['a dangling link', root => join(root, 'gone')],
    ['a link that loops on itself', root => join(root, '.claude')],
  ];
  for (const [name, target] of rows) {
    await t.test(name, (st) => {
      const root = project();
      if (!linkOrSkip(st, target(root), join(root, '.claude'), name.includes('loops') ? 'dir' : 'junction')) return;
      assert.deepEqual(readExtensions(root), { state: 'absent' });
    });
  }
});

test('no .claude, or no .claude/kh-harness, means no extensions', () => {
  const root = project();
  assert.deepEqual(readExtensions(root), { state: 'absent' });
  mkdirSync(join(root, '.claude'));
  assert.deepEqual(readExtensions(root), { state: 'absent' });
});

test('a repository root reached through a link still reads and judges its extensions', (t) => {
  const root = project();
  const e = extension(root, 'a', ALLOW);
  writeExtensions(root, [e]);
  const link = join(tempDir('hk-ext-link-'), 'repo');
  if (!linkOrSkip(t, root, link, 'junction')) return;
  assert.deepEqual(readExtensions(link), { state: 'ok', entries: [e] });
  assertMatchesWhatWasHashed(moduleState(link, e), e);
  assert.equal(moduleState(link, e).path, realpathSync.native(join(root, e.module)));
});

// --- moduleState ----------------------------------------------------------

test('a module whose bytes hash to the recorded value matches, and its real path and the bytes hashed are returned', () => {
  const root = project(); const e = extension(root, 'a', ALLOW);
  const state = moduleState(root, e);
  assert.deepEqual(state, { state: 'matches', path: realpathSync.native(join(root, e.module)), bytes: Buffer.from(ALLOW) });
  assertMatchesWhatWasHashed(state, e);
});

test('REVIEW FOCUS 2: the same module with CRLF line endings still matches, and the bytes returned are the LF ones hashed', () => {
  const root = project(); const e = extension(root, 'a', ALLOW);
  writeFileSync(join(root, e.module), ALLOW.replace(/\n/g, '\r\n'));
  const state = moduleState(root, e);
  assertMatchesWhatWasHashed(state, e);
  assert.deepEqual(state.bytes, Buffer.from(ALLOW));
});

test('a module holding CR CR LF, recorded by moduleSha256 of its file, matches and hands on the bytes of that hash', () => {
  const root = project(); const e = extension(root, 'a', 'x\r\r\ny\n');
  const state = moduleState(root, e);
  assertMatchesWhatWasHashed(state, e);
  assert.deepEqual(state.bytes, Buffer.from('x\r\ny\n'));
});

test('a module approved as LF that holds CR CR LF on disk differs', () => {
  const root = project(); const e = extension(root, 'a', 'x\ny\n');
  writeFileSync(join(root, e.module), 'x\r\r\ny\n');
  assert.deepEqual(moduleState(root, e), { state: 'differs' });
});

test('moduleSha256 makes each CRLF an LF in one pass', () => {
  assert.equal(moduleSha256(Buffer.from('x\r\r\ny')), plainSha256(Buffer.from('x\r\ny')));
});

test('moduleSha256 is the hash harness-log.mjs gives an installed script', () => {
  assert.equal(moduleSha256, lfSha256);
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
  writeFileSync(join(root, e.module), 'x'.repeat(EXTENSION_LIMITS.moduleMaxBytes));
  assert.deepEqual(moduleState(root, e), { state: 'differs' }, 'a module of exactly the bound is read');
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
  const state = moduleState(root, e);
  assert.deepEqual(state, { state: 'matches', path: realpathSync.native(join(root, target.module)), bytes: Buffer.from(ALLOW) });
  assertMatchesWhatWasHashed(state, e);
});

test('a module that is a dangling link is missing', (t) => {
  const root = project();
  const e = { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', sha256: moduleSha256(Buffer.from(ALLOW)), onFailure: 'block' };
  mkdirSync(join(root, '.claude/ext'), { recursive: true });
  if (!linkOrSkip(t, join(root, '.claude/ext/gone.mjs'), join(root, e.module), 'file')) return;
  assert.deepEqual(moduleState(root, e), { state: 'missing' });
});

test('a module that is a FIFO is unreadable, and judging it does not wait for a writer', (t) => {
  const root = project();
  const e = { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', sha256: moduleSha256(Buffer.from(ALLOW)), onFailure: 'block' };
  mkdirSync(join(root, '.claude/ext'), { recursive: true });
  const made = spawnSync('mkfifo', [join(root, e.module)]);
  if (made.status !== 0) {
    t.skip('this platform has no mkfifo');
    return;
  }
  // In a child process: were the open to wait for a writer, this test would
  // time out instead of hanging the suite.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { moduleState } from ${JSON.stringify(pathToFileURL(EXTENSIONS_MODULE).href)}; process.stdout.write(JSON.stringify(moduleState(process.argv[1], JSON.parse(process.argv[2]))));`,
    root, JSON.stringify(e)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.signal, null, 'judging a FIFO returned');
  assert.deepEqual(JSON.parse(r.stdout), { state: 'unreadable' });
});

test('a module that is a link loop is unreadable', (t) => {
  const root = project();
  const e = { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', sha256: moduleSha256(Buffer.from(ALLOW)), onFailure: 'block' };
  mkdirSync(join(root, '.claude/ext'), { recursive: true });
  if (!linkOrSkip(t, join(root, '.claude/ext/b.mjs'), join(root, e.module), 'file')) return;
  if (!linkOrSkip(t, join(root, e.module), join(root, '.claude/ext/b.mjs'), 'file')) return;
  assert.deepEqual(moduleState(root, e), { state: 'unreadable' });
});

test('a module reached through a link into .claude/scripts/ is outside', (t) => {
  const root = project();
  writeAt(join(root, '.claude/scripts/dispatch-pre-tool.mjs'), ALLOW);
  const e = { id: 'a', version: '1.0.0', module: '.claude/ext/dispatch-pre-tool.mjs', sha256: moduleSha256(Buffer.from(ALLOW)), onFailure: 'block' };
  if (!linkOrSkip(t, join(root, '.claude/scripts'), join(root, '.claude/ext'), 'junction')) return;
  assert.deepEqual(moduleState(root, e), { state: 'outside' });
});

test('moduleState never throws, whatever it is handed', () => {
  assert.deepEqual(moduleState(project(), { module: 7 }), { state: 'unreadable' });
  assert.deepEqual(moduleState(join(tmpdir(), 'hk-ext-no-such-root'), { module: '.claude/a.mjs' }), { state: 'missing' });
});
