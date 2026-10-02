// scripts/lib/detect-exposure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { listFiles } from './scan.mjs';
import { detectHarness } from './detect-harness.mjs';
import { detectStack } from './detect-stack.mjs';
import { buildGaps } from './gap-model.mjs';
import { selectProfile } from './profiles/index.mjs';
import { fileURLToPath } from 'node:url';
import { detectExposures, classifyCredentialValue, splitExposures, isProminentExposure, collapsedExposureNote } from './detect-exposure.mjs';

const SECRET = 'glpat-' + 'A'.repeat(20);

// Coordinator ruling (post-review, concern 5): every credential-SHAPED
// fixture in this file is ASSEMBLED AT RUNTIME, never committed as a
// literal. `SECRET` above was already built this way; the rest were not, and
// this file was therefore BOTH a `token-in-tracked-file` and a
// `credentials-in-doc` finding when harness-kit was pointed at its own
// repository — a security tool failing its own check, which is the one
// signal that matters most for it.
//
// The fix is NOT a suppression mechanism: that is the weaken-the-guard
// direction, and the detector must keep seeing these patterns wherever they
// genuinely appear. These fixtures exist to exercise the detector at
// RUNTIME, so they do not need to exist on disk. Each is split so that no
// single source literal matches a TOKEN_PATTERN, the PEM header or DB_CRED,
// while the assembled value is byte-identical to what the test needs.

/** The PEM header `PEM_PATTERN` looks for, split at the space so neither
 * half matches `-----BEGIN [A-Z ]*PRIVATE KEY-----` on its own. */
const PEM_KEY = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')
  + '\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';

/** A `DB_CRED` line: the key and its value are separate literals, so neither
 * matches `(password|passwd|pwd)\s*[:=]\s*(\S{8,})` alone. */
const credLine = value => ['password', value].join(': ') + '\n';

/** An `Authorization:` header value. "Bearer" is not itself a secret, so the
 * split is between the scheme and the token. */
const bearer = token => ['Bearer', token].join(' ');

