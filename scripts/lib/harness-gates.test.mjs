// scripts/lib/harness-gates.test.mjs
//
// The gate language: what a learned gate may say, how its file is parsed,
// how it is hashed, and how it matches a tool call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GATE_LIMITS, gateSha256, matchGate, parseGates, validateGate } from '../../assets/scripts/harness-gates.mjs';
import { canonicalJson, GATES_PATH, harnessIdentity } from '../../assets/scripts/harness-log.mjs';

const MODULE_PATH = new URL('../../assets/scripts/harness-gates.mjs', import.meta.url);

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-gates-data-');

const gate = (extra = {}) => ({
  id: 'L1',
  tool: 'Bash',
  field: 'command',
  match: { kind: 'literal', value: 'rm -rf' },
  action: 'block',
  message: 'Remove the directory with a scoped path instead.',
  ...extra,
});
const withMatch = (kind, value) => gate({ match: { kind, value } });
const file = gates => JSON.stringify({ schema: 1, gates });
const rejectsWith = (g, pattern) => {
  const result = validateGate(g);
  assert.equal(result.ok, false, `expected ${JSON.stringify(g)} to be rejected`);
  assert.match(result.reason, pattern);
};

test('GATE_LIMITS holds the stated bounds', () => {
  assert.deepEqual(GATE_LIMITS, { valueMax: 200, messageMax: 300, gatesMax: 200, inputMax: 262144 });
  assert.ok(Object.isFrozen(GATE_LIMITS));
});

// --- validateGate ---------------------------------------------------------

test('a well-formed gate is valid, with and without cites', () => {
  assert.deepEqual(validateGate(gate()), { ok: true });
  assert.deepEqual(validateGate(gate({ cites: ['docs/harness/RULES.md', 'src/a b.ts'] })), { ok: true });
  for (const action of ['observe', 'warn', 'block']) assert.deepEqual(validateGate(gate({ action })), { ok: true });
  for (const kind of ['literal', 'token', 'glob']) assert.deepEqual(validateGate(withMatch(kind, 'xyz')), { ok: true });
  assert.deepEqual(validateGate(gate({ field: 'edits.first.new_string' })), { ok: true });
});

test('a non-object gate is rejected', () => {
  for (const g of [null, undefined, 'L1', 3, [gate()]]) rejectsWith(g, /object/);
});

test('an id must be L followed by 1 to 9 digits with no leading zero', () => {
  for (const id of ['L', 'l1', 'L1a', ' L1', 'X1', 'L-1', 'L0', 'L042', 'L1234567890', 1]) rejectsWith(gate({ id }), /id/);
  for (const id of ['L1', 'L10', 'L123456789']) assert.deepEqual(validateGate(gate({ id })), { ok: true }, id);
});

test('a tool must be a non-empty string within the value limit', () => {
  for (const tool of ['', 7, null, 'B'.repeat(GATE_LIMITS.valueMax + 1)]) rejectsWith(gate({ tool }), /tool/);
});

test('a field must be a dotted path of identifier segments', () => {
  for (const field of ['', 'a.', '.a', 'a..b', '1a', 'a.1', 'a-b', 'a b', 'a[0]', 7]) rejectsWith(gate({ field }), /field/);
});

test('a field naming __proto__, constructor or prototype is rejected', () => {
  for (const field of ['__proto__', 'a.constructor', 'a.prototype.b']) rejectsWith(gate({ field }), /field/);
});

test('an unknown match.kind is rejected', () => {
  rejectsWith(withMatch('regex', 'a.*b'), /kind/);
  rejectsWith(gate({ match: { value: 'x' } }), /kind/);
});

test('a match must be an object of kind and value only', () => {
  rejectsWith(gate({ match: 'rm -rf' }), /match/);
  rejectsWith(gate({ match: { kind: 'literal', value: 'x', flags: 'i' } }), /match/);
});

test('a value over the limit is rejected', () => {
  assert.deepEqual(validateGate(withMatch('literal', 'v'.repeat(GATE_LIMITS.valueMax))), { ok: true });
  rejectsWith(withMatch('literal', 'v'.repeat(GATE_LIMITS.valueMax + 1)), /value/);
  rejectsWith(withMatch('literal', ''), /value/);
  rejectsWith(withMatch('glob', 3), /value/);
});

