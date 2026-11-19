// scripts/lib/plugin-version.test.mjs
//
// Audit Tier 4: nothing tied the plugin manifest's version to the package's.
// The kit stamps every generated file with package.json's version and the
// plugin registry reads plugin.json's; two numbers for one release is how a
// user is told they run a version that was never published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const read = rel => JSON.parse(text(rel));

test('plugin.json and package.json carry the same version', () => {
  const pkg = read('package.json');
  const plugin = read('.claude-plugin/plugin.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'package.json carries a semver version');
  assert.equal(plugin.version, pkg.version, 'bump both, or the stamps and the registry disagree about what shipped');
});

test('every version string agrees: the manifests and the latest CHANGELOG release', () => {
  const { version } = read('package.json');
  const marketplace = read('.claude-plugin/marketplace.json');
  for (const plugin of marketplace.plugins) {
    if (plugin.version !== undefined) assert.equal(plugin.version, version, `marketplace.json's ${plugin.name} entry`);
  }
  const latest = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/m.exec(text('CHANGELOG.md'));
  assert.ok(latest, 'CHANGELOG.md has a release heading in Keep a Changelog form');
  assert.equal(latest[1], version, 'the latest release in CHANGELOG.md is the version package.json carries');
  const badges = [...text('README.md').matchAll(/img\.shields\.io\/badge\/version-([^-]+)-/g)].map(m => m[1]);
  assert.deepEqual(badges, [version], "the README's version badge is the version package.json carries");
});
