// scripts/lib/rules-evidence.test.mjs
//
// Shared evidence for P3.rules (gap-model.mjs) and the P3.reinject generator
// (propose.mjs): what the registry holds, which rules are enforced by what,
// which pointers no longer resolve, and how many rule-shaped lines sit in
// the instruction file outside the registry. Counts and line numbers only —
// never a sentence from the user's file, because this output is serialised
// into docs/harness/detect.json, which is committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rulesRegistryEvidence, ruleShapedLines, RULE_SHAPED } from './rules-evidence.mjs';
import { LEARNED_PATH, RULES_PATH } from '../../assets/scripts/harness-redact.mjs';
import { SESSION_LOG_PATH, VERIFY_TOUCHED_PATH } from './propose.mjs';
import { execEntry } from './hook-evidence.mjs';
import { hookEntrySha256 } from './settings-merge.mjs';

function repo() { return mkdtempSync(join(tmpdir(), 'hk-rules-ev-')); }
function write(d, rel, text) {
  mkdirSync(join(d, rel, '..'), { recursive: true });
  writeFileSync(join(d, rel), text);
}
const bare = {
  instructions: { path: null, lines: 0 },
  claudeDir: { denyRules: 0, hookEvents: {}, hookRegistrations: {}, rules: [] },
};
const withHooks = {
  instructions: { path: 'CLAUDE.md', lines: 10 },
  claudeDir: { denyRules: 2, hookEvents: { Stop: ['.claude/scripts/verify-touched.mjs'] }, hookRegistrations: { Stop: [{ script: '.claude/scripts/verify-touched.mjs', matcher: null }] }, rules: [] },
};

const REGISTRY = [
  '# Rules',
  '## R1 — tenant scoping',
  '- enforced-by: critic',
  '- pointer: .claude/agents/tenant-scoping.md',
  '## R2 — money is integer cents',
  '- enforced-by: test',
  '- pointer: tests/money.test.mjs',
  '## R3 — never log bodies',
  '- enforced-by: none',
  '## R4 — no force push',
  '- enforced-by: hook',
  '- pointer: settings:hooks.Stop',
  '## R5 — lockfile is protected',
  '- enforced-by: deny',
  '- pointer: settings:permissions.deny',
  '',
].join('\n');

test('returns null when there is no registry', () => {
  assert.equal(rulesRegistryEvidence(repo(), bare), null);
});

test('counts active rules by enforcer and lists unenforced ids', () => {
  const d = repo();
  write(d, RULES_PATH, REGISTRY);
  write(d, 'tests/money.test.mjs', '');
  write(d, '.claude/agents/tenant-scoping.md', '');
  const ev = rulesRegistryEvidence(d, withHooks);
  assert.equal(ev.path, RULES_PATH);
  assert.equal(ev.count, 5);
  assert.deepEqual(ev.byEnforcer, { critic: 1, test: 1, none: 1, hook: 1, deny: 1 });
  assert.deepEqual(ev.unenforced, ['R3']);
  assert.deepEqual(ev.missingPointers, []);
  assert.deepEqual(ev.problems, []);
});

test('a pointer to a missing file is reported with its id', () => {
  const d = repo();
  write(d, RULES_PATH, '## R1 — r\n- enforced-by: test\n- pointer: tests/gone.test.mjs\n');
  const ev = rulesRegistryEvidence(d, bare);
  assert.deepEqual(ev.missingPointers, [{ id: 'R1', pointer: 'tests/gone.test.mjs' }]);
});

test('settings:hooks.Stop resolves when a Stop hook is registered, and is missing when not', () => {
  const d = repo();
  write(d, RULES_PATH, '## R4 — r\n- enforced-by: hook\n- pointer: settings:hooks.Stop\n');
  assert.deepEqual(rulesRegistryEvidence(d, withHooks).missingPointers, []);
  assert.deepEqual(rulesRegistryEvidence(d, bare).missingPointers, [{ id: 'R4', pointer: 'settings:hooks.Stop' }]);
});

/** A harness whose Stop event holds exactly `registrations`. */
const onStop = registrations => ({ ...bare, claudeDir: { ...bare.claudeDir, hookRegistrations: { Stop: registrations } } });
const LOGGING = { script: SESSION_LOG_PATH, matcher: null };
// The logging hook on a repository that ignores .claude/: its script does
// not resolve, and only its entry's hash says what it is.
const LOGGING_UNRESOLVED = { script: null, matcher: null, entrySha256: hookEntrySha256(execEntry(SESSION_LOG_PATH), undefined) };

