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
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rulesRegistryEvidence, ruleShapedLines, RULE_SHAPED } from './rules-evidence.mjs';
import { MAX_DOCUMENT_BYTES, OVER_DOCUMENT_LIMIT } from './scan.mjs';
import { LEARNED_PATH, RULES_PATH } from '../../assets/scripts/harness-redact.mjs';
import { DISPATCH_PRE_PATH, SESSION_LOG_PATH, VERIFY_TOUCHED_PATH, toolGateDenyRules } from './propose.mjs';
import { ENTRY_SCRIPTS, execEntry } from './hook-evidence.mjs';
import { hookEntrySha256 } from './settings-merge.mjs';

function repo() { return mkdtempSync(join(tmpdir(), 'hk-rules-ev-')); }
function write(d, rel, text) {
  mkdirSync(join(d, rel, '..'), { recursive: true });
  writeFileSync(join(d, rel), text);
}
const bare = {
  instructions: { path: null, lines: 0 },
  claudeDir: { denyRules: 0, hookRegistrations: {}, rules: [] },
};
const withHooks = {
  instructions: { path: 'CLAUDE.md', lines: 10 },
  claudeDir: { denyRules: 2, denyRuleList: ['Edit(secrets/**)', 'Edit(*-lock.json)'], hookRegistrations: { Stop: [{ script: '.claude/scripts/verify-touched.mjs', matcher: null }] }, rules: [] },
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
  assert.deepEqual(ev.missingPointers, [{ id: 'R1', pointer: 'tests/gone.test.mjs', reason: 'not-found' }]);
});

