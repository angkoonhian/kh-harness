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

export function readManifest(root) {
  const p = join(root, MANIFEST_PATH);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    if (m?.schema !== 1 || !Array.isArray(m.files)) return null;
    m.settingsPatches ??= [];
    return m;
  } catch { return null; }
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
