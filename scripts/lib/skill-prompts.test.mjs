// scripts/lib/skill-prompts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REF = resolve(import.meta.dirname, '..', '..', 'skills', 'harness-init', 'references');
const ref = n => readFileSync(join(REF, n), 'utf8');

test('LOAD-BEARING: the CLAUDE.md step writes a proposal, never the file itself', () => {
  const t = ref('phase-1-legible.md');
  assert.match(t, /docs\/harness\/CLAUDE\.proposed\.md/,
    'spec §6: step 6 never writes CLAUDE.md in place when one exists');
  // Cross-file sweep (kh-harness-4, review round 3): markdown in these
  // reference files wraps at roughly 75 columns, so a multi-word phrase can
  // straddle a line break — a newline, not a space, then sits between two
  // of its words, and a regex built from literal spaces silently never
  // matches even when the prose is correct. \s+ everywhere a phrase spans
  // more than one word tolerates that reflow; a literal space does not.
  // This assertion passed today only because the prose happened not to
  // wrap at these two points — do not revert this to literal spaces on the
  // grounds that it was "already working."
  assert.match(t, /never\s+(write|overwrite|replace)[^.]*CLAUDE\.md[^.]*in\s+place/i);
  assert.doesNotMatch(t, /write\s+(the\s+)?CLAUDE\.md\s+(file\s+)?directly/i);
});

test('the recon step writes to docs/harness/recon.md and reads detect.json first', () => {
  const t = ref('phase-0-recon.md');
  // Tightened (review Finding 3): a bare substring check on the path passes
  // even for a sentence that FORBIDS the write (e.g. "never write
  // docs/harness/recon.md"). Require "write" to actually govern the path in
  // the same clause, and explicitly reject the forbidding phrasing.
  assert.match(t, /\bwrite\b[^.]*docs\/harness\/recon\.md/i,
    'must instruct writing the file, not merely mention its path');
  assert.doesNotMatch(t, /\bnever\b[^.]*\bwrite\b[^.]*docs\/harness\/recon\.md/i,
    'a mutation forbidding the write must fail this test');
  assert.match(t, /\bread\b[^.]*detect\.json[^.]*\bfirst\b/i,
    'must instruct reading detect.json before anything else, not merely mention it');
});

test('the architecture step derives from this repository, not from a template', () => {
  const t = ref('phase-1-legible.md');
  assert.match(t, /docs\/ARCHITECTURE\.md/);
  assert.doesNotMatch(t, /ARCHITECTURE\.md\.tmpl/,
    'there is deliberately no template: a templated architecture document is a guess');
});

test('every prompt-gated step names its gate', () => {
  // Tightened (review Finding 3): a bare word-count on "gate" passes even
  // when every occurrence is a cross-reference ("the gate below") with no
  // actual stop instruction. Require "gate" to be paired, within a bounded
  // window, with the imperative that makes it a gate (wait/stop) — not just
  // present somewhere in the file. The window crosses periods on purpose:
  // "CLAUDE.md" and "ARCHITECTURE.md" sit between some gates and their
  // "wait", and a literal filename period must not break the pairing.
  for (const [file, count] of [['phase-0-recon.md', 1], ['phase-1-legible.md', 2]]) {
    const hits = (ref(file).match(/\bgate\b[\s\S]{0,200}?\b(wait|stop)\b/gi) ?? []).length;
    assert.ok(hits >= count, `${file} pairs "gate" with an actual wait/stop instruction ${hits} times; it owns ${count} prompt-gated step(s)`);
  }
});

test('the credential rule is stated where recon will meet credentials', () => {
  const t = ref('phase-0-recon.md');
  assert.match(t, /never[^.]*value/i, 'spec §6: report location and type, never the value');
});

// --- Phase 3: intent and rules (phase-3-intent.md) -------------------------

test('the intent step writes docs/INTENT.md after reading the repository, and routes unknowns to Open questions rather than guessing', () => {
  const t = ref('phase-3-intent.md');
  assert.match(t, /\bwrite\b[^.]*docs\/INTENT\.md/i, 'must instruct writing the file, not merely mention its path');
  assert.doesNotMatch(t, /\bnever\b[^.]*\bwrite\b[^.]*docs\/INTENT\.md/i);
  // The seven sections are named, in the reference's own prose.
  for (const s of ['Purpose', 'Users', 'How it works', 'Success', 'Failure', 'Non-goals', 'Open questions']) {
    assert.ok(t.includes(s), `section "${s}" must be named`);
  }
  // A section that cannot be answered goes under Open questions — the
  // kit's couldNotDerive discipline, landed in a human document.
  assert.match(t, /open\s+questions[^.]{0,200}\b(rather|instead|not)\b[^.]{0,80}\bguess/i,
    'unanswerable sections go under Open questions rather than a guess');
});

test('the intent step has no template — a templated statement of purpose is a guess', () => {
  const t = ref('phase-3-intent.md');
  assert.doesNotMatch(t, /INTENT\.md\.tmpl/);
  assert.match(t, /no\s+(starting\s+)?template/i);
});

test('the rules step never invents an enforcer: enforced-by is none unless a real one was found and named', () => {
  const t = ref('phase-3-intent.md');
  assert.match(t, /never\s+invent[^.]*enforcer/i);
  assert.match(t, /enforced-by:\s*none/i);
  assert.match(t, /generated\s+EMPTY/i, 'the scaffold is generated empty, and the reference says so');
});

test('every phase-3 prompt-gated step names its gate with a wait/stop', () => {
  const hits = (ref('phase-3-intent.md').match(/\bgate\b[\s\S]{0,200}?\b(wait|stop)\b/gi) ?? []).length;
  assert.ok(hits >= 2, `phase-3-intent.md pairs "gate" with wait/stop ${hits} times; it owns 2 prompt-gated steps (26, 27's fill)`);
});