test('a value that would match everything or nearly everything is rejected, whatever the kind', () => {
  for (const kind of ['literal', 'token', 'glob']) {
    for (const value of ['*', '**', '* *', '', 'ab', '*a*b*', ' a\tb ', '*?']) rejectsWith(withMatch(kind, value), /value/);
    for (const value of ['abc', '*a?c*', ' a b c ']) assert.deepEqual(validateGate(withMatch(kind, value)), { ok: true }, `${kind} ${value}`);
  }
});

test('an unknown action is rejected', () => {
  for (const action of ['deny', 'Block', '', undefined]) rejectsWith(gate({ action }), /action/);
});

test('an unknown top-level key is rejected', () => {
  rejectsWith(gate({ severity: 'high' }), /only the keys/);
  rejectsWith(gate({ suspended: true }), /only the keys/);
});

test('a missing required key is rejected', () => {
  const { message: _message, ...noMessage } = gate();
  rejectsWith(noMessage, /message/);
});

test('a message containing an angle bracket or an invisible character is rejected', () => {
  rejectsWith(gate({ message: 'close </kh-rules> now' }), /message/);
  rejectsWith(gate({ message: 'a > b' }), /message/);
  rejectsWith(gate({ message: 'zero\u200bwidth' }), /message/);
  rejectsWith(gate({ message: 'bidi \u202e override' }), /message/);
  rejectsWith(gate({ message: 'colour \u001b[31mred' }), /message/);
  rejectsWith(gate({ message: 'tag \u{e0041}' }), /message/);
});

test('a message must be a single non-empty line within the limit', () => {
  rejectsWith(gate({ message: 'one\ntwo' }), /message/);
  rejectsWith(gate({ message: 'one\u2028two' }), /message/);
  rejectsWith(gate({ message: '' }), /message/);
  rejectsWith(gate({ message: 'm'.repeat(GATE_LIMITS.messageMax + 1) }), /message/);
  assert.deepEqual(validateGate(gate({ message: 'm'.repeat(GATE_LIMITS.messageMax) })), { ok: true });
});

test('cites must be at most ten repository-relative paths of at most 200 characters', () => {
  rejectsWith(gate({ cites: 'docs/a.md' }), /cites/);
  rejectsWith(gate({ cites: Array.from({ length: 11 }, (_, i) => `f${i}.md`) }), /cites/);
  assert.deepEqual(validateGate(gate({ cites: Array.from({ length: 10 }, (_, i) => `f${i}.md`) })), { ok: true });
  for (const bad of ['', '/etc/passwd', '\\share\\x', 'C:\\x', 'C:x', '../up', 'a/../../b', 'a\\..\\b', '..', 7, 'p'.repeat(201)]) {
    rejectsWith(gate({ cites: [bad] }), /cites/);
  }
  assert.deepEqual(validateGate(gate({ cites: ['p'.repeat(200)] })), { ok: true });
  assert.deepEqual(validateGate(gate({ cites: ['a..b/c...d'] })), { ok: true });
});

// --- gateSha256 -----------------------------------------------------------

test('the hash ignores the action', () => {
  const h = gateSha256(gate({ action: 'observe' }));
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(gateSha256(gate({ action: 'block' })), h);
  assert.notEqual(gateSha256(gate({ message: 'Another message.' })), h);
});

test('the hash ignores key order and is SHA-256 of canonicalJson without action', () => {
  const g = gate();
  const { action: _action, ...rest } = g;
  const reordered = Object.fromEntries(Object.entries(g).reverse());
  assert.equal(gateSha256(g), createHash('sha256').update(canonicalJson(rest)).digest('hex'));
  assert.equal(gateSha256(reordered), gateSha256(g));
});

test('gateSha256 agrees with the gate hash harnessIdentity records', () => {
  const root = tempDir('hk-gates-repo-');
  const g = gate({ id: 'L7', cites: ['docs/harness/LEARNED.md'] });
  mkdirSync(dirname(join(root, GATES_PATH)), { recursive: true });
  writeFileSync(join(root, GATES_PATH), file([g]));
  const expected = createHash('sha256').update(canonicalJson([`L7:${gateSha256(g)}`])).digest('hex');
  assert.equal(harnessIdentity(root).learned, expected);
});

// --- matchGate ------------------------------------------------------------

test('a literal matches a substring of the named field', () => {
  const g = withMatch('literal', 'rm -rf');
  assert.equal(matchGate(g, 'Bash', { command: 'cd x && rm -rf build' }), true);
  assert.equal(matchGate(g, 'Bash', { command: 'rm -r build' }), false);
  assert.equal(matchGate(g, 'Bash', { description: 'rm -rf build' }), false, 'only the named field is tested');
  assert.equal(matchGate(g, 'Write', { command: 'rm -rf build' }), false, 'only the named tool is tested');
  assert.equal(matchGate(g, 'Bash', { command: 'RM -RF build' }), false, 'matching is case-sensitive');
});

