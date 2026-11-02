// scripts/lib/protected-evidence.test.mjs
//
// Audit Tier 2, finding 13. `P2.protected` compared a user's deny rules to
// ours by exact string, so `Edit(package-lock.json)` was reported as
// "unrelated" and `Edit(*-lock.json)` proposed on top of it. Coverage is
// decided by what the globs MATCH in the repository's own file list, with
// the same matcher (`globToRegExp`) the evidence filter already uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denyRuleCoverage } from './protected-evidence.mjs';

const files = ['package.json', 'package-lock.json', 'dist/index.js', 'src/index.ts'];
const candidates = ['*-lock.json', 'dist/**'];

test('denyRuleCoverage: a user rule naming the lockfile covers the *-lock.json candidate', () => {
  const r = denyRuleCoverage({ candidates, denyRuleList: ['Edit(package-lock.json)'], files });
  assert.deepEqual(r.covered, [{ glob: '*-lock.json', by: ['Edit(package-lock.json)'] }]);
  assert.deepEqual(r.uncovered, ['dist/**']);
  assert.deepEqual(r.unrelated, []);
});

test('denyRuleCoverage: our own exact rule covers, as before', () => {
  const r = denyRuleCoverage({ candidates, denyRuleList: ['Edit(*-lock.json)', 'Edit(dist/**)'], files });
  assert.deepEqual(r.uncovered, []);
  assert.deepEqual(r.covered.map(c => c.glob), candidates);
});

test('denyRuleCoverage: a leading slash on the user rule is project-relative', () => {
  const r = denyRuleCoverage({ candidates, denyRuleList: ['Edit(/package-lock.json)'], files });
  assert.deepEqual(r.covered.map(c => c.glob), ['*-lock.json']);
});

test('denyRuleCoverage: a rule must cover EVERY file the candidate matches', () => {
  const r = denyRuleCoverage({ candidates, denyRuleList: ['Edit(dist/index.js)'], files: [...files, 'dist/vendor.js'] });
  assert.deepEqual(r.uncovered, candidates, 'dist/vendor.js is still editable');
  assert.deepEqual(r.unrelated, [], 'the rule protects one of our files, so it is related, just insufficient');
});

test('denyRuleCoverage: a Read(...) rule never covers an edit, and a rule covering none of our files is unrelated', () => {
  const r = denyRuleCoverage({ candidates, denyRuleList: ['Read(package-lock.json)', 'Edit(secrets/**)', null], files });
  assert.deepEqual(r.covered, []);
  assert.deepEqual(r.unrelated, ['Read(package-lock.json)', 'Edit(secrets/**)'], 'a redacted (null) rule is neither');
});

// Tier 2 final review, Minor 3: Claude Code's path forms. A bare pattern or
// `./pattern` is project-relative, so is one `/`; `//pattern` is an absolute
// filesystem path and `~/pattern` is under the home directory — neither can
// be related to a project path, so neither ever covers.
test('denyRuleCoverage: ./ and one leading / are project-relative; // and ~/ never cover', () => {
  assert.deepEqual(denyRuleCoverage({ candidates, denyRuleList: ['Edit(./package-lock.json)'], files }).covered.map(c => c.glob), ['*-lock.json']);
  assert.deepEqual(denyRuleCoverage({ candidates, denyRuleList: ['Edit(/package-lock.json)'], files }).covered.map(c => c.glob), ['*-lock.json']);
  const abs = denyRuleCoverage({ candidates, denyRuleList: ['Edit(//package-lock.json)', 'Edit(~/package-lock.json)'], files });
  assert.deepEqual(abs.covered, [], 'an absolute or home path is not this project\'s lockfile');
  assert.deepEqual(abs.unrelated, ['Edit(//package-lock.json)', 'Edit(~/package-lock.json)']);
});