test('settings:hooks.Stop resolves when a Stop hook is registered, and is missing when not', () => {
  const d = repo();
  write(d, RULES_PATH, '## R4 — r\n- enforced-by: hook\n- pointer: settings:hooks.Stop\n');
  assert.deepEqual(rulesRegistryEvidence(d, withHooks).missingPointers, []);
  assert.deepEqual(rulesRegistryEvidence(d, bare).missingPointers, [{ id: 'R4', pointer: 'settings:hooks.Stop', reason: 'not-found' }]);
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
  const dead = [{ id: 'R4', pointer: 'settings:hooks.Stop', reason: 'not-found' }];
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

test('settings:hooks.PreToolUse resolves when the entry script is the only hook on PreToolUse', () => {
  const d = repo();
  write(d, RULES_PATH, '## R4 — r\n- enforced-by: hook\n- pointer: settings:hooks.PreToolUse\n');
  const harness = { ...bare, claudeDir: { ...bare.claudeDir, hookRegistrations: { PreToolUse: [{ script: DISPATCH_PRE_PATH, matcher: null }] } } };
  assert.deepEqual(rulesRegistryEvidence(d, harness).missingPointers, []);
});

test('every entry script runs a hook besides the logging one, so its registration is never the logging half alone', () => {
  for (const [event, { halves }] of Object.entries(ENTRY_SCRIPTS)) assert.ok(halves.some(h => h !== SESSION_LOG_PATH), event);
});

/** A harness whose deny rules in effect are `denyRuleList`, as `detect`
 * reads them: a rule that is not a path-taking permission is null. */
const denying = denyRuleList => ({ ...bare, claudeDir: { ...bare.claudeDir, denyRules: denyRuleList.length, denyRuleList } });

test('settings:permissions.deny resolves on a deny rule of the owner\'s, and not on the rules the kit installs with its gate hook', () => {
  const d = repo();
  write(d, RULES_PATH, '## R5 — r\n- enforced-by: deny\n- pointer: settings:permissions.deny\n');
  const dead = [{ id: 'R5', pointer: 'settings:permissions.deny', reason: 'not-found' }];
  const pointers = list => rulesRegistryEvidence(d, denying(list)).missingPointers;
  assert.deepEqual(pointers([]), dead);
  assert.deepEqual(pointers(toolGateDenyRules()), dead, 'every install holds these, whatever the owner denies');
  assert.deepEqual(pointers([...toolGateDenyRules(), 'Edit(secrets/**)']), []);
  assert.deepEqual(pointers([...toolGateDenyRules(), null]), [], 'a rule detect does not show, a command rule of the owner\'s, counts as theirs');
  assert.deepEqual(pointers(['Edit(*-lock.json)']), [], 'a protected-path rule denies what the owner approved it for');
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
  assert.deepEqual(ev.missingPointers.map(m => [m.id, m.reason]), [['A', 'not-in-repository'], ['B', 'not-in-repository'], ['C', 'not-in-repository']]);
});

const OFFICER = '## V8 — Screens use the design tokens\n- enforced-by: officer\n- pointer: tools/officers/v8.mjs\n';

test('an officer rule whose pointer exists is counted under officer and reported as held', () => {
  const d = repo();
  write(d, RULES_PATH, OFFICER);
  write(d, 'tools/officers/v8.mjs', '');
  const ev = rulesRegistryEvidence(d, bare);
  assert.equal(ev.byEnforcer.officer, 1);
  assert.deepEqual(ev.unenforced, []);
  assert.deepEqual(ev.missingPointers, []);
});

test('an officer rule whose pointer does not exist is a missing pointer', () => {
  const d = repo();
  write(d, RULES_PATH, OFFICER);
  assert.deepEqual(rulesRegistryEvidence(d, bare).missingPointers, [{ id: 'V8', pointer: 'tools/officers/v8.mjs', reason: 'not-found' }]);
});

test('an officer rule with no pointer, or a settings: pointer, is a missing pointer', () => {
  const d = repo();
  write(d, RULES_PATH, '## V8 — r\n- enforced-by: officer\n');
  assert.deepEqual(rulesRegistryEvidence(d, bare).missingPointers, [{ id: 'V8', pointer: null, reason: 'no-pointer' }]);
  const pre = { ...bare, claudeDir: { ...bare.claudeDir, hookRegistrations: { PreToolUse: [{ script: DISPATCH_PRE_PATH, matcher: null }] } } };
  write(d, RULES_PATH, '## R4 — r\n- enforced-by: hook\n- pointer: settings:hooks.PreToolUse\n');
  assert.deepEqual(rulesRegistryEvidence(d, pre).missingPointers, [], 'the same registration holds a hook rule');
  write(d, RULES_PATH, '## V8 — r\n- enforced-by: officer\n- pointer: settings:hooks.PreToolUse\n');
  assert.deepEqual(rulesRegistryEvidence(d, pre).missingPointers, [{ id: 'V8', pointer: 'settings:hooks.PreToolUse', reason: 'not-in-repository' }]);
});

test('an officer pointer that is absolute or has a .. segment is not in the repository; a long or unusual name that exists resolves', () => {
  const d = repo();
  const long = `tools/${'a'.repeat(200)}.mjs`;
  const spaced = 'tools/officers/a b.mjs';
  const unusual = `tools/v8${String.fromCodePoint(0x200b)}.mjs`;
  write(d, 'README.md', '');
  write(d, long, '');
  write(d, spaced, '');
  write(d, unusual, '');
  write(d, RULES_PATH, [
    '## A — r', '- enforced-by: officer', `- pointer: ${join(d, 'README.md')}`,
    '## B — r', '- enforced-by: officer', '- pointer: ../README.md',
    '## C — r', '- enforced-by: officer', '- pointer: docs/../README.md',
    '## D — r', '- enforced-by: officer', `- pointer: ${long}`,
    '## E — r', '- enforced-by: officer', `- pointer: ${unusual}`,
    '## F — r', '- enforced-by: officer', '- pointer: README.md',
    '## G — r', '- enforced-by: officer', `- pointer: ${spaced}`,
    '',
  ].join('\n'));
  assert.deepEqual(rulesRegistryEvidence(d, bare).missingPointers.map(m => [m.id, m.reason]),
    [['A', 'not-in-repository'], ['B', 'not-in-repository'], ['C', 'not-in-repository']]);
});

test('an officer pointer: a trailing slash after a file, a name that differs only in case, a directory', () => {
  const d = repo();
  write(d, 'tools/officers/v8.mjs', '');
  write(d, RULES_PATH, [
    '## S — r', '- enforced-by: officer', '- pointer: tools/officers/v8.mjs/',
    '## K — r', '- enforced-by: officer', '- pointer: tools/officers/V8.mjs',
    '## D — r', '- enforced-by: officer', '- pointer: tools/officers',
    '',
  ].join('\n'));
  // Both answers are the filesystem's, not the kit's, so each expectation is
  // read from the filesystem the test runs on. Whether `V8.mjs` names
  // `v8.mjs`: case-insensitive on default macOS and Windows volumes,
  // sensitive on Linux. Whether a file followed by a slash exists: not on
  // POSIX (ENOTDIR).
  const caseFolds = existsSync(join(d, 'tools/officers/V8.mjs'));
  const slashFolds = existsSync(join(d, 'tools/officers/v8.mjs/'));
  assert.deepEqual(rulesRegistryEvidence(d, bare).missingPointers, [
    ...(slashFolds ? [] : [{ id: 'S', pointer: 'tools/officers/v8.mjs/', reason: 'not-found' }]),
    ...(caseFolds ? [] : [{ id: 'K', pointer: 'tools/officers/V8.mjs', reason: 'not-found' }]),
  ]);
});

test('an officer pointer through a link that leaves the repository is missing, one through a link inside it exists', () => {
  const d = repo();
  const outside = repo();
  write(outside, 'v8.mjs', '');
  write(d, 'tools/inside/v8.mjs', '');
  symlinkSync(outside, join(d, 'tools', 'out'), 'junction');
  symlinkSync(join(d, 'tools', 'inside'), join(d, 'tools', 'in'), 'junction');
  write(d, RULES_PATH, [
    '## V8 — r', '- enforced-by: officer', '- pointer: tools/out/v8.mjs',
    '## V9 — r', '- enforced-by: officer', '- pointer: tools/in/v8.mjs',
    '',
  ].join('\n'));
  assert.deepEqual(rulesRegistryEvidence(d, bare).missingPointers, [{ id: 'V8', pointer: 'tools/out/v8.mjs', reason: 'leaves-repository' }]);
});

test('a rule with an enforcer but no pointer is reported as missing a pointer; none/review need none', () => {
  const d = repo();
  write(d, RULES_PATH, '## A — r\n- enforced-by: test\n## B — r\n- enforced-by: review\n## C — r\n- enforced-by: none\n');
  const ev = rulesRegistryEvidence(d, bare);
  assert.deepEqual(ev.missingPointers, [{ id: 'A', pointer: null, reason: 'no-pointer' }]);
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

test('a registry larger than detect reads, or one that is not a file, is a stated problem and not zero rules', () => {
  const d = repo();
  write(d, RULES_PATH, `## R1 — r\n- enforced-by: none\n${'x'.repeat(MAX_DOCUMENT_BYTES)}`);
  mkdirSync(join(d, LEARNED_PATH), { recursive: true });
  const ev = rulesRegistryEvidence(d, bare);
  assert.equal(ev.notRead, OVER_DOCUMENT_LIMIT);
  assert.deepEqual(ev.problems, [`${RULES_PATH} ${OVER_DOCUMENT_LIMIT}, so the rules it holds were not read`]);
  assert.equal(ev.count, 0);
  assert.equal(ev.learned.notRead, 'exists but could not be read');
  assert.deepEqual(ev.learned.problems, [`${LEARNED_PATH} exists but could not be read, so the rules it holds were not read`]);

  const read = repo();
  write(read, RULES_PATH, '## R1 — r\n- enforced-by: none\n');
  assert.equal(rulesRegistryEvidence(read, bare).notRead, null);
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
  '- approved-action: block',
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
    byEnforcer: { hook: 1, test: 1 }, unenforced: [], missingPointers: [], problems: [], notRead: null,
  });
  assert.equal(ev.injectable, 3, 'two owner\'s rules and the one learned rule no gate blocks');
});

test('a learned rule whose gate warns, or whose entry records no action, is counted as injected', () => {
  const d = repo();
  write(d, LEARNED_PATH, LEARNED.replace('- approved-action: block', '- approved-action: warn'));
  assert.equal(rulesRegistryEvidence(d, bare).injectable, 2);
  write(d, LEARNED_PATH, LEARNED.replace('- approved-action: block\n', ''));
  assert.equal(rulesRegistryEvidence(d, bare).injectable, 2);
});

test('a learned entry whose pointer does not resolve is reported the way an owner\'s is', () => {
  const d = repo();
  write(d, RULES_PATH, '## R1 — r\n- enforced-by: test\n- pointer: tests/gone.test.mjs\n');
  write(d, LEARNED_PATH, LEARNED);
  const ev = rulesRegistryEvidence(d, bare);
  assert.deepEqual(ev.missingPointers, [{ id: 'R1', pointer: 'tests/gone.test.mjs', reason: 'not-found' }]);
  assert.deepEqual(ev.learned.missingPointers, [
    { id: 'L1', pointer: '.claude/kh-harness/gates.json', reason: 'not-found' },
    { id: 'L2', pointer: 'tests/money.test.mjs', reason: 'not-found' },
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
  const h = { instructions: { path: 'CLAUDE.md', lines: 1 }, claudeDir: { denyRules: 0, rules: ['.claude/rules/api.md', '.claude/rules/web.md'] } };
  assert.deepEqual(ruleShapedLines(d, h), [{ file: '.claude/rules/api.md', lines: [4] }]);
});

test('ruleShapedLines does NOT count lines inside docs/harness/RULES.md itself, and returns [] with no instruction file', () => {
  const d = repo();
  write(d, RULES_PATH, '## R1 — never do X\n- enforced-by: none\n');
  assert.deepEqual(ruleShapedLines(d, bare), []);
});
