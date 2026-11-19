// scripts/lib/harness-log.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  appendEvent,
  canonicalJson,
  dataRoot,
  GATES_PATH,
  harnessIdentity,
  isEnabled,
  LOCAL_GATES_FILE,
  LOG_SCHEMA,
  readConfig,
  readEvents,
  repoDataDir,
  repoKey,
  SCRUB_MARK,
  scrubValue,
  sessionFileName,
  setEnabled,
  storeBlob,
} from '../../assets/scripts/harness-log.mjs';

import { CREDENTIAL_SHAPES } from '../../assets/scripts/harness-redact.mjs';

const HARNESS_LOG_URL = new URL('../../assets/scripts/harness-log.mjs', import.meta.url).href;

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-log-data-');

const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function gitRepo() {
  const d = tempDir('hk-log-repo-');
  execFileSync('git', ['init', '-q', d]);
  writeFileSync(join(d, 'a.txt'), 'a\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

test('two worktrees of one repository map to one key', () => {
  const main = gitRepo();
  const wt = join(tempDir('hk-log-wt-'), 'wt');
  git(main, 'worktree', 'add', '-q', wt);
  assert.match(repoKey(main), /^[0-9a-f]{16}$/);
  assert.equal(repoKey(wt), repoKey(main));
  assert.equal(repoDataDir(wt), repoDataDir(main));
});

test('a sub-directory of a repository maps to the repository\'s key', () => {
  const repo = gitRepo();
  const sub = join(repo, 'packages', 'api');
  mkdirSync(sub, { recursive: true });
  assert.equal(repoKey(sub), repoKey(repo));
});

test('a sub-directory of a worktree maps to the same key as the main checkout', () => {
  const main = gitRepo();
  const wt = join(tempDir('hk-log-wt-'), 'wt');
  git(main, 'worktree', 'add', '-q', wt);
  const sub = join(wt, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  assert.equal(repoKey(sub), repoKey(main));
});

test('different repositories map to different keys', () => {
  assert.notEqual(repoKey(gitRepo()), repoKey(gitRepo()));
});

test('a .git file whose git directory has no commondir keys on that git directory', () => {
  const gitDir = join(tempDir('hk-log-gitdir-'), 'modules', 'sub');
  mkdirSync(gitDir, { recursive: true });
  const a = tempDir('hk-log-sub-a-');
  const b = tempDir('hk-log-sub-b-');
  writeFileSync(join(a, '.git'), `gitdir: ${gitDir}\n`);
  writeFileSync(join(b, '.git'), `gitdir: ${gitDir}\n`);
  assert.equal(repoKey(a), repoKey(b));
  assert.notEqual(repoKey(a), repoKey(tempDir('hk-log-plain-')));
});

test('a path differing only in case or separator maps to the same key on win32', { skip: process.platform !== 'win32' }, () => {
  const plain = tempDir('hk-log-case-');
  const variant = p => p.toUpperCase().replace(/\\/g, '/');
  assert.equal(repoKey(variant(plain)), repoKey(plain));
  const repo = gitRepo();
  assert.equal(repoKey(variant(repo)), repoKey(repo));
});

test('a non-git directory gets a key', () => {
  const d = tempDir('hk-log-nogit-');
  assert.match(repoKey(d), /^[0-9a-f]{16}$/);
  assert.equal(repoKey(d), repoKey(d));
  assert.notEqual(repoKey(d), repoKey(tempDir('hk-log-nogit-')));
});

test('a malformed .git file is treated as a non-git directory', () => {
  const d = tempDir('hk-log-badgit-');
  writeFileSync(join(d, '.git'), 'not a gitdir line\n');
  assert.match(repoKey(d), /^[0-9a-f]{16}$/);
});

test('nothing is enabled by default', () => {
  const d = gitRepo();
  assert.equal(isEnabled(d), false);
  assert.equal(existsSync(repoDataDir(d)), false, 'asking writes nothing');
  setEnabled(d, true);
  assert.equal(isEnabled(d), true);
  assert.ok(existsSync(join(repoDataDir(d), 'enabled.json')));
  setEnabled(d, false);
  assert.equal(isEnabled(d), false);
});

test('an unreadable enabled.json means disabled', () => {
  const d = tempDir('hk-log-badflag-');
  mkdirSync(repoDataDir(d), { recursive: true });
  writeFileSync(join(repoDataDir(d), 'enabled.json'), '{ not json');
  assert.equal(isEnabled(d), false);
});

test('KH_DATA_DIR overrides the location', () => {
  const previous = process.env.KH_DATA_DIR;
  const override = tempDir('hk-log-override-');
  process.env.KH_DATA_DIR = override;
  try {
    const d = gitRepo();
    assert.equal(dataRoot(), override);
    assert.equal(repoDataDir(d), join(override, repoKey(d)));
    setEnabled(d, true);
    assert.ok(existsSync(join(override, repoKey(d), 'enabled.json')));
  } finally {
    process.env.KH_DATA_DIR = previous;
  }
});

test('with no config file the defaults apply', () => {
  assert.deepEqual(readConfig(tempDir('hk-log-cfg-')), { contentRetentionDays: 90, inlineCapBytes: 65536, autodraft: false });
});

test('a valid config overrides the defaults it names', () => {
  const d = tempDir('hk-log-cfg-');
  mkdirSync(repoDataDir(d), { recursive: true });
  writeFileSync(join(repoDataDir(d), 'config.json'), JSON.stringify({ contentRetentionDays: 30, autodraft: true }));
  assert.deepEqual(readConfig(d), { contentRetentionDays: 30, inlineCapBytes: 65536, autodraft: true });
});

test('an unreadable config yields the defaults and says so', () => {
  const d = tempDir('hk-log-cfg-');
  mkdirSync(repoDataDir(d), { recursive: true });
  const defaults = { contentRetentionDays: 90, inlineCapBytes: 65536, autodraft: false, configUnreadable: true };
  for (const body of ['{ not json', '[]', 'null', JSON.stringify({ contentRetentionDays: -1 }), JSON.stringify({ inlineCapBytes: '64k' }), JSON.stringify({ autodraft: 'yes' })]) {
    writeFileSync(join(repoDataDir(d), 'config.json'), body);
    assert.deepEqual(readConfig(d), defaults, body);
  }
});

test('the gate locations are exported for later readers', () => {
  assert.equal(GATES_PATH, '.claude/kh-harness/gates.json');
  assert.equal(LOCAL_GATES_FILE, 'gates.local.json');
});

test('canonicalJson: key order does not change the output', () => {
  assert.equal(canonicalJson({ b: 1, a: 2, 10: 3, 9: 4 }), canonicalJson({ 9: 4, a: 2, 10: 3, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2, 10: 3, 9: 4 }), '{"10":3,"9":4,"a":2,"b":1}');
});

test('canonical JSON has one implementation, in harness-redact.mjs, which every installed script uses', async () => {
  const redact = await import('../../assets/scripts/harness-redact.mjs');
  assert.equal(typeof redact.canonicalJson, 'function');
  assert.equal(canonicalJson, redact.canonicalJson, 'harness-log.mjs re-exports it for the kit\'s readers');
  const scripts = join(import.meta.dirname, '..', '..', 'assets', 'scripts');
  const defining = readdirSync(scripts).filter(name => /function (canonicalJson|serialiseSorted)\b/.test(readFileSync(join(scripts, name), 'utf8')));
  assert.deepEqual(defining, ['harness-redact.mjs']);
});

test('canonicalJson: arrays keep their order', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('canonicalJson: nested objects are sorted', () => {
  assert.equal(
    canonicalJson({ z: { y: [{ b: 'x', a: null }], x: true }, a: 'q' }),
    '{"a":"q","z":{"x":true,"y":[{"a":null,"b":"x"}]}}',
  );
});

const HOOK = '.claude/scripts/session-log.mjs';
const RULES = 'docs/harness/RULES.md';
const LEARNED = 'docs/harness/LEARNED.md';
const HANDOFF = 'HANDOFF.md';
const MANIFEST = '.claude/kh-harness.manifest.json';

const gate = (id, extra = {}) => ({ id, tool: 'Bash', field: 'command', match: { kind: 'literal', value: 'rm -rf' }, action: 'observe', message: 'no', ...extra });
const committedGates = gates => JSON.stringify({ schema: 1, generatedBy: 'kh-harness land', gates }) + '\n';
const localGates = gates => JSON.stringify({ schema: 1, gates });

const writeAt = (root, rel, body) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};

/** A repository as `apply` and one landed learning leave it: every file
 * below is recorded in the manifest, the scaffolded documents and the
 * learned files included. */
function installedRepo({ settingsPatches = [{ event: 'PreToolUse', entrySha256: 'e1', appliedAt: '2026-11-01T00:00:00.000Z' }] } = {}) {
  const root = tempDir('hk-log-ident-');
  const files = {
    [HOOK]: '// hook\nexport {};\n',
    [RULES]: '# Rules\n',
    [HANDOFF]: '# Handoff\n',
    [LEARNED]: '# Learned\n',
    [GATES_PATH]: committedGates([gate('L1')]),
  };
  for (const [rel, body] of Object.entries(files)) writeAt(root, rel, body);
  const manifest = { schema: 1, kitVersion: '0.9.0', files: Object.keys(files).map(path => ({ path, sha256: 'recorded' })), settingsPatches };
  writeAt(root, MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  return root;
}

test('harnessIdentity: base and learned are SHA-256 hex and kitVersion comes from the manifest', () => {
  const id = harnessIdentity(installedRepo());
  assert.match(id.base, /^[0-9a-f]{64}$/);
  assert.match(id.learned, /^[0-9a-f]{64}$/);
  assert.equal(id.kitVersion, '0.9.0');
});

test('editing an installed hook changes base', () => {
  const root = installedRepo();
  const before = harnessIdentity(root);
  writeAt(root, HOOK, '// hook, edited by hand\nexport {};\n');
  const after = harnessIdentity(root);
  assert.notEqual(after.base, before.base);
  assert.equal(after.learned, before.learned);
});

test('deleting an installed hook changes base', () => {
  const root = installedRepo();
  const before = harnessIdentity(root).base;
  rmSync(join(root, HOOK));
  assert.notEqual(harnessIdentity(root).base, before);
});

test('a CRLF checkout does not change base', () => {
  const root = installedRepo();
  const before = harnessIdentity(root);
  for (const rel of [HOOK, RULES, HANDOFF, LEARNED, GATES_PATH]) {
    writeFileSync(join(root, rel), readFileSync(join(root, rel), 'utf8').replace(/\n/g, '\r\n'));
  }
  assert.deepEqual(harnessIdentity(root), before);
});

test('a lone CR is not normalised away', () => {
  const root = installedRepo();
  writeAt(root, HOOK, 'a\nb\n');
  const before = harnessIdentity(root).base;
  writeAt(root, HOOK, 'a\rb\n');
  assert.notEqual(harnessIdentity(root).base, before);
});

test('a change to the settings patches changes base', () => {
  const a = installedRepo();
  const b = installedRepo({ settingsPatches: [{ event: 'PreToolUse', entrySha256: 'e2', appliedAt: '2026-11-01T00:00:00.000Z' }] });
  assert.notEqual(harnessIdentity(a).base, harnessIdentity(b).base);
  assert.equal(harnessIdentity(a).learned, harnessIdentity(b).learned);
});

test('re-running apply with nothing changed leaves base the same', () => {
  const a = installedRepo();
  const b = installedRepo({ settingsPatches: [{ event: 'PreToolUse', entrySha256: 'e1', appliedAt: '2026-11-19T12:34:56.789Z' }] });
  assert.equal(harnessIdentity(a).base, harnessIdentity(b).base);
});

const writeLocalGates = (root, body) => {
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(join(repoDataDir(root), LOCAL_GATES_FILE), body);
};

test('adding a local trial gate changes learned and not base', () => {
  const root = installedRepo();
  const before = harnessIdentity(root);
  writeLocalGates(root, localGates([gate('L2')]));
  const after = harnessIdentity(root);
  assert.notEqual(after.learned, before.learned);
  assert.equal(after.base, before.base);
});

test('suspending a committed gate locally changes learned', () => {
  const root = installedRepo();
  const before = harnessIdentity(root);
  writeLocalGates(root, localGates([{ id: 'L1', suspended: true }]));
  const suspended = harnessIdentity(root);
  assert.notEqual(suspended.learned, before.learned);
  assert.equal(suspended.base, before.base);
  writeLocalGates(root, localGates([{ id: 'L1', suspended: true, reason: 'marked wrong twice' }]));
  assert.equal(harnessIdentity(root).learned, suspended.learned, 'a suspension contributes only its id');
});

test('landing a gate in the tree changes learned and not base', () => {
  const root = installedRepo();
  const before = harnessIdentity(root);
  writeAt(root, GATES_PATH, committedGates([gate('L1'), gate('L2')]));
  writeAt(root, LEARNED, '# Learned\n\n## L2 — second\n');
  const after = harnessIdentity(root);
  assert.notEqual(after.learned, before.learned);
  assert.equal(after.base, before.base);
});

test('editing docs/harness/RULES.md changes neither', () => {
  const root = installedRepo();
  const before = harnessIdentity(root);
  writeAt(root, RULES, '# Rules\n\n## R1 — the owner\'s rule\n');
  assert.deepEqual(harnessIdentity(root), before);
});

test('editing HANDOFF.md, though the manifest records it, does not change base', () => {
  const root = installedRepo();
  const before = harnessIdentity(root);
  writeAt(root, HANDOFF, '# Handoff\n\nNext: finish the parser.\n');
  assert.deepEqual(harnessIdentity(root), before);
});

test('a gate\'s action does not change learned; its content does', () => {
  const root = installedRepo();
  const before = harnessIdentity(root).learned;
  writeAt(root, GATES_PATH, committedGates([gate('L1', { action: 'block' })]));
  assert.equal(harnessIdentity(root).learned, before);
  writeAt(root, GATES_PATH, committedGates([gate('L1', { message: 'changed' })]));
  assert.notEqual(harnessIdentity(root).learned, before);
});

test('the committed file\'s generatedBy does not change learned', () => {
  const root = installedRepo();
  const before = harnessIdentity(root).learned;
  writeAt(root, GATES_PATH, JSON.stringify({ schema: 1, generatedBy: 'another writer', gates: [gate('L1')] }));
  assert.equal(harnessIdentity(root).learned, before);
});

test('learned does not depend on the order the gates are written in', () => {
  const root = installedRepo();
  writeAt(root, GATES_PATH, committedGates([gate('L1'), gate('L2')]));
  const before = harnessIdentity(root).learned;
  writeAt(root, GATES_PATH, committedGates([gate('L2'), gate('L1')]));
  assert.equal(harnessIdentity(root).learned, before);
});

test('a damaged gate file changes learned', () => {
  const root = installedRepo();
  rmSync(join(root, GATES_PATH));
  const absent = harnessIdentity(root).learned;
  const seen = new Set([absent]);
  const damage = [
    '{ not json', 'null', JSON.stringify([gate('L1')]), '{"schema":1}', '{"schema":2,"gates":[]}', '{"gates":[]}',
    '{"schema":1,"gates":{}}', '{"schema":1,"gates":[1]}', '{"schema":1,"gates":[{"tool":"Bash"}]}',
  ];
  for (const body of damage) {
    writeAt(root, GATES_PATH, body);
    const damaged = harnessIdentity(root).learned;
    assert.notEqual(damaged, absent, body);
    seen.add(damaged);
  }
  assert.equal(seen.size, 2, 'every kind of damage contributes the one literal "unreadable"');
});

test('no manifest yields base none', () => {
  const id = harnessIdentity(tempDir('hk-log-ident-bare-'));
  assert.equal(id.base, 'none');
  assert.equal(id.kitVersion, null);
  assert.match(id.learned, /^[0-9a-f]{64}$/);
});

test('an unreadable or malformed manifest yields base unreadable', () => {
  const root = installedRepo();
  const bodies = [
    '{ not json', 'null', '[]', '{"schema":2,"files":[]}', '{"schema":1}',
    '{"schema":1,"files":[{"sha256":"x"}]}', '{"schema":1,"files":[],"settingsPatches":{}}', '{"schema":1,"files":[],"settingsPatches":[1]}',
    '{"schema":1,"files":[{"path":"../outside.txt"}]}', '{"schema":1,"files":[{"path":"/etc/hosts"}]}',
  ];
  for (const body of bodies) {
    writeAt(root, MANIFEST, body);
    const id = harnessIdentity(root);
    assert.equal(id.base, 'unreadable', body);
    assert.equal(id.kitVersion, null, body);
  }
  rmSync(join(root, MANIFEST));
  mkdirSync(join(root, MANIFEST));
  assert.equal(harnessIdentity(root).base, 'unreadable', 'a manifest path that cannot be read as a file');
});

// Built at runtime so the repository's own credential sweep never sees one.
const githubToken = () => 'gh' + 'p_' + 'A1b2C3d4'.repeat(5);

const sessionFile = (root, sessionId) => join(repoDataDir(root), 'sessions', sessionFileName(sessionId));
const blobFile = (root, sha256) => join(repoDataDir(root), 'blobs', `${sha256}.gz`);
const sha256Of = text => createHash('sha256').update(text, 'utf8').digest('hex');

const writeConfig = (root, config) => {
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'config.json'), JSON.stringify(config));
};

/** Runs `count` child processes at once, each appending `perChild` events to
 * one session, and resolves with every child's exit code and stderr. */
function appendFromChildren(root, sessionId, count, perChild) {
  const script = `
    import { appendEvent } from ${JSON.stringify(HARNESS_LOG_URL)};
    const [root, sessionId, child, perChild] = process.argv.slice(1);
    for (let i = 0; i < Number(perChild); i++) {
      const r = appendEvent(root, sessionId, { child: Number(child), i, pad: 'x'.repeat(2000 + Number(child) * 37 + i) });
      if (!r.written) { console.error(r.reason); process.exit(1); }
    }`;
  const runs = Array.from({ length: count }, (_, child) => new Promise(resolve => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script, root, sessionId, String(child), String(perChild)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', chunk => { stderr += chunk; });
    p.on('error', error => resolve({ code: null, stderr: String(error) }));
    p.on('close', code => resolve({ code, stderr }));
  }));
  return Promise.all(runs);
}

test('fifty processes appending at once lose and interleave no line', async () => {
  const root = tempDir('hk-log-concurrent-');
  const results = await appendFromChildren(root, 'concurrent', 50, 20);
  assert.deepEqual(results.filter(r => r.code !== 0), [], 'every child wrote every event');
  const raw = readFileSync(sessionFile(root, 'concurrent'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(raw.split('\n').length - 1, 1000, 'one line per event');
  const { events, unparseable } = readEvents(root, 'concurrent');
  assert.equal(unparseable, 0);
  assert.equal(events.length, 1000);
  const seen = new Set();
  for (const e of events) {
    assert.equal(e.pad, 'x'.repeat(2000 + e.child * 37 + e.i), 'the line arrived whole');
    seen.add(`${e.child}:${e.i}`);
  }
  assert.equal(seen.size, 1000, 'no event is duplicated or missing');
});

test('each event carries schema, ts and pid, and the writer owns them', () => {
  const root = tempDir('hk-log-envelope-');
  const before = Date.now();
  assert.deepEqual(appendEvent(root, 's1', { type: 'PreToolUse', schema: 99, pid: -1, ts: 'then' }), { written: true });
  const { events } = readEvents(root, 's1');
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(LOG_SCHEMA, 1);
  assert.equal(e.schema, LOG_SCHEMA);
  assert.equal(e.pid, process.pid);
  assert.ok(Date.parse(e.ts) >= before - 1000 && Date.parse(e.ts) <= Date.now() + 1000, e.ts);
  assert.equal(e.type, 'PreToolUse');
});

test('SCRUB_MARK is what both the mask and a credential-named key leave behind', () => {
  assert.equal(SCRUB_MARK, '***');
  assert.deepEqual(scrubValue({ note: `key ${githubToken()}`, [PASSWORD]: 'plain' }), { note: `key ${SCRUB_MARK}`, [PASSWORD]: SCRUB_MARK });
});

test('scrubValue masks every string leaf of a deep copy and leaves the input alone', () => {
  const token = githubToken();
  const input = { a: [token, 1, null, true, { b: `key ${token}` }], c: 'plain' };
  assert.deepEqual(scrubValue(input), { a: ['***', 1, null, true, { b: 'key ***' }], c: 'plain' });
  assert.equal(input.a[0], token, 'the input is not modified');
  assert.equal(scrubValue(token), '***');
  assert.equal(scrubValue(7), 7);
});

test('a credential used as an object key is masked', () => {
  const token = githubToken();
  assert.deepEqual(scrubValue({ headers: { [token]: 'x', plain: 'y' } }), { headers: { '***': 'x', plain: 'y' } });
  const root = tempDir('hk-log-key-');
  appendEvent(root, 's1', { env: { [token]: 'v' } });
  assert.ok(!readFileSync(sessionFile(root, 's1'), 'utf8').includes(token.slice(4)), 'no part of the key is stored');
  assert.deepEqual(readEvents(root, 's1').events[0].env, { '***': 'v' });
});

test('keys that mask to the same string keep every value, the later ones suffixed', () => {
  const a = githubToken();
  const b = 'gh' + 'o_' + 'Z9y8X7w6'.repeat(5);
  assert.deepEqual(
    scrubValue({ [a]: 1, [b]: 2, '***#2': 3, [a + ' ']: 4 }),
    { '***': 1, '***#2': 2, '***#2#2': 3, '*** ': 4 },
  );
  assert.deepEqual(scrubValue({ '***': 1, [a]: 2 }), { '***': 1, '***#2': 2 }, 'an unmasked key that is already *** is kept first');
});

// Credential names and values assembled at runtime, for the same reason as
// `githubToken`; each value is distinct so a raw-file search is meaningful.
const PASSWORD = 'pass' + 'word';
const CREDENTIAL_KEYS = [PASSWORD, 'DB_' + 'PASS', 'api' + '_key', 'client' + '_secret', 'GITHUB_' + 'TOKEN'];
const secretValue = n => 'Qz' + '7v' + `-s3cr3t-${n}`;

const rawSession = (root, sessionId) => readFileSync(sessionFile(root, sessionId), 'utf8');

test('a credential identified by its key is masked', () => {
  const root = tempDir('hk-log-keyed-');
  CREDENTIAL_KEYS.forEach((key, n) => {
    const value = secretValue(n);
    assert.deepEqual(scrubValue({ [key]: value, note: 'kept' }), { [key]: '***', note: 'kept' }, key);
    assert.deepEqual(appendEvent(root, 's1', { tool_input: { [key]: value } }), { written: true });
    assert.ok(!rawSession(root, 's1').includes(value), key);
  });
  const header = 'Bearer ' + secretValue('h');
  assert.deepEqual(scrubValue({ ['author' + 'ization']: header }), { ['author' + 'ization']: '***' });
  appendEvent(root, 's1', { headers: { ['Author' + 'ization']: header } });
  assert.ok(!rawSession(root, 's1').includes(secretValue('h')));
  assert.deepEqual(readEvents(root, 's1').events.map(e => Object.values(e.tool_input ?? e.headers)[0]), Array(6).fill('***'));
});

test('a number or boolean under a credential-named key is masked', () => {
  const root = tempDir('hk-log-keyed-num-');
  assert.deepEqual(scrubValue({ [PASSWORD]: 12345678, count: 12345678, flag: true }), { [PASSWORD]: '***', count: 12345678, flag: true });
  assert.deepEqual(scrubValue({ ['api' + '_key']: false }), { ['api' + '_key']: '***' });
  appendEvent(root, 's1', { [PASSWORD]: 87654321 });
  assert.ok(!rawSession(root, 's1').includes('87654321'));
});

test('a value after a credential flag in an argument list is masked', () => {
  const root = tempDir('hk-log-argv-');
  const args = ['mysql', '--' + PASSWORD, secretValue('a'), '--token', secretValue('b'), '-H', 'Author' + 'ization:', 'Basic ' + secretValue('c'), '--name', 'kept'];
  assert.deepEqual(scrubValue(args), ['mysql', '--' + PASSWORD, '***', '--token', '***', '-H', 'Author' + 'ization:', '***', '--name', 'kept']);
  appendEvent(root, 's1', { tool_input: { args } });
  const raw = rawSession(root, 's1');
  for (const n of ['a', 'b', 'c']) assert.ok(!raw.includes(secretValue(n)), n);
  assert.deepEqual(scrubValue(['git', 'commit', '-m', 'fix']), ['git', 'commit', '-m', 'fix']);
});

test('a secret three levels deep under a credential-named key is masked', () => {
  const root = tempDir('hk-log-deep-');
  const event = { tool_input: { config: { db: { [PASSWORD]: secretValue('d') } } }, list: [{ env: { ['DB_' + 'PASS']: secretValue('e') } }] };
  assert.deepEqual(scrubValue(event), { tool_input: { config: { db: { [PASSWORD]: '***' } } }, list: [{ env: { ['DB_' + 'PASS']: '***' } }] });
  appendEvent(root, 's1', event);
  const raw = rawSession(root, 's1');
  assert.ok(!raw.includes(secretValue('d')) && !raw.includes(secretValue('e')));
});

test('a credential-named key hides every scalar beneath it, through arrays and objects', () => {
  const root = tempDir('hk-log-keyed-deep-');
  const event = {
    [PASSWORD]: [secretValue('in-array')],
    ['api' + '_key']: { current: secretValue('in-object'), previous: [secretValue('nested'), 7, true, null] },
    note: ['kept', { also: 'kept' }],
  };
  assert.deepEqual(scrubValue(event), {
    [PASSWORD]: ['***'],
    ['api' + '_key']: { current: '***', previous: ['***', '***', '***', null] },
    note: ['kept', { also: 'kept' }],
  });
  appendEvent(root, 's1', event);
  const raw = rawSession(root, 's1');
  for (const n of ['in-array', 'in-object', 'nested']) assert.ok(!raw.includes(secretValue(n)), n);
});

test('a private key held one line per array element is masked whole', () => {
  const root = tempDir('hk-log-pem-lines-');
  const body = ['MIIEowIBAAKCAQEA' + 'x'.repeat(48), 'y'.repeat(64), 'z'.repeat(24) + '=='];
  const lines = ['before', '-----BEGIN RSA ' + 'PRIVATE KEY-----', ...body, '-----END RSA ' + 'PRIVATE KEY-----', 'after'];
  assert.deepEqual(scrubValue(lines), ['before', '***', '***', '***', '***', '***', 'after']);
  assert.deepEqual(scrubValue({ patch: [{ lines }] }), { patch: [{ lines: ['before', '***', '***', '***', '***', '***', 'after'] }] });
  appendEvent(root, 's1', { tool_response: { lines } });
  const raw = rawSession(root, 's1');
  for (const line of body) assert.ok(!raw.includes(line), 'no body line is stored');
});

test('a string element holding several lines keeps them when its run is masked as one text', () => {
  const token = githubToken();
  assert.deepEqual(scrubValue(['one\ntwo', `three ${token}\r\nfour`, 5, 'six\n']), ['one\ntwo', 'three ***\r\nfour', 5, 'six\n']);
});

test('a run whose elements cannot be told apart after masking is hidden whole', () => {
  // An operating-system-command escape opened in one element and closed in
  // the next takes the line break between them with it.
  assert.deepEqual(scrubValue(['a \u001b]0;title', 'still title\u0007 b', 'c']), ['***', '***', '***']);
});

test('a credential-named key hides its value whatever the value starts with', () => {
  const root = tempDir('hk-log-keyed-start-');
  const starts = ['=', '>', ',', ';', '\n', '=>', ' ', githubToken() + ' '];
  starts.forEach((start, n) => {
    for (const key of [PASSWORD, 'GITHUB_' + 'TOKEN']) {
      const value = start + secretValue(`${key}-${n}`);
      assert.deepEqual(scrubValue({ [key]: value }), { [key]: '***' }, JSON.stringify(value));
      appendEvent(root, 's1', { tool_input: { [key]: value } });
      assert.ok(!rawSession(root, 's1').includes(secretValue(`${key}-${n}`)), JSON.stringify(value));
    }
    const args = ['--' + PASSWORD, start + secretValue(`argv-${n}`)];
    assert.deepEqual(scrubValue(args), ['--' + PASSWORD, '***'], JSON.stringify(args));
    appendEvent(root, 's1', { args });
    assert.ok(!rawSession(root, 's1').includes(secretValue(`argv-${n}`)), JSON.stringify(args));
  });
});

// A keyed shape whose key is part of the value itself, so the value's own
// mask covers it and no key or flag can name it.
const VALUE_ONLY_KEYED = new Set(['url-userinfo']);
// For every other keyed shape, keys it must recognise by the key alone.
const KEYED_REPRESENTATIVES = {
  'credential-assignment': [PASSWORD, 'DB_' + 'PASS', 'api' + '_key', 'client' + '_secret', 'pwd'],
  'token-assignment': ['GITHUB_' + 'TOKEN', '--token'],
  'authorization-header': ['author' + 'ization', 'Author' + 'ization'],
};

test('every keyed credential shape is recognised from a key or flag alone', () => {
  const keyed = CREDENTIAL_SHAPES.filter(s => s.kind === 'keyed').map(s => s.id).sort();
  assert.deepEqual(keyed, [...VALUE_ONLY_KEYED, ...Object.keys(KEYED_REPRESENTATIVES)].sort(),
    'a new keyed shape must be given representative keys here, or ruled value-only');
  for (const [id, keys] of Object.entries(KEYED_REPRESENTATIVES)) {
    for (const key of keys) {
      assert.deepEqual(scrubValue({ [key]: 'v' }), { [key]: '***' }, `${id}: ${key}`);
      assert.deepEqual(scrubValue([key, 'v']), [key, '***'], `${id}: ${key} as a flag`);
    }
  }
});

test('a Bearer scheme after an Authorization flag hides the token after it too', () => {
  const root = tempDir('hk-log-argv-bearer-');
  const args = ['curl', '-H', 'Author' + 'ization:', 'Bearer', secretValue('t'), 'https://example.test'];
  assert.deepEqual(scrubValue(args), ['curl', '-H', 'Author' + 'ization:', '***', '***', 'https://example.test']);
  appendEvent(root, 's1', { args });
  assert.ok(!rawSession(root, 's1').includes(secretValue('t')));
});

test('a number or boolean after a credential flag is masked', () => {
  const root = tempDir('hk-log-argv-num-');
  assert.deepEqual(scrubValue(['--' + PASSWORD, 12345678, '--count', 5, '--token', true]), ['--' + PASSWORD, '***', '--count', 5, '--token', '***']);
  appendEvent(root, 's1', { args: ['--' + PASSWORD, 87654321] });
  assert.ok(!rawSession(root, 's1').includes('87654321'));
});

test('a value merely mentioning a credential word is kept', () => {
  assert.deepEqual(scrubValue({ description: `reset the ${PASSWORD}`, path: '/tmp/x' }), { description: `reset the ${PASSWORD}`, path: '/tmp/x' });
});

test('a __proto__ key stays an ordinary property', () => {
  const copy = scrubValue(JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.ok(Object.hasOwn(copy, '__proto__'));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
});

test('a session id that is a Windows device name still gets a writable file', () => {
  const root = tempDir('hk-log-device-');
  for (const id of ['CON', 'NUL', 'COM1', 'aux', 'PRN', 'LPT1']) {
    assert.equal(sessionFileName(id), `s-${id}.jsonl`);
    assert.deepEqual(appendEvent(root, id, { id }), { written: true }, id);
    assert.deepEqual(readEvents(root, id).events.map(e => e.id), [id], id);
  }
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'sessions')).sort(),
    ['s-COM1.jsonl', 's-CON.jsonl', 's-LPT1.jsonl', 's-NUL.jsonl', 's-PRN.jsonl', 's-aux.jsonl'].sort());
  assert.equal(sessionFileName('../escape'), null);
});

test('an ANSI-coloured token is masked in the stored event', () => {
  const root = tempDir('hk-log-ansi-');
  const token = githubToken();
  appendEvent(root, 's1', { output: `\u001b[31m${token}\u001b[0m done` });
  const raw = readFileSync(sessionFile(root, 's1'), 'utf8');
  assert.ok(!raw.includes(token.slice(4)), 'no part of the token is stored');
  assert.ok(!raw.includes('\\u001b'), 'no escape sequence is stored');
  assert.equal(readEvents(root, 's1').events[0].output, '*** done');
});

test('a credential is masked before the cap is applied, so it cannot straddle the boundary', () => {
  const root = tempDir('hk-log-straddle-');
  writeConfig(root, { inlineCapBytes: 100 });
  const token = githubToken();
  const straddling = 'a'.repeat(80) + ' ' + token + ' ' + 'b'.repeat(50);
  const shrinks = 'c'.repeat(80) + ' ' + token;
  assert.ok(Buffer.byteLength(shrinks) > 100 && Buffer.byteLength(scrubValue(shrinks)) <= 100);
  appendEvent(root, 's1', { straddling, shrinks });
  const [e] = readEvents(root, 's1').events;
  assert.equal(e.shrinks, 'c'.repeat(80) + ' ***', 'the masked length, not the raw one, decides the cap');
  assert.deepEqual(Object.keys(e.straddling).sort(), ['blob', 'bytes', 'truncated']);
  const blob = gunzipSync(readFileSync(blobFile(root, e.straddling.blob))).toString('utf8');
  assert.equal(blob, 'a'.repeat(80) + ' *** ' + 'b'.repeat(50));
  for (const stored of [readFileSync(sessionFile(root, 's1'), 'utf8'), blob]) {
    assert.ok(!stored.includes(token.slice(0, 12)) && !stored.includes(token.slice(-12)), 'neither half of the token is stored');
  }
});

test('a 200 KB output becomes a blob reference and the blob holds the scrubbed text', () => {
  const root = tempDir('hk-log-blob-');
  const token = githubToken();
  const output = 'line of output\n'.repeat(10000) + 'export GITHUB_TOKEN' + '=' + token + '\n' + 'é'.repeat(30000);
  assert.ok(Buffer.byteLength(output) > 200 * 1024);
  assert.deepEqual(appendEvent(root, 's1', { tool_response: { stdout: output, exitCode: 0 } }), { written: true });
  const [e] = readEvents(root, 's1').events;
  const scrubbed = scrubValue(output);
  assert.ok(!scrubbed.includes(token));
  assert.deepEqual(e.tool_response, { stdout: { blob: sha256Of(scrubbed), bytes: Buffer.byteLength(scrubbed), truncated: true }, exitCode: 0 });
  assert.equal(gunzipSync(readFileSync(blobFile(root, e.tool_response.stdout.blob))).toString('utf8'), scrubbed);
  assert.ok(statSync(sessionFile(root, 's1')).size < 1024, 'the content is not inlined');
});

test('the same blob is written once', () => {
  const root = tempDir('hk-log-once-');
  const text = 'z'.repeat(70000);
  const first = storeBlob(root, text);
  assert.deepEqual(first, { sha256: sha256Of(text), bytes: 70000 });
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(blobFile(root, first.sha256), old, old);
  assert.deepEqual(storeBlob(root, text), first);
  appendEvent(root, 's1', { output: text });
  appendEvent(root, 's2', { output: text });
  assert.equal(statSync(blobFile(root, first.sha256)).mtimeMs, old.getTime(), 'the existing blob is not rewritten');
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'blobs')), [`${first.sha256}.gz`]);
});

