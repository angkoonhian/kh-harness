import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyManifest, readManifest, sha256 } from './manifest.mjs';
import { assertAllowed, applyProposals, renderDiff } from './apply-lib.mjs';

const repo = () => mkdtempSync(join(tmpdir(), 'hk-apply-'));
const fileProposal = (o = {}) => ({ kind: 'file', path: 'HANDOFF.md', step: 16, contents: 'hello\n', checkId: 'P4.handoff', reason: 'r', ...o });

test('the allowlist admits the kit\'s own paths', () => {
  for (const p of ['CLAUDE.md', 'HANDOFF.md', 'docs/ARCHITECTURE.md', 'docs/harness/x.json', '.claude/settings.json', 'scripts/bootstrap.sh']) {
    assert.doesNotThrow(() => assertAllowed(p), p);
  }
});

test('the allowlist REFUSES anything else', () => {
  for (const p of ['src/index.ts', 'package.json', '../escape.md', '/etc/passwd', 'docs/README.md', '.git/config']) {
    assert.throws(() => assertAllowed(p), /not allowed/i, p);
  }
});

test('writes a proposed file and records it in the manifest', () => {
  const d = repo();
  const { manifest } = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'hello\n');
  assert.equal(manifest.files[0].sha256, sha256('hello\n'));
});

test('REFUSES to overwrite a file it did not write', () => {
  const d = repo();
  writeFileSync(join(d, 'HANDOFF.md'), 'user content\n');
  const r = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'user content\n', 'must not overwrite');
  assert.equal(r.written.length, 0);
  assert.equal(r.skipped.length, 1);
});

test('REFUSES to overwrite a file the user edited after we wrote it', () => {
  const d = repo();
  const m = emptyManifest('0.2.0');
  const r1 = applyProposals({ root: d, proposals: [fileProposal()], manifest: m, kitVersion: '0.2.0' });
  writeFileSync(join(d, 'HANDOFF.md'), 'edited by user\n');
  const r2 = applyProposals({ root: d, proposals: [fileProposal({ contents: 'new\n' })], manifest: r1.manifest, kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'edited by user\n');
  assert.equal(r2.skipped[0].why, 'ours-modified');
});

test('a settings-hook proposal merges and records a hash-identified patch', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  const p = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const { manifest } = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions, { deny: ['Edit(x)'] }, 'unrelated settings survive');
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.match(manifest.settingsPatches[0].entrySha256, /^[0-9a-f]{64}$/);
});

test('applying twice is a no-op', () => {
  const d = repo();
  const r1 = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const r2 = applyProposals({ root: d, proposals: [fileProposal()], manifest: r1.manifest, kitVersion: '0.2.0' });
  assert.equal(r2.written.length, 0);
  assert.equal(r1.manifest.files.length, 1);
});

test('renderDiff shows added lines for a new file', () => {
  const diff = renderDiff(repo(), fileProposal());
  assert.match(diff, /^\+hello$/m);
});

test('a proposal targeting a disallowed path throws before anything is written', () => {
  const d = repo();
  assert.throws(() => applyProposals({ root: d, proposals: [fileProposal({ path: 'src/evil.ts' })], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(existsSync(join(d, 'src/evil.ts')), false);
});
