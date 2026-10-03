import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SKILL_DIR = resolve(import.meta.dirname, '..', '..', 'skills', 'harness-init');
const skill = () => readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');

/** Every markdown link target under references/, as written in SKILL.md. */
function linkedPaths(text) {
  return [...text.matchAll(/\]\((\.\/)?(references\/[A-Za-z0-9._/-]+\.md)\)/g)].map(m => m[2]);
}

/** Every reference file that actually exists, relative to the skill directory. */
function referenceFiles(dir = join(SKILL_DIR, 'references'), prefix = 'references') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...referenceFiles(join(dir, e.name), `${prefix}/${e.name}`));
    else if (e.name.endsWith('.md')) out.push(`${prefix}/${e.name}`);
  }
  return out.sort();
}

test('SKILL.md has the frontmatter the three prompt-gated steps require', () => {
  const t = skill();
  assert.match(t, /^---\n/, 'frontmatter must open the file');
  assert.match(t, /\nname:\s*harness-init\b/);
  assert.match(t, /\ndescription:\s*\S/);
  assert.match(t, /\ndisable-model-invocation:\s*true\b/,
    'recon, CLAUDE.md and ARCHITECTURE.md write files that need judgement — Claude must not fire this autonomously');
  assert.doesNotMatch(t, /\nuser-invocable:\s*false\b/,
    'the user must still be able to invoke it as a slash command');
});

test('SKILL.md stays a router, not a manual', () => {
  const lines = skill().split('\n').length;
  assert.ok(lines <= 140, `SKILL.md is ${lines} lines; the budget is 140. Move explanation into references/.`);
});

test('LOAD-BEARING: every reference SKILL.md links to exists', () => {
  const missing = linkedPaths(skill()).filter(p => !existsSync(join(SKILL_DIR, p)));
  assert.deepEqual(missing, [], 'a dangling link is a reference the model is told to read and cannot');
});

test('LOAD-BEARING: SKILL.md stays inside its byte budget', () => {
  // Moved here from Task 7 by a pre-flight ruling: Tasks 2-5 PRODUCE this file
  // and the references, so a budget checked only at the end fails in Task 7
  // with the fix belonging to whichever earlier task overspent. Checked here,
  // every task that adds to the skill is held to it as it goes.
  const bytes = Buffer.byteLength(skill(), 'utf8');
  assert.ok(bytes <= 8 * 1024,
    `SKILL.md is ${bytes} bytes and loads on EVERY invocation; budget is 8 KiB.`);
});

test('LOAD-BEARING: each on-demand reference stays individually readable', () => {
  for (const f of referenceFiles()) {
    const bytes = Buffer.byteLength(readFileSync(join(SKILL_DIR, f), 'utf8'), 'utf8');
    assert.ok(bytes <= 24 * 1024, `${f} is ${bytes} bytes; keep one reference under 24 KiB`);
  }
});

test('LOAD-BEARING: every reference file is reachable from SKILL.md', () => {
  const linked = new Set(linkedPaths(skill()));
  // A profile reference is reached from phase-1, not from SKILL.md directly;
  // treat any file linked from a linked file as reachable, one level deep.
  for (const p of [...linked]) {
    const body = readFileSync(join(SKILL_DIR, p), 'utf8');
    for (const q of linkedPaths(body)) linked.add(q);
  }
  const orphans = referenceFiles().filter(f => !linked.has(f));
  assert.deepEqual(orphans, [], 'only SKILL.md auto-loads; an unlinked reference can never be read');
});
