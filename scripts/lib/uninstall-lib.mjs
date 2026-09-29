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
  const removed = [], failed = [];

  // Track actual outcomes of each removal attempt
  for (const r of plan.remove) {
    try {
      rmSync(join(root, r.path));
      removed.push(r.path);
    } catch (e) {
      failed.push({ path: r.path, reason: e?.message ?? 'unknown error' });
    }
  }

  // Guard settings read/parse like planUninstall does
  let settingsReadFailed = false;
  if (plan.revert.length) {
    let settings = null;
    try { settings = JSON.parse(readFileSync(join(root, SETTINGS), 'utf8')); } catch { settingsReadFailed = true; }
    if (settings) {
      for (const p of plan.revert) settings = revertPatch(settings, p).settings;
      writeFileSync(join(root, SETTINGS), JSON.stringify(settings, null, 2) + '\n', 'utf8');
    }
  }

  // The manifest records what we still have in the tree. It goes only when
  // there is nothing left to record AND no removals failed.
  const hasKept = plan.keep.length > 0 || plan.keepPatches.length > 0 || settingsReadFailed;
  const hasFailures = failed.length > 0;

  if (!hasKept && !hasFailures) {
    try { rmSync(join(root, MANIFEST_PATH)); } catch { /* fine */ }
  } else {
    // Update manifest to track what we kept and what failed to remove
    const keptPaths = new Set(plan.keep.map(k => k.path));
    const failedPaths = new Set(failed.map(f => f.path));
    const updatedManifest = {
      ...manifest,
      files: manifest.files.filter(f => keptPaths.has(f.path) || failedPaths.has(f.path)),
      settingsPatches: plan.keepPatches
    };
    writeManifest(root, updatedManifest);
  }

  return { removed, failed, settingsReadFailed };
}