test('a token does not match inside a longer word', () => {
  const g = withMatch('token', 'push');
  assert.equal(matchGate(g, 'Bash', { command: 'git push origin' }), true);
  assert.equal(matchGate(g, 'Bash', { command: 'push' }), true);
  assert.equal(matchGate(g, 'Bash', { command: 'git push' }), true);
  assert.equal(matchGate(g, 'Bash', { command: 'git pushd' }), false);
  assert.equal(matchGate(g, 'Bash', { command: 'git_push x' }), false);
  assert.equal(matchGate(g, 'Bash', { command: 'pushed; push2; xpush' }), false);
  assert.equal(matchGate(g, 'Bash', { command: 'pushx push' }), true, 'a later bounded occurrence matches');
  assert.equal(matchGate(withMatch('token', '--force'), 'Bash', { command: 'git push --force' }), true);
  assert.equal(matchGate(withMatch('token', '--force'), 'Bash', { command: 'git push --force-with-lease' }), true,
    'the boundary after a value is any non-word character, here a hyphen');
});

test('a token finds a bounded occurrence among overlapping ones', () => {
  assert.equal(matchGate(withMatch('token', 'aaa'), 'Bash', { command: 'aaaa aaa' }), true);
  assert.equal(matchGate(withMatch('token', 'aaa'), 'Bash', { command: 'aaaa aaaa' }), false);
  assert.equal(matchGate(withMatch('token', 'aba'), 'Bash', { command: 'ababa-aba' }), true);
  assert.equal(matchGate(withMatch('token', 'abab'), 'Bash', { command: 'xababab ababab' }), false);
  assert.equal(matchGate(withMatch('token', 'abab'), 'Bash', { command: 'xababab abab' }), true);
  const astral = `x${String.fromCodePoint(0x1f600)}y`;
  assert.equal(matchGate(withMatch('token', astral), 'Bash', { command: `a ${astral} b` }), true, 'a surrogate pair is matched whole');
  assert.equal(matchGate(withMatch('token', astral), 'Bash', { command: `a ${astral}z b` }), false);
});

test('a glob matches the whole field, with * as its only wildcard', () => {
  const g = withMatch('glob', 'git push * --force');
  assert.equal(matchGate(g, 'Bash', { command: 'git push origin main --force' }), true);
  assert.equal(matchGate(g, 'Bash', { command: 'git push origin --force-with-lease' }), false, 'a glob is anchored at both ends');
  assert.equal(matchGate(g, 'Bash', { command: 'xgit push origin --force' }), false, 'and at the start');
  assert.equal(matchGate(withMatch('glob', 'a?c'), 'Bash', { command: 'abc' }), false, '? is an ordinary character');
  assert.equal(matchGate(withMatch('glob', 'a?c'), 'Bash', { command: 'a?c' }), true);
  assert.equal(matchGate(withMatch('glob', 'abc'), 'Bash', { command: 'abcd' }), false, 'a value with no star is the whole field');
  assert.equal(matchGate(withMatch('glob', 'abc*'), 'Bash', { command: 'abc' }), true, '* matches the empty run');
  assert.equal(matchGate(withMatch('glob', '*.env*'), 'Bash', { command: 'config/.env.local' }), true, '* crosses /');
  assert.equal(matchGate(withMatch('glob', '[ab]*'), 'Bash', { command: 'a1' }), false, 'brackets are literal');
  assert.equal(matchGate(withMatch('glob', '[ab]*'), 'Bash', { command: '[ab]1' }), true);
  assert.equal(matchGate(withMatch('glob', 'a.c'), 'Bash', { command: 'abc' }), false, 'a dot is literal');
  assert.equal(matchGate(withMatch('glob', 'ab*ba'), 'Bash', { command: 'aba' }), false, 'head and tail never overlap');
  assert.equal(matchGate(withMatch('glob', 'ab*ab*ab'), 'Bash', { command: 'ababab' }), true);
  assert.equal(matchGate(withMatch('glob', 'ab*ab*ab'), 'Bash', { command: 'abab' }), false);
  assert.equal(matchGate(withMatch('glob', 'a*x*b*y*c'), 'Bash', { command: 'a1x2b3y4c' }), true);
  assert.equal(matchGate(withMatch('glob', 'a*x*b*y*c'), 'Bash', { command: 'a1y2b3x4c' }), false, 'segments are found in order');
  assert.equal(matchGate(withMatch('glob', '*abc*abc'), 'Bash', { command: 'abcabc' }), true);
});

