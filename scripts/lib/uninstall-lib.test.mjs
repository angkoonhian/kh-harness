import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, emptyManifest, sha256, writeManifest, MANIFEST_PATH } from './manifest.mjs';
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

// --- C1: uninstall must clear both of the gates apply clears -------------
//
// Each of these two shapes is stopped by exactly one of the two guards, so a
// fix that adds only one of them leaves the other hole wide open.

test('C1: REFUSES to delete a manifest path outside the write allowlist', () => {
  const d = repo();
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src/index.ts'), 'export const x = 1;\n');
  writeFileSync(join(d, 'package.json'), '{"name":"theirs"}\n');

  const manifest = {
    schema: 1, kitVersion: '0.2.0', installedAt: 'now',
    files: [
      { path: 'src/index.ts', sha256: sha256(readFileSync(join(d, 'src/index.ts'))), step: 1 },
      { path: 'package.json', sha256: sha256(readFileSync(join(d, 'package.json'))), step: 1 },
    ],
    settingsPatches: [],
  };

  // Both hashes match, so nothing about the file contents will save them.
  assert.equal(classify(d, manifest, 'src/index.ts'), 'ours-unmodified');
  assert.equal(classify(d, manifest, 'package.json'), 'ours-unmodified');
  // Containment would pass these happily: they resolve inside the repository.
  // Only the allowlist refuses them.

  const plan = planUninstall({ root: d, manifest });
  assert.deepEqual(plan.remove, [], 'nothing outside the allowlist may be scheduled for removal');
  assert.deepEqual(plan.keep, [
    { path: 'src/index.ts', why: 'outside-allowlist' },
    { path: 'package.json', why: 'outside-allowlist' },
  ]);

  // And handed a plan that names them anyway, the run itself still refuses.
  const forced = { remove: [{ path: 'src/index.ts' }, { path: 'package.json' }], keep: [], revert: [], keepPatches: [], gonePatches: [] };
  const result = runUninstall({ root: d, manifest, plan: forced });
  assert.equal(readFileSync(join(d, 'src/index.ts'), 'utf8'), 'export const x = 1;\n');
  assert.equal(readFileSync(join(d, 'package.json'), 'utf8'), '{"name":"theirs"}\n');
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.refused, [
    { path: 'src/index.ts', why: 'outside-allowlist' },
    { path: 'package.json', why: 'outside-allowlist' },
  ]);
});

test('C1: REFUSES to delete through a junction that escapes the repository', () => {
  const d = repo();
  const outside = mkdtempSync(join(tmpdir(), 'hk-uninst-outside-'));
  writeFileSync(join(outside, 'victim.txt'), 'precious\n');
  mkdirSync(join(d, 'docs'), { recursive: true });
  symlinkSync(outside, join(d, 'docs/harness'), 'junction');

  const manifest = {
    schema: 1, kitVersion: '0.2.0', installedAt: 'now',
    files: [{ path: 'docs/harness/victim.txt', sha256: sha256(readFileSync(join(outside, 'victim.txt'))), step: 1 }],
    settingsPatches: [],
  };

  // The contents are unchanged, so the hash still matches, and
  // `docs/harness/` is on the write allowlist. The allowlist alone would let
  // this straight through; only containment refuses it.
  assert.equal(classify(d, manifest, 'docs/harness/victim.txt'), 'ours-unmodified');

  const plan = planUninstall({ root: d, manifest });
  assert.deepEqual(plan.remove, [], 'an allowlisted prefix is not enough when it resolves outside the repository');
  assert.deepEqual(plan.keep, [{ path: 'docs/harness/victim.txt', why: 'escapes-repository' }]);

  const forced = { remove: [{ path: 'docs/harness/victim.txt' }], keep: [], revert: [], keepPatches: [], gonePatches: [] };
  const result = runUninstall({ root: d, manifest, plan: forced });
  assert.equal(existsSync(join(outside, 'victim.txt')), true, 'a file outside the repository must never be deleted');
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.refused, [{ path: 'docs/harness/victim.txt', why: 'escapes-repository' }]);
});

test('C1: a refused entry stays in the manifest rather than vanishing from the record', () => {
  const d = repo();
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src/index.ts'), 'export const x = 1;\n');
  const manifest = {
    schema: 1, kitVersion: '0.2.0', installedAt: 'now',
    files: [{ path: 'src/index.ts', sha256: sha256(readFileSync(join(d, 'src/index.ts'))), step: 1 }],
    settingsPatches: [],
  };
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, MANIFEST_PATH), JSON.stringify(manifest));

  const plan = planUninstall({ root: d, manifest });
  runUninstall({ root: d, manifest, plan });
  const after = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.deepEqual(after.files.map(f => f.path), ['src/index.ts'], 'a refusal is recorded, not forgotten');
});

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

  // Delete .claude directory to cause read/write failure
  // This verifies file removal succeeds even when settings failure occurs
  rmSync(join(d, '.claude'), { recursive: true });

  const result = runUninstall({ root: d, manifest, plan });

  assert.equal(result.removed.length, 1, 'file was removed');
  assert.equal(result.settingsReadFailed, true, 'settings read failed (directory was deleted)');
  assert.equal(result.patchesNotReverted.length, 1, 'patch recorded as not reverted');

  // Verify manifest records that the file was removed
  const manifestAfter = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.equal(manifestAfter.files.length, 0, 'file not in manifest (was successfully removed)');
  assert.equal(manifestAfter.settingsPatches.length, 1, 'patch in manifest (couldn\'t be reverted)');
  assert.equal(manifestAfter.settingsPatches[0].why, 'settings-unreadable');
});

