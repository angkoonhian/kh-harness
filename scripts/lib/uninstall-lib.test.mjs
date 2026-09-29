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

  // Route 1: planUninstall refuses, so the entry arrives via plan.keep.
  const plan = planUninstall({ root: d, manifest });
  runUninstall({ root: d, manifest, plan });
  const after = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.deepEqual(after.files.map(f => f.path), ['src/index.ts'], 'a refusal is recorded, not forgotten');

  // Route 2: the run refuses on its own, with a plan that keeps nothing.
  // Without this case a refusal is the ONLY outcome, and treating "nothing
  // kept" as "nothing left behind" deletes the manifest — quietly forgetting
  // a file that is still on disk and still ours.
  writeFileSync(join(d, MANIFEST_PATH), JSON.stringify(manifest));
  const forced = { remove: [{ path: 'src/index.ts' }], keep: [], revert: [], keepPatches: [], gonePatches: [] };
  const result = runUninstall({ root: d, manifest, plan: forced });
  assert.equal(result.refused.length, 1);
  assert.equal(existsSync(join(d, MANIFEST_PATH)), true, 'a refusal is not "nothing left behind"');
  assert.deepEqual(
    JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8')).files.map(f => f.path),
    ['src/index.ts'],
  );
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

// --- I3: an absent settings file is the clean case, not a failure --------

test('I3/C1a: settings deleted between plan and run still lets the run complete cleanly', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  writeManifest(d, manifest);

  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.revert.length, 1, 'has a patch to revert');

  // The user deletes their own settings file between plan and run. There is
  // no hook left to remain registered, so there is nothing to fail about.
  rmSync(join(d, '.claude/settings.json'));

  const result = runUninstall({ root: d, manifest, plan });
  assert.equal(result.settingsReadFailed, false, 'absent is not unreadable');
  assert.equal(result.settingsMissing, true, 'but it is still reported');
  assert.deepEqual(result.patchesNotReverted, [], 'nothing was left behind');
  assert.equal(existsSync(join(d, MANIFEST_PATH)), false,
    'and the manifest is cleared — otherwise every re-run repeats this forever');
});

test('I3: a settings file already gone at plan time is reported distinguishably, not as a keep', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  writeManifest(d, manifest);
  rmSync(join(d, '.claude/settings.json'));

  const plan = planUninstall({ root: d, manifest });
  assert.deepEqual(plan.revert, []);
  assert.deepEqual(plan.keepPatches, [], 'nothing is kept: the hook is already gone');
  assert.equal(plan.gonePatches.length, 1, 'but the recorded patch is still accounted for');
  assert.equal(plan.gonePatches[0].why, 'settings-missing',
    'an EACCES, a syntax error and a deleted file must not be indistinguishable');

  const result = runUninstall({ root: d, manifest, plan });
  assert.equal(result.settingsMissing, true);
  assert.equal(existsSync(join(d, MANIFEST_PATH)), false);
});

// --- I6: the three failure flags that had no assertion anywhere ----------
//
// `settingsWriteFailed`, `manifestWriteFailed` and `manifestDeleteFailed`
// were all reported and none was ever exercised. Two separate defects lived
// inside the settingsWriteFailed branch for exactly that reason.

/**
 * Makes `path` readable but not writable, and proves it. Read-only is the
 * one mechanism that lets the read at the top of the revert block succeed
 * and the write at the bottom of it fail on the same file. If the OS ever
 * stops honouring it (running as root, say), the assertion below fails the
 * test rather than letting it pass without entering the branch at all.
 */
function makeUnwritable(path) {
  chmodSync(path, 0o444);
  assert.throws(
    () => writeFileSync(path, 'probe'),
    /EPERM|EACCES/,
    'precondition: the OS must actually refuse this write, or the test proves nothing',
  );
}

test('I6/C1c: a settings WRITE failure is reported, leaves the file untouched, and keeps the patch', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));

  const { manifest } = applyProposals({ root: d, proposals: [fileProposal(), hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  writeManifest(d, manifest);

  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.remove.length, 1, 'has a file to remove');
  assert.equal(plan.revert.length, 1, 'has a patch to revert');

  const settingsPath = join(d, '.claude/settings.json');
  const before = readFileSync(settingsPath, 'utf8');
  makeUnwritable(settingsPath);

  const result = runUninstall({ root: d, manifest, plan });

  assert.equal(result.settingsWriteFailed, true, 'the write path — not the read path — is what failed');
  assert.equal(result.settingsReadFailed, false, 'the file was perfectly readable');
  assert.equal(readFileSync(settingsPath, 'utf8'), before, 'nothing reached disk, so the hook is still registered');

  // The file removal is independent of the settings failure and must still
  // have happened.
  assert.deepEqual(result.removed, ['HANDOFF.md']);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false);

  assert.equal(result.patchesNotReverted.length, 1, 'the still-registered patch must be recorded');
  assert.equal(result.patchesNotReverted[0].why, 'settings-write-failed');

  const after = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.equal(after.files.length, 0, 'the removed file is gone from the manifest');
  assert.equal(after.settingsPatches.length, 1, 'the un-reverted patch is still tracked');
  assert.equal(after.settingsPatches[0].why, 'settings-write-failed');
});

