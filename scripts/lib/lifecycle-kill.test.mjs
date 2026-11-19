// scripts/lib/lifecycle-kill.test.mjs — an `apply --yes` killed at either
// side of the one settings write, on a first install and on an upgrade from
// the 0.1.0 kit this repository's history holds. The state a kill leaves is
// made by the code `apply` runs: `applyProposals` is called as `apply.mjs`
// calls it, stopped at the settings write or before the last manifest write,
// and the CLIs are then run on what is on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { applyProposals, SETTINGS_PATH } from './apply-lib.mjs';
import { detectExposures } from './detect-exposure.mjs';
import { detectHarness } from './detect-harness.mjs';
import { detectStack } from './detect-stack.mjs';
import { buildGaps } from './gap-model.mjs';
import { gitInfo } from './git-info.mjs';
import { APPLY, DETECT, fixture, git, kitAt, run, runEveryRegisteredHook, runResult, sandboxDataDir, settings, UNINSTALL } from './lifecycle-fixtures.mjs';
import { emptyManifest, KIT_VERSION, MANIFEST_PATH, readManifestResult, replaceFile, writeManifest } from './manifest.mjs';
import { selectProfile } from './profiles/index.mjs';
import { buildProposals, GENERATORS } from './propose.mjs';
import { listFiles } from './scan.mjs';

sandboxDataDir();

const KIT_0_1_0 = '681189d';
const old = kitAt(KIT_0_1_0);
const skipUpgrade = old === null ? `commit ${KIT_0_1_0} is not in this checkout (a shallow clone); fetch the full history to run this` : false;

/** The proposals `apply.mjs` builds for `root`, and the manifest it builds
 * them against. */
function proposalsFor(root) {
  const manifestResult = readManifestResult(root);
  assert.notEqual(manifestResult.state, 'corrupt');
  const manifest = manifestResult.manifest ?? emptyManifest(KIT_VERSION);
  const { files, unreadableDirs } = listFiles(root);
  const stack = detectStack(root, files);
  const harness = detectHarness(root, files);
  harness.reconPresent = files.includes('docs/harness/recon.md');
  const exposures = detectExposures(root, files, harness, unreadableDirs);
  const checks = buildGaps({ stack, harness, exposures, profile: selectProfile(stack), git: gitInfo(root), files, root, manifest: manifestResult.manifest, kitVersion: KIT_VERSION });
  return { manifest, proposals: buildProposals({ checks, manifest, kitVersion: KIT_VERSION, harness, root, stack, files }) };
}

const KILLED = 'the run was killed here';

/**
 * Leaves `root` as an `apply --yes` killed at `point` leaves it:
 * `before-settings`, after the manifest that records the staged patches is
 * on disk and before the settings file is replaced; `after-settings`, after
 * the settings file is replaced and before the manifest is written again.
 */
function killApplyAt(root, point) {
  const { manifest, proposals } = proposalsFor(root);
  assert.ok(proposals.some(p => p.kind !== 'file'), 'fixture: the run patches the settings file');
  const manifestPath = join(root, MANIFEST_PATH);
  let onDiskAtKill = null;
  const result = applyProposals({
    root, proposals, manifest, kitVersion: KIT_VERSION,
    persistManifest: staged => writeManifest(root, staged),
    replaceSettings: (path, text) => {
      if (point === 'before-settings') {
        onDiskAtKill = readFileSync(manifestPath);
        throw new Error(KILLED);
      }
      replaceFile(path, text);
    },
  });
  if (point === 'before-settings') {
    assert.deepEqual(result.failed.map(f => f.error), [`failed to write ${SETTINGS_PATH}: ${KILLED}`]);
    // The process is gone at the throw: the manifest is as it was then.
    writeFileSync(manifestPath, onDiskAtKill);
  } else {
    assert.deepEqual(result.failed, []);
  }
}

