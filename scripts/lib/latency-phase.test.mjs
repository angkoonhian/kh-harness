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

// The first Node release with each test-runner flag the script may use, from
// Node's own CLI documentation (nodejs.org/docs/latest-v22.x/api/cli.html,
// read on 2026-11-20). A flag missing here fails the test below until its
// release is looked up and added.
const FLAG_SINCE = {
  '--test-concurrency': '18.19.0',
  '--test-name-pattern': '18.11.0',
  '--test-skip-pattern': '22.1.0',
};

const versionOf = text => text.split('.').map(Number);
const atLeast = (a, b) => {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
};

test('the README states the Node release npm test needs, which the script\'s flags need and the kit\'s own floor does not exceed', () => {
  const pkg = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8'));
  const floor = /^>=(\d+)$/.exec(pkg.engines.node);
  assert.ok(floor, `engines.node is a plain floor: ${pkg.engines.node}`);
  const kitFloor = `${floor[1]}.0.0`;
  const stated = /\*\*`npm test` needs Node (\d+\.\d+) or later\*\*/.exec(readFileSync(join(KIT, 'README.md'), 'utf8'));
  assert.ok(stated, 'the README says which Node release npm test needs');
  const testFloor = `${stated[1]}.0`;
  const flags = [...new Set(pkg.scripts.test.match(/--test-[a-z-]+/g))];
  for (const flag of flags) {
    assert.ok(flag in FLAG_SINCE, `${flag}: look up the release that added it and add it to FLAG_SINCE`);
  }
  const needed = flags.map(flag => FLAG_SINCE[flag]).reduce((a, b) => (atLeast(a, b) ? a : b), kitFloor);
  assert.equal(testFloor, needed, `npm test uses ${flags.join(', ')}, which need Node ${needed}; the README says ${testFloor}`);
  assert.ok(atLeast(testFloor, kitFloor), 'npm test cannot need less than the kit itself');
});
