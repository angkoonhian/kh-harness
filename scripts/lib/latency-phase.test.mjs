// scripts/lib/latency-phase.test.mjs
//
// `npm test` runs every test file at once and then, alone and one file at a
// time, the tests named `latency budget: …`, whose wall times mean nothing
// while the rest of the suite runs beside them. A latency test in a file the
// second run does not name would be skipped by the first and never run, so
// the two lists are held equal here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const KIT = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'latency budget: ';

/** Every `*.test.mjs` under scripts/lib, relative to the kit, forward slashes. */
function testFiles(dir = join(KIT, 'scripts', 'lib')) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith('.test.mjs') ? [relative(KIT, path).replace(/\\/g, '/')] : [];
  });
}

test('npm test runs the latency tests alone, after the rest, and names every file that holds one', () => {
  const script = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).scripts.test;
  const [everything, alone, ...rest] = script.split(' && ');
  assert.deepEqual(rest, [], script);
  assert.ok(everything.includes(`--test-skip-pattern="^${PREFIX}"`), `the first run leaves the latency tests out: ${everything}`);
  assert.ok(alone.includes('--test-concurrency=1') && alone.includes(`--test-name-pattern="^${PREFIX}"`), `the second runs only them, one file at a time: ${alone}`);
  const named = alone.split(' ').filter(word => word.endsWith('.test.mjs')).sort();
  const holding = testFiles().filter(file => readFileSync(join(KIT, file), 'utf8').includes(`test('${PREFIX}`)).sort();
  assert.ok(holding.length > 0, 'fixture sanity: the latency tests are found');
  assert.deepEqual(named, holding);
});
