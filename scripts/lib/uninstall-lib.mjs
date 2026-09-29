import { rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classify, MANIFEST_PATH, writeManifest } from './manifest.mjs';
import { revertPatch } from './settings-merge.mjs';

const SETTINGS = '.claude/settings.json';

/** Validate settings structure — must be a plain object, not null/array/primitive. */
function validateSettings(content) {
  if (!existsSync(content)) return { valid: false, object: null, reason: 'settings-missing' };

  try {
    const parsed = JSON.parse(readFileSync(content, 'utf8'));
    const isPlain = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    if (isPlain) return { valid: true, object: parsed, reason: null };
    return { valid: false, object: null, reason: 'settings-unreadable' };
  } catch {
    return { valid: false, object: null, reason: 'settings-unreadable' };
  }
}

/** Read-only. Decides what may be removed; removes nothing. */
export function planUninstall({ root, manifest }) {
  const remove = [], keep = [], revert = [], keepPatches = [];

  for (const f of manifest?.files ?? []) {
    const state = classify(root, manifest, f.path);
    if (state === 'ours-unmodified') remove.push({ path: f.path, step: f.step });
    else keep.push({ path: f.path, why: state });
  }

  const validated = validateSettings(join(root, SETTINGS));
  if (validated.valid) {
    for (const p of manifest?.settingsPatches ?? []) {
      if (revertPatch(validated.object, p).reverted) revert.push(p);
      else keepPatches.push({ ...p, why: 'patch-modified' });
    }
  } else {
    for (const p of manifest?.settingsPatches ?? []) {
      keepPatches.push({ ...p, why: validated.reason });
    }
  }

  return { remove, keep, revert, keepPatches };
}

export function runUninstall({ root, manifest, plan }) {
  // Collect all outcomes before persisting anything.
  // Compute, then persist, always — no throw between action and bookkeeping.
  const removed = [], failed = [];
  let settingsReadFailed = false, settingsWriteFailed = false, manifestWriteFailed = false;
  const patchesNotReverted = [];
  const changedSincePlan = [];

  // 1. Re-classify and remove only if still ours-unmodified (defect 1: CRITICAL)
  for (const r of plan.remove) {
    const currentState = classify(root, manifest, r.path);
    if (currentState === 'ours-unmodified') {
      try {
        rmSync(join(root, r.path));
        removed.push(r.path);
      } catch (e) {
        failed.push({ path: r.path, reason: e?.message ?? 'unknown error' });
      }
    } else {
      // File changed since plan was made
      changedSincePlan.push({ path: r.path, why: currentState });
    }
  }

  // 2. Attempt to revert settings patches, tracking what could not be reverted
  // Always validate settings to detect runtime changes, even if nothing planned to revert
  const validated = validateSettings(join(root, SETTINGS));

  if (plan.revert.length) {
    if (validated.valid) {
      let settings = validated.object;
      // Settings is a valid object; apply reverts
      for (const p of plan.revert) settings = revertPatch(settings, p).settings;

      // Try to write reverted settings; guard the write
      try {
        writeFileSync(join(root, SETTINGS), JSON.stringify(settings, null, 2) + '\n', 'utf8');
      } catch (e) {
        settingsWriteFailed = true;
        patchesNotReverted.push(...plan.revert);
      }
    } else {
      // Settings not readable, missing, or not a plain object; patches cannot be reverted
      if (validated.reason !== null) settingsReadFailed = true;
      patchesNotReverted.push(...plan.revert);
    }
  } else if (!validated.valid && validated.reason === 'settings-unreadable') {
    // No patches to revert, but settings invalid at runtime — report it
    settingsReadFailed = true;
  }

  // 3. Build manifest from actual outcomes, not from plan
  const keptPaths = new Set(plan.keep.map(k => k.path));
  const changedPaths = new Set(changedSincePlan.map(c => c.path));
  const failedPaths = new Set(failed.map(f => f.path));

  // Files to keep in manifest: kept files, files changed since plan, and files that failed to remove
  const keptFiles = manifest.files.filter(f =>
    keptPaths.has(f.path) || changedPaths.has(f.path) || failedPaths.has(f.path)
  );

  // Patches to keep in manifest: user-edited patches + patches we couldn't revert
  const keptPatches = [
    ...plan.keepPatches,
    ...patchesNotReverted.map(p => ({
      ...p,
      why: settingsReadFailed ? 'settings-unreadable' : 'settings-write-failed'
    }))
  ];

  // 4. Persist the manifest once, from actual outcomes
  // Guard both write and delete so the outcome is always returned
  let manifestDeleteFailed = false;
  const hasKept = keptFiles.length > 0 || keptPatches.length > 0 || changedSincePlan.length > 0;
  const hasFailures = failed.length > 0;

  if (!hasKept && !hasFailures) {
    try {
      rmSync(join(root, MANIFEST_PATH));
    } catch (e) {
      manifestDeleteFailed = true;
    }
  } else {
    const updatedManifest = {
      ...manifest,
      files: keptFiles,
      settingsPatches: keptPatches
    };
    try {
      writeManifest(root, updatedManifest);
    } catch (e) {
      manifestWriteFailed = true;
    }
  }

  return {
    removed,
    failed,
    settingsReadFailed,
    settingsWriteFailed,
    manifestWriteFailed,
    manifestDeleteFailed,
    changedSincePlan,
    patchesNotReverted
  };
}
