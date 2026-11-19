import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { readJsonFile } from './read-json.mjs';
import { GATE_ID } from '../../assets/scripts/harness-gates.mjs';

const MANIFEST_PATH = '.claude/kh-harness.manifest.json';

/** The version of the kit this code is, read from its package.json: the one
 * place it is read. */
export const KIT_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

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
 * same fact: an `apply` that treated a corrupt manifest as "nothing
 * installed" would overwrite it with a fresh empty one, and the record of
 * what to `uninstall` would be gone for good. `readManifest`, below,
 * collapses both to `null` for a caller that writes nothing and tells
 * them apart itself where it matters (gap-model.mjs); `apply.mjs` and
 * `uninstall.mjs` use this directly so each can say which of the two it
 * refused on.
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
 * Replaces the file at `path` with `text`, whole: written to a temporary
 * sibling and renamed into place, so a reader, or a run killed at any point,
 * finds the previous file or the new one and never part of one. The kit's
 * one way of rewriting a file in a repository: the manifest, the owner's
 * settings file and `detect`'s report.
 *
 * What a write in place would have kept is kept: the file's permission
 * bits, and a link at `path`, whose target is what is replaced. A target the
 * owner made read-only is refused, as a write in place would be, though a
 * rename could replace it. A missing directory is created.
 *
 * On any failure the temporary file is removed, the target is as it was and
 * the error is thrown. A temporary file left by a hard kill carries this
 * function's own suffix, and nothing else would ever remove it, so those are
 * cleared before the next write.
 */
export function replaceFile(path, text) {
  let target = path;
  let mode;
  try {
    target = realpathSync(path);
    mode = statSync(target).mode & 0o777;
    accessSync(target, constants.W_OK);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const stalePrefix = `${basename(target)}.tmp-`;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(stalePrefix)) rmSync(join(dir, name), { force: true });
  }
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode });
    renameSync(tmp, target);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* the error below is the one to report */ }
    throw err;
  }
}

/** Writes the manifest whole (`replaceFile`): one truncated by a kill would
 * read back as corrupt, and `apply` refuses on a corrupt manifest, so every
 * file that run had written would be orphaned behind the refusal. */
export function writeManifest(root, manifest) {
  replaceFile(join(root, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + '\n');
}

/** CRLF → LF, nothing else. A lone CR is left alone: git never writes one. */
export function normalizeLineEndings(buf) {
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

/**
 * Three answers, and every write decision follows from them:
 *   ours-unmodified — we wrote it, it is untouched, we may update or remove it
 *   ours-modified   — we wrote it, the user changed or deleted it: report, never write
 *                     (`uninstall` asks separately whether it is still there)
 *   theirs          — we never wrote it: never touch it
 *
 * Line endings: the kit writes LF and records LF hashes, but a checkout
 * with `core.autocrlf=true`, the Windows default, rewrites every installed
 * file to CRLF, and raw bytes alone would then call all of them
 * `ours-modified`: every file kept, nothing ever updated. So on a raw
 * mismatch, and only when the bytes hold a CR, the LF-normalised content is
 * hashed too. One way only: the kit
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
  return contentMatches(current, entry.sha256) ? 'ours-unmodified' : 'ours-modified';
}

/** True when `bytes` hash to `expected`, as they are or, when they hold a
 * CR, with CRLF read as LF (see `classify`). */
export function contentMatches(bytes, expected) {
  if (sha256(bytes) === expected) return true;
  return bytes.includes(0x0d) && sha256(normalizeLineEndings(bytes)) === expected;
}

// A path made only of these is printed as it is.
const PLAIN_PATH = /^[A-Za-z0-9._/-]{1,200}$/;
const DISPLAY_MAX = 200;

/**
 * A path, or any other string, read from the manifest, as it may be printed
 * or written into `detect`'s report. The manifest is a file in the
 * repository, so a pull request can put anything in it, and what is printed
 * from it reaches a terminal, which acts on escape sequences, and a model,
 * which reads a new line as a new statement. An ordinary path is returned
 * unchanged; anything else comes back in double quotes, cut to
 * `DISPLAY_MAX` characters, with every character outside printable ASCII,
 * and the quote and the backslash, written as `\u{…}`.
 */
export function displayPath(path) {
  const text = String(path);
  if (PLAIN_PATH.test(text)) return text;
  const shown = [...text.slice(0, DISPLAY_MAX)].map(ch => {
    const code = ch.codePointAt(0);
    return code >= 0x20 && code < 0x7f && ch !== '"' && ch !== '\\' ? ch : `\\u{${code.toString(16)}}`;
  }).join('');
  return `"${shown}${text.length > DISPLAY_MAX ? '...' : ''}"`;
}

export { MANIFEST_PATH };
