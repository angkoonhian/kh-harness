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
import { closeSync, constants, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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
  CREDENTIAL_SHAPES,
  dropCommandFragments,
  escapeDelimiters,
  pathTokenExemptions,
  MAX_REPORTS_SINCE_CLEAN,
  MAX_REPORT_BYTES,
  MAX_REPORT_LINES,
  markerDir,
  markerPath,
  maskCredentials,
  maskText,
  openMarker,
  readJSONMarker,
  rootTag,
  runBounded,
  safeSessionId,
  signatureOf,
  stripAnsi,
  stripUnsafe,
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

// A one-word script is shorter than the fragment floor, so the whole-command
// rule is the only one that sees it; as a substring match it dropped every
// line that named the tool.
test('"lint": "eslint" reports the full stylish diagnostic', () => {
  const stylish = [
    'src/a.ts',
    "  1:7  error    'a' is assigned a value but never used  @typescript-eslint/no-unused-vars",
    '  2:1  warning  Unexpected console statement            no-console',
  ];
  // The sensor's own call: the script, the script with the edited file
  // appended, and the edited file exempt.
  const survived = dropCommandFragments(stylish, ['eslint', 'eslint src/a.ts'], new Set(['src/a.ts', 'a.ts']));
  assert.deepEqual(survived, stylish);
});

test('"test": "jest" keeps lines containing the word jest', () => {
  const lines = [
    'FAIL src/sum.test.js',
    '    at Object.toBe (src/sum.test.js:3:17)',
    '    at jestAdapter (node_modules/jest-circus/build/legacy-code-todo-rewrite/jestAdapter.js:79:19)',
    'Ran all test suites. Configuration read from jest.config.js',
  ];
  assert.deepEqual(dropCommandFragments(lines, ['jest']), lines);
});

test('a line that is exactly the echoed command is still dropped', () => {
  const lines = ['jest', '  jest  ', 'FAIL src/sum.test.js'];
  assert.deepEqual(dropCommandFragments(lines, ['jest']), ['FAIL src/sum.test.js']);
});

// --- pathTokenExemptions (audit Tier 1, finding 2) -------------------------
//
// Layer 1 dropped every diagnostic for `eslint src/components`, `ruff check
// backend/app` and `eslint -c .eslintrc.cjs .`: each diagnostic names the
// path or config the command names, so each was treated as an echo of the
// command. A path or a config file name is not a secret.

test('pathTokenExemptions: a directory prefix of a touched path is exempt', () => {
  assert.deepEqual([...pathTokenExemptions('eslint src/components --max-warnings 0', ['src/components/Button.tsx'])], ['src/components']);
});

test('pathTokenExemptions: a ./-prefixed directory, a trailing slash and the path itself are exempt', () => {
  const ex = pathTokenExemptions('ruff check ./backend/app backend/app/ backend/app/models.py', ['backend/app/models.py']);
  assert.deepEqual([...ex].sort(), ['./backend/app', 'backend/app/', 'backend/app/models.py']);
});

test('pathTokenExemptions: a directory that is not a prefix of any touched path is not exempt', () => {
  assert.equal(pathTokenExemptions('eslint src/components', ['src/pages/Home.tsx']).size, 0);
  // `src/comp` is a string prefix but not a directory prefix.
  assert.equal(pathTokenExemptions('eslint src/comp', ['src/components/Button.tsx']).size, 0);
});

test('pathTokenExemptions: config-file-shaped tokens are exempt, attached to a flag or not', () => {
  const ex = pathTokenExemptions('eslint -c .eslintrc.cjs --config=eslint.config.js . && tsc -p tsconfig.build.json && ruff check --config ruff.toml .');
  assert.deepEqual([...ex].sort(), ['--config=eslint.config.js', '.eslintrc.cjs', 'ruff.toml', 'tsconfig.build.json']);
});

// Assembled: a credential flag with a value is a credential-table match in
// this file's own source.
const TOKEN_FLAG = ['--token', 'abcdefghijkl'].join('=');

test('pathTokenExemptions: a credential-shaped token is never exempt', () => {
  const keyFlag = ['--api-key', 'secretvalue.json'].join('=');
  const ex = pathTokenExemptions(`cli ${TOKEN_FLAG} ${keyFlag} src/components`, ['src/components/a.ts']);
  assert.equal(ex.has(TOKEN_FLAG), false);
  assert.equal(ex.has(keyFlag), false, 'a credential flag is never exempt, whatever its value ends in');
  assert.deepEqual([...ex], ['src/components']);
});

test('pathTokenExemptions: a URL token is never exempt, even when it ends like a config file', () => {
  // Final review, re-graded Important: a credential URL in a lint or verify
  // command, echoed in a diagnostic, must keep dropping at layer 1.
  const url = ['https://user', 'hunter2hunter2@host.invalid/x.json'].join(':');
  assert.equal(pathTokenExemptions(`curl ${url} src/components`, ['src/components/a.ts']).has(url), false);
  assert.equal(pathTokenExemptions('deploy user@host.invalid:config.json').size, 0);
});

test('pathTokenExemptions: a token naming an existing path under the root is exempt', () => {
  const parent = mkdtempSync(join(tmpdir(), 'hk-redact-root-'));
  const root = join(parent, 'repo');
  mkdirSync(join(root, 'packages', 'app'), { recursive: true });
  mkdirSync(join(parent, 'outside-dir'));
  try {
    const keyFlag = ['--api-key', 'packages/app'].join('=');
    const ex = pathTokenExemptions(`tsc -p packages/app packages/missing ../outside-dir ${keyFlag}`, [], root);
    assert.deepEqual([...ex], ['packages/app'], 'a missing path, a path outside the root and a credential flag are not exempt');
    assert.equal(pathTokenExemptions('tsc -p packages/app').size, 0, 'with no root, nothing is resolved');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('dropCommandFragments with pathTokenExemptions keeps a diagnostic naming the linted directory and still drops a token fragment', () => {
  const command = `eslint src/components ${TOKEN_FLAG}`;
  const lines = ['src/components/Button.tsx:1:1 error no-unused-vars', `auth: ${TOKEN_FLAG} rejected`];
  const survived = dropCommandFragments(lines, [command], pathTokenExemptions(command, ['src/components/Button.tsx']));
  assert.deepEqual(survived, ['src/components/Button.tsx:1:1 error no-unused-vars']);
});

// --- maskCredentials / CREDENTIAL_SHAPES (layer 2) -------------------------
//
// Every shape is also checked against the sweep, sample by sample, in
// detect-exposure.test.mjs ("the sweep and the mask recognise the same
// shapes"). Every credential-shaped sample here is assembled at runtime, so
// the sweep never finds one in this file's own source.

test('CREDENTIAL_SHAPES is frozen and every entry carries the documented fields', () => {
  assert.ok(Object.isFrozen(CREDENTIAL_SHAPES));
  const ids = new Set();
  for (const shape of CREDENTIAL_SHAPES) {
    assert.ok(Object.isFrozen(shape), shape.id);
    const keys = Object.keys(shape).sort();
    assert.ok(['id,kind,pattern,severity', 'id,kind,maskPattern,pattern,severity'].includes(keys.join()), `${shape.id}: ${keys}`);
    assert.ok(['token', 'keyed'].includes(shape.kind), shape.id);
    assert.equal(shape.severity, 'high', shape.id);
    for (const re of [shape.pattern, shape.maskPattern ?? shape.pattern]) {
      assert.ok(re instanceof RegExp && re.global, `${shape.id}: a global pattern, so every match is seen`);
    }
    if (shape.kind === 'keyed' && shape.maskPattern) assert.match(shape.maskPattern.source, /\(\?<value>/, shape.id);
    assert.equal(ids.has(shape.id), false, `duplicate id ${shape.id}`);
    ids.add(shape.id);
  }
});

// The sweep runs every shape over files up to 512 KB and the hooks over
// whole lines of tool output, so a pattern that backtracks quadratically is
// a hang. At 256 KB a quadratic shape takes tens of seconds; a linear one,
// milliseconds.
test('every credential shape stays linear on long adversarial lines', () => {
  const n = 256 * 1024;
  const inputs = [
    ' '.repeat(n),
    'Bearer' + ' '.repeat(n),
    Array.from({ length: n }, (_, i) => 'Ab1_-'[i % 5]).join(''),
    ['password', ' '.repeat(n)].join(''),
    ['password', ' '.repeat(n), '=>'].join(''),
    ["'password'", ' '.repeat(n), '=>'].join(''),
    "'" + 'a'.repeat(n),
    "'a".repeat(n / 2),
    ['password', '"' + 'a'.repeat(n)].join('='),
    ['password', '"' + '\\"'.repeat(n / 2)].join('='),
    ['password', '"""' + '""\\'.repeat(n / 3)].join('='),
    ['password', "'''" + "''x".repeat(n / 3)].join('='),
    ['password', "'" + "''".repeat(n / 2)].join('='),
    ['password', "'" + "a''".repeat(n / 3)].join('='),
    'Basic' + ' '.repeat(n),
    'sk-' + '-'.repeat(n),
    '://u:' + 'x'.repeat(n),
    'eyJ'.repeat(n / 3),
  ];
  for (const shape of CREDENTIAL_SHAPES) {
    for (const re of new Set([shape.pattern, shape.maskPattern ?? shape.pattern])) {
      const started = performance.now();
      for (const text of inputs) for (const _ of text.matchAll(re)) { /* drain */ }
      const ms = performance.now() - started;
      assert.ok(ms < 2000, `${shape.id} (${re === shape.pattern ? 'pattern' : 'maskPattern'}) took ${Math.round(ms)} ms over ${inputs.length} inputs of ${n} characters`);
    }
  }
});

test('maskCredentials masks the vendor shapes at realistic lengths', () => {
  const tokens = [
    ['sk', 'A'.repeat(48)].join('-'),
    ['glpat', 'A'.repeat(20)].join('-'),
    ['ghp', 'A'.repeat(36)].join('_'),
    ['github_pat', 'A'.repeat(82)].join('_'),
    ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
    ['xoxb', 'A'.repeat(10)].join('-'),
  ];
  for (const s of tokens) assert.equal(maskCredentials(`got ${s} back`), 'got *** back', s);
  const bearer = ['Bearer', 'A'.repeat(24)].join(' ');
  assert.equal(maskCredentials(bearer), 'Bearer ***', 'the Bearer scheme word survives; only the token is masked');
});

// Inputs assembled with join('='): a flag named like a credential key, an
// `=` and a long value is a keyed-shape match in this file's own source.
test('maskCredentials masks the --token, --auth-token and --api-key flags by key shape', () => {
  const flag = (name, value) => [name, value].join('=');
  assert.equal(maskCredentials(flag('--token', 'secretvalue')), '--token=***');
  assert.equal(maskCredentials(flag('--auth-token', 'secretvalue')), '--auth-token=***');
  assert.equal(maskCredentials(flag('--api-key', 'secretvalue')), '--api-key=***');
});

// The title names the two keys in prose rather than joining them with a
// slash: that joined form is itself a keyed-shape match (a credential key,
// then `=`, then nine non-space characters), and it made this FILE a
// `credentials-in-doc` finding when kh-harness was run on its own repo.
// A comment is tracked text like any other — see this file's header.
test('maskCredentials masks a password or api_key assignment by key shape', () => {
  // Assembled: written out, the closing quote and comma push the value
  // past the sweep's eight-character floor, so the LITERAL
  // would make this file a finding — see this file's header.
  const assign = (key, value) => [key, value].join('=');
  assert.equal(maskCredentials(assign('password', 'hunter2')), assign('password', '***'));
  assert.equal(maskCredentials(assign('api_key', 'hunter2')), assign('api_key', '***'));
});

test('maskCredentials never drops the line — only the value', () => {
  const key = ['sk-proj', 'ABCDEFGHIJ'.repeat(3)].join('-');
  const masked = maskCredentials(`found token ${key} in config`);
  assert.match(masked, /found token/);
  assert.match(masked, /in config/);
  assert.equal(masked.includes(key), false, masked);
});

// --- Audit Tier 3, finding 24: the mask knew six vendor shapes --------------
//
// Every secret below is assembled from parts (see this file's header): the
// sweep must keep seeing these shapes wherever they genuinely appear,
// including in this repository.

test('maskCredentials masks today\'s shapes: npm, GitHub, Stripe-style, Google, JWT and the common vendor prefixes', () => {
  const cases = [
    ['npm', ['npm', 'A'.repeat(36)].join('_'), 'A'.repeat(36)],
    ['GitHub server-to-server', ['ghs', 'B'.repeat(20)].join('_'), 'B'.repeat(20)],
    ['Stripe-style', ['sk_live', 'C'.repeat(16)].join('_'), 'C'.repeat(16)],
    ['Google', ['AIza', 'D'.repeat(35)].join(''), 'D'.repeat(35)],
    ['JWT', ['eyJhbGciOiJIUzI1NiJ9', 'e'.repeat(20), 'f'.repeat(20)].join('.'), 'e'.repeat(20)],
    ['GitLab runner', ['glrt', 'G'.repeat(20)].join('-'), 'G'.repeat(20)],
    ['Slack app', ['xapp', 'H'.repeat(20)].join('-'), 'H'.repeat(20)],
    ['Hugging Face', ['hf', 'I'.repeat(20)].join('_'), 'I'.repeat(20)],
    ['Docker', ['dckr_pat', 'J'.repeat(20)].join('_'), 'J'.repeat(20)],
    ['PyPI', ['pypi', 'K'.repeat(60)].join('-'), 'K'.repeat(60)],
  ];
  for (const [name, token, secret] of cases) {
    const masked = maskCredentials(`found ${token} in config`);
    assert.equal(masked.includes(secret), false, `${name}: ${masked}`);
    assert.match(masked, /^found .* in config$/, `${name}: the line survives, only the value goes`);
  }
});

test('maskCredentials masks a URL\'s password and keeps the rest of the URL', () => {
  const url = ['https://deploy:hunter2hunter2', 'host.invalid/repo.git'].join('@');
  assert.equal(maskCredentials(`fetched ${url} failed`), 'fetched https://deploy:***@host.invalid/repo.git failed');
  assert.equal(maskCredentials('see https://host.invalid/x for details'), 'see https://host.invalid/x for details', 'no userinfo, nothing to mask');
});

test('maskCredentials masks a Basic header value', () => {
  const line = ['Authorization: Basic', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ=='].join(' ');
  assert.equal(maskCredentials(line), 'Authorization: Basic ***');
});

test('maskCredentials masks key: value forms in any quoting, with the same key list the sweep uses', () => {
  const colon = (k, v) => [k, v].join(': ');
  assert.equal(maskCredentials(colon('password', 'hunter2hunter2')), 'password: ***');
  assert.equal(maskCredentials(colon('"password"', '"hunter2hunter2",')), '"password": ***,');
  assert.equal(maskCredentials(colon('api_key', 'hunter2hunter2')), 'api_key: ***');
  assert.equal(maskCredentials(colon('client_secret', 'hunter2hunter2')), 'client_secret: ***');
  assert.equal(maskCredentials(colon('password', 'null')), 'password: ***', 'the mask does not judge the value; the sweep does');
  assert.equal(maskCredentials('the password is set elsewhere'), 'the password is set elsewhere', 'a key without a value is prose');
});

const PEM_HEADER = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
const PEM_FOOTER = ['-----END RSA', 'PRIVATE KEY-----'].join(' ');

test('maskCredentials masks a PEM block on one line, and from a header alone to the end of its line', () => {
  assert.equal(maskCredentials(`${PEM_HEADER} MIIEowIBAAKCAQEA ${PEM_FOOTER}`), '***');
  assert.equal(maskCredentials(`key: ${PEM_HEADER}`), 'key: ***', 'a header alone — what a line-at-a-time mask sees — is enough');
});

test('every body line of a PEM private key is masked by maskText', () => {
  const body = ['MIIEowIBAAKCAQEAx1', 'q2w3e4r5t6y7u8i9o0', 'ZmFrZWtleWJvZHkK'];
  const text = ['before', PEM_HEADER, ...body, PEM_FOOTER, 'after'].join('\n');
  const masked = maskText(text);
  for (const line of body) assert.equal(masked.includes(line), false, `${line} survived: ${masked}`);
  assert.equal(masked, ['before', '***', '***', '***', '***', '***', 'after'].join('\n'), 'line count is kept and the text after the footer is not masked');
});

test('maskText keeps the leading spaces and tabs of every masked key line', () => {
  const text = [`  ${PEM_HEADER}`, '  MIIEowIBAAKCAQEAx1', '\tq2w3e4r5t6y7u8i9o0', `  ${PEM_FOOTER}`, '  after'].join('\n');
  assert.equal(maskText(text), ['  ***', '  ***', '\t***', '  ***', '  after'].join('\n'));
});

test('maskText keeps CRLF line endings and masks every line it is given', () => {
  const assignment = ['password', 'hunter2hunter2'].join('=');
  const crlf = maskText(['ok', assignment, ''].join('\r\n'));
  assert.equal(crlf, ['ok', ['password', '***'].join('='), ''].join('\r\n'));
  assert.equal(maskText(`${PEM_HEADER}\r\nMIIEowIBAAKCAQEA\r\n${PEM_FOOTER}\r\nnext`), '***\r\n***\r\n***\r\nnext');
});

test('a credential wrapped in an SGR colour sequence is masked', () => {
  const token = ['ghp', 'A'.repeat(36)].join('_');
  const assignment = ['password', 'hunter2hunter2'].join('=');
  assert.equal(maskCredentials(`\u001b[31m${token}\u001b[0m`), '***');
  assert.equal(maskCredentials(`\u001b[1m${assignment}\u001b[22m`), ['password', '***'].join('='));
  // The key itself coloured apart from its value: what a linter's source
  // snippet looks like.
  assert.equal(maskCredentials(`\u001b[36mpassword\u001b[39m=hunter2hunter2`), ['password', '***'].join('='));
});

test('stripAnsi removes CSI, OSC and two-byte escape sequences and leaves plain text alone', () => {
  assert.equal(stripAnsi('\u001b[1;31merror\u001b[0m: x'), 'error: x');
  assert.equal(stripAnsi('\u001b]8;;https://h.invalid\u0007link\u001b]8;;\u0007'), 'link');
  assert.equal(stripAnsi('a\u001b7b\u001b8c\u001b(Bd'), 'abcd');
  assert.equal(stripAnsi('\u009b2Kline'), 'line');
  assert.equal(stripAnsi('plain text: 1 [2] 3'), 'plain text: 1 [2] 3');
});

test('a quoted value containing spaces is masked to its closing quote', () => {
  const colon = (k, v) => [k, v].join(': ');
  assert.equal(maskCredentials(colon('password', '"correct horse battery staple" # note')), 'password: *** # note');
  assert.equal(maskCredentials(colon('"password"', "'correct horse battery staple',")), '"password": ***,');
});

test('a quote with no closing quote, an escaped quote and a triple quote are each masked whole', () => {
  const eq = (k, v) => [k, v].join('=');
  assert.equal(maskCredentials(eq('password', '"hunter2 secret value')), eq('password', '***'), 'an unclosed quote runs to the end of the line');
  assert.equal(maskCredentials(['"password"', String.raw`"abc\"defghijklmnop"`].join(': ')), '"password": ***');
  assert.equal(maskCredentials(eq('password', "'abc\\'defghijklmnop', next")), eq('password', '***, next'));
  assert.equal(maskCredentials(eq('password', '"""tr0ub4dor&3secret""" # py')), eq('password', '*** # py'));
  assert.equal(maskCredentials(eq('password', "'''tr0ub4dor&3secret'''")), eq('password', '***'));
  assert.equal(maskCredentials(eq('password', "'it''s a secret value' # sql")), eq('password', '*** # sql'), 'a doubled single quote is an escape');
});

test('=> is an assignment only between a quoted key and a quoted value, and == is not one', () => {
  assert.equal(maskCredentials(["'password'", "'hunter2hunter2',"].join(' => ')), "'password' => ***,");
  assert.equal(maskCredentials(['"api_key"', '"hunter2hunter2"'].join('=>')), '"api_key"=>***');
  assert.equal(maskCredentials(["'DB_PASS'", "'hunter2hunter2'"].join(' => ')), "'DB_PASS' => ***");
  const unquotedValue = ["'password'", 'hunter2hunter2'].join(' => ');
  assert.equal(maskCredentials(unquotedValue), unquotedValue, 'an unquoted value after => is code');
  const comparison = ['if (password', '= expected)'].join(' =');
  assert.equal(maskCredentials(comparison), comparison);
});

test('the mask is broader than the sweep: short Bearer, Basic, ghp_, glpat- and sk-<word>- values are masked', () => {
  const cases = [
    ['Bearer', 'abcd1234'].join(' '),
    ['Basic', 'dXNlcjpw'].join(' '),
    ['ghp', 'Ab1Cd2Ef3G'].join('_'),
    ['glpat', 'Ab1Cd2Ef3G'].join('-'),
    ['sk-live', 'Ab1Cd2Ef3G'].join('-'),
  ];
  for (const line of cases) {
    const secret = line.split(/[ _]|-(?=Ab1)/).at(-1);
    assert.equal(maskCredentials(`got ${line} back`).includes(secret), false, line);
  }
  for (const line of ['Bearer tokens', 'Basic auth', 'const ghp_client = make()', 'see sk-learn docs']) {
    assert.equal(maskCredentials(line), line, `${line}: below every mask floor`);
  }
});

// --- floors: 'sweep', for prose the model is told to follow ----------------

test("floors: 'sweep' leaves a word below the sweep's floors alone and still masks a real-length token", () => {
  const prose = 'Use Bearer authentication everywhere';
  assert.equal(maskText(prose), 'Use Bearer *** everywhere', 'the default floors star the word');
  assert.equal(maskText(prose, { floors: 'sweep' }), prose);
  assert.equal(maskCredentials(prose, { floors: 'sweep' }), prose);
  const token = 'abc' + 'Z9'.repeat(15);
  assert.equal(maskText(['Bearer', token].join(' '), { floors: 'sweep' }), 'Bearer ***');
  const github = ['ghp', 'A'.repeat(24)].join('_');
  assert.equal(maskCredentials(`rotate ${github} now`, { floors: 'sweep' }), 'rotate *** now');
});

test("floors: 'sweep' still masks a private key from its header to the end of the line", () => {
  const header = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
  const footer = ['-----END', 'RSA PRIVATE KEY-----'].join(' ');
  assert.equal(maskText(`key ${header} MIIEowIBAAKCAQEA`, { floors: 'sweep' }), 'key ***');
  assert.equal(maskText(`${header}\nMIIEowIBAAKCAQEA\n${footer}\nnext`, { floors: 'sweep' }), '***\n***\n***\nnext');
});

test('a value other than sweep, or a stray argument such as an array index, keeps the default floors', () => {
  const short = ['Bearer', 'abcd1234'].join(' ');
  assert.equal(maskText(short, { floors: 'other' }), 'Bearer ***');
  assert.deepEqual([short].map(maskText), ['Bearer ***']);
});

// --- stripUnsafe / escapeDelimiters ------------------------------------------

const cp = (...points) => String.fromCodePoint(...points);

test('stripUnsafe leaves plain text, tabs and newlines unchanged', () => {
  const plain = 'line one\twith a tab\nline two: <b> & café';
  assert.equal(stripUnsafe(plain), plain);
});

test('stripUnsafe removes C0 and C1 controls, carriage returns and whole ANSI sequences', () => {
  assert.equal(stripUnsafe(`a${cp(0x07)}b${cp(0x0d)}${cp(0x85)}c${cp(0x1b)}[31md${cp(0x1b)}[0m`), 'abcd');
});

test('stripUnsafe removes format characters: zero-width, bidi controls, the byte-order mark', () => {
  for (const point of [0x00ad, 0x200b, 0x200d, 0x200e, 0x202a, 0x202e, 0x2066, 0x2069, 0x2060, 0xfeff]) {
    assert.equal(stripUnsafe(`a${cp(point)}b`), 'ab', `U+${point.toString(16)}`);
  }
});

test('stripUnsafe removes the whole tag block, assigned or not', () => {
  for (const point of [0xe0000, 0xe0001, 0xe0002, 0xe0020, 0xe0041, 0xe007f]) {
    assert.equal(stripUnsafe(`a${cp(point)}b`), 'ab', `U+${point.toString(16)}`);
  }
  assert.equal(stripUnsafe(`a${cp(0xe0080)}b`), `a${cp(0xe0080)}b`, 'the range ends at U+E007F');
});

test('stripUnsafe removes the variation selectors U+FE00–U+FE0F', () => {
  for (let point = 0xfe00; point <= 0xfe0f; point++) {
    assert.equal(stripUnsafe(`a${cp(point)}b`), 'ab', `U+${point.toString(16)}`);
  }
  assert.equal(stripUnsafe(`a${cp(0xfe10)}b`), `a${cp(0xfe10)}b`, 'U+FE10 is a presentation form, not a selector');
});

test('stripUnsafe removes the variation selectors supplement U+E0100–U+E01EF', () => {
  for (const point of [0xe0100, 0xe0101, 0xe0180, 0xe01ee, 0xe01ef]) {
    assert.equal(stripUnsafe(`a${cp(point)}b`), 'ab', `U+${point.toString(16)}`);
  }
  assert.equal(stripUnsafe(`a${cp(0xe01f0)}b`), `a${cp(0xe01f0)}b`, 'the range ends at U+E01EF');
});

test('stripUnsafe removes the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0', () => {
  for (const point of [0x115f, 0x1160, 0x3164, 0xffa0]) {
    assert.equal(stripUnsafe(`a${cp(point)}b`), 'ab', `U+${point.toString(16)}`);
  }
  assert.equal(stripUnsafe(cp(0xd55c)), cp(0xd55c), 'an ordinary Hangul syllable survives');
});

test('stripUnsafe removes the line and paragraph separators and next-line, which a regular expression reads as line breaks', () => {
  for (const point of [0x2028, 0x2029, 0x85]) {
    assert.equal(stripUnsafe(`a${cp(point)}b`), 'ab', `U+${point.toString(16)}`);
  }
  assert.equal(stripUnsafe(`a${cp(0xa0)}b`), `a${cp(0xa0)}b`, 'a no-break space is visible space, not a line break');
});

test('escapeDelimiters escapes angle brackets and nothing else', () => {
  assert.equal(escapeDelimiters('</project-rules> a & b'), '&lt;/project-rules&gt; a & b');
});

// --- runBounded / killTree (shared process runner, audit Tier 3) -----------

test('runBounded resolves with overflowed, the captured prefix and the command\'s own exit code — it no longer kills on overflow', async () => {
  const r = await runBounded(`node -e "process.stdout.write('y'.repeat(5000)); process.exit(4)"`, {
    cwd: process.cwd(), env: process.env, timeoutMs: 10_000, maxBuffer: 1000,
  });
  assert.equal(r.overflowed, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 4, 'the command ran to its own end');
  assert.ok(r.stdout.length <= 1000 && r.stdout.length > 0, `the first maxBuffer bytes are kept: ${r.stdout.length}`);
});

test('runBounded reports a timeout as timedOut with no exit status', async () => {
  const r = await runBounded('node -e "setTimeout(() => {}, 10000)"', {
    cwd: process.cwd(), env: process.env, timeoutMs: 300, maxBuffer: 1000, killGraceMs: 2000,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.overflowed, false);
});

// --- Tier 3 final review, Important 3 and Minor 4 ---------------------------
test('maskCredentials masks a URL password with an empty user name, the standard Redis form', () => {
  const url = ['redis://:hunter2hunter2', 'cache:6379/0'].join('@');
  assert.equal(maskCredentials(`REDIS_URL=${url}`), 'REDIS_URL=redis://:***@cache:6379/0');
});

test('maskCredentials leaves ordinary identifiers that merely start like a vendor prefix alone', () => {
  for (const line of ['npm_config_cache is unset; npm_lifecycle_event=test', 'install hf_transfer for faster downloads', 'const ghp_client = make()', 'see xapp-config.md']) {
    assert.equal(maskCredentials(line), line, line);
  }
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

// --- Audit Tier 4, finding 26: the marker directory is never a link ------------
//
// The marker directory under the OS temp directory is predictable, and
// `mkdirSync({ recursive: true })` accepts a pre-existing entry whatever it
// is: a symlink or junction planted there by another user redirected every
// marker read and write. A link is refused — the callers' existing fail-open
// paths take over (the marker reads as its fallback, the write reports
// false) — and on POSIX so is a directory owned by someone else.

/** A directory link of the kind the platform lets an unprivileged user make. */
function linkDir(target, at, t) {
  try {
    symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (e) {
    t.skip(`cannot create a directory link here: ${e.message}`);
    return false;
  }
}

test('markerPath refuses a repository marker directory that is a link', (t) => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'hk-marker-elsewhere-'));
  const root = mkdtempSync(join(tmpdir(), 'hk-marker-root-'));
  const at = join(markerDir(), rootTag(root));
  if (!linkDir(elsewhere, at, t)) return;
  assert.equal(markerPath(root, 'sess1', 'stop'), null, 'a linked directory is not ours to write under');
  assert.equal(readJSONMarker(null, { count: 0 }).count, 0, 'and the callers fall open');
  assert.equal(writeJSONMarker(null, { count: 1 }), false);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written behind the link');
});

test('writeJSONMarker refuses to follow a symlink planted at the marker path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hk-marker-root-'));
  const victim = join(mkdtempSync(join(tmpdir(), 'hk-marker-victim-')), 'victim.txt');
  writeFileSync(victim, 'untouched');
  const path = markerPath(root, 'sess2', 'stop');
  assert.ok(path, 'fixture sanity: a plain directory yields a path');
  try {
    symlinkSync(victim, path, 'file');
  } catch (e) {
    t.skip(`cannot create a file symlink here: ${e.message}`);
    return;
  }
  const wrote = writeJSONMarker(path, { count: 1 });
  assert.equal(readFileSync(victim, 'utf8'), 'untouched', 'the link target is never written through');
  assert.equal(wrote, false);
});

test('openMarker opens a plain marker path and never one where a link is planted', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hk-marker-root-'));
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND;
  const plain = markerPath(root, 'open1', 'stop');
  const fd = openMarker(plain, flags);
  assert.equal(typeof fd, 'number', 'an absent marker is created and opened');
  closeSync(fd);
  const victim = join(mkdtempSync(join(tmpdir(), 'hk-marker-victim-')), 'victim.txt');
  writeFileSync(victim, 'untouched');
  const linked = markerPath(root, 'open2', 'stop');
  try {
    symlinkSync(victim, linked, 'file');
  } catch (e) {
    t.skip(`cannot create a file symlink here: ${e.message}`);
    return;
  }
  // POSIX refuses the open itself (ELOOP); elsewhere the lstat returns null.
  let opened = null;
  try { opened = openMarker(linked, flags); } catch { /* refused */ }
  assert.equal(opened, null, 'no descriptor for a linked path');
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
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

// --- MAX_REPORTS_SINCE_CLEAN ------------------------------------------

test('MAX_REPORTS_SINCE_CLEAN is the documented value of 3', () => {
  assert.equal(MAX_REPORTS_SINCE_CLEAN, 3);
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
//     <tmpdir>/kh-harness-stop-28d5673005cc744e: 8983 entries
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
    assert.ok(fallback.includes('kh-harness-stop-'), `expected the per-user default, got ${fallback}`);
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
