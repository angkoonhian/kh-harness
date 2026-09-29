// scripts/lib/detect-exposure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles } from './scan.mjs';
import { detectExposures } from './detect-exposure.mjs';

const SECRET = 'glpat-' + 'A'.repeat(20);

function write(d, rel, content) {
  const p = join(d, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function repo() { return mkdtempSync(join(tmpdir(), 'hk-exp-')); }
function run(d, harness = { remotes: [] }) {
  return detectExposures(d, listFiles(d).files, harness);
}

test('clean repo reports nothing', () => {
  const d = repo();
  write(d, 'README.md', '# x');
  assert.deepEqual(run(d), []);
});

test('finds a provider token in a tracked file', () => {
  const d = repo();
  write(d, '.env.example', `TOKEN=${SECRET}\n`);
  const found = run(d);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'token-in-tracked-file');
  assert.equal(found[0].location, '.env.example');
});

test('NEVER returns the secret value', () => {
  const d = repo();
  write(d, '.env.example', `TOKEN=${SECRET}\n`);
  write(d, '.claude/settings.local.json', JSON.stringify({ x: `Bearer ${SECRET}` }));
  const serialised = JSON.stringify(run(d));
  assert.equal(serialised.includes(SECRET), false);
  assert.equal(serialised.includes('glpat-'), false);
});

test('flags a credential in a remote url', () => {
  const d = repo();
  write(d, 'README.md', '#');
  const found = run(d, { remotes: [{ name: 'origin', hasCredential: true }] });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'token-in-remote-url');
  assert.equal(found[0].severity, 'high');
});

test('flags bearer tokens in local settings', () => {
  const d = repo();
  write(d, '.claude/settings.local.json', JSON.stringify({ cmd: 'curl -H "Authorization: Bearer abcdef1234567890abcdef"' }));
  const kinds = run(d).map(e => e.kind);
  assert.ok(kinds.includes('token-in-local-settings'));
});

test('flags documents holding database credentials', () => {
  const d = repo();
  write(d, 'docs/reference_uat_db.md', 'host: db.example.com\nuser: root\npassword: hunter2hunter2\n');
  const kinds = run(d).map(e => e.kind);
  assert.ok(kinds.includes('credentials-in-doc'));
});

test('skips binary-ish and oversized files without throwing', () => {
  const d = repo();
  write(d, 'big.bin', 'x'.repeat(3_000_000));
  assert.doesNotThrow(() => run(d));
});