test('settings parse to null (falsy value) are treated as unreadable', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const hookProposal = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });

  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.revert.length, 1);

  // Replace settings with literal null
  writeFileSync(join(d, '.claude/settings.json'), 'null');

  const result = runUninstall({ root: d, manifest, plan });
  assert.equal(result.settingsReadFailed, true, 'falsy parse result treated as read failure');
  assert.equal(result.patchesNotReverted.length, 1, 'patch recorded as not reverted');

  // Verify manifest records with correct reason
  const manifestAfter = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.equal(manifestAfter.settingsPatches.length, 1);
  assert.equal(manifestAfter.settingsPatches[0].why, 'settings-unreadable');
});

test('file edited between plan and run is kept and reported', () => {
  const { d, manifest } = installed();
  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.remove.length, 1, 'plan to remove HANDOFF.md');

  // Edit the file after planning
  writeFileSync(join(d, 'HANDOFF.md'), 'user edit\n');

  const result = runUninstall({ root: d, manifest, plan });
  assert.equal(result.removed.length, 0, 'file not removed (changed)');
  assert.equal(result.changedSincePlan.length, 1, 'file recorded as changed');
  assert.equal(result.changedSincePlan[0].path, 'HANDOFF.md');
  assert.equal(result.changedSincePlan[0].why, 'ours-modified');

  // Verify file still exists with user's edit
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'user edit\n');

  // Verify manifest still records it
  const manifestAfter = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.equal(manifestAfter.files.length, 1, 'file still in manifest');
});

test('settings array from the start is treated as unreadable', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });

  // Create manifest with patch and settings as array (no race, just malformed)
  const manifest = {
    schema: 1,
    kitVersion: '0.2.0',
    installedAt: new Date().toISOString(),
    files: [],
    settingsPatches: [
      { container: '/hooks/SessionStart', entrySha256: 'test', checkId: 'P4' }
    ]
  };
  writeFileSync(join(d, MANIFEST_PATH), JSON.stringify(manifest));
  writeFileSync(join(d, '.claude/settings.json'), '["not", "an", "object"]');

  // planUninstall should treat settings as unreadable and keep the patch
  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.revert.length, 0, 'plan has no patches to revert (settings invalid)');
  assert.equal(plan.keepPatches.length, 1, 'patch kept with reason');
  assert.equal(plan.keepPatches[0].why, 'settings-unreadable');

  // runUninstall should also treat it as unreadable
  const result = runUninstall({ root: d, manifest, plan });
  assert.equal(result.settingsReadFailed, true);
});

test('settings array (falsy-like non-object) is treated as unreadable', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const hookProposal = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });

  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.revert.length, 1);

  // Replace settings with array (valid JSON but not an object)
  writeFileSync(join(d, '.claude/settings.json'), '["not", "an", "object"]');

  const result = runUninstall({ root: d, manifest, plan });
  assert.equal(result.settingsReadFailed, true, 'array parse result treated as unreadable');
  assert.equal(result.patchesNotReverted.length, 1);

  const manifestAfter = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.equal(manifestAfter.settingsPatches[0].why, 'settings-unreadable');
});

// --- I1: the revert path must re-derive, not replay a stale plan ---------

test('I1: a settings file repaired between plan and run still gets its hook reverted', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  writeManifest(d, manifest);
  const healthy = readFileSync(join(d, '.claude/settings.json'), 'utf8');

  // At plan time the file is unparseable, so the plan's candidate list is
  // empty — through no fault of the patch, which is perfectly revertible.
  writeFileSync(join(d, '.claude/settings.json'), '{ "permissions": { "deny": ["Edit(x)"], }, }');
  const plan = planUninstall({ root: d, manifest });
  assert.deepEqual(plan.revert, [], 'the plan could not read the file, so it has nothing to offer');
  assert.equal(plan.keepPatches.length, 1);

  // The user repairs their JSON before confirming. The hook is right there.
  writeFileSync(join(d, '.claude/settings.json'), healthy);

  const result = runUninstall({ root: d, manifest, plan });
  const after = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.equal(after.hooks, undefined, 'the hook must be reverted, not left registered while the run reports success');
  assert.deepEqual(after.permissions, { deny: ['Edit(x)'] }, 'their settings survive');
  assert.deepEqual(result.patchesNotReverted, [], 'nothing was left behind, so nothing may be reported as kept');
  assert.equal(result.settingsReadFailed, false);
  assert.equal(existsSync(join(d, MANIFEST_PATH)), false, 'and the manifest is cleared, so the repo is genuinely clean');
});
