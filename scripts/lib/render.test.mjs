import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carriesStamp, machineryStamp, render, stampVersion, STAMP_MARKER, versionStamp } from './render.mjs';

test('substitutes named placeholders', () => {
  assert.equal(render('a {{x}} c', { x: 'b' }), 'a b c');
});

test('substitutes every occurrence', () => {
  assert.equal(render('{{x}}-{{x}}', { x: '1' }), '1-1');
});

test('throws on a placeholder with no value — never silently leaves it', () => {
  assert.throws(() => render('a {{missing}}', {}), /missing/);
});

test('leaves non-placeholder braces alone', () => {
  assert.equal(render('{ "a": 1 }', {}), '{ "a": 1 }');
});

test('versionStamp names the kit version and the step', () => {
  const s = versionStamp('0.2.0', 16, '#');
  assert.match(s, /kh-harness 0\.2\.0/);
  assert.match(s, /step 16/);
  assert.ok(s.startsWith('#'));
});

test('machineryStamp carries the marker and the version, names what the file is, and says an edit stops updates', () => {
  const s = machineryStamp('0.2.0', 'runbook step 9', '//');
  assert.ok(s.startsWith(`// ${STAMP_MARKER} 0.2.0 (runbook step 9). `));
  assert.match(s, /Do not edit/);
  assert.match(s, /an edit stops its hook scripts being updated, and the integrity check reports it\.$/);
  assert.doesNotMatch(s, /Edit freely/);
});

test('stampVersion reads the version either stamp names, and nothing that is not version-shaped', () => {
  assert.equal(stampVersion(`#!/usr/bin/env node\n${machineryStamp('0.2.0', 'runbook step 9', '//')}\n`), '0.2.0');
  assert.equal(stampVersion(`${versionStamp('0.1.0', 16, '<!--')} -->\n# Handoff\n`), '0.1.0');
  assert.equal(stampVersion(`// ${STAMP_MARKER} 1.0.0-rc.1 (shared asset).\n`), '1.0.0-rc.1');
  assert.equal(stampVersion('# my own file\n'), null);
  assert.equal(stampVersion(`// ${STAMP_MARKER} \u001b[31mred (x)\n`), null, 'text after the marker that is not a version is not printed back');
});

test('carriesStamp is true only of a readable file that holds the marker', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-render-'));
  writeFileSync(join(d, 'ours.md'), `${versionStamp('0.2.0', 16, '<!--')} -->\n`);
  writeFileSync(join(d, 'theirs.md'), '# mine\n');
  mkdirSync(join(d, 'dir'));
  assert.equal(carriesStamp(d, 'ours.md'), true);
  assert.equal(carriesStamp(d, 'theirs.md'), false);
  assert.equal(carriesStamp(d, 'dir'), false);
  assert.equal(carriesStamp(d, 'missing.md'), false);
});
