import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'session-brief.mjs');
const run = cwd => execFileSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

test('prints the handoff contents when present', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-brief-'));
  writeFileSync(join(d, 'HANDOFF.md'), '## Where I stopped\nMid-refactor of the parser.\n');
  assert.match(run(d), /Mid-refactor of the parser/);
});

test('says so plainly when there is no handoff, and still exits 0', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-brief-'));
  const out = run(d);
  assert.match(out, /no HANDOFF\.md/i);
});

test('truncates a very long handoff rather than flooding the session', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-brief-'));
  writeFileSync(join(d, 'HANDOFF.md'), Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
  const out = run(d);
  assert.ok(out.split('\n').length < 80, 'a brief that floods the context defeats its own purpose');
  assert.match(out, /truncated/i);
  // Verify actual handoff content survived truncation at the boundary
  assert.match(out, /line 0/);
  assert.match(out, /line 59/);
  assert.doesNotMatch(out, /line 60\b/);
});
