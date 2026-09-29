// scripts/lib/detect-exposure.mjs
import { statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readIfPresent } from './scan.mjs';

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
const PLACEHOLDER = /(your[-_]|<|xxx|example|changeme|placeholder|dummy|redacted|^(password|secret|todo)$)/i;

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

function isBinaryContent(text) {
  // Check first 8 KB for NUL byte (binary content marker)
  const chunk = text.slice(0, 8192);
  return chunk.includes('\0');
}

function scanFile(root, rel, isLocalSettings) {
  const findings = [];

  // Check size
  try {
    if (statSync(join(root, rel)).size > MAX_BYTES) return findings;
  } catch {
    return findings;
  }

  const text = readIfPresent(root, rel);
  if (!text) return findings;

  // Skip binary content
  if (isBinaryContent(text)) return findings;

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
