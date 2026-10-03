// scripts/lib/skill-phases.test.mjs
//
// Task 4's own brief shipped four assertions shaped like
// `/automatic|every edit|.../i` — a bare keyword-soup regex that passes on
// any prose CONTAINING those words, whether or not it makes the actual
// disclosure. Task 3's brief had the same shape and shipped two
// near-vacuous tests that needed a follow-up round to fix. Tightened here:
// every assertion below pairs a keyword check with a PROXIMITY check — the
// two phrases a claim depends on must sit near each other, in a window
// small enough that an unrelated sentence elsewhere in the file cannot
// satisfy it by accident. See task-4-report.md for mutation-tested proof
// that each tightened assertion fails on prose that still satisfies the
// brief's original, looser version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REF = resolve(import.meta.dirname, '..', '..', 'skills', 'harness-init', 'references');
const ref = n => readFileSync(join(REF, n), 'utf8');

/** True if `near` matches somewhere within `window` characters of some
 * match of `re` in `text` — checked around every match, not just the
 * first, and in both directions, since prose order is not fixed. */
function hasNear(text, re, near, window = 120) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const g = new RegExp(re.source, flags);
  const matches = [...text.matchAll(g)];
  return matches.some(m => {
    const start = Math.max(0, m.index - window);
    const end = Math.min(text.length, m.index + m[0].length + window);
    return near.test(text.slice(start, end));
  });
}

test('the sensor phase discloses that installing the hook runs the repository’s own lint script automatically, on every edit', () => {
  const t = ref('phase-2-sensors.md');
  assert.match(t, /lint/i);
  // Loose version (task-4-brief.md): /automatic|every edit|each edit|turn end/i
  // anywhere in the file. Passes on prose like: "This phase covers lint,
  // typecheck, and test scripts. Every edit may deserve review, though
  // nothing here runs fully automatically." — mentions lint AND "every
  // edit" AND "automatically" without ever saying the hook runs the repo's
  // OWN script FOR you. Tightened: "own ... lint ... script" must sit next
  // to the every-edit/automatic disclosure, not just share the document.
  assert.ok(
    hasNear(
      t,
      /own\b[^.]{0,40}\blint\b[^.]{0,40}script|lint\b[^.]{0,40}script[^.]{0,40}\bown\b/i,
      /every edit|each edit|automatically/i,
    ),
    'the claim that the sensor runs the repository’s OWN lint script must sit next to the every-edit/automatic disclosure',
  );
});

test('the stop gate’s cost is disclosed with the measured numbers, not just the word "cost"', () => {
  const t = ref('phase-2-sensors.md');
  // Loose version: /scales|repository size|whole[- ]program|cost/i anywhere
  // in the file. Passes on "This step has a cost; repository size matters
  // when you scale your architecture" — contains "cost", "repository
  // size" and "scale" and discloses nothing a user could decide from.
  // Tightened: the actual measured figures must be present.
  assert.match(t, /whole[- ]program/i);
  assert.match(t, /\b40\b[^.]{0,20}module/i, 'the ~1s-at-40-modules figure must be stated');
  assert.match(t, /\b1000\b[^.]{0,20}module/i, 'the 10-30s-at-1000-modules figure must be stated');
  assert.match(t, /10-30\s*seconds/i, 'the measured range itself must be stated, not just that a range exists');
});

test('LOAD-BEARING: the advise steps say plainly that the kit takes no action on git remotes or memory', () => {
  const t = ref('phase-4-continuity.md');
  // Loose version: three independent regexes anywhere in the file. Passes
  // on "We advise checking your remote settings; this never shows ads and
  // takes no action against your privacy." — satisfies all three without
  // disclosing the actual rule. Tightened: "remote" must sit next to its
  // own never-touches disclosure, and "memory" next to its own.
  assert.match(t, /\b(advise|advice|instructions)\b/i);
  assert.ok(
    hasNear(t, /\bremote/i, /never\b|takes no action|does not touch/i, 80),
    'spec §6: "remote" must sit next to the never-touches disclosure, not just appear somewhere in the file',
  );
  assert.ok(
    hasNear(t, /memory/i, /never\b|takes no action|does not (relocate|touch|move)/i, 80),
    'spec §6: "memory" must sit next to its own never-relocates disclosure',
  );
  assert.match(t, /credential/i, 'the reason memory is not relocated must name what it may hold');
});

test('LOAD-BEARING: declining a gate leaves nothing written, stated for both references', () => {
  for (const f of ['phase-2-sensors.md', 'phase-4-continuity.md']) {
    const t = ref(f);
    // Loose version: /declin\w+/i anywhere in the file. Passes on an
    // unrelated sentence like "Declining a gym membership is a personal
    // choice." Tightened: the word must sit next to a statement that
    // nothing was written.
    assert.ok(
      hasNear(t, /declin\w+/i, /nothing (is |was )?written|writes? nothing/i, 120),
      `${f} must say, near the word "declin...", that nothing is written when the user declines`,
    );
  }
});
