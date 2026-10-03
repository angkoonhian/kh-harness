import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { PROFILE_IDS } from './profiles/index.mjs';

const PROF = resolve(import.meta.dirname, '..', '..', 'skills', 'harness-init', 'references', 'profiles');

test('LOAD-BEARING: every profile the detector can select has a reference', () => {
  const missing = PROFILE_IDS
    .filter(id => id !== 'generic')               // the fallback; phase-1 covers it inline
    .filter(id => !existsSync(join(PROF, `${id}.md`)));
  assert.deepEqual(missing, [], 'a selectable profile with no reference leaves the model guessing');
});

test('no reference describes a profile that does not exist', () => {
  const ids = new Set(PROFILE_IDS);
  const stray = readdirSync(PROF).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''))
    .filter(id => !ids.has(id));
  assert.deepEqual(stray, [], 'a reference for a removed profile is worse than none');
});

test('each profile reference states what the profile will NOT claim', () => {
  for (const f of ['typescript-single.md', 'python.md']) {
    const t = readFileSync(join(PROF, f), 'utf8');
    assert.match(t, /never|not derive|cannot derive|no opinion/i,
      `${f} must say what the profile declines to assert — a profile that claims layout is a guess`);
  }
});