test('a rule pointing at settings:hooks.Stop is reported dead when only the logging hook is on Stop', () => {
  const d = repo();
  write(d, RULES_PATH, '## R4 — r\n- enforced-by: hook\n- pointer: settings:hooks.Stop\n');
  const dead = [{ id: 'R4', pointer: 'settings:hooks.Stop' }];
  assert.deepEqual(rulesRegistryEvidence(d, onStop([LOGGING])).missingPointers, dead);
  assert.deepEqual(rulesRegistryEvidence(d, onStop([LOGGING_UNRESOLVED])).missingPointers, dead, 'known by its hash when its script does not resolve');
});

test('it resolves when the Stop gate is also registered', () => {
  const d = repo();
  write(d, RULES_PATH, '## R4 — r\n- enforced-by: hook\n- pointer: settings:hooks.Stop\n');
  assert.deepEqual(rulesRegistryEvidence(d, onStop([LOGGING, { script: VERIFY_TOUCHED_PATH, matcher: null }])).missingPointers, []);
  assert.deepEqual(rulesRegistryEvidence(d, onStop([LOGGING_UNRESOLVED, { script: null, matcher: null, entrySha256: 'another entry' }])).missingPointers, [],
    'an unresolved entry that is not the logging hook may be what enforces the rule');
});

test('settings:permissions.deny resolves iff denyRules > 0', () => {
  const d = repo();
  write(d, RULES_PATH, '## R5 — r\n- enforced-by: deny\n- pointer: settings:permissions.deny\n');
  assert.deepEqual(rulesRegistryEvidence(d, withHooks).missingPointers, []);
  assert.deepEqual(rulesRegistryEvidence(d, bare).missingPointers, [{ id: 'R5', pointer: 'settings:permissions.deny' }]);
});

test('an absolute or .. pointer is reported as missing, never resolved', () => {
  const d = repo();
  write(d, 'README.md', '');
  write(d, RULES_PATH, [
    '## A — r', '- enforced-by: test', `- pointer: ${join(d, 'README.md')}`,
    '## B — r', '- enforced-by: test', '- pointer: ../README.md',
    '## C — r', '- enforced-by: test', '- pointer: docs/../README.md',
    '',
  ].join('\n'));
  const ev = rulesRegistryEvidence(d, bare);
  assert.deepEqual(ev.missingPointers.map(m => m.id), ['A', 'B', 'C']);
});

test('a rule with an enforcer but no pointer is reported as missing a pointer; none/review need none', () => {
  const d = repo();
  write(d, RULES_PATH, '## A — r\n- enforced-by: test\n## B — r\n- enforced-by: review\n## C — r\n- enforced-by: none\n');
  const ev = rulesRegistryEvidence(d, bare);
  assert.deepEqual(ev.missingPointers, [{ id: 'A', pointer: null }]);
});

test('superseded rules are excluded from count, byEnforcer, unenforced and pointer checks', () => {
  const d = repo();
  write(d, RULES_PATH, '## A — r\n- enforced-by: test\n- pointer: gone.mjs\n- status: superseded\n## B — r\n- enforced-by: none\n');
  const ev = rulesRegistryEvidence(d, bare);
  assert.equal(ev.count, 1);
  assert.equal(ev.superseded, 1);
  assert.deepEqual(ev.byEnforcer, { none: 1 });
  assert.deepEqual(ev.unenforced, ['B']);
  assert.deepEqual(ev.missingPointers, []);
});

test('parser problems are passed through', () => {
  const d = repo();
  write(d, RULES_PATH, '## A — r\n- enforced-by: magic\n');
  const ev = rulesRegistryEvidence(d, bare);
  assert.equal(ev.problems.length, 1);
  assert.match(ev.problems[0], /magic/);
});

// --- The learned registry, docs/harness/LEARNED.md ---------------------------

const LEARNED = [
  '## L1 — Run the suite through npm test',
  '- enforced-by: hook',
  '- pointer: .claude/kh-harness/gates.json',
  '- origin: learned',
  '- status: active',
  '- evidence: signature 3f9a0c2e7b14d856, seen in 3 sessions from 2026-11-01 to 2026-11-18',
  `- approved-sha256: ${'ab'.repeat(32)}`,
  '## L2 — Keep the money test green',
  '- enforced-by: test',
  '- pointer: tests/money.test.mjs',
  '- origin: learned',
  '## L3 — Retired learning',
  '- enforced-by: none',
  '- status: superseded',
  '',
].join('\n');

test('detect counts learned rules separately from the owner\'s', () => {
  const d = repo();
  write(d, RULES_PATH, '## R1 — r\n- enforced-by: none\n## R2 — claims to be learned\n- enforced-by: none\n- origin: learned\n');
  write(d, LEARNED_PATH, LEARNED);
  write(d, '.claude/kh-harness/gates.json', '{}');
  write(d, 'tests/money.test.mjs', '');
  const ev = rulesRegistryEvidence(d, bare);
  assert.equal(ev.path, RULES_PATH);
  assert.equal(ev.count, 2, 'an owner\'s entry that claims origin: learned is still the owner\'s');
  assert.deepEqual(ev.unenforced, ['R1', 'R2']);
  assert.deepEqual(ev.problems, [], 'the learned keys are known keys in the owner\'s file');
  assert.deepEqual(ev.learned, {
    path: LEARNED_PATH, count: 2, superseded: 1,
    byEnforcer: { hook: 1, test: 1 }, unenforced: [], missingPointers: [], problems: [],
  });
  assert.equal(ev.injectable, 3, 'two owner\'s rules and the one learned rule no gate enforces');
});

