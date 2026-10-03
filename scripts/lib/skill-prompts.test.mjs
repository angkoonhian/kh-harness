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
  assert.match(t, /never (write|overwrite|replace)[^.]*CLAUDE\.md[^.]*in place/i);
  assert.doesNotMatch(t, /write\s+(the\s+)?CLAUDE\.md\s+(file\s+)?directly/i);
});

test('the recon step writes to docs/harness/recon.md and reads detect.json first', () => {
  const t = ref('phase-0-recon.md');
  assert.match(t, /docs\/harness\/recon\.md/);
  assert.match(t, /detect\.json/);
});

test('the architecture step derives from this repository, not from a template', () => {
  const t = ref('phase-1-legible.md');
  assert.match(t, /docs\/ARCHITECTURE\.md/);
  assert.doesNotMatch(t, /ARCHITECTURE\.md\.tmpl/,
    'there is deliberately no template: a templated architecture document is a guess');
});

test('every prompt-gated step names its gate', () => {
  for (const [file, count] of [['phase-0-recon.md', 1], ['phase-1-legible.md', 2]]) {
    const hits = (ref(file).match(/\bgate\b/gi) ?? []).length;
    assert.ok(hits >= count, `${file} mentions a gate ${hits} times; it owns ${count} prompt-gated step(s)`);
  }
});

test('the credential rule is stated where recon will meet credentials', () => {
  const t = ref('phase-0-recon.md');
  assert.match(t, /never[^.]*value/i, 'spec §6: report location and type, never the value');
});
