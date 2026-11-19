import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { readJsonFile } from './read-json.mjs';
import { GATE_ID } from '../../assets/scripts/harness-gates.mjs';

const MANIFEST_PATH = '.claude/kh-harness.manifest.json';

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
 * — it never writes anything); `apply.mjs` and `uninstall.mjs` use this
 * directly so each can say which of the two it refused on.
 */
export function readManifestResult(root) {
  const read = readJsonFile(join(root, MANIFEST_PATH));
  if (read.state === 'absent') return { state: 'missing', manifest: null };
  if (read.state === 'unreadable' || !isWellFormedManifest(read.value)) return { state: 'corrupt', manifest: null };
  read.value.settingsPatches ??= [];
  return { state: 'ok', manifest: read.value };
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A landed learning as the manifest records it: exactly `{ id, gateSha256 }`,
 * a gate id and the SHA-256 hex of the gate the repository holds for it. */
const isLearningRecord = l => isPlainObject(l) && Object.keys(l).length === 2 &&
  typeof l.id === 'string' && GATE_ID.test(l.id) && typeof l.gateSha256 === 'string' && /^[0-9a-f]{64}$/.test(l.gateSha256);

/**
 * Every shape a reader of the manifest dereferences without checking —
 * `f.path`, `f.sha256`, `p.event`, `dirsCreated` iterated as paths, each
 * landed learning's id and hash — is checked here, once, so a hand-edited
 * or forged manifest is refused as `corrupt` instead of crashing `apply`,
 * `uninstall` or a landing part-way through.
 */
function isWellFormedManifest(m) {
  return isPlainObject(m) && m.schema === 1 &&
    Array.isArray(m.files) &&
    m.files.every(f => isPlainObject(f) && typeof f.path === 'string' && typeof f.sha256 === 'string') &&
    (m.settingsPatches === undefined || (Array.isArray(m.settingsPatches) && m.settingsPatches.every(isPlainObject))) &&
    (m.dirsCreated === undefined || (Array.isArray(m.dirsCreated) && m.dirsCreated.every(d => typeof d === 'string'))) &&
    (m.learnings === undefined || (Array.isArray(m.learnings) && m.learnings.every(isLearningRecord)));
}

export function readManifest(root) {
  return readManifestResult(root).manifest;
}

/**
 * Written to a temporary sibling and renamed into place, so the manifest on
 * disk is always either the previous one or the new one, whole. Audit Tier
 * 2, finding 8: an in-place write killed midway left a truncated file that
 * read back as `corrupt` — and `apply` refuses on a corrupt manifest, so
 * every file that run had written was orphaned behind a refusal. On any
 * failure the temporary file is removed and the error propagates; the
 * caller (apply.mjs) already reports a manifest write failure by path. A
 * temporary left by a hard kill (nothing else would ever remove it, and the
 * prefix is unambiguously ours) is cleared before the next write.
 */
export function writeManifest(root, manifest) {
  const p = join(root, MANIFEST_PATH);
  mkdirSync(dirname(p), { recursive: true });
  const stalePrefix = `${basename(MANIFEST_PATH)}.tmp-`;
  for (const name of readdirSync(dirname(p))) {
    if (name.startsWith(stalePrefix)) rmSync(join(dirname(p), name), { force: true });
  }
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* the error below is the one to report */ }
    throw err;
  }
}

/** CRLF → LF, nothing else. A lone CR is left alone: git never writes one. */
export function normalizeLineEndings(buf) {
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

/**
 * Three answers, and every write decision follows from them:
 *   ours-unmodified — we wrote it, it is untouched, we may update or remove it
 *   ours-modified   — we wrote it, the user changed or deleted it: report, never write
 *   theirs          — we never wrote it: never touch it
 *
 * Line endings (audit Tier 1, finding 4): the kit writes LF and records LF
 * hashes, but a checkout with `core.autocrlf=true` — the Windows default —
 * rewrites every installed file to CRLF, and hashing raw bytes then called
 * all of them `ours-modified`: apply reported `kept (modified)` for every
 * file, uninstall kept every file, the upgrade path never fired (measured
 * on a real repository). So on a raw mismatch, and only when the bytes hold
 * a CR, the LF-normalised content is hashed too. One way only: the kit
 * never writes CRLF, so a CRLF hash in the manifest is never matched by an
 * LF file. The UTF-8 round trip in `normalizeLineEndings` is lossy for
 * non-UTF-8 bytes, which can only turn a would-be match into a non-match —
 * the safe direction — and every file the kit writes is UTF-8 text.
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
  if (sha256(current) === entry.sha256) return 'ours-unmodified';
  if (current.includes(0x0d) && sha256(normalizeLineEndings(current)) === entry.sha256) return 'ours-unmodified';
  return 'ours-modified';
}

export { MANIFEST_PATH };
