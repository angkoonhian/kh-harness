// scripts/lib/detect-exposure.mjs
import { statSync } from 'node:fs';
import { join } from 'node:path';
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

const SCAN_EXT = [
  '.md', '.json', '.yml', '.yaml', '.toml', '.env', '.example', '.txt', '.sh', '.ps1', '.cfg', '.ini',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.java', '.cs', '.php',
];
const SKIP_DIRS = ['node_modules/', '.git/', 'dist/', 'build/'];

function scannable(root, rel) {
  if (SKIP_DIRS.some(p => rel.startsWith(p) || rel.includes('/' + p))) return false;
  const lower = rel.toLowerCase();
  const dotted = lower.includes('.env');
  // Allow: .env files, files with SCAN_EXT extensions, or extensionless files
  if (!dotted && !SCAN_EXT.some(e => lower.endsWith(e))) {
    // Reject files with extensions that don't match SCAN_EXT
    if (lower.includes('.')) return false;
  }
  try { return statSync(join(root, rel)).size <= MAX_BYTES; } catch { return false; }
}

function isPlaceholder(value) {
  return PLACEHOLDER.test(value);
}

export function detectExposures(root, files, harness) {
  const out = [];
  const seen = new Set(files);

  for (const r of harness?.remotes ?? []) {
    if (r.hasCredential) out.push({ kind: 'token-in-remote-url', location: `git remote "${r.name}"`, severity: 'high' });
  }

  for (const rel of files) {
    if (!scannable(root, rel)) continue;
    const text = readIfPresent(root, rel);
    if (!text) continue;

    const hasToken = TOKEN_PATTERNS.some(re => re.test(text)) || PEM_PATTERN.test(text);
    if (hasToken) {
      const kind = rel.startsWith('.claude/') ? 'token-in-local-settings' : 'token-in-tracked-file';
      out.push({ kind, location: rel, severity: 'high' });
    }

    if (DB_CRED.test(text)) {
      const match = text.match(DB_CRED);
      if (match && !isPlaceholder(match[0])) {
        out.push({ kind: 'credentials-in-doc', location: rel, severity: 'medium' });
      }
    }
  }

  // Scan always-probed paths, deduplicating against files already checked
  for (const rel of ALWAYS_PROBE) {
    if (seen.has(rel)) continue;
    const text = readIfPresent(root, rel);
    if (!text) continue;

    const hasToken = TOKEN_PATTERNS.some(re => re.test(text)) || PEM_PATTERN.test(text);
    if (hasToken) {
      const kind = rel.startsWith('.claude/') ? 'token-in-local-settings' : 'token-in-tracked-file';
      out.push({ kind, location: rel, severity: 'high' });
      continue;
    }

    if (DB_CRED.test(text)) {
      const match = text.match(DB_CRED);
      if (match && !isPlaceholder(match[0])) {
        out.push({ kind: 'credentials-in-doc', location: rel, severity: 'medium' });
      }
    }
  }

  return out;
}
