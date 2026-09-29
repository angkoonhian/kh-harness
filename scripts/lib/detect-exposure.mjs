// scripts/lib/detect-exposure.mjs
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readIfPresent } from './scan.mjs';

const MAX_BYTES = 512 * 1024;

const TOKEN_PATTERNS = [
  /glpat-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

const DB_CRED = /(password|passwd|pwd)\s*[:=]\s*\S{8,}/i;

const SCAN_EXT = ['.md', '.json', '.yml', '.yaml', '.toml', '.env', '.example', '.txt', '.sh', '.ps1', '.cfg', '.ini'];
const SKIP_DIRS = ['node_modules/', '.git/', 'dist/', 'build/'];

function scannable(root, rel) {
  if (SKIP_DIRS.some(p => rel.startsWith(p) || rel.includes('/' + p))) return false;
  const dotted = rel.includes('.env');
  if (!dotted && !SCAN_EXT.some(e => rel.endsWith(e))) return false;
  try { return statSync(join(root, rel)).size <= MAX_BYTES; } catch { return false; }
}

export function detectExposures(root, files, harness) {
  const out = [];

  for (const r of harness?.remotes ?? []) {
    if (r.hasCredential) out.push({ kind: 'token-in-remote-url', location: `git remote "${r.name}"`, severity: 'high' });
  }

  for (const rel of files) {
    if (!scannable(root, rel)) continue;
    const text = readIfPresent(root, rel);
    if (!text) continue;

    const hasToken = TOKEN_PATTERNS.some(re => re.test(text));
    if (hasToken) {
      const kind = rel.startsWith('.claude/') ? 'token-in-local-settings' : 'token-in-tracked-file';
      out.push({ kind, location: rel, severity: 'high' });
      continue;
    }
    if (DB_CRED.test(text)) {
      out.push({ kind: 'credentials-in-doc', location: rel, severity: 'medium' });
    }
  }

  return out;
}
