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
import { fileURLToPath } from 'node:url';
import { listFiles } from './scan.mjs';
import { detectHarness } from './detect-harness.mjs';
import { intentEvidence, INTENT_PATH, INTENT_SECTIONS } from './intent-evidence.mjs';
import { rulesRegistryEvidence } from './rules-evidence.mjs';
import { RULES_PATH } from '../../assets/scripts/harness-redact.mjs';

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
