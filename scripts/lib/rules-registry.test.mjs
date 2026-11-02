// scripts/lib/rules-registry.test.mjs
//
// The rules-registry parser lives in assets/scripts/harness-redact.mjs — the
// shared hook asset — for the same reason `findHandoff` does: the installed
// re-injection hook (rules-brief.mjs) and `detect` must agree on what a rule
// IS, and the hook can import nothing but that one module. These tests pin
// the parser's contract directly, independent of either caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRules, findRules, RULES_PATH, ENFORCERS } from '../../assets/scripts/harness-redact.mjs';

const ONE_RULE = [
  '# Rules',
  '',
  '## R1 — Every database query is scoped to the current tenant',
  '',
  '- why: a cross-tenant read is a data breach, not a bug',
  '- enforced-by: critic',
  '- pointer: .claude/agents/tenant-scoping.md',
  '- verify: npm test -- tenant',
  '',
].join('\n');

test('parses a heading with id, em-dash and rule, plus keys', () => {
  const { rules, problems } = parseRules(ONE_RULE);
  assert.deepEqual(problems, []);
  assert.equal(rules.length, 1);
  const r = rules[0];
  assert.equal(r.id, 'R1');
  assert.equal(r.rule, 'Every database query is scoped to the current tenant');
  assert.equal(r.why, 'a cross-tenant read is a data breach, not a bug');
  assert.equal(r.enforcedBy, 'critic');
  assert.equal(r.pointer, '.claude/agents/tenant-scoping.md');
  assert.equal(r.verify, 'npm test -- tenant');
  assert.equal(r.priority, 'normal');
  assert.equal(r.line, 3, 'line is the 1-based line of the heading');
});

test('a heading without an em-dash still yields the id and the rest as the rule', () => {
  const { rules } = parseRules('## R2 Money is stored as integer cents\n- enforced-by: test\n');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'R2');
  assert.equal(rules[0].rule, 'Money is stored as integer cents');
});

test('a plain hyphen separator is accepted too', () => {
  const { rules } = parseRules('## R2 - Money is stored as integer cents\n- enforced-by: test\n');
  assert.equal(rules[0].id, 'R2');
  assert.equal(rules[0].rule, 'Money is stored as integer cents');
});

test('missing enforced-by is recorded as none and reported as a problem', () => {
  const { rules, problems } = parseRules('## R3 — Never log a request body\n- why: bodies hold credentials\n');
  assert.equal(rules[0].enforcedBy, 'none');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /R3/);
  assert.match(problems[0], /enforced-by/);
  assert.match(problems[0], /none/);
});

test('an unknown enforced-by value is recorded as none and reported', () => {
  const { rules, problems } = parseRules('## R4 — Rule\n- enforced-by: magic\n');
  assert.equal(rules[0].enforcedBy, 'none');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /R4/);
  assert.match(problems[0], /magic/);
});

test('every ENFORCERS value is accepted as-is', () => {
  for (const e of ENFORCERS) {
    const { rules, problems } = parseRules(`## X — rule\n- enforced-by: ${e}\n`);
    assert.equal(rules[0].enforcedBy, e);
    assert.deepEqual(problems, [], `${e} must not be reported as a problem`);
  }
});

test('enforced-by key spellings enforcedBy / enforced_by / Enforced-By all map to the same field', () => {
  for (const key of ['enforcedBy', 'enforced_by', 'Enforced-By', 'ENFORCED-BY']) {
    const { rules, problems } = parseRules(`## X — rule\n- ${key}: test\n`);
    assert.equal(rules[0].enforcedBy, 'test', key);
    assert.deepEqual(problems, [], key);
  }
});

test('priority high is kept; anything else is normal', () => {
  assert.equal(parseRules('## A — r\n- enforced-by: none\n- priority: high\n').rules[0].priority, 'high');
  assert.equal(parseRules('## A — r\n- enforced-by: none\n- priority: HIGH\n').rules[0].priority, 'high');
  assert.equal(parseRules('## A — r\n- enforced-by: none\n- priority: urgent\n').rules[0].priority, 'normal');
  assert.equal(parseRules('## A — r\n- enforced-by: none\n').rules[0].priority, 'normal');
});

test('a rule inside an HTML comment is NOT parsed', () => {
  const text = [
    '# Rules',
    '<!--',
    '## EXAMPLE — this is only an example and must never load',
    '- enforced-by: test',
    '-->',
    '',
  ].join('\n');
  const { rules, problems } = parseRules(text);
  assert.deepEqual(rules, []);
  assert.deepEqual(problems, []);
});