function write(d, rel, content) {
  const p = join(d, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function repo() { return mkdtempSync(join(tmpdir(), 'hk-exp-')); }
/** This repository itself — see the DOGFOOD test at the end of this file. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
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
  write(d, '.claude/settings.local.json', JSON.stringify({ cmd: `curl -H "Authorization: ${bearer('abcdef1234567890abcdef')}"` }));
  const kinds = run(d).map(e => e.kind);
  assert.ok(kinds.includes('token-in-local-settings'));
});

test('flags documents holding database credentials', () => {
  const d = repo();
  write(d, 'docs/reference_uat_db.md', 'host: db.example.com\nuser: root\n' + credLine('hunter2hunter2'));
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
  write(d, 'id_rsa', PEM_KEY);
  const found = run(d);
  const hasExposure = found.some(e => e.location === 'id_rsa' && e.kind === 'token-in-tracked-file');
  assert.ok(hasExposure, 'Should find PEM private key in extensionless file');
});

// Fix 4: Placeholder guard
test('ignores placeholder password values', () => {
  const d = repo();
  write(d, 'README.md', 'Set ' + ['password', 'your-password-here in config'].join(': ') + '\n');
  const found = run(d);
  const hasDbCred = found.some(e => e.kind === 'credentials-in-doc');
  assert.ok(!hasDbCred, 'Should not flag placeholder password');
});

test('still flags realistic database credentials', () => {
  const d = repo();
  write(d, 'docs/db.md', credLine('hunter2hunter2hunter2'));
  const found = run(d);
  const hasDbCred = found.some(e => e.kind === 'credentials-in-doc');
  assert.ok(hasDbCred, 'Should flag realistic password value');
});

// Fix 5: Both token and DB cred reported
test('reports both token and database credential in same file', () => {
  const d = repo();
  write(d, 'config.env', `token: ${SECRET}\n` + credLine('secretpass123456'));
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
  write(d, '.ssh/id_rsa', PEM_KEY);
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
  write(d, '.env', `TOKEN=sk_test_${'F'.repeat(15)}\n${['DB_PASSWORD', 'secretpass123456'].join('=')}\n`);
  write(d, 'README.md', '# test');
  execSync('git add .gitignore README.md', { cwd: d, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: d, stdio: 'ignore' });
  const found = run(d);
  const hasToken = found.some(e => e.location === '.env' && e.kind === 'token-in-tracked-file');
  const hasDbCred = found.some(e => e.location === '.env' && e.kind === 'credentials-in-doc');
  assert.ok(hasToken, 'Should find token in .env');
  assert.ok(hasDbCred, 'Should find password in .env');
  assert.ok(found.filter(e => e.location === '.env').length === 2, 'Should report both findings for .env');
});

// Fix Round 3: Regression suite for all discovered issues
// Fix Round 4: this test previously never ran `git init`, so `listFiles`
// fell back to the directory walk and the test never exercised the
// `git ls-files` tracked-file route it claims to cover (where the original
// bug lived). It now creates a real git repo and commits the file.
test('finds tracked .env.local with token (round 3 regression)', () => {
  const d = repo();
  execSync('git init', { cwd: d, stdio: 'ignore' });
  write(d, '.env.local', `API_TOKEN=sk_live_${'G'.repeat(15)}\n`);
  write(d, 'README.md', '# test');
  execSync('git add .env.local README.md', { cwd: d, stdio: 'ignore' });
  execSync('git -c user.email=test@example.com -c user.name=Test commit -m "init"', { cwd: d, stdio: 'ignore' });
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

// Fix Round 4: UTF-16LE/BE text (e.g. from PowerShell `Out-File`/`>` redirection)
// was previously classified as binary by the NUL sniff and silently skipped.
test('finds token in UTF-16LE file with BOM (round 4 fix)', () => {
  const d = repo();
  const body = Buffer.from(`TOKEN=${SECRET}\n`, 'utf16le');
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  write(d, '.env.ps1out', buf);
  const found = run(d);
  const hasExposure = found.some(e => e.location === '.env.ps1out' && e.kind === 'token-in-tracked-file');
  assert.ok(hasExposure, 'Should find token in UTF-16LE BOM file');
});

test('finds token in UTF-16BE file with BOM (round 4 fix)', () => {
  const d = repo();
  const leBody = Buffer.from(`TOKEN=${SECRET}\n`, 'utf16le');
  const beBody = Buffer.from(leBody); // copy before mutating in place
  beBody.swap16();
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
  write(d, '.env.be', buf);
  const found = run(d);
  const hasExposure = found.some(e => e.location === '.env.be' && e.kind === 'token-in-tracked-file');
  assert.ok(hasExposure, 'Should find token in UTF-16BE BOM file');
});

// A genuinely binary file (NUL bytes, no BOM, no token-shaped bytes at all)
// must still be skipped and must never throw.
test('skips genuinely binary file (NUL bytes, no BOM) without throwing (round 4)', () => {
  const d = repo();
  const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x00, 0x10, 0x20, 0x7f]);
  write(d, 'blob.dat', buf);
  assert.doesNotThrow(() => run(d));
  const found = run(d);
  assert.equal(found.some(e => e.location === 'blob.dat'), false, 'Should skip genuinely binary file');
});

// --- Task 9b, finding 1: literal vs. code-reference classification -------
//
// On a real TypeScript codebase, 62 of 66 `credentials-in-doc` hits were a
// credential-shaped key whose VALUE is a code reference (`process.env.X`,
// `config.get('x')`, ...), not a literal — noise that buried the one real
// finding. `classifyCredentialValue` is the syntactic classifier; these
// pin it against the exact shapes the brief named, in both directions.

test('classifyCredentialValue: real reference shapes are all classified "reference"', () => {
  for (const value of ['process.env.TOKEN', "config.get('x')", 'os.environ["K"]', 'self.password', 'settings.SECRET_KEY']) {
    assert.equal(classifyCredentialValue(value), 'reference', `${value} must be a reference`);
  }
});

test('classifyCredentialValue: a glpat-shaped literal is never demoted to "reference"', () => {
  assert.equal(classifyCredentialValue('glpat-' + 'A'.repeat(20)), 'literal');
});

test('classifyCredentialValue: a quoted string literal is classified "literal"', () => {
  assert.equal(classifyCredentialValue('"hunter2hunter2"'), 'literal');
});

test('classifyCredentialValue: an empty string is classified "literal" (conservative default)', () => {
  assert.equal(classifyCredentialValue(''), 'literal');
});

test('classifyCredentialValue: a bare token with no dot/call/subscript is "literal", not merely identifier-shaped', () => {
  // SECRET_KEY alone — no property access, call or subscript — is a bare
  // token per the brief's own wording, not a reference: only a GENUINE
  // compound expression (seen above) may be demoted.
  assert.equal(classifyCredentialValue('SECRET_KEY'), 'literal');
  assert.equal(classifyCredentialValue('hunter2hunter2hunter2'), 'literal');
});

test('classifyCredentialValue: trailing statement punctuation on a real reference does not flip it to literal', () => {
  assert.equal(classifyCredentialValue('process.env.TOKEN;'), 'reference');
  assert.equal(classifyCredentialValue('process.env.TOKEN,'), 'reference');
});

test('detectExposures tags credentials-in-doc findings with valueKind, never dropping either class', () => {
  const d = repo();
  write(d, 'src/config/db.ts', credLine('process.env.DB_PASSWORD,'));
  write(d, 'docs/real-db.md', credLine('hunter2hunter2hunter2'));
  const found = run(d);
  const byLocation = Object.fromEntries(found.map(e => [e.location, e]));
  assert.equal(byLocation['src/config/db.ts'].kind, 'credentials-in-doc');
  assert.equal(byLocation['src/config/db.ts'].valueKind, 'reference', 'fixture sanity: the code-reference row must actually be present');
  assert.equal(byLocation['docs/real-db.md'].kind, 'credentials-in-doc');
  assert.equal(byLocation['docs/real-db.md'].valueKind, 'literal', 'fixture sanity: the literal row must actually be present');
  // Both still appear in the raw list — classification tags, it never
  // suppresses. "Listed in detect.json, not shown here" only ever applies
  // to the rendered report, which splitExposures/renderSummary handle.
  assert.equal(found.length, 2);
});

test('splitExposures: a reference-valued credentials-in-doc finding is collapsed; everything else stays prominent', () => {
  const exposures = [
    { kind: 'token-in-remote-url', location: 'git remote "origin"', severity: 'high' },
    { kind: 'credentials-in-doc', location: 'src/a.ts', severity: 'medium', valueKind: 'reference' },
    { kind: 'credentials-in-doc', location: 'src/b.ts', severity: 'medium', valueKind: 'reference' },
    { kind: 'credentials-in-doc', location: 'docs/real.md', severity: 'medium', valueKind: 'literal' },
  ];
  const { prominent, collapsedCount } = splitExposures(exposures);
  assert.deepEqual(prominent.map(e => e.location).sort(), ['docs/real.md', 'git remote "origin"']);
  assert.equal(collapsedCount, 2);
  // The invariant the brief demands outright: the demoted class never
  // contains a literal.
  const collapsed = exposures.filter(e => !isProminentExposure(e));
  assert.equal(collapsed.some(e => e.valueKind === 'literal'), false);
});

test('collapsedExposureNote names the count and says where the rest live', () => {
  const note = collapsedExposureNote(62);
  assert.match(note, /^62 /);
  assert.match(note, /code reference/);
  assert.match(note, /not literal/);
  assert.match(note, /detect\.json/);
});

// --- Coordinator ruling (post-review, concern 5): harness-kit passes its own
// --- credential check, and a regression is visible rather than normalised --
//
// `P0.security` used to read `failing` on this very repository, over eight
// findings that were all its own test fixtures. Correct behaviour, and a real
// problem: a security tool that cannot be pointed at itself is asking for
// trust it has not demonstrated, and "it always says failing here" is how a
// genuine finding gets normalised into noise.
//
// The fix was NOT a suppression mechanism — that is the weaken-the-guard
// direction this project has refused all along. The fixtures exist to
// exercise the detector at RUNTIME, so they are assembled at runtime and do
// not exist on disk. Each test file that holds one now says so in its own
// header.
//
// This runs the REAL detector over THIS repository, through the library
// rather than the CLI, for one reason: the CLI writes
// `docs/harness/detect.json` into its target, and a test suite must not
// dirty the repository it is run from. Everything that decides `P0.security`
// — `listFiles`, `detectExposures`, `buildGaps` — is exercised exactly as
// `detect.mjs` exercises it.
test('DOGFOOD: harness-kit passes its own P0.security check', () => {
  const files = listFiles(ROOT).files;
  assert.ok(files.length > 50, `fixture sanity: the scan must actually see this repository, got ${files.length} files`);
  assert.ok(files.includes('scripts/lib/detect-exposure.mjs'), 'fixture sanity: the scan must include our own source');

  const harness = detectHarness(ROOT, files);
  const exposures = detectExposures(ROOT, files, harness);

  // The message names every finding, because a bare count is useless to
  // whoever broke this: they need to know which file and which kind.
  const listed = exposures.map(e => `${e.severity} ${e.kind} at ${e.location}${e.reason ? ' — ' + e.reason : ''}`);
  const WHAT_TO_DO = [
    'harness-kit must pass its own credential check — see the README section that states it does.',
    '',
    'IF YOU ADDED A CREDENTIAL-SHAPED TEST FIXTURE: assemble it at RUNTIME instead of committing the literal.',
    '  Split the value so no single source literal matches a pattern, e.g.',
    "    const PAT = 'ghp_' + 'AAAABBBBCCCCDDDDEEEE';",
    "    const line = ['password', 'hunter2hunter2'].join(': ');",
    '  Every *.test.mjs that holds one has a header explaining this; detect-exposure.test.mjs',
    '  has `credLine`, `bearer` and `PEM_KEY` helpers you can reuse.',
    '',
    'IF YOU ADDED A DETECTOR PATTERN and it now matches harness-kit’s OWN PROSE: that is this',
    '  check working, and the fix is in the prose, not the detector. Four of the eight findings',
    '  this check was built to clear were not fixtures at all — a test title, a variable name',
    '  (a variable whose name ends in the word password, assigned anything eight characters or longer,',
    '  is a DB_CRED match), an assertion’s own regex literal,',
    '  and a comment. Rename the identifier, reword the sentence, or assemble the string.',
    '',
    'WHAT NOT TO DO: do not add a suppression mechanism, an ignore list, or a path exclusion.',
    '  An exclusion that silences this check on THIS repository silences it on the user’s too,',
    '  and "it always says failing here" is exactly how a real finding becomes noise.',
    '',
    'Findings:',
    ...listed.map(l => '  ' + l),
  ].join('\n');
  assert.deepEqual(exposures, [], WHAT_TO_DO);

  // And the check itself, through the real gap model, so this cannot pass
  // because `exposures` stopped being read.
  const stack = detectStack(ROOT, files);
  const checks = buildGaps({
    stack, harness, exposures, profile: selectProfile(stack),
    git: { isRepo: true, branch: 'feat/x' }, files, root: ROOT,
  });
  const security = checks.find(c => c.id === 'P0.security');
  assert.equal(security.state, 'verified', `P0.security must read verified on this repository: ${JSON.stringify(security.evidence)}`);
});
