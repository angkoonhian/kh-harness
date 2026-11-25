// scripts/lib/extensions-evidence.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extensionsEvidence } from './extensions-evidence.mjs';
import { EXTENSIONS_PATH, moduleSha256 } from '../../assets/scripts/harness-extensions.mjs';

const made = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-ext-evidence-'));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function write(d, rel, text) {
  mkdirSync(join(d, rel, '..'), { recursive: true });
  writeFileSync(join(d, rel), text);
}

const entry = (id, onFailure, source) => ({ id, version: '1.0.0', module: `.claude/ext/${id}.mjs`, sha256: moduleSha256(Buffer.from(source)), onFailure });

test('no file is absent, a bad file is malformed with the loader\'s own problem text', () => {
  const d = tempDir();
  assert.deepEqual(extensionsEvidence(d), { state: 'absent' });
  write(d, EXTENSIONS_PATH, '[ not json');
  assert.deepEqual(extensionsEvidence(d), { state: 'malformed', problem: 'it is not JSON' });
});

test('each extension is listed with its hash state, and its recorded sha256 is not', () => {
  const d = tempDir();
  const source = 'export const preToolUse = () => ({ decision: \'allow\' });\n';
  const entries = [entry('a', 'block', source), entry('b', 'allow', source), entry('c', 'block', source)];
  write(d, '.claude/ext/a.mjs', source);
  write(d, '.claude/ext/b.mjs', `${source}// changed after hashing\n`);
  write(d, EXTENSIONS_PATH, JSON.stringify(entries));
  assert.deepEqual(extensionsEvidence(d), { state: 'ok', extensions: [
    { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', onFailure: 'block', hash: 'matches' },
    { id: 'b', version: '1.0.0', module: '.claude/ext/b.mjs', onFailure: 'allow', hash: 'differs' },
    { id: 'c', version: '1.0.0', module: '.claude/ext/c.mjs', onFailure: 'block', hash: 'missing' },
  ] });
});

test('listing an extension does not load it', () => {
  const d = tempDir();
  const marker = join(d, 'loaded');
  const source = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '');\nexport const preToolUse = () => ({ decision: 'allow' });\n`;
  write(d, '.claude/ext/a.mjs', source);
  write(d, EXTENSIONS_PATH, JSON.stringify([entry('a', 'block', source)]));
  assert.equal(extensionsEvidence(d).extensions[0].hash, 'matches');
  assert.equal(existsSync(marker), false, 'the module was imported');
});