test('storeBlob masks what it stores', () => {
  const root = tempDir('hk-log-storemask-');
  const { sha256 } = storeBlob(root, `value ${githubToken()}`);
  assert.equal(gunzipSync(readFileSync(blobFile(root, sha256))).toString('utf8'), 'value ***');
  assert.equal(sha256, sha256Of('value ***'));
});

test('a blob that cannot be stored leaves a null reference, never a dangling one', () => {
  const root = tempDir('hk-log-noblob-');
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'blobs'), 'a file where the directory should be');
  assert.equal(storeBlob(root, 'text'), null);
  assert.deepEqual(appendEvent(root, 's1', { output: 'y'.repeat(70000) }), { written: true });
  assert.deepEqual(readEvents(root, 's1').events[0].output, { blob: null, bytes: 70000, truncated: true });
});

test('an unwritable sessions directory returns written: false and does not throw', () => {
  const root = tempDir('hk-log-unwritable-');
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'sessions'), 'a file where the directory should be');
  const r = appendEvent(root, 's1', { type: 'Stop' });
  assert.equal(r.written, false);
  assert.match(r.reason, /^write failed: E[A-Z]+$/);
});

test('an unsafe session id or a non-object event writes nothing', () => {
  const root = tempDir('hk-log-unsafe-');
  for (const id of ['../escape', '', null, 'a/b', 'x'.repeat(201)]) {
    assert.deepEqual(appendEvent(root, id, { type: 'Stop' }), { written: false, reason: 'unsafe session id' }, String(id));
  }
  for (const event of [null, 'text', [1, 2], 5]) {
    assert.deepEqual(appendEvent(root, 's1', event), { written: false, reason: 'event is not an object' }, JSON.stringify(event));
  }
  assert.equal(existsSync(join(repoDataDir(root), 'sessions')), false);
});

