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

// WHAT THE FOUR TESTS BELOW DO AND DO NOT ESTABLISH (review finding 2).
// Each pairs a keyword with a proximity check, which is strictly stronger
// than the brief's own bare keyword-soup regexes — but a regex pins the
// PRESENCE of particular wording, never meaning. A reviewer constructed
// decoy prose that passed three of the four tightened assertions below
// without making the actual disclosure, and no further regex tightening
// closes that gap; chasing it buys fragility, not assurance. These tests
// guard against the disclosure sentence being deleted outright, or
// reworded past recognition, between now and whenever this file is next
// touched — nothing more. Whether the prose, AS WRITTEN, actually produces
// the right model behaviour at the gate is the eval suite's job (the next
// task), which runs the real skill against real repositories with a
// no-plugin baseline. A green run here is evidence the words are still in
// the file, not evidence the disclosure works.
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
      /every\s+edit|each\s+edit|automatically/i,
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
  //
  // Review finding 1 (Major): an EARLIER tightened version of this test
  // asserted bare `/whole[- ]program/i` presence, anywhere in the file —
  // which looked pinned to the disclosure sentence until a later editing
  // round (correcting the cost figure to match propose.mjs) added a
  // SECOND, independent "whole-program" occurrence elsewhere in the same
  // paragraph (the 1000-module scaling sentence). After that round,
  // deleting the disclosure sentence no longer failed this test: the
  // regex simply matched the other occurrence instead. A bare keyword
  // check cannot tell "the sentence that matters" from "any sentence
  // using this word" once the word appears twice — anchoring on
  // "no incremental cache" instead fixes that, because (checked at the
  // time this was written, and worth re-checking if this paragraph is
  // ever edited) that exact phrase appears exactly once in the file, only
  // inside the disclosure sentence itself.
  assert.match(t, /no\s+incremental\s+cache/i, 'the cost-disclosure sentence itself must be present, not merely a word it happens to share with other prose');
  assert.match(t, /\b40\b[^.]{0,20}module/i, 'the ~2.8s-per-turn-at-40-modules figure must be stated');
  assert.match(t, /\b1000\b[^.]{0,20}module/i, 'the 10-30s-at-1000-modules figure must be stated');
  assert.match(t, /10-30\s*seconds/i, 'the measured range itself must be stated, not just that a range exists');
});

test('step 12 (language server) is present as an advise step, with the real reason and a verification check', () => {
  const t = ref('phase-2-sensors.md');
  assert.match(t, /step 12/i);
  assert.ok(
    // Markdown in this file wraps at ~75 columns, so a multi-word phrase
    // crossing a line break has a newline, not a space, between two of its
    // words — \s+ (not a literal space) is required everywhere a phrase
    // spans more than a few words, or this breaks the same way review
    // finding 1 did, just for a different reason (a true-negative false
    // failure instead of a false pass, but still a test that does not mean
    // what it appears to mean).
    hasNear(t, /language\s+server/i, /not\s+reliably\s+automat\w+\s+across\s+platforms/i, 600),
    'the real reason (not reliably automatable across platforms) must be stated near the language-server step, not merely "not supported"',
  );
  assert.ok(
    hasNear(t, /language\s+server/i, /verify\s+by\s+hand|hover\s+over\s+a\s+symbol|go\s+to\s+definition/i, 600),
    'a verification check the user can actually run must be given',
  );
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
    hasNear(t, /\bremote/i, /never\b|takes\s+no\s+action|does\s+not\s+touch/i, 80),
    'spec §6: "remote" must sit next to the never-touches disclosure, not just appear somewhere in the file',
  );
  assert.ok(
    hasNear(t, /memory/i, /never\b|takes\s+no\s+action|does\s+not\s+(relocate|touch|move)/i, 80),
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
      hasNear(t, /declin\w+/i, /nothing\s+(is\s+|was\s+)?written|writes?\s+nothing/i, 120),
      `${f} must say, near the word "declin...", that nothing is written when the user declines`,
    );
  }
});
