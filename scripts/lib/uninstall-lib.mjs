import { rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classify, MANIFEST_PATH, writeManifest } from './manifest.mjs';
import { revertPatch } from './settings-merge.mjs';

const SETTINGS = '.claude/settings.json';

/** Read-only. Decides what may be removed; removes nothing. */
export function planUninstall({ root, manifest }) {
  const remove = [], keep = [], revert = [], keepPatches = [];

  for (const f of manifest?.files ?? []) {
    const state = classify(root, manifest, f.path);
    if (state === 'ours-unmodified') remove.push({ path: f.path, step: f.step });
    else keep.push({ path: f.path, why: state });
  }

  if (existsSync(join(root, SETTINGS))) {
    let settings = null;
    try { settings = JSON.parse(readFileSync(join(root, SETTINGS), 'utf8')); } catch { settings = null; }
    for (const p of manifest?.settingsPatches ?? []) {
      if (settings && revertPatch(settings, p).reverted) revert.push(p);
      else keepPatches.push({ ...p, why: settings ? 'patch-modified' : 'settings-unreadable' });
    }
  } else {
    for (const p of manifest?.settingsPatches ?? []) keepPatches.push({ ...p, why: 'settings-missing' });
  }

  return { remove, keep, revert, keepPatches };
}

export function runUninstall({ root, manifest, plan }) {
  // Collect all outcomes before persisting anything.
  // Compute, then write manifest, unconditionally — no throw between action and bookkeeping.
  const removed = [], failed = [];
  let settingsReadFailed = false, settingsWriteFailed = false;
  const patchesNotReverted = [];

  // 1. Track actual outcomes of each removal attempt
  for (const r of plan.remove) {
    try {
      rmSync(join(root, r.path));
      removed.push(r.path);
    } catch (e) {
      failed.push({ path: r.path, reason: e?.message ?? 'unknown error' });
    }
  }

  // 2. Attempt to revert settings patches, tracking what could not be reverted
  if (plan.revert.length) {
    let settings = null;
    try {
      settings = JSON.parse(readFileSync(join(root, SETTINGS), 'utf8'));
    } catch {
      settingsReadFailed = true;
    }

    if (settings) {
      // Settings readable; apply reverts
      for (const p of plan.revert) settings = revertPatch(settings, p).settings;

      // Try to write reverted settings; guard the write (C1c)
      try {
        writeFileSync(join(root, SETTINGS), JSON.stringify(settings, null, 2) + '\n', 'utf8');
      } catch (e) {
        settingsWriteFailed = true;
        patchesNotReverted.push(...plan.revert);
      }
    } else {
      // Settings not readable; patches cannot be reverted
      patchesNotReverted.push(...plan.revert);
    }
  }

  // 3. Build manifest from actual outcomes, not from plan (C1a, C1c)
  const keptPaths = new Set(plan.keep.map(k => k.path));
  const failedPaths = new Set(failed.map(f => f.path));

  // Files to keep in manifest: kept files and files that failed to remove
  const keptFiles = manifest.files.filter(f => keptPaths.has(f.path) || failedPaths.has(f.path));

  // Patches to keep in manifest: user-edited patches + patches we couldn't revert
  const keptPatches = [
    ...plan.keepPatches,
    ...patchesNotReverted.map(p => ({
      ...p,
      why: settingsReadFailed ? 'settings-unreadable' : (settingsWriteFailed ? 'settings-write-failed' : 'unknown')
    }))
  ];

  // 4. Persist the manifest once, from actual outcomes (C1c)
  // No throw path between actions and bookkeeping — this is always reachable
  const hasKept = keptFiles.length > 0 || keptPatches.length > 0;
  const hasFailures = failed.length > 0;

  if (!hasKept && !hasFailures) {
    try { rmSync(join(root, MANIFEST_PATH)); } catch { /* fine */ }
  } else {
    const updatedManifest = {
      ...manifest,
      files: keptFiles,
      settingsPatches: keptPatches
    };
    writeManifest(root, updatedManifest);
  }

  return {
    removed,
    failed,
    settingsReadFailed,
    settingsWriteFailed,
    patchesNotReverted
  };
}
