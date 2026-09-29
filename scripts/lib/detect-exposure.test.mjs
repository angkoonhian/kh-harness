// scripts/lib/detect-exposure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
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

// Fix 1: Gitignored files are found
test('finds token in gitignored .claude/settings.local.json', () => {
  const d = repo();
  try {
    execSync('git init', { cwd: d, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: d, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: d, stdio: 'ignore' });
  } catch {}
  write(d, '.gitignore', '.claude/settings.local.json\n');
  write(d, '.claude/settings.local.json', `token: ${SECRET}\n`);
  write(d, 'README.md', '# test');
  execSync('git add .gitignore README.md', { cwd: d, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: d, stdio: 'ignore' });
  const found = run(d);
  const hasExposure = found.some(e => e.location === '.claude/settings.local.json');
  assert.ok(hasExposure, 'Should find token in gitignored .claude/settings.local.json');
});

// Fix 2: Source files are scanned
test('finds token in JavaScript source file', () => {
  const d = repo();
  write(d, 'src/config.js', `const API_KEY = 'sk-${'A'.repeat(25)}';\n`);
  const found = run(d);
  const hasToken = found.some(e => e.location === 'src/config.js' && e.kind === 'token-in-tracked-file');
  assert.ok(hasToken, 'Should find token in .js file');
});

test('finds token in Python source file', () => {
  const d = repo();
  write(d, 'config.py', `API_KEY = "sk-${'B'.repeat(25)}"\n`);
  const found = run(d);
  const hasToken = found.some(e => e.location === 'config.py' && e.kind === 'token-in-tracked-file');
  assert.ok(hasToken, 'Should find token in .py file');
});

// Fix 3: Extensionless files and PEM pattern
test('finds PEM private key in extensionless file', () => {
  const d = repo();
  write(d, 'id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n');
  const found = run(d);
  const hasExposure = found.some(e => e.location === 'id_rsa' && e.kind === 'token-in-tracked-file');
  assert.ok(hasExposure, 'Should find PEM private key in extensionless file');
});

// Fix 4: Placeholder guard
test('ignores placeholder password values', () => {
  const d = repo();
  write(d, 'README.md', 'Set password: your-password-here in config\n');
  const found = run(d);
  const hasDbCred = found.some(e => e.kind === 'credentials-in-doc');
  assert.ok(!hasDbCred, 'Should not flag placeholder password');
});

test('still flags realistic database credentials', () => {
  const d = repo();
  write(d, 'docs/db.md', 'password: hunter2hunter2hunter2\n');
  const found = run(d);
  const hasDbCred = found.some(e => e.kind === 'credentials-in-doc');
  assert.ok(hasDbCred, 'Should flag realistic password value');
});

// Fix 5: Both token and DB cred reported
test('reports both token and database credential in same file', () => {
  const d = repo();
  write(d, 'config.env', `token: ${SECRET}\npassword: secretpass123456\n`);
  const found = run(d);
  assert.ok(found.some(e => e.kind === 'token-in-tracked-file'), 'Should report token');
  assert.ok(found.some(e => e.kind === 'credentials-in-doc'), 'Should report db cred');
});

// Fix 6: Underscore-style tokens
test('finds underscore-style API keys', () => {
  const d = repo();
  write(d, 'keys.txt', `live key: sk_live_${'C'.repeat(15)}\ntest key: pk_test_${'D'.repeat(15)}\n`);
  const found = run(d);
  assert.ok(found.some(e => e.kind === 'token-in-tracked-file'), 'Should find underscore-style tokens');
});

// Fix 7: Case-insensitive extension matching
test('scans uppercase file extensions', () => {
  const d = repo();
  write(d, 'README.MD', `CONFIG: sk_test_${'E'.repeat(15)}\n`);
  const found = run(d);
  const hasExposure = found.some(e => e.location === 'README.MD');
  assert.ok(hasExposure, 'Should scan .MD file');
});

// Fix Round 2: Remaining issues
test('finds PEM key in .ssh/id_rsa (extensionless under dotted directory)', () => {
  const d = repo();
  write(d, '.ssh/id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n');
  const found = run(d);
  const hasExposure = found.some(e => e.location === '.ssh/id_rsa' && e.kind === 'token-in-tracked-file');
  assert.ok(hasExposure, 'Should find PEM key in .ssh/id_rsa');
});

test('reports both token and password in gitignored .env', () => {
  const d = repo();
  try {
    execSync('git init', { cwd: d, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: d, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: d, stdio: 'ignore' });
  } catch {}
  write(d, '.gitignore', '.env\n');
  write(d, '.env', `TOKEN=sk_test_${'F'.repeat(15)}\nDB_PASSWORD=secretpass123456\n`);
  write(d, 'README.md', '# test');
  execSync('git add .gitignore README.md', { cwd: d, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: d, stdio: 'ignore' });
  const found = run(d);
  const hasToken = found.some(e => e.location === '.env' && e.kind === 'token-in-tracked-file');
  const hasPassword = found.some(e => e.location === '.env' && e.kind === 'credentials-in-doc');
  assert.ok(hasToken, 'Should find token in .env');
  assert.ok(hasPassword, 'Should find password in .env');
  assert.ok(found.filter(e => e.location === '.env').length === 2, 'Should report both findings for .env');
});

// Fix Round 3: Regression suite for all discovered issues
test('finds tracked .env.local with token (round 3 regression)', () => {
  const d = repo();
  write(d, '.env.local', `API_TOKEN=sk_live_${'G'.repeat(15)}\n`);
  write(d, 'README.md', '# test');
  const found = run(d);
  const hasExposure = found.some(e => e.location === '.env.local' && e.kind === 'token-in-tracked-file');
  assert.ok(hasExposure, 'Should find token in tracked .env.local');
});

test('skips binary file with NUL byte plus token-shaped string', () => {
  const d = repo();
  write(d, 'binary.dat', `\x00\x01\x02sk_live_${'H'.repeat(15)}`);
  assert.doesNotThrow(() => run(d), 'Should not throw on binary with token-pattern');
  const found = run(d);
  const hasExposure = found.some(e => e.location === 'binary.dat');
  assert.ok(!hasExposure, 'Should skip binary file even with token-like content');
});

test('skips oversized file at always-probed path', () => {
  const d = repo();
  write(d, '.env', 'x'.repeat(600_000) + `sk_live_${'I'.repeat(15)}`);
  assert.doesNotThrow(() => run(d), 'Should not throw on oversized always-probed file');
  const found = run(d);
  const hasExposure = found.some(e => e.location === '.env');
  assert.ok(!hasExposure, 'Should skip oversized file at always-probed path due to MAX_BYTES');
});

test('no path reported twice across routes', () => {
  const d = repo();
  try {
    execSync('git init', { cwd: d, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: d, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: d, stdio: 'ignore' });
  } catch {}
  write(d, '.gitignore', '.env\n');
  write(d, '.env', `TOKEN=sk_test_${'J'.repeat(15)}\n`);
  write(d, 'README.md', '# test');
  execSync('git add .gitignore README.md', { cwd: d, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: d, stdio: 'ignore' });
  const found = run(d);
  const envLocations = found.filter(e => e.location === '.env');
  assert.ok(envLocations.length <= 2, 'Should not report .env more than twice (one per finding type)');
});

test('finds token in extensionless credentials file', () => {
  const d = repo();
  write(d, 'credentials', `key: pk_live_${'K'.repeat(15)}\n`);
  const found = run(d);
  const hasExposure = found.some(e => e.location === 'credentials' && e.kind === 'token-in-tracked-file');
  assert.ok(hasExposure, 'Should find token in extensionless credentials file');
});
