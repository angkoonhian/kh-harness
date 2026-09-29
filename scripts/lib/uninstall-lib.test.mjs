import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
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
  const contentBefore = readFileSync(join(d, 'HANDOFF.md'), 'utf8');
  planUninstall({ root: d, manifest });
  assert.equal(existsSync(join(d, 'HANDOFF.md')), true, 'file still exists');
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), contentBefore, 'file content unchanged');
  assert.equal(existsSync(join(d, MANIFEST_PATH)), false, 'manifest untouched (was never written by applyProposals)');
});

test('settings deleted between plan and run records patches as kept (C1a)', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  const hookProposal = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });

  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.revert.length, 1, 'has a patch to revert');

  // Delete settings file between plan and run
  rmSync(join(d, '.claude/settings.json'));

  const result = runUninstall({ root: d, manifest, plan });
  assert.equal(result.settingsReadFailed, true);
  assert.equal(result.patchesNotReverted.length, 1, 'patch recorded as not reverted');

  // Verify manifest records the patch with reason
  const manifestAfter = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.equal(manifestAfter.settingsPatches.length, 1);
  assert.equal(manifestAfter.settingsPatches[0].why, 'settings-unreadable');
});

test('settings write fails after file removal records file as removed (C1c)', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const fileProposal = { kind: 'file', path: 'HANDOFF.md', step: 16, contents: 'hello\n', checkId: 'P4.handoff', reason: 'r' };
  const hookProposal = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };

  const { manifest } = applyProposals({ root: d, proposals: [fileProposal, hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });

  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.remove.length, 1, 'has file to remove');
  assert.equal(plan.revert.length, 1, 'has patch to revert');

  // Make settings read-only so write will fail after file is removed
  const settingsPath = join(d, '.claude/settings.json');
  writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  chmodSync(settingsPath, 0o444);

  const result = runUninstall({ root: d, manifest, plan });

  // Restore permissions for cleanup
  chmodSync(settingsPath, 0o644);

  assert.equal(result.removed.length, 1, 'file was removed');
  assert.equal(result.settingsWriteFailed, true, 'settings write failed');
  assert.equal(result.patchesNotReverted.length, 1, 'patch recorded as not reverted');

  // Verify manifest records that the file was removed
  const manifestAfter = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.equal(manifestAfter.files.length, 0, 'file not in manifest (was successfully removed)');
  assert.equal(manifestAfter.settingsPatches.length, 1, 'patch in manifest (write failed)');
  assert.equal(manifestAfter.settingsPatches[0].why, 'settings-write-failed');
});
