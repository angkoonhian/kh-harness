import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles } from './scan.mjs';
import { detectHarness } from './detect-harness.mjs';

function write(d, rel, content) {
  const p = join(d, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function repo() { return mkdtempSync(join(tmpdir(), 'hk-harness-')); }
function run(d) { return detectHarness(d, listFiles(d).files); }

test('bare repository reports nothing present', () => {
  const d = repo();
  write(d, 'README.md', '# x');
  const h = run(d);
  assert.equal(h.instructions.path, null);
  assert.equal(h.instructions.lines, 0);
  assert.equal(h.architecture, null);
  assert.equal(h.bootstrap, null);
  assert.deepEqual(h.claudeDir.agents, []);
});

test('counts instruction file lines', () => {
  const d = repo();
  write(d, 'CLAUDE.md', 'a\nb\nc\n');
  const h = run(d);
  assert.equal(h.instructions.path, 'CLAUDE.md');
  assert.equal(h.instructions.lines, 3);
});

test('prefers CLAUDE.md but records AGENTS.md separately', () => {
  const d = repo();
  write(d, 'CLAUDE.md', 'x\n');
  write(d, 'AGENTS.md', 'y\n');
  const h = run(d);
  assert.equal(h.instructions.path, 'CLAUDE.md');
  assert.equal(h.agentsMd, 'AGENTS.md');
});

test('falls back to AGENTS.md as the instruction file', () => {
  const d = repo();
  write(d, 'AGENTS.md', 'y\n');
  assert.equal(run(d).instructions.path, 'AGENTS.md');
});

test('enumerates .claude contents', () => {
  const d = repo();
  write(d, '.claude/settings.json', '{}');
  write(d, '.claude/agents/critic-a.md', '#');
  write(d, '.claude/agents/critic-b.md', '#');
  write(d, '.claude/scripts/hook.mjs', '//');
  write(d, '.claude/rules/api.md', '#');
  const h = run(d);
  assert.equal(h.claudeDir.settings, true);
  assert.equal(h.claudeDir.agents.length, 2);
  assert.equal(h.claudeDir.rules.length, 1);
});

test('finds a bootstrap script under any common name', () => {
  const d = repo();
  write(d, 'scripts/setup.sh', '#!/bin/sh\n');
  assert.equal(run(d).bootstrap, 'scripts/setup.sh');
});

test('detects other editors', () => {
  const d = repo();
  write(d, '.github/copilot-instructions.md', '#');
  write(d, '.cursor/rules/x.mdc', '#');
  const h = run(d);
  assert.ok(h.otherEditors.includes('.github/copilot-instructions.md'));
  assert.ok(h.otherEditors.some(p => p.startsWith('.cursor/rules')));
});
