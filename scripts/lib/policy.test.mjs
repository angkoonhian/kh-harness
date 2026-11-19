// scripts/lib/policy.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { checkedPolicy, policyAllows, readPolicy, removePolicy, writePolicy } from './policy.mjs';

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-policy-data-');

const POLICY = Object.freeze({ minTrialFirings: 5, minTrialSessions: 2, maxAction: 'warn' });
const MET = Object.freeze({ firings: 5, sessions: 2, wrong: 0, external: false });

function writeRaw(root, text) {
  const dir = repoDataDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.json'), text, 'utf8');
}

test('no policy file means nothing is allowed', () => {
  const root = tempDir('hk-policy-repo-');
  const read = readPolicy(root);
  assert.deepEqual(read, { state: 'absent' });
  assert.equal(policyAllows(null, MET), false);
});

test('one wrong mark blocks promotion', () => {
  assert.equal(policyAllows(POLICY, MET), true);
  assert.equal(policyAllows(POLICY, { ...MET, firings: 100, sessions: 100, wrong: 1 }), false);
});

test('a missing wrong count or external flag blocks promotion', () => {
  const { wrong: _w, ...noWrong } = MET;
  const { external: _e, ...noExternal } = MET;
  assert.equal(policyAllows(POLICY, noWrong), false);
  assert.equal(policyAllows(POLICY, noExternal), false);
  assert.equal(policyAllows(POLICY, { firings: 5, sessions: 2 }), false);
  assert.equal(policyAllows(POLICY), false);
});

test('malformed trial counts block promotion', () => {
  for (const bad of [undefined, null, NaN, -1, 1.5, '5', Infinity]) {
    assert.equal(policyAllows(POLICY, { ...MET, firings: bad }), false, `firings ${String(bad)}`);
    assert.equal(policyAllows(POLICY, { ...MET, sessions: bad }), false, `sessions ${String(bad)}`);
    assert.equal(policyAllows(POLICY, { ...MET, wrong: bad }), false, `wrong ${String(bad)}`);
  }
  for (const bad of [undefined, null, 0, '', 'false']) {
    assert.equal(policyAllows(POLICY, { ...MET, external: bad }), false, `external ${String(bad)}`);
  }
});

test('anything but a valid policy allows nothing', () => {
  const invalid = [
    undefined,
    null,
    [],
    { ...POLICY, minTrialFirings: 0 },
    { ...POLICY, maxAction: 'observe' },
    { minTrialFirings: 5, maxAction: 'warn' },
    { ...POLICY, allowExternal: true },
  ];
  for (const policy of invalid) {
    assert.equal(policyAllows(policy, { ...MET, firings: 100, sessions: 100 }), false, JSON.stringify(policy));
  }
});

test('external evidence blocks promotion', () => {
  assert.equal(policyAllows(POLICY, { ...MET, firings: 100, sessions: 100, external: true }), false);
});

test('the thresholds are inclusive', () => {
  assert.equal(policyAllows(POLICY, { ...MET, firings: 5, sessions: 2 }), true);
  assert.equal(policyAllows(POLICY, { ...MET, firings: 4 }), false);
  assert.equal(policyAllows(POLICY, { ...MET, sessions: 1 }), false);
});

test('a written policy reads back with the hash writePolicy returned', () => {
  const root = tempDir('hk-policy-repo-');
  const sha256 = writePolicy(root, POLICY);
  assert.equal(sha256, createHash('sha256').update(canonicalJson(POLICY)).digest('hex'));
  assert.deepEqual(readPolicy(root), { state: 'ok', policy: { ...POLICY }, sha256 });
  assert.deepEqual(readdirSync(repoDataDir(root)), ['policy.json'], 'the temporary file is renamed, not left behind');
});

test('rewriting a policy replaces it', () => {
  const root = tempDir('hk-policy-repo-');
  writePolicy(root, POLICY);
  const next = { minTrialFirings: 1, minTrialSessions: 1, maxAction: 'block' };
  const sha256 = writePolicy(root, next);
  assert.deepEqual(readPolicy(root), { state: 'ok', policy: next, sha256 });
});

test('the hash does not depend on key order', () => {
  const root = tempDir('hk-policy-repo-');
  writeRaw(root, '{"maxAction":"warn","minTrialSessions":2,"minTrialFirings":5}');
  const read = readPolicy(root);
  assert.equal(read.state, 'ok');
  assert.equal(read.sha256, createHash('sha256').update(canonicalJson(POLICY)).digest('hex'));
});

test('a malformed policy file is unreadable with a reason', () => {
  const cases = [
    ['not json', /JSON/],
    ['[]', /object/],
    ['null', /object/],
    [JSON.stringify({ ...POLICY, minTrialFirings: -1 }), /minTrialFirings/],
    [JSON.stringify({ ...POLICY, minTrialFirings: 0 }), /minTrialFirings must be an integer of at least 1/],
    [JSON.stringify({ ...POLICY, minTrialSessions: 0 }), /minTrialSessions must be an integer of at least 1/],
    [JSON.stringify({ ...POLICY, minTrialFirings: 1.5 }), /minTrialFirings/],
    [JSON.stringify({ ...POLICY, minTrialSessions: '2' }), /minTrialSessions/],
    [JSON.stringify({ ...POLICY, maxAction: 'observe' }), /maxAction/],
    [JSON.stringify({ minTrialFirings: 5, maxAction: 'warn' }), /minTrialSessions/],
    [JSON.stringify({ ...POLICY, allowExternal: true }), /allowExternal/],
  ];
  for (const [text, reason] of cases) {
    const root = tempDir('hk-policy-repo-');
    writeRaw(root, text);
    const read = readPolicy(root);
    assert.equal(read.state, 'unreadable', text);
    assert.match(read.reason, reason, text);
  }
});

test('a policy.json that is a directory reads as unreadable', () => {
  const root = tempDir('hk-policy-repo-');
  mkdirSync(join(repoDataDir(root), 'policy.json'), { recursive: true });
  const read = readPolicy(root);
  assert.equal(read.state, 'unreadable');
  assert.match(read.reason, /cannot be read/);
});

test('writePolicy refuses a policy readPolicy would reject', () => {
  const root = tempDir('hk-policy-repo-');
  assert.throws(() => writePolicy(root, { ...POLICY, maxAction: 'observe' }), /maxAction/);
  assert.throws(() => writePolicy(root, { ...POLICY, minTrialSessions: 0 }), /minTrialSessions/);
  assert.deepEqual(readPolicy(root), { state: 'absent' });
});

test('a checked policy carries the hash that writing and reading it give', () => {
  const root = tempDir('hk-policy-repo-');
  const checked = checkedPolicy({ maxAction: 'warn', minTrialSessions: 2, minTrialFirings: 5 });
  assert.deepEqual(checked.policy, POLICY);
  assert.equal(checked.sha256, writePolicy(root, POLICY));
  assert.equal(checked.sha256, readPolicy(root).sha256);
  assert.deepEqual(checkedPolicy({ ...POLICY, maxAction: 'observe' }), { reason: "maxAction must be 'warn' or 'block'" });
  assert.deepEqual(checkedPolicy(null), { reason: 'the policy is not a JSON object' });
});

test('removing the policy leaves none, and removing none is no error', () => {
  const root = tempDir('hk-policy-repo-');
  writePolicy(root, POLICY);
  removePolicy(root);
  assert.deepEqual(readPolicy(root), { state: 'absent' });
  removePolicy(root);
  assert.deepEqual(readPolicy(root), { state: 'absent' });
});
