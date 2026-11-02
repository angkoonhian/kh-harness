// scripts/lib/rules-brief.test.mjs
//
// The UserPromptSubmit hook that puts docs/harness/RULES.md back in front of
// the model on every prompt. It injects CONTEXT rather than guarding an
// action, so it fails OPEN (no registry, no output, exit 0) — the opposite
// of what a guard should do and the right call for a reminder. It is
// byte-bounded because it runs on every single prompt, and every line it
// emits passes the shared credential mask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RULES_PATH } from '../../assets/scripts/harness-redact.mjs';

const SCRIPT = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'rules-brief.mjs');
const run = (cwd, env = {}) => execFileSync(process.execPath, [SCRIPT], {
  cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', HK_RULES_BRIEF_MAX_BYTES: '', ...env },
});
const repo = () => mkdtempSync(join(tmpdir(), 'hk-rules-brief-'));
function registry(d, text) {
  mkdirSync(join(d, 'docs', 'harness'), { recursive: true });
  writeFileSync(join(d, RULES_PATH), text);
}
/** Parses the hook's stdout as the one JSON object it must be, and returns
 * the injected text. */
function injected(out) {
  const obj = JSON.parse(out);
  assert.deepEqual(Object.keys(obj), ['hookSpecificOutput']);
  assert.equal(obj.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(typeof obj.hookSpecificOutput.additionalContext, 'string');
  return obj.hookSpecificOutput.additionalContext;
}

const TWO_RULES = [
  '## R1 — Every query is scoped to the current tenant',
  '- enforced-by: critic',
  '- pointer: .claude/agents/tenant-scoping.md',
  '## R2 — Money is integer cents',
  '- enforced-by: test',
  '- pointer: tests/money.test.mjs',
  '',
].join('\n');

test('emits one JSON object with hookEventName UserPromptSubmit and the rules as additionalContext', () => {
  const d = repo();
  registry(d, TWO_RULES);
  const out = run(d);
  assert.ok(out.endsWith('\n'), 'one object, one trailing newline');
  const text = injected(out);
  assert.match(text, /^<project-rules source="docs\/harness\/RULES\.md">\nProject rules \(docs\/harness\/RULES\.md\):\n/);
  assert.match(text, /^- R1: Every query is scoped to the current tenant \[enforced-by: critic\]$/m);
  assert.match(text, /^- R2: Money is integer cents \[enforced-by: test\]$/m);
});

test('high-priority rules come first, in stable order within a priority', () => {
  const d = repo();
  registry(d, [
    '## A — first normal', '- enforced-by: none',
    '## B — the urgent one', '- enforced-by: none', '- priority: high',
    '## C — second normal', '- enforced-by: none',
    '## D — second urgent', '- enforced-by: none', '- priority: high',
    '',
  ].join('\n'));
  const text = injected(run(d));
  const order = [...text.matchAll(/^- ([A-D]):/gm)].map(m => m[1]);
  assert.deepEqual(order, ['B', 'D', 'A', 'C']);
});

test('superseded rules are not injected', () => {
  const d = repo();
  registry(d, '## OLD — do the old thing\n- enforced-by: none\n- status: superseded\n## NEW — do the new thing\n- enforced-by: none\n');
  const text = injected(run(d));
  assert.doesNotMatch(text, /OLD/);
  assert.match(text, /NEW/);
});

test('the byte bound is honoured and announced, dropping whole rules, never mid-line', () => {
  const d = repo();
  const many = Array.from({ length: 12 }, (_, i) => `## R${i} — rule number ${i} with some words to take up space\n- enforced-by: none\n`).join('');
  registry(d, many);
  const text = injected(run(d, { HK_RULES_BRIEF_MAX_BYTES: '300' }));
  assert.ok(Buffer.byteLength(text, 'utf8') <= 300, `got ${Buffer.byteLength(text, 'utf8')} bytes`);
  assert.match(text, /^… \d+ more rule\(s\) in docs\/harness\/RULES\.md$/m);
  // Every rule line that did make it is complete.
  for (const line of text.split('\n').filter(l => l.startsWith('- '))) assert.match(line, /\[enforced-by: none\]$/);
  // And the full set does fit under the real default.
  const full = injected(run(d));
  assert.doesNotMatch(full, /more rule/);
  assert.equal((full.match(/^- R\d+:/gm) ?? []).length, 12);
});

test('a credential-shaped value in a rule line is masked before it reaches stdout', () => {
  const d = repo();
  // Assembled at runtime so this test file never holds a credential-shaped
  // literal (the DOGFOOD security test scans this repository).
  const token = 'ghp_' + 'A'.repeat(24);
  registry(d, `## R1 — Rotate the deploy token (currently ${token})\n- enforced-by: none\n`);
  const out = run(d);
  assert.equal(out.includes(token), false, 'the token must never reach stdout');
  assert.match(injected(out), /\*\*\*/);
});

// --- Audit Tier 4, finding 25: control and bidi characters, and a delimiter --
//
// A rule's text is the user's prose and reaches the model on every prompt.
// A right-to-left override or a C0 control character in it would reach the
// model too; and an undelimited block is indistinguishable from the prompt.
test('control and bidirectional-format characters never reach the injected context', () => {
  const d = repo();
  registry(d, `## R1 — Never ‮evom‬ the ledger\u0007 file​\n- enforced-by: none\n`);
  const text = injected(run(d));
  for (const ch of ['‮', '‬', '\u0007', '​']) assert.equal(text.includes(ch), false, `U+${ch.codePointAt(0).toString(16)} must be stripped`);
  assert.match(text, /Never evom the ledger file/, 'the visible text survives');
});

test('the injected block is delimited and names its source', () => {
  const d = repo();
  registry(d, TWO_RULES);
  const text = injected(run(d));
  assert.ok(text.startsWith(`<project-rules source="${RULES_PATH}">\n`), text.slice(0, 80));
  assert.ok(text.endsWith('\n</project-rules>'), text.slice(-40));
});

test('the byte bound counts the delimiter', () => {
  const d = repo();
  const many = Array.from({ length: 12 }, (_, i) => `## R${i} — rule number ${i} with some words to take up space\n- enforced-by: none\n`).join('');
  registry(d, many);
  const text = injected(run(d, { HK_RULES_BRIEF_MAX_BYTES: '300' }));
  assert.ok(Buffer.byteLength(text, 'utf8') <= 300, `got ${Buffer.byteLength(text, 'utf8')} bytes`);
  assert.ok(text.endsWith('</project-rules>'));
});

test('no registry → no output, exit 0', () => {
  const d = repo();
  assert.equal(run(d), '');
});

test('a scaffold with zero rules → no output, exit 0', () => {
  const d = repo();
  registry(d, '# Rules\n<!--\n## EXAMPLE — not a rule\n- enforced-by: test\n-->\n');
  assert.equal(run(d), '');
});

test('only superseded rules → no output, exit 0', () => {
  const d = repo();
  registry(d, '## OLD — gone\n- enforced-by: none\n- status: superseded\n');
  assert.equal(run(d), '');
});

test('CLAUDE_PROJECT_DIR is honoured from a nested cwd', () => {
  const d = repo();
  registry(d, TWO_RULES);
  mkdirSync(join(d, 'sub', 'deeper'), { recursive: true });
  assert.match(injected(run(join(d, 'sub', 'deeper'), { CLAUDE_PROJECT_DIR: d })), /R1/);
  assert.equal(run(join(d, 'sub', 'deeper')), '', 'without it, a nested cwd has no registry and the hook says nothing');
});

// --- UPGRADE SKEW: an older shared asset beside this hook --------------------
//
// Found on a real repository: kh-harness 0.1.0's harness-redact.mjs was
// already installed, and this hook died at import on every prompt because
// that copy has no `parseRules`. A static named import cannot be caught, so
// the hook must probe the asset's shape at runtime and FAIL VISIBLY — one
// stderr line and a non-zero exit, which Claude Code surfaces as a hook
// error notice — rather than crash with a stack trace or, worse, go silent.
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';

test('an older harness-redact.mjs beside the hook produces one stderr line naming the fix, exit 1, and no stdout', () => {
  const d = repo();
  registry(d, TWO_RULES);
  mkdirSync(join(d, '.claude', 'scripts'), { recursive: true });
  // The hook is run from the user's .claude/scripts/, beside the asset —
  // exactly how apply installs it.
  copyFileSync(SCRIPT, join(d, '.claude', 'scripts', 'rules-brief.mjs'));
  writeFileSync(join(d, '.claude', 'scripts', 'harness-redact.mjs'),
    '// Generated by kh-harness 0.1.0 (shared asset).\nexport function projectRoot() { return process.env.CLAUDE_PROJECT_DIR || process.cwd(); }\n');
  const r = spawnSync(process.execPath, [join(d, '.claude', 'scripts', 'rules-brief.mjs')], {
    cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d, HK_RULES_BRIEF_MAX_BYTES: '' },
  });
  assert.equal(r.status, 1, 'non-zero so Claude Code shows a hook-error notice; never 2, which would block the prompt');
  assert.equal(r.stdout, '', 'nothing injected from a hook that cannot run');
  assert.match(r.stderr, /harness-redact\.mjs/);
  assert.match(r.stderr, /older|outdated|out of date/i);
  assert.match(r.stderr, /apply/);
  assert.equal(r.stderr.trim().split('\n').length, 1, 'one line, not a stack trace');
});

