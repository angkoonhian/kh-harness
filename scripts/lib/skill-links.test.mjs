import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SKILL_DIR = resolve(import.meta.dirname, '..', '..', 'skills', 'harness-init');
const skill = () => readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');

/** Removes fenced code blocks (```...```) before link extraction. Review
 * finding 2: an EXAMPLE link shown inside a fence (prose teaching how to
 * read a reference, not a real link) made the extractor return a path that
 * does not exist and does not need to, and the reachability test crashed
 * with an uncaught ENOENT instead of failing cleanly. Tasks 3-5 write prose
 * ABOUT how to read references, so a fenced example link is expected, not
 * exotic. */
function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

/** Every markdown link target under references/, as written in SKILL.md.
 * Case-insensitive on the extension (review finding 3: `UPPER.MD` is a
 * valid, if unusual, reference filename and must not be a blind spot). */
function linkedPaths(text) {
  return [...stripFences(text).matchAll(/\]\((\.\/)?(references\/[A-Za-z0-9._/-]+\.md)\)/gi)].map(m => m[2]);
}

/** Every reference file that actually exists, relative to the skill
 * directory. Case-insensitive `.md` match — see `linkedPaths`' own comment. */
function referenceFiles(dir = join(SKILL_DIR, 'references'), prefix = 'references') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...referenceFiles(join(dir, e.name), `${prefix}/${e.name}`));
    else if (/\.md$/i.test(e.name)) out.push(`${prefix}/${e.name}`);
  }
  return out.sort();
}

/**
 * Transitive closure over markdown links, starting from `start` (an
 * iterable of reference paths). `read(path)` returns that file's content,
 * or `null` if it doesn't exist — a dangling link, which this function
 * skips rather than throws on; the separate dangling-link test is what
 * reports that.
 *
 * Review finding 4: the previous version followed links exactly one hop
 * past SKILL.md, which happened to fit today's layout (SKILL.md ->
 * phase-1-legible.md -> profiles/*.md is exactly two levels) but is a bound
 * that silently expires the moment a third level is added — a worklist and a
 * `reachable` Set (doubling as the visited set) makes this a proper closure
 * instead, and the Set is what guarantees termination on a cycle (two
 * references linking each other) rather than looping forever.
 */
function transitiveClosure(start, read) {
  const reachable = new Set(start);
  const worklist = [...reachable];
  while (worklist.length) {
    const p = worklist.pop();
    const body = read(p);
    if (body == null) continue;
    for (const q of linkedPaths(body)) {
      if (!reachable.has(q)) {
        reachable.add(q);
        worklist.push(q);
      }
    }
  }
  return reachable;
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
  const links = linkedPaths(skill());
  // Review finding 1: this test is vacuous on zero links (nothing to be
  // dangling), so it must first prove the extractor actually found
  // something in a real SKILL.md before trusting an empty `missing` list.
  // Sound only as a pair with the orphan test below; this half pins that.
  assert.ok(links.length > 0, 'no links were extracted from SKILL.md — the extractor may be broken, which would make the check below pass vacuously');
  const missing = links.filter(p => !existsSync(join(SKILL_DIR, p)));
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
  // A profile reference is reached from phase-1, not from SKILL.md directly
  // — `transitiveClosure` follows links through any number of intermediate
  // files, not just one hop (review finding 4).
  const reachable = transitiveClosure(linkedPaths(skill()), p => {
    const full = join(SKILL_DIR, p);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  });
  const orphans = referenceFiles().filter(f => !reachable.has(f));
  assert.deepEqual(orphans, [], 'only SKILL.md auto-loads; an unlinked reference can never be read');
});

// Review finding 4's termination guarantee, pinned directly: a cycle (two
// references linking each other) must not loop forever. Uses an in-memory
// fixture rather than real files so this test exercises `transitiveClosure`
// alone, independent of anything under skills/harness-init/references/.
test('the transitive closure terminates on a cycle and still finds both files', () => {
  const fixture = {
    'references/cycle-a.md': 'See [b](references/cycle-b.md) for the rest.',
    'references/cycle-b.md': 'Back to [a](references/cycle-a.md).',
  };
  const reachable = transitiveClosure(['references/cycle-a.md'], p => fixture[p] ?? null);
  assert.deepEqual([...reachable].sort(), ['references/cycle-a.md', 'references/cycle-b.md']);
});