test('I2: a patch kept because the user edited it is recorded as edited, not as a write failure', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), '{}');
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  writeManifest(d, manifest);

  // The user edits our hook. Nothing reverts, so no write is even attempted.
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  s.hooks.SessionStart[0].hooks[0].command = 'node edited.mjs';
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s));

  const plan = planUninstall({ root: d, manifest });
  const result = runUninstall({ root: d, manifest, plan });

  assert.equal(result.settingsWriteFailed, false, 'no write was attempted, let alone failed');
  assert.equal(result.settingsReadFailed, false);
  assert.equal(result.patchesNotReverted[0].why, 'patch-modified', 'the returned object tells the truth');

  const after = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.equal(after.settingsPatches[0].why, 'patch-modified',
    'and so must the durable record — a run-level flag must not overwrite a per-patch reason');
});

test('I4: two patches under one event are both recorded when the settings write fails', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), '{}');

  // Two hooks under the SAME event: they share the container
  // `/hooks/SessionStart` and differ only by entrySha256.
  const second = { ...hookProposal, entry: { type: 'command', command: 'node second.mjs' }, checkId: 'P4.second' };
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal, second], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  writeManifest(d, manifest);
  assert.equal(manifest.settingsPatches.length, 2);
  assert.equal(new Set(manifest.settingsPatches.map(p => p.container)).size, 1, 'one container, two patches');

  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.revert.length, 2);

  makeUnwritable(join(d, '.claude/settings.json'));
  const result = runUninstall({ root: d, manifest, plan });

  assert.equal(result.settingsWriteFailed, true);
  assert.equal(result.patchesNotReverted.length, 2,
    'deduping by container drops the second patch, leaving it registered with no record anywhere');
  assert.deepEqual(
    result.patchesNotReverted.map(p => p.entrySha256).sort(),
    manifest.settingsPatches.map(p => p.entrySha256).sort(),
  );

  const after = JSON.parse(readFileSync(join(d, MANIFEST_PATH), 'utf8'));
  assert.equal(after.settingsPatches.length, 2, 'both survive into the manifest, or one is a permanent orphan');
});

test('I6: a manifest that cannot be written is reported, not swallowed', () => {
  const { d, manifest } = installed();
  writeFileSync(join(d, 'HANDOFF.md'), 'edited, so something is kept\n');
  // The manifest path is a directory: writeFileSync cannot write it.
  mkdirSync(join(d, MANIFEST_PATH), { recursive: true });

  const plan = planUninstall({ root: d, manifest });
  const result = runUninstall({ root: d, manifest, plan });
  assert.equal(result.manifestWriteFailed, true);
  assert.equal(result.manifestDeleteFailed, false);
});

test('I6: a manifest that cannot be removed is reported, not swallowed', () => {
  const { d, manifest } = installed();
  const plan = planUninstall({ root: d, manifest });
  assert.equal(plan.remove.length, 1, 'nothing will be kept, so the manifest is due for deletion');
  // The manifest path is a non-empty directory: rmSync (no recursive) refuses.
  mkdirSync(join(d, MANIFEST_PATH), { recursive: true });
  writeFileSync(join(d, MANIFEST_PATH, 'blocker'), 'x');

  const result = runUninstall({ root: d, manifest, plan });
  assert.deepEqual(result.removed, ['HANDOFF.md']);
  assert.equal(result.manifestDeleteFailed, true);
  assert.equal(result.manifestWriteFailed, false);
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

// --- I5: the guard that stops an empty run from rewriting their file -----

test('I5: a run that reverts nothing leaves settings.json byte-identical', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), '{}');
  const { manifest } = applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  writeManifest(d, manifest);

  const settingsPath = join(d, '.claude/settings.json');
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  s.hooks.SessionStart[0].hooks[0].command = 'node edited.mjs';
  // Deliberately in the user's own formatting — compact, no trailing
  // newline — so that a rewrite is visible even when the *content* is
  // unchanged. Re-indenting someone's settings.json is still touching it.
  const theirs = JSON.stringify(s);
  writeFileSync(settingsPath, theirs);

  const plan = planUninstall({ root: d, manifest });
  assert.deepEqual(plan.revert, [], 'nothing is revertible, so no write may be attempted');

  const result = runUninstall({ root: d, manifest, plan });
  assert.equal(result.settingsWriteFailed, false);
  assert.equal(readFileSync(settingsPath, 'utf8'), theirs,
    'a run that reverts nothing has no business rewriting or re-indenting the user\'s file');
});