test('REVIEW-6: a MISSING harness-redact.mjs beside the hook also produces one stderr line and exit 1, never a stack trace', () => {
  const d = repo();
  registry(d, TWO_RULES);
  mkdirSync(join(d, '.claude', 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(d, '.claude', 'scripts', 'rules-brief.mjs'));
  const r = spawnSync(process.execPath, [join(d, '.claude', 'scripts', 'rules-brief.mjs')], {
    cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d, HK_RULES_BRIEF_MAX_BYTES: '' },
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1, `one line, not a stack trace: ${r.stderr}`);
  assert.match(r.stderr, /harness-redact\.mjs/);
  assert.match(r.stderr, /missing|not found|older/i);
});

test('REVIEW-4: the skew notice names the fallback for when apply cannot update the asset', () => {
  const d = repo();
  registry(d, TWO_RULES);
  mkdirSync(join(d, '.claude', 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(d, '.claude', 'scripts', 'rules-brief.mjs'));
  writeFileSync(join(d, '.claude', 'scripts', 'harness-redact.mjs'), 'export function projectRoot() { return process.cwd(); }\n');
  const r = spawnSync(process.execPath, [join(d, '.claude', 'scripts', 'rules-brief.mjs')], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  assert.match(r.stderr, /uninstall/, 'when apply reports the asset as modified (CRLF checkouts, hand edits), uninstall then apply is the way through');
});