test('a gate inspects only the first inputMax characters of its field', () => {
  const cap = GATE_LIMITS.inputMax;
  const pad = 'x'.repeat(cap - 3);
  assert.equal(matchGate(withMatch('literal', 'END'), 'Bash', { command: pad + 'END' }), true, 'the last inspected characters');
  assert.equal(matchGate(withMatch('literal', 'END'), 'Bash', { command: pad + 'xxEND' }), false, 'beyond the cap');
  assert.equal(matchGate(withMatch('literal', 'END'), 'Bash', { command: pad + 'xEND' }), false, 'straddling the cap');
  assert.equal(matchGate(withMatch('token', 'END'), 'Bash', { command: `${pad.slice(1)} ENDxyz` }), true, 'the cut is a string end');
  assert.equal(matchGate(withMatch('token', 'END'), 'Bash', { command: `${pad} xx END` }), false);
  assert.equal(matchGate(withMatch('glob', 'xxx*END'), 'Bash', { command: pad + 'END' + 'more' }), true, 'the cut is the end a glob anchors to');
  assert.equal(matchGate(withMatch('glob', 'xxx*more'), 'Bash', { command: pad + 'END' + 'more' }), false);
});

// The adversarial shape for each kind, on a field four times `inputMax`: the
// reviewer's glob (one star, then 198 `a` and a `b`) against all `a`, and a
// 200-character value that occurs, or almost occurs, at every position.
// Measured on the development machine (Windows 11, Node 24.0): the slowest
// shape, a token of 200 `a`, took about 5 ms for one gate and 0.65 s for
// `gatesMax` gates alone, about 1.1 s while the full suite ran in parallel;
// a literal about 1 ms and 0.18 s; the glob under 0.1 ms and 1 ms.
const ADVERSARIAL = [
  ['glob', '*' + 'a'.repeat(198) + 'b'],
  ['literal', 'a'.repeat(199) + 'b'],
  ['literal', 'b' + 'a'.repeat(199)],
  ['token', 'a'.repeat(200)],
  ['token', 'a'.repeat(199) + 'b'],
];

for (const [kind, value] of ADVERSARIAL) {
  test(`a ${kind} gate stays linear on its adversarial input at the cap: ${value.slice(0, 3)}...${value.slice(-2)}`, () => {
    assert.ok(value.length <= GATE_LIMITS.valueMax);
    const g = withMatch(kind, value);
    const input = { command: 'a'.repeat(GATE_LIMITS.inputMax * 4) };
    assert.equal(matchGate(g, 'Bash', input), false);
    let started = process.hrtime.bigint();
    matchGate(g, 'Bash', input);
    const oneMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(oneMs < 50, `one gate took ${oneMs} ms`);
    started = process.hrtime.bigint();
    for (let i = 0; i < GATE_LIMITS.gatesMax; i++) matchGate(g, 'Bash', input);
    const allMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(allMs < 2000, `${GATE_LIMITS.gatesMax} gates took ${allMs} ms`);
  });
}

test('a dotted field resolves through own properties of nested objects', () => {
  const g = gate({ field: 'edit.target.path', match: { kind: 'literal', value: '.env' } });
  assert.equal(matchGate(g, 'Bash', { edit: { target: { path: 'a/.env' } } }), true);
  assert.equal(matchGate(g, 'Bash', { edit: { target: null } }), false);
  assert.equal(matchGate(g, 'Bash', { edit: 'a/.env' }), false, 'a non-object on the path resolves to nothing');
  assert.equal(matchGate(g, 'Bash', { edit: { target: { path: ['a/.env'] } } }), false, 'only a string leaf can match');
  assert.equal(matchGate(gate({ field: 'command' }), 'Bash', { command: 7 }), false);
  assert.equal(matchGate(gate({ field: 'command' }), 'Bash', null), false);
  assert.equal(matchGate(gate({ field: 'command' }), 'Bash', 'rm -rf x'), false);
});

test('an inherited property never resolves', () => {
  const proto = { command: 'rm -rf x' };
  assert.equal(matchGate(gate(), 'Bash', Object.create(proto)), false);
  assert.equal(matchGate(withMatch('literal', 'Object'), 'Bash', {}), false);
  const g = gate({ field: 'command.length' });
  assert.equal(matchGate(g, 'Bash', { command: 'rm -rf x' }), false, 'a string is not an object to descend into');
});

