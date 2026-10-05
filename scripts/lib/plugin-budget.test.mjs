import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

test('README documents installing as a plugin, not detection only', () => {
  const t = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(t, /plugin/i);
  assert.match(t, /harness-init/);
  assert.doesNotMatch(t, /cannot yet apply anything/i,
    'this claim was false once already — a final-review finding');
});

test('the plugin ships the skill and no hooks, as installed', () => {
  // The byte budgets live in Task 2's skill-links.test.mjs, where every task
  // that adds to the skill is held to them as it goes. Do not duplicate them
  // here: two places asserting one budget is the drift shape this project
  // removed five times in Plan 3.
  const m = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(m.hooks, undefined);
  assert.ok(existsSync(join(ROOT, 'skills', 'harness-init', 'SKILL.md')),
    'found by convention rather than declared — see Task 1');
});
