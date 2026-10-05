import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const readme = () => readFileSync(join(ROOT, 'README.md'), 'utf8');

test('README documents the install path that actually works', () => {
  const t = readme();

  // Pinned verbatim because the leading `./` is load-bearing: Claude Code
  // rejects `marketplace add .` with "Invalid marketplace source format",
  // measured, and `./` is the only accepted spelling. Tidying the `./` away
  // looks like a harmless cleanup and silently breaks the documented install.
  // Prose elsewhere in this repo is matched loosely on purpose; a command is
  // matched exactly, because here the exact characters ARE the fact.
  assert.match(t, /claude plugin marketplace add \.\/(?=\s|$)/,
    'the README must show `marketplace add ./` — bare `.` is rejected by Claude Code');
  assert.match(t, /claude plugin install kh-harness@kh-harness-local/,
    'the install command needs the marketplace-qualified name to resolve');

  // The skill is the front door, so the README has to name it.
  assert.match(t, /\/harness-init/);

  // This claim shipped once and was false: apply already worked when the
  // README said it did not. An honest README is the whole premise of this
  // tool, so the regression gets a test rather than a memory.
  assert.doesNotMatch(t, /cannot yet apply anything/i,
    'the README understated what apply does once already; it must not return');
});

test('README warns that apply can install code-executing hooks', () => {
  // apply writes hooks that run lint/typecheck/test on edits and turn ends.
  // Someone running `apply --yes` on a repo they do not own should not learn
  // that from the diff afterwards.
  const t = readme();
  assert.match(t, /apply --yes/,
    'the flag that skips the prompt must be named where its effect is explained');
  assert.match(t, /hooks/i);
});

test('the plugin ships the skill and declares no hooks', () => {
  // The line and byte budgets live in skill-links.test.mjs, which every
  // change to the skill is already held to. They are deliberately not
  // repeated here: two places asserting one budget drift apart, and the copy
  // that is wrong is always the copy nobody is reading.
  const m = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));

  // Not an omission. Plugin hooks merge with no deduplication, and the only
  // documented off switch (disableAllHooks) is global — so a plugin-declared
  // hook beside an apply-installed one double-fires with no per-plugin way to
  // stop it. apply owns hook installation; the plugin ships the skill alone.
  assert.equal(m.hooks, undefined,
    'declaring hooks here would double-fire against the ones apply installs');

  // The manifest declares no `skills` key: a declared component path must
  // exist or `validate --strict` exits 1 (measured). Convention scans
  // skills/, so this path on disk is the contract.
  assert.equal(m.skills, undefined,
    'the skill is found by convention; declaring the path adds a way to break validate');
  assert.ok(existsSync(join(ROOT, 'skills', 'harness-init', 'SKILL.md')),
    'convention-based discovery means this exact path is what makes the skill load');
});
