import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile } from './read-json.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'hk-readjson-'));

test('an absent file is absent', () => {
  assert.deepEqual(readJsonFile(join(dir(), 'settings.json')), { state: 'absent' });
});

test('a file under a path whose parent is a plain file is absent, not unreadable', () => {
  const d = dir();
  writeFileSync(join(d, '.claude'), 'not a directory');
  assert.deepEqual(readJsonFile(join(d, '.claude', 'settings.json')), { state: 'absent' });
});

test('a settings.json with a BOM is read', () => {
  const d = dir();
  const text = '﻿{"permissions":{"deny":["Edit(x)"]}}\n';
  writeFileSync(join(d, 'settings.json'), text, 'utf8');
  const r = readJsonFile(join(d, 'settings.json'));
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.value, { permissions: { deny: ['Edit(x)'] } });
  assert.equal(r.text, text, 'the text is returned exactly as read, BOM included, so a writer can keep it');
});

test('only one leading BOM is stripped', () => {
  const d = dir();
  writeFileSync(join(d, 'settings.json'), '﻿﻿{}', 'utf8');
  assert.equal(readJsonFile(join(d, 'settings.json')).state, 'unreadable');
});

test('a syntax error is unreadable, and the reason quotes nothing from the file', () => {
  const d = dir();
  const secret = ['sk', 'live', 'abcdef0123456789'].join('_');
  writeFileSync(join(d, 'settings.json'), `{ "env": { "KEY": "${secret}" }, }`);
  const r = readJsonFile(join(d, 'settings.json'));
  assert.deepEqual(r, { state: 'unreadable', reason: 'is not valid JSON' });
});

test('a directory where the file should be is unreadable, with the error code as the reason', () => {
  const d = dir();
  mkdirSync(join(d, 'settings.json'));
  const r = readJsonFile(join(d, 'settings.json'));
  assert.equal(r.state, 'unreadable');
  assert.match(r.reason, /^could not be read \(E[A-Z]+\)$/);
});

test('valid JSON of any type is ok; judging its shape is the caller\'s job', () => {
  const d = dir();
  writeFileSync(join(d, 'a.json'), '[1,2]');
  assert.deepEqual(readJsonFile(join(d, 'a.json')).value, [1, 2]);
});
