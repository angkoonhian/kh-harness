import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const MANIFEST_PATH = '.claude/harness-kit.manifest.json';

export function sha256(input) {
  // Handle both strings and buffers. Buffers are hashed as raw bytes (no encoding).
  // Strings are hashed as utf-8 for backward compatibility, but file content must use buffers.
  if (typeof input === 'string') {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }
  return createHash('sha256').update(input).digest('hex');
}

export function emptyManifest(kitVersion) {
  return { schema: 1, kitVersion, installedAt: new Date().toISOString(), files: [], settingsPatches: [] };
}

/**
 * Distinguishes "no manifest file" (nothing installed yet — a common,
 * entirely legitimate state) from "a manifest file exists but could not
 * be read as our schema" (corrupt — hand-edited, truncated by a crash
 * mid-write, merge-conflict markers left in, ...). The two are NOT the
 * same fact: silently treating a corrupt manifest as "nothing installed"
 * is how `apply` used to orphan every file it had previously written —
 * the manifest is overwritten with a fresh empty one, and the record of
 * what to `uninstall` is gone, permanently, with no notice to the user
 * (coordinator finding, Major). `readManifest`, below, still collapses
 * both to `null` for `detect.mjs` (which correctly fails safe either way
 * — it never writes anything) and `uninstall.mjs` (which already refuses
 * on either); `apply.mjs` uses this directly so it can refuse ONLY on the
 * corrupt case, exactly like it already refuses on a dirty tree or a
 * default branch, rather than silently starting over.
 */
export function readManifestResult(root) {
  const p = join(root, MANIFEST_PATH);
  if (!existsSync(p)) return { state: 'missing', manifest: null };
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return { state: 'corrupt', manifest: null };
  }
  try {
    const m = JSON.parse(raw);
    if (m?.schema !== 1 || !Array.isArray(m.files)) return { state: 'corrupt', manifest: null };
    m.settingsPatches ??= [];
    return { state: 'ok', manifest: m };
  } catch {
    return { state: 'corrupt', manifest: null };
  }
}

export function readManifest(root) {
  return readManifestResult(root).manifest;
}

export function writeManifest(root, manifest) {
  const p = join(root, MANIFEST_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Three answers, and every write decision follows from them:
 *   ours-unmodified — we wrote it, it is untouched, we may update or remove it
 *   ours-modified   — we wrote it, the user changed or deleted it: report, never write
 *   theirs          — we never wrote it: never touch it
 */
export function classify(root, manifest, relPath) {
  const entry = manifest?.files?.find(f => f.path === relPath);
  if (!entry) return 'theirs';

  // Guard against path traversal: reject absolute paths and paths that escape root
  const p = join(root, relPath);
  const rootResolved = resolve(root);
  const pResolved = resolve(p);
  const rel = relative(rootResolved, pResolved);
  if (rel.startsWith('..')) {
    return 'theirs';
  }

  if (!existsSync(p)) return 'ours-modified';
  let current;
  try {
    // Read raw bytes (no encoding) to avoid lossy UTF-8 decoding
    current = readFileSync(p);
  } catch {
    return 'ours-modified';
  }
  return sha256(current) === entry.sha256 ? 'ours-unmodified' : 'ours-modified';
}

export { MANIFEST_PATH };
