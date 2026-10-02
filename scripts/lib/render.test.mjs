import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, versionStamp } from './render.mjs';

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
  assert.match(s, /harness-kit 0\.2\.0/);
  assert.match(s, /step 16/);
  assert.ok(s.startsWith('#'));
});
