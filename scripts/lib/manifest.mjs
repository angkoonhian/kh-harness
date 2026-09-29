import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MANIFEST_PATH = '.claude/harness-kit.manifest.json';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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
  const p = join(root, relPath);
  if (!existsSync(p)) return 'ours-modified';
  let current;
  try { current = readFileSync(p, 'utf8'); } catch { return 'ours-modified'; }
  return sha256(current) === entry.sha256 ? 'ours-unmodified' : 'ours-modified';
}

export { MANIFEST_PATH };
