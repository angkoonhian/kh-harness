// scripts/lib/detect-exposure.mjs
import { statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const MAX_BYTES = 512 * 1024;

// Always-probed paths (e.g., .gitignored local settings)
const ALWAYS_PROBE = [
  '.claude/settings.local.json',
  '.claude/settings.json',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.npmrc',
  '.netrc',
];

const TOKEN_PATTERNS = [
  /glpat-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

const PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const DB_CRED = /(password|passwd|pwd)\s*[:=]\s*\S{8,}/i;

const PLACEHOLDER =/(your[-_]|<|xxx|example|changeme|placeholder|dummy|redacted|^(password|secret|todo)$)/i;

// Skip binary-ish extensions: images, archives, binaries, fonts, media, source maps
const SKIP_EXT = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.pdf', '.zip', '.gz', '.tar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.class', '.jar', '.pyc', '.node', '.bin',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mp3', '.wav',
  '.map',
];
const SKIP_DIRS = ['node_modules/', '.git/', 'dist/', 'build/'];

function isBinaryExtension(base) {
  const lower = base.toLowerCase();
  return SKIP_EXT.some(e => lower.endsWith(e));
}

function scannable(root, rel) {
  if (SKIP_DIRS.some(p => rel.startsWith(p) || rel.includes('/' + p))) return false;
  const base = basename(rel);
  if (isBinaryExtension(base)) return false;
  try { return statSync(join(root, rel)).size <= MAX_BYTES; } catch { return false; }
}

function isPlaceholder(value) {
  return PLACEHOLDER.test(value);
}

/**
 * Read a file's text content, deciding the encoding from its bytes rather
 * than assuming UTF-8. Order matters (see task-5-report.md, fix round 4):
 *   1. UTF-16LE BOM (FF FE)  -> decode as utf16le
 *   2. UTF-16BE BOM (FE FF)  -> byte-swap then decode as utf16le
 *   3. NUL byte in first 8 KB, no BOM -> treat as binary, skip (return null)
 *   4. Otherwise decode as UTF-8, stripping a UTF-8 BOM if present.
 *
 * Known limitation: BOM-less UTF-16 (or other multi-byte-per-char encodings
 * without a BOM) is out of scope. There is no reliable, non-heuristic way to
 * distinguish it from binary content, and heuristics here have a history of
 * causing regressions (see task-5-report.md). Such files are skipped.
 *
 * Never throws: any failure decoding is treated as "not readable text".
 */
function readTextIfPresent(root, rel) {
  let buf;
  try {
    buf = readFileSync(join(root, rel));
  } catch {
    return null;
  }

  try {
    // UTF-16LE BOM
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return buf.subarray(2).toString('utf16le');
    }

    // UTF-16BE BOM: Node has no native utf16be decoder, so byte-swap into
    // little-endian order first.
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      let body = Buffer.from(buf.subarray(2)); // copy: swap16 mutates in place
      if (body.length % 2 !== 0) body = body.subarray(0, body.length - 1);
      body.swap16();
      return body.toString('utf16le');
    }

    // Binary-content sniff over the raw bytes (not a decoded string).
    const sniffLen = Math.min(buf.length, 8192);
    if (buf.subarray(0, sniffLen).includes(0)) return null;

    // UTF-8, stripping a UTF-8 BOM if present so BOM-prefixed first lines
    // still match patterns anchored at the start of the text.
    const start = (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? 3 : 0;
    return buf.subarray(start).toString('utf8');
  } catch {
    return null;
  }
}

function scanFile(root, rel, isLocalSettings) {
  const findings = [];

  // Check size
  try {
    if (statSync(join(root, rel)).size > MAX_BYTES) return findings;
  } catch {
    return findings;
  }

  const text = readTextIfPresent(root, rel);
  if (!text) return findings;

  const hasToken = TOKEN_PATTERNS.some(re => re.test(text)) || PEM_PATTERN.test(text);
  if (hasToken) {
    const kind = isLocalSettings ? 'token-in-local-settings' : 'token-in-tracked-file';
    findings.push({ kind, location: rel, severity: 'high' });
  }

  if (DB_CRED.test(text)) {
    const match = text.match(DB_CRED);
    if (match && !isPlaceholder(match[0])) {
      findings.push({ kind: 'credentials-in-doc', location: rel, severity: 'medium' });
    }
  }

  return findings;
}

export function detectExposures(root, files, harness) {
  const out = [];
  const seen = new Set(files);

  for (const r of harness?.remotes ?? []) {
    if (r.hasCredential) out.push({ kind: 'token-in-remote-url', location: `git remote "${r.name}"`, severity: 'high' });
  }

  for (const rel of files) {
    if (!scannable(root, rel)) continue;
    const isLocalSettings = rel.startsWith('.claude/');
    out.push(...scanFile(root, rel, isLocalSettings));
  }

  // Scan always-probed paths, deduplicating against files already checked
  for (const rel of ALWAYS_PROBE) {
    if (seen.has(rel)) continue;
    const isLocalSettings = rel.startsWith('.claude/');
    out.push(...scanFile(root, rel, isLocalSettings));
  }

  return out;
}