test('a path through __proto__, constructor or prototype resolves to nothing', () => {
  const input = JSON.parse('{"__proto__": {"command": "rm -rf x"}, "constructor": {"command": "rm -rf x"}, "prototype": {"command": "rm -rf x"}}');
  for (const head of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(matchGate(gate({ field: `${head}.command` }), 'Bash', input), false, head);
  }
  assert.equal(matchGate(gate({ field: 'constructor.name', match: { kind: 'literal', value: 'Object' } }), 'Bash', {}), false);
  assert.equal(matchGate(gate({ field: 'a.prototype' }), 'Bash', { a: { prototype: 'rm -rf x' } }), false, 'a forbidden leaf too');
});

test('a gate of unknown kind never matches', () => {
  assert.equal(matchGate(withMatch('regex', 'rm'), 'Bash', { command: 'rm -rf x' }), false);
});

// --- parseGates -----------------------------------------------------------

test('a well-formed file yields its gates and its suspensions', () => {
  const text = JSON.stringify({ schema: 1, generatedBy: 'kh-harness land', gates: [gate({ id: 'L1' }), { id: 'L3', suspended: true }, gate({ id: 'L2' })] });
  const parsed = parseGates(text);
  assert.deepEqual(parsed.gates.map(g => g.id), ['L1', 'L2']);
  assert.deepEqual(parsed.gates[0], gate({ id: 'L1' }));
  assert.deepEqual(parsed.suspended, ['L3']);
  assert.deepEqual(parsed.rejected, []);
});

test('malformed JSON yields no gates and one rejection', () => {
  const parsed = parseGates('{ "schema": 1, "gates": [');
  assert.deepEqual(parsed.gates, []);
  assert.deepEqual(parsed.suspended, []);
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0].reason, /JSON/);
});

test('a file of the wrong shape yields no gates and one rejection', () => {
  const shapes = [
    '[]',
    'null',
    '"text"',
    JSON.stringify({ gates: [gate()] }),
    JSON.stringify({ schema: 2, gates: [gate()] }),
    JSON.stringify({ schema: 1, gates: {} }),
    JSON.stringify({ schema: 1, gates: [gate()], extra: true }),
    JSON.stringify({ schema: 1, gates: [gate()], generatedBy: 3 }),
  ];
  for (const text of [...shapes, undefined, 42]) {
    const parsed = parseGates(text);
    assert.deepEqual(parsed.gates, [], String(text));
    assert.deepEqual(parsed.suspended, [], String(text));
    assert.equal(parsed.rejected.length, 1, String(text));
  }
});

test('an invalid entry is rejected by index and the rest still load', () => {
  const parsed = parseGates(file([gate({ id: 'L1' }), withMatch('regex', 'x'), gate({ id: 'L2', action: 'deny' }), gate({ id: 'L3' })]));
  assert.deepEqual(parsed.gates.map(g => g.id), ['L1', 'L3']);
  assert.deepEqual(parsed.rejected.map(r => r.index), [1, 2]);
  assert.match(parsed.rejected[0].reason, /kind/);
  assert.match(parsed.rejected[1].reason, /action/);
});

test('a duplicate id is rejected, whether gate or suspension', () => {
  const parsed = parseGates(file([gate({ id: 'L1' }), gate({ id: 'L1', message: 'Second.' }), { id: 'L1', suspended: true }]));
  assert.deepEqual(parsed.gates, [gate({ id: 'L1' })]);
  assert.deepEqual(parsed.suspended, []);
  assert.deepEqual(parsed.rejected.map(r => r.index), [1, 2]);
  for (const r of parsed.rejected) assert.match(r.reason, /duplicate/);
});

test('a suspension is exactly an id and suspended: true', () => {
  const parsed = parseGates(file([{ id: 'L1', suspended: false }, { id: 'X', suspended: true }, { id: 'L2', suspended: true, why: 'x' }]));
  assert.deepEqual(parsed.gates, []);
  assert.deepEqual(parsed.suspended, []);
  assert.deepEqual(parsed.rejected.map(r => r.index), [0, 1, 2]);
});

test('entries beyond gatesMax are rejected, never silently dropped', () => {
  const many = Array.from({ length: GATE_LIMITS.gatesMax + 2 }, (_, i) => gate({ id: `L${i + 1}` }));
  const parsed = parseGates(file(many));
  assert.equal(parsed.gates.length, GATE_LIMITS.gatesMax);
  assert.deepEqual(parsed.rejected.map(r => r.index), [GATE_LIMITS.gatesMax, GATE_LIMITS.gatesMax + 1]);
  for (const r of parsed.rejected) assert.match(r.reason, /200/);
});