test('a single-line HTML comment between rules does not swallow the next rule', () => {
  const text = '## R1 — one\n- enforced-by: test\n<!-- a note -->\n## R2 — two\n- enforced-by: lint\n';
  const { rules } = parseRules(text);
  assert.deepEqual(rules.map(r => r.id), ['R1', 'R2']);
});

test('duplicate ids keep the first and report the second', () => {
  const text = '## R1 — first\n- enforced-by: test\n## R1 — second\n- enforced-by: lint\n';
  const { rules, problems } = parseRules(text);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].rule, 'first');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /duplicate/i);
  assert.match(problems[0], /R1/);
  assert.match(problems[0], /line 3/);
});

test('a level-2 heading that is not "<id> — <rule>" is reported, not silently skipped', () => {
  const { rules, problems } = parseRules('## \n- enforced-by: test\n');
  assert.deepEqual(rules, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /line 1/);
});

test('a bare id heading with no rule text is reported, not accepted as an empty rule', () => {
  const { rules, problems } = parseRules('## R9\n- enforced-by: test\n');
  assert.deepEqual(rules, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /line 1/);
});

test('CRLF input parses identically to LF', () => {
  const lf = parseRules(ONE_RULE);
  const crlf = parseRules(ONE_RULE.replace(/\n/g, '\r\n'));
  assert.deepEqual(crlf, lf);
});

test('unknown keys are ignored without a problem', () => {
  const { rules, problems } = parseRules('## R1 — r\n- enforced-by: test\n- owner: platform team\n- colour: blue\n');
  assert.equal(rules.length, 1);
  assert.deepEqual(problems, []);
  assert.equal('owner' in rules[0], false);
});

test('a level-1 or level-3 heading is not a rule', () => {
  const { rules } = parseRules('# R0 — not a rule\n### R0 — not a rule either\n## R1 — a rule\n- enforced-by: test\n');
  assert.deepEqual(rules.map(r => r.id), ['R1']);
});

test('empty text yields zero rules and zero problems', () => {
  assert.deepEqual(parseRules(''), { rules: [], problems: [] });
  assert.deepEqual(parseRules(null), { rules: [], problems: [] });
});

test('RULES_PATH is docs/harness/RULES.md and findRules returns it only when the file exists', () => {
  assert.equal(RULES_PATH, 'docs/harness/RULES.md');
  const d = mkdtempSync(join(tmpdir(), 'hk-rules-'));
  assert.equal(findRules(d), null);
  mkdirSync(join(d, 'docs', 'harness'), { recursive: true });
  writeFileSync(join(d, RULES_PATH), '# Rules\n');
  assert.equal(findRules(d), RULES_PATH);
});

// Research round (2026-11-02, intent/rules sweep): every registry format
// surveyed that survives contact with time carries a status and a last-
// reviewed date (MADR status, Doorstop `reviewed`, Google "last reviewed by").
// Both are optional keys here; `superseded` rules stay in the file as a
// record but are excluded from re-injection and from the enforcement counts.
test('status defaults to active; superseded is kept; anything else is active and reported', () => {
  assert.equal(parseRules('## A — r\n- enforced-by: none\n').rules[0].status, 'active');
  assert.equal(parseRules('## A — r\n- enforced-by: none\n- status: superseded\n').rules[0].status, 'superseded');
  assert.equal(parseRules('## A — r\n- enforced-by: none\n- status: SUPERSEDED\n').rules[0].status, 'superseded');
  const odd = parseRules('## A — r\n- enforced-by: none\n- status: retired\n');
  assert.equal(odd.rules[0].status, 'active');
  assert.equal(odd.problems.length, 1);
  assert.match(odd.problems[0], /A/);
  assert.match(odd.problems[0], /status/);
});

test('last-verified is kept as a YYYY-MM-DD string, or null when absent or malformed', () => {
  assert.equal(parseRules('## A — r\n- enforced-by: test\n- last-verified: 2026-11-02\n').rules[0].lastVerified, '2026-11-02');
  assert.equal(parseRules('## A — r\n- enforced-by: test\n- last_verified: 2026-11-02\n').rules[0].lastVerified, '2026-11-02');
  assert.equal(parseRules('## A — r\n- enforced-by: test\n').rules[0].lastVerified, null);
  const bad = parseRules('## A — r\n- enforced-by: test\n- last-verified: yesterday\n');
  assert.equal(bad.rules[0].lastVerified, null);
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0], /last-verified/);
});
