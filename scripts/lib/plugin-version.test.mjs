// scripts/lib/plugin-version.test.mjs
//
// Audit Tier 4: nothing tied the plugin manifest's version to the package's.
// The kit stamps every generated file with package.json's version and the
// plugin registry reads plugin.json's; two numbers for one release is how a
// user is told they run a version that was never published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

test('plugin.json and package.json carry the same version', () => {
  const pkg = read('package.json');
  const plugin = read('.claude-plugin/plugin.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'package.json carries a semver version');
  assert.equal(plugin.version, pkg.version, 'bump both, or the stamps and the registry disagree about what shipped');
});
