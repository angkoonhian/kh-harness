// scripts/lib/harness-log.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  canonicalJson,
  dataRoot,
  GATES_PATH,
  harnessIdentity,
  isEnabled,
  LOCAL_GATES_FILE,
  readConfig,
  repoDataDir,
  repoKey,
  setEnabled,
} from '../../assets/scripts/harness-log.mjs';

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