test('an event that cannot be serialised returns written: false', () => {
  const root = tempDir('hk-log-cycle-');
  const cyclic = { type: 'Stop' };
  cyclic.self = cyclic;
  for (const event of [cyclic, { n: 1n }]) {
    assert.deepEqual(appendEvent(root, 's1', event), { written: false, reason: 'event is not serialisable' });
  }
  assert.equal(existsSync(sessionFile(root, 's1')), false);
});

test('a damaged line is counted, not silently dropped', () => {
  const root = tempDir('hk-log-damaged-');
  appendEvent(root, 's1', { n: 1 });
  writeFileSync(sessionFile(root, 's1'), '{"n":2, trunc\n42\n', { flag: 'a' });
  appendEvent(root, 's1', { n: 3 });
  const { events, unparseable } = readEvents(root, 's1');
  assert.deepEqual(events.map(e => e.n), [1, 3]);
  assert.equal(unparseable, 2);
});

test('a compressed session is read, before any events appended after it', () => {
  const root = tempDir('hk-log-gz-');
  appendEvent(root, 's1', { n: 1 });
  appendEvent(root, 's1', { n: 2 });
  const plain = sessionFile(root, 's1');
  writeFileSync(`${plain}.gz`, gzipSync(readFileSync(plain)));
  rmSync(plain);
  assert.deepEqual(readEvents(root, 's1').events.map(e => e.n), [1, 2]);
  appendEvent(root, 's1', { n: 3 });
  assert.deepEqual(readEvents(root, 's1').events.map(e => e.n), [1, 2, 3]);
});

test('reading an absent, unsafe or undecompressable session never throws', () => {
  const root = tempDir('hk-log-readfail-');
  assert.deepEqual(readEvents(root, 'absent'), { events: [], unparseable: 0, unreadable: false });
  assert.deepEqual(readEvents(root, '../escape'), { events: [], unparseable: 0, unreadable: false });
  mkdirSync(join(repoDataDir(root), 'sessions'), { recursive: true });
  writeFileSync(`${sessionFile(root, 's1')}.gz`, 'not gzip');
  appendEvent(root, 's1', { n: 1 });
  const read = readEvents(root, 's1');
  assert.deepEqual(read.events.map(e => e.n), [1], 'what could be read is still returned');
  assert.equal(read.unreadable, true);
  assert.equal(read.unparseable, 0);
});