test('a learned entry whose pointer does not resolve is reported the way an owner\'s is', () => {
  const d = repo();
  write(d, RULES_PATH, '## R1 — r\n- enforced-by: test\n- pointer: tests/gone.test.mjs\n');
  write(d, LEARNED_PATH, LEARNED);
  const ev = rulesRegistryEvidence(d, bare);
  assert.deepEqual(ev.missingPointers, [{ id: 'R1', pointer: 'tests/gone.test.mjs' }]);
  assert.deepEqual(ev.learned.missingPointers, [
    { id: 'L1', pointer: '.claude/kh-harness/gates.json' },
    { id: 'L2', pointer: 'tests/money.test.mjs' },
  ]);
});

test('without a learned registry, learned is null and injectable is the owner\'s count', () => {
  const d = repo();
  write(d, RULES_PATH, REGISTRY);
  const ev = rulesRegistryEvidence(d, bare);
  assert.equal(ev.learned, null);
  assert.equal(ev.injectable, 5);
});

test('a learned registry without the owner\'s reports the learned rules and no owner\'s file', () => {
  const d = repo();
  write(d, LEARNED_PATH, LEARNED);
  const ev = rulesRegistryEvidence(d, bare);
  assert.equal(ev.path, null);
  assert.equal(ev.count, 0);
  assert.equal(ev.superseded, 0);
  assert.deepEqual(ev.byEnforcer, {});
  assert.equal(ev.learned.count, 2);
  assert.equal(ev.injectable, 1);
});

test('RULE_SHAPED matches the imperative shapes and nothing ordinary', () => {
  for (const s of ['You must run tests', 'Never commit secrets', 'always use pnpm', 'Do not edit dist/', "don't guess", 'This is forbidden', 'A lockfile is required', 'must not import']) {
    assert.ok(RULE_SHAPED.test(s), s);
  }
  for (const s of ['Run the tests with pnpm test', 'The API lives in src/api', 'Mustard is a condiment', 'a trustworthy answer']) {
    assert.equal(RULE_SHAPED.test(s), false, s);
  }
});

test('ruleShapedLines reports line numbers only, never the sentence', () => {
  const d = repo();
  const secretish = ['password', 'hunter2hunter2'].join(': ');
  write(d, 'CLAUDE.md', `# Project\n\nYou must never commit the ${secretish}.\nRun pnpm test.\nAlways scope queries by tenant.\n`);
  const h = { ...bare, instructions: { path: 'CLAUDE.md', lines: 5 } };
  const out = ruleShapedLines(d, h);
  assert.deepEqual(out, [{ file: 'CLAUDE.md', lines: [3, 5] }]);
  assert.equal(JSON.stringify(out).includes('hunter2'), false);
  assert.equal(JSON.stringify(out).includes('tenant'), false);
});

test('ruleShapedLines ignores fenced code and HTML comments', () => {
  const d = repo();
  write(d, 'CLAUDE.md', '<!-- never mind -->\n```\nmust not\n```\nAlways run lint.\n');
  const out = ruleShapedLines(d, { ...bare, instructions: { path: 'CLAUDE.md', lines: 5 } });
  assert.deepEqual(out, [{ file: 'CLAUDE.md', lines: [5] }]);
});

test('ruleShapedLines covers .claude/rules files and omits files with no hits', () => {
  const d = repo();
  write(d, 'CLAUDE.md', 'Nothing imperative here.\n');
  write(d, '.claude/rules/api.md', '---\npaths: ["apps/api/**"]\n---\nNever return a raw error.\n');
  write(d, '.claude/rules/web.md', 'Plain notes.\n');
  const h = { instructions: { path: 'CLAUDE.md', lines: 1 }, claudeDir: { denyRules: 0, hookEvents: {}, rules: ['.claude/rules/api.md', '.claude/rules/web.md'] } };
  assert.deepEqual(ruleShapedLines(d, h), [{ file: '.claude/rules/api.md', lines: [4] }]);
});

test('ruleShapedLines does NOT count lines inside docs/harness/RULES.md itself, and returns [] with no instruction file', () => {
  const d = repo();
  write(d, RULES_PATH, '## R1 — never do X\n- enforced-by: none\n');
  assert.deepEqual(ruleShapedLines(d, bare), []);
});