test('gatesMax bounds the gates returned, not the suspensions', () => {
  const many = Array.from({ length: GATE_LIMITS.gatesMax }, (_, i) => gate({ id: `L${i + 1}` }));
  const parsed = parseGates(file([...many, { id: 'L9999', suspended: true }]));
  assert.equal(parsed.gates.length, GATE_LIMITS.gatesMax);
  assert.deepEqual(parsed.suspended, ['L9999']);
  assert.deepEqual(parsed.rejected, []);
});

test('a rejection reason never repeats a key or value taken from the file', () => {
  const marker = 'Zq9marker';
  const entries = [
    { ...gate({ id: 'L1' }), [marker]: 1 },
    gate({ id: 'L2', match: { kind: marker, value: 'abc' } }),
    gate({ id: 'L3', match: { kind: 'literal', value: `${marker}` + 'v'.repeat(GATE_LIMITS.valueMax) } }),
    gate({ id: 'L4', action: marker }),
    gate({ id: 'L5', message: `${marker} <` }),
    gate({ id: 'L6', cites: [`../${marker}`] }),
    gate({ id: `L${marker}` }),
    gate({ id: 'L7', tool: marker.repeat(30) }),
    gate({ id: 'L8', field: `${marker}.__proto__` }),
    { id: 'L9', suspended: marker },
    gate({ id: 'L10' }),
    gate({ id: 'L10', message: marker }),
  ];
  const parsed = parseGates(file(entries));
  assert.deepEqual(parsed.rejected.map(r => r.index), entries.slice(0, -2).map((_, i) => i).concat(entries.length - 1));
  for (const r of parsed.rejected) assert.ok(!r.reason.includes(marker), r.reason);
  const wholeFile = parseGates(JSON.stringify({ schema: 1, gates: [], [marker]: true }));
  assert.equal(wholeFile.rejected.length, 1);
  assert.ok(!wholeFile.rejected[0].reason.includes(marker), wholeFile.rejected[0].reason);
});

// --- the module's own constraints ----------------------------------------

/** Each call in `source` of `RegExp`, or of a string method that takes a
 * pattern, whose first argument is not a literal: a quoted string or a
 * template without substitution, or a regex literal. */
function nonLiteralRegExpCalls(source) {
  const found = [];
  for (const m of source.matchAll(/(?:\bRegExp|\.(?:match|matchAll|search|replace|replaceAll|split))\s*\(\s*/g)) {
    const rest = source.slice(m.index + m[0].length);
    const literal = /^(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`|\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*)\s*[,)]/.exec(rest);
    if (!literal) found.push(source.slice(m.index, m.index + m[0].length + 30));
  }
  return found;
}

test('the RegExp scan recognises a non-literal argument', () => {
  assert.deepEqual(nonLiteralRegExpCalls(`new RegExp('a+', 'g'); RegExp(/x/); RegExp(\`y\`)`), []);
  assert.equal(nonLiteralRegExpCalls('new RegExp(gate.match.value)').length, 1);
  assert.equal(nonLiteralRegExpCalls('RegExp(`^${v}$`)').length, 1);
  assert.equal(nonLiteralRegExpCalls("new RegExp('a' + v)").length, 1);
  assert.deepEqual(nonLiteralRegExpCalls("s.split('.'); s.split(/[\\\\/]/); s.replace(/[*]/g, ''); s.match(/a/); s.search('x'); s.replaceAll(`y`, '')"), []);
  for (const call of ['s.match(v)', 's.matchAll(v)', 's.search(v)', "s.replace(v, '')", "s.replaceAll(v, '')", 's.split(v)', 's.split(`${v}`)']) {
    assert.equal(nonLiteralRegExpCalls(call).length, 1, call);
  }
});

test('the module passes no non-literal pattern to RegExp or a pattern-taking string method', () => {
  assert.deepEqual(nonLiteralRegExpCalls(readFileSync(MODULE_PATH, 'utf8')), []);
});

test('the module imports only Node built-ins and sibling files, and no child process', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');
  const specifiers = [...source.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.ok(specifiers.length > 0);
  for (const s of specifiers) assert.ok(/^node:/.test(s) || /^\.\/[^/]+\.mjs$/.test(s), s);
  assert.doesNotMatch(source, /child_process|\bimport\s*\(/);
});
