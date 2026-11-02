// scripts/lib/intent-evidence.test.mjs
//
// P3.intent measures the SHAPE of docs/INTENT.md — which of the required
// sections are present — never the quality of the prose. These tests pin
// the section matcher and the file-backed evidence function it feeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTENT_PATH, INTENT_SECTIONS, intentSections, intentEvidence } from './intent-evidence.mjs';

const FULL = [
  '# Intent',
  '',
  '- last-reviewed: 2026-11-02',
  '',
  '## Purpose', 'p',
  '## Users', 'u',
  '## How it works', 'h',
  '## Success', 's',
  '## Failure', 'f',
  '## Non-goals', 'n',
  '## Open questions', 'o',
  '',
].join('\n');

test('INTENT_PATH and the seven canonical sections', () => {
  assert.equal(INTENT_PATH, 'docs/INTENT.md');
  assert.deepEqual(INTENT_SECTIONS, ['Purpose', 'Users', 'How it works', 'Success', 'Failure', 'Non-goals', 'Open questions']);
});

test('all seven canonical headings are found, none missing', () => {
  const r = intentSections(FULL);
  assert.deepEqual(r.found, INTENT_SECTIONS);
  assert.deepEqual(r.missing, []);
});

test('aliases count as present: Behaviour / Behavior for How it works; Users and non-users; Non-Goals; Open Questions', () => {
  const text = [
    '## purpose', '## Users and non-users', '## Behavior', '## Success criteria',
    '## Failure modes', '## Non-Goals', '## Open Questions',
  ].join('\n');
  const r = intentSections(text);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.found, INTENT_SECTIONS, 'found names are the canonical spellings, whatever alias matched');
  assert.deepEqual(intentSections('## Behaviour').found, ['How it works']);
});

test('a level-3 heading does not count', () => {
  const r = intentSections('### Purpose\n### Users\n');
  assert.deepEqual(r.found, []);
  assert.equal(r.missing.length, 7);
});

test('a heading inside an HTML comment or a fenced code block does not count', () => {
  const text = '<!--\n## Purpose\n-->\n```md\n## Users\n```\n## Success\n';
  const r = intentSections(text);
  assert.deepEqual(r.found, ['Success']);
});

test('missing sections are named in canonical order', () => {
  const r = intentSections('## Open questions\n## Purpose\n## Success\n');
  assert.deepEqual(r.missing, ['Users', 'How it works', 'Failure', 'Non-goals']);
  assert.deepEqual(r.found, ['Purpose', 'Success', 'Open questions'], 'found is reported in canonical order, not document order');
});

test('last-reviewed is read when present as a YYYY-MM-DD bullet, else null', () => {
  assert.equal(intentSections(FULL).lastReviewed, '2026-11-02');
  assert.equal(intentSections('## Purpose\n').lastReviewed, null);
  assert.equal(intentSections('- last-reviewed: soon\n## Purpose\n').lastReviewed, null);
  assert.equal(intentSections('- last_reviewed: 2026-01-31\n').lastReviewed, '2026-01-31');
});

test('empty or non-string text yields nothing found and everything missing', () => {
  for (const t of ['', null, undefined]) {
    const r = intentSections(t);
    assert.deepEqual(r.found, []);
    assert.deepEqual(r.missing, INTENT_SECTIONS);
    assert.equal(r.lastReviewed, null);
  }
});

test('intentEvidence returns null when docs/INTENT.md is absent', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-intent-'));
  assert.equal(intentEvidence(d), null);
});

test('intentEvidence reads the file and reports path, found, missing and lastReviewed', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-intent-'));
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, INTENT_PATH), '## Purpose\n## Failure\n');
  const r = intentEvidence(d);
  assert.equal(r.path, INTENT_PATH);
  assert.deepEqual(r.found, ['Purpose', 'Failure']);
  assert.deepEqual(r.missing, ['Users', 'How it works', 'Success', 'Non-goals', 'Open questions']);
  assert.equal(r.lastReviewed, null);
});
