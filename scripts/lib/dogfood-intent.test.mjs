// scripts/lib/dogfood-intent.test.mjs
//
// kh-harness passes its own Phase 3 checks. This is the acceptance test
// for the design as much as for the documents: if the kit's own intent and
// rules cannot be expressed in the schema it ships, the schema is wrong —
// and a tool that asks every repository for a registry while keeping none
// of its own has not demonstrated the thing it is asking for.
//
// Same discipline as the DOGFOOD security test in detect-exposure.test.mjs:
// the fixture is THIS repository, read through the same functions `detect`
// uses, and the failure message says what to fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from './scan.mjs';
import { detectHarness } from './detect-harness.mjs';
import { intentEvidence, INTENT_PATH, INTENT_SECTIONS } from './intent-evidence.mjs';
import { rulesRegistryEvidence } from './rules-evidence.mjs';
import { parseRules, RULES_PATH } from '../../assets/scripts/harness-redact.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('DOGFOOD: kh-harness has its own docs/INTENT.md with every section present', () => {
  const intent = intentEvidence(ROOT);
  assert.ok(intent, `${INTENT_PATH} must exist in this repository — the kit asks every repository for one`);
  assert.deepEqual(intent.missing, [], `${INTENT_PATH} is missing sections; the seven are ${INTENT_SECTIONS.join(', ')}`);
  assert.ok(intent.lastReviewed, 'the kit\'s own intent carries a last-reviewed date, because it tells others to');
});

test('DOGFOOD: kh-harness has its own rules registry, every rule held by a named enforcer that exists', () => {
  const files = listFiles(ROOT).files;
  assert.ok(files.includes(RULES_PATH), `${RULES_PATH} must be TRACKED in this repository, not merely present`);
  const harness = detectHarness(ROOT, files);
  const reg = rulesRegistryEvidence(ROOT, harness);
  assert.ok(reg, `${RULES_PATH} must exist`);
  assert.ok(reg.count >= 5, `expected at least five rules (the kit's doctrine has at least that many), got ${reg.count}`);
  assert.deepEqual(reg.problems, [], 'the kit\'s own registry must parse cleanly');
  assert.deepEqual(reg.missingPointers, [], 'every pointer in the kit\'s own registry must resolve — a dead pointer here is the drift signal the registry exists to catch');
  // Every rule is held by something; `review` is allowed (a human is a
  // mechanism), `none` is not — the kit's doctrine is enforced by tests, and
  // a doctrine rule recorded as a bare claim would be a false modesty worth
  // failing on.
  assert.deepEqual(reg.unenforced, [], `rules with enforced-by: none in the kit's own registry: ${reg.unenforced.join(', ')}`);
});

const readRepo = rel => readFileSync(join(ROOT, rel), 'utf8');

// The rules that bind the session log and the learning loop, each with the
// test file that proves it.
const LOOP_RULES = {
  R11: 'scripts/lib/harness-gates.test.mjs',
  R12: 'scripts/lib/session-log.test.mjs',
  R13: 'scripts/lib/learn-promote.test.mjs',
  R14: 'scripts/lib/learn-promote.test.mjs',
};

test("the kit's registry holds R11 to R14 and each pointer resolves", () => {
  const { rules } = parseRules(readRepo(RULES_PATH));
  for (const [id, pointer] of Object.entries(LOOP_RULES)) {
    const rule = rules.find(r => r.id === id);
    assert.ok(rule, `${RULES_PATH} has no ${id}`);
    assert.equal(rule.enforcedBy, 'test', `${id} is held by a test`);
    assert.equal(rule.pointer, pointer, `${id} points at the test file that proves it`);
    assert.ok(existsSync(join(ROOT, pointer)), `${id}'s pointer ${pointer} does not exist`);
    const run = [...(rule.verify ?? '').matchAll(/scripts\/lib\/[\w.-]+\.test\.mjs/g)].map(m => m[0]);
    assert.ok(run.includes(pointer), `${id}'s verify command runs its pointer`);
    for (const file of run) assert.ok(existsSync(join(ROOT, file)), `${id}'s verify command names ${file}, which does not exist`);
  }
});

/**
 * The pointers in INTENT.md's Success and Failure sections, in order: each
 * backticked repository path, and each double-quoted test name after one,
 * paired with the path it follows.
 */
function intentPointers(text) {
  const pointers = [];
  for (const section of text.split(/^## /m).filter(s => /^(Success|Failure)\n/.test(s))) {
    let file = null;
    for (const m of section.matchAll(/`([^`]+)`|"([^"]+)"/g)) {
      if (m[1] !== undefined && m[1].includes('/')) {
        file = m[1];
        pointers.push({ file });
      } else if (m[2] !== undefined && file !== null) {
        // Prose wraps, so a name may cross a line break.
        pointers.push({ file, test: m[2].replace(/\s+/g, ' ') });
      }
    }
  }
  return pointers;
}

/** The name of every top-level `test(...)` in the file at `rel`. */
const testNames = rel => [...readRepo(rel).matchAll(/^test\((['"])((?:\\.|(?!\1).)*)\1/gm)].map(m => m[2].replace(/\\(.)/g, '$1'));

test("INTENT.md's Shown-by pointers resolve to existing files", () => {
  const pointers = intentPointers(readRepo(INTENT_PATH));
  assert.ok(pointers.filter(p => p.test === undefined).length >= 8, 'the extractor found the pointers');
  for (const p of pointers) {
    assert.ok(existsSync(join(ROOT, p.file)), `${INTENT_PATH} points at ${p.file}, which does not exist`);
    if (p.test !== undefined) {
      assert.ok(testNames(p.file).some(name => name.includes(p.test)), `${INTENT_PATH} names a test "${p.test}" that ${p.file} does not hold`);
    }
  }
  assert.doesNotMatch(readRepo(INTENT_PATH), /docs\/ARCHITECTURE\.md/, 'the kit keeps no ARCHITECTURE.md, so its intent must not point at one');
});

test('the session log and learning loop design records where the build differs from it', () => {
  const design = readRepo('docs/superpowers/specs/2026-11-19-session-log-and-learning-loop-design.md');
  const at = design.indexOf('\n## As built: where the implementation differs\n');
  assert.ok(at > 0, 'the design has its as-built section');
  assert.ok(design.indexOf('\n## Open risks\n') < at, "the as-built section follows the design's own text");
  const section = design.slice(at + 1).split(/\n## /)[0];
  assert.ok((section.match(/^- /gm) ?? []).length >= 10, 'the as-built section lists each deviation');
});