const copies = [];
after(() => {
  for (const d of copies) rmSync(d, { recursive: true, force: true });
});
/** A copy of the repository `d`, so two recoveries start from one state. */
function copyOf(d) {
  const copy = mkdtempSync(join(tmpdir(), 'hk-kill-copy-'));
  copies.push(copy);
  cpSync(d, copy, { recursive: true });
  return copy;
}

const kitScriptsOnDisk = d => (existsSync(join(d, '.claude/scripts')) ? readdirSync(join(d, '.claude/scripts')) : []);
const kitEntries = d => Object.values(settings(d).hooks ?? {}).flat().flatMap(m => m.hooks ?? []).map(h => h.args?.[0] ?? h.command).filter(s => s.includes('.claude/scripts/'));
const kitDenyRules = d => (settings(d).permissions?.deny ?? []).filter(rule => rule.includes('kh-harness') || rule.includes('learn.mjs') || rule.includes('log.mjs') || rule.includes('.claude/scripts'));

/** `uninstall --yes` on the killed state takes out everything the kit put
 * in the repository, and leaves no record. */
function assertUninstallRecovers(d) {
  const result = runResult(UNINSTALL, d, '--yes');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(kitScriptsOnDisk(d), [], 'no kit script is left');
  assert.deepEqual(kitEntries(d), [], 'no kit hook entry is left registered');
  assert.deepEqual(kitDenyRules(d), [], 'no kit deny rule is left');
  assert.equal(existsSync(join(d, MANIFEST_PATH)), false, 'the manifest is removed');
  assert.deepEqual(settings(d).permissions?.deny, ['Edit(secrets/**)'], "the owner's own rule is as it was");
}

/** `apply --yes` on the killed state completes the install: nothing is left
 * for it to propose, every registered hook runs, and `uninstall` then
 * removes all of it. */
function assertApplyRecovers(d) {
  const applied = runResult(APPLY, d, '--yes', '--allow-dirty');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const checks = JSON.parse(run(DETECT, d, '--json')).checks;
  assert.deepEqual(checks.filter(c => c.proposal && c.id in GENERATORS).map(c => c.id), [], 'nothing is left to propose');
  assert.match(run(APPLY, d), /no actions/);
  assert.ok(kitEntries(d).length > 0, 'the hooks are registered');
  for (const h of runEveryRegisteredHook(d)) assert.notEqual(h.status, 1, `${h.script} on ${h.event}: ${h.stderr}`);
  assertUninstallRecovers(d);
}

/** A repository holding a committed install by the 0.1.0 kit. */
function installedAt010() {
  const d = fixture();
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest', lint: 'node -e 0' } }));
  writeFileSync(join(d, 'index.js'), 'export const ok = true;\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a lint script');
  run(old.apply, d, '--yes');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'install kh-harness 0.1.0');
  return d;
}

for (const point of ['before-settings', 'after-settings']) {
  test(`a first install killed ${point} is one uninstall removes and apply completes`, () => {
    const d = fixture();
    killApplyAt(d, point);
    assert.ok(kitScriptsOnDisk(d).length > 0, 'fixture: the kill left kit scripts on disk');
    assert.equal(kitEntries(d).length > 0, point === 'after-settings', 'fixture: the settings file is replaced only after the kill point');
    assertApplyRecovers(copyOf(d));
    assertUninstallRecovers(d);
  });

  test(`an upgrade from 0.1.0 killed ${point} is one uninstall removes and apply completes`, { skip: skipUpgrade }, () => {
    const d = installedAt010();
    const before = kitEntries(d).length;
    assert.ok(before > 0, 'fixture: the 0.1.0 kit registered hooks');
    killApplyAt(d, point);
    assert.equal(kitEntries(d).length > before, point === 'after-settings', 'fixture: the new entries are in the file only after the kill point');
    assertApplyRecovers(copyOf(d));
    assertUninstallRecovers(d);
  });
}
