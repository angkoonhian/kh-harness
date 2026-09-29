import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyManifest, MANIFEST_PATH } from './manifest.mjs';
import { applyProposals } from './apply-lib.mjs';
import { planUninstall, runUninstall } from './uninstall-lib.mjs';

const repo = () => mkdtempSync(join(tmpdir(), 'hk-uninst-'));
const fileProposal = (o = {}) => ({ kind: 'file', path: 'HANDOFF.md', step: 16, contents: 'hello\n', checkId: 'P4.handoff', reason: 'r', ...o });
const hookProposal = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };

function installed(proposals = [fileProposal()]) {
  const d = repo();
  const r = applyProposals({ root: d, proposals, manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  return { d, manifest: r.manifest };
}

test('removes a file we wrote that nobody touched', () => {
  const { d, manifest } = installed();
  const plan = planUninstall({ root: d, manifest });
  assert.deepEqual(plan.remove.map(r => r.path), ['HANDOFF.md']);
  runUninstall({ root: d, manifest, plan });
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false);
});

test('keeps a file the user edited and says why', () => {
  const { d, manifest } = installed();
  writeFileSync(join(d, 'HANDOFF.md'), 'mine now\n');
  const plan = planUninstall({ root: d, manifest });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.keep[0].path, 'HANDOFF.md');
  assert.equal(plan.keep[0].why, 'ours-modified');
  runUninstall({ root: d, manifest, plan });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'mine now\n');
});

test('a file the user already deleted is reported, not an error', () => {
  const { d, manifest } = installed();
  rmSync(join(d, 'HANDOFF.md'));
  const plan = planUninstall({ root: d, manifest });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.keep[0].why, 'ours-modified');
  assert.doesNotThrow(() => runUninstall({ root: d, manifest, plan }));
});

test('reverts an untouched settings patch and leaves unrelated settings', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.revert.length, 1);
  runUninstall({ root: d, manifest, plan });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.equal(s.hooks, undefined, 'our hook is gone');
  assert.deepEqual(s.permissions, { deny: ['Edit(x)'] }, 'their settings survive');
});

test('keeps a settings patch the user edited', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), '{}');
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  s.hooks.SessionStart[0].hooks[0].command = 'node edited.mjs';
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));
  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.revert.length, 0);
  assert.equal(plan.keepPatches.length, 1);
  runUninstall({ root: d, manifest, plan });
  const after = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.equal(after.hooks.SessionStart[0].hooks[0].command, 'node edited.mjs');
});

test('removes the manifest only when nothing was kept', () => {
  const a = installed();
  runUninstall({ root: a.d, manifest: a.manifest, plan: planUninstall({ root: a.d, manifest: a.manifest }) });
  assert.equal(existsSync(join(a.d, MANIFEST_PATH)), false);

  const b = installed();
  writeFileSync(join(b.d, 'HANDOFF.md'), 'kept\n');
  runUninstall({ root: b.d, manifest: b.manifest, plan: planUninstall({ root: b.d, manifest: b.manifest }) });
  assert.equal(existsSync(join(b.d, MANIFEST_PATH)), true, 'still tracking what we left behind');
});

test('planUninstall writes nothing', () => {
  const { d, manifest } = installed();
  planUninstall({ root: d, manifest });
  assert.equal(existsSync(join(d, 'HANDOFF.md')), true, 'planning is read-only');
});
