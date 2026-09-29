// scripts/lib/uninstall-lib.mjs
//
// The delete side of apply-lib.mjs. It must mirror apply's *defences*, not
// only its bookkeeping: deleting a file is at least as destructive as
// writing one, so every path reaches rmSync only after clearing the same two
// gates apply clears before writeFileSync — the write allowlist and
// filesystem containment. See guardRemoval below for why neither alone is
// enough.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { assertAllowed, assertContained } from './apply-lib.mjs';
import { classify, MANIFEST_PATH, writeManifest } from './manifest.mjs';
import { revertPatch } from './settings-merge.mjs';

const SETTINGS = '.claude/settings.json';

/**
 * The two gates every removal must clear, and why both are required:
 *
 *   - A manifest naming `src/index.ts` or `package.json` resolves happily
 *     inside the repository. Containment passes it; only the allowlist
 *     refuses it.
 *   - A junction at `docs/harness` pointing outside the repository, with a
 *     manifest entry naming `docs/harness/victim.txt` whose hash still
 *     matches, is on the allowlist — `docs/harness/` is a permitted prefix.
 *     Only containment refuses it. This is not an exotic setup: move
 *     `docs/harness` elsewhere, leave a junction behind, and the contents
 *     are unchanged, so the hashes still match.
 *
 * A refusal is returned, never thrown. Uninstall has to finish its work and
 * report honestly even when the state on disk is strange; a throw here would
 * abandon the run between an action and its bookkeeping, which is the one
 * thing this module must never do.
 *
 * @returns {null|string} null when the path may be removed, otherwise the
 *   reason to record against the entry that will be kept instead.
 */
function guardRemoval(root, relPath) {
  try {
    assertAllowed(relPath);
  } catch {
    return 'outside-allowlist';
  }
  try {
    assertContained(root, relPath);
  } catch {
    return 'escapes-repository';
  }
  return null;
}

/** Validate settings structure — must be a plain object, not null/array/primitive. */
function validateSettings(content) {
  if (!fs.existsSync(content)) return { valid: false, object: null, reason: 'settings-missing' };

  try {
    const parsed = JSON.parse(fs.readFileSync(content, 'utf8'));
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
    const refusal = guardRemoval(root, f.path);
    if (refusal) {
      keep.push({ path: f.path, why: refusal });
      continue;
    }
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
  const removed = [], failed = [], refused = [];
  let settingsReadFailed = false, settingsWriteFailed = false, manifestWriteFailed = false;
  const patchesNotReverted = [];
  const changedSincePlan = [];

  // 1. Guard, re-classify, and remove only if still ours-unmodified.
  //    The guard runs here as well as in planUninstall because this is the
  //    call that actually deletes, and `plan` may have been built before the
  //    junction or entry that makes the path unsafe existed — or by a caller
  //    that is not planUninstall at all.
  for (const r of plan.remove) {
    const refusal = guardRemoval(root, r.path);
    if (refusal) {
      refused.push({ path: r.path, why: refusal });
      continue;
    }
    const currentState = classify(root, manifest, r.path);
    if (currentState === 'ours-unmodified') {
      try {
        fs.rmSync(join(root, r.path));
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
  // Validate settings whenever the manifest has patches (avoids a false failure with no patches)
  const manifestPatches = manifest?.settingsPatches ?? [];
  if (manifestPatches.length > 0) {
    const validated = validateSettings(join(root, SETTINGS));

    if (validated.valid) {
      let settings = validated.object;
      let settingsChanged = false;

      // The revertable set is re-derived from the manifest here, exactly as
      // planUninstall derives it — the file path already works this way, and
      // the patch path must too. `plan.revert` is a stale candidate list:
      // it was computed against whatever settings.json looked like at plan
      // time, and the user may well have repaired an unparseable file in
      // between. Iterating it then leaves a perfectly revertible hook
      // registered while the run reports success and exits 0. The fresh
      // revertPatch result below is what decides.
      for (const p of manifestPatches) {
        const r = revertPatch(settings, p);
        if (r.reverted) {
          settings = r.settings;
          settingsChanged = true;
        } else {
          // Patch exists but could not be reverted (user edited it).
          patchesNotReverted.push({ ...p, why: 'patch-modified' });
        }
      }

      // Write reverted settings only if something changed
      if (settingsChanged) {
        try {
          fs.writeFileSync(join(root, SETTINGS), JSON.stringify(settings, null, 2) + '\n', 'utf8');
        } catch (e) {
          settingsWriteFailed = true;
          // Track any patches that couldn't be written
          for (const p of plan.revert) {
            if (!patchesNotReverted.some(pr => pr.container === p.container)) {
              patchesNotReverted.push({ ...p, why: 'settings-write-failed' });
            }
          }
        }
      }
    } else {
      // Settings not readable, missing, or not a plain object; patches cannot
      // be reverted. Derived from the manifest for the same reason as above:
      // plan.revert is whatever the plan happened to manage, and a patch the
      // plan never saw must still be recorded rather than silently dropped.
      if (validated.reason !== null) settingsReadFailed = true;
      for (const p of manifestPatches) {
        patchesNotReverted.push({ ...p, why: validated.reason });
      }
    }
  }

  // 3. Build manifest from actual outcomes, not from plan
  const keptPaths = new Set(plan.keep.map(k => k.path));
  const changedPaths = new Set(changedSincePlan.map(c => c.path));
  const failedPaths = new Set(failed.map(f => f.path));
  const refusedPaths = new Set(refused.map(r => r.path));

  // Files to keep in manifest: kept files, files refused at removal time,
  // files changed since plan, and files that failed to remove
  const keptFiles = (manifest?.files ?? []).filter(f =>
    keptPaths.has(f.path) || changedPaths.has(f.path) || failedPaths.has(f.path) || refusedPaths.has(f.path)
  );

  // Patches to keep in the manifest: everything the run itself could not
  // revert. Not plan.keepPatches — that list was computed before the run and
  // the run re-derives the revertable set from the manifest, so merging the
  // two records a patch as left behind that this run actually removed.
  const keptPatches = patchesNotReverted.map(p => ({
    ...p,
    why: settingsReadFailed ? 'settings-unreadable' : 'settings-write-failed'
  }));

  // 4. Persist the manifest once, from actual outcomes
  // Guard both write and delete so the outcome is always returned
  let manifestDeleteFailed = false;
  const hasKept = keptFiles.length > 0 || keptPatches.length > 0 || changedSincePlan.length > 0 || refused.length > 0;
  const hasFailures = failed.length > 0;

  if (!hasKept && !hasFailures) {
    try {
      fs.rmSync(join(root, MANIFEST_PATH));
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
    refused,
    settingsReadFailed,
    settingsWriteFailed,
    manifestWriteFailed,
    manifestDeleteFailed,
    changedSincePlan,
    patchesNotReverted
  };
}
