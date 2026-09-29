import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);

/**
 * Prefer `git ls-files`: it respects .gitignore and is dramatically faster than
 * a directory walk on NTFS repositories containing node_modules.
 */
export function listFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out.split('\n').map(s => s.trim()).filter(Boolean)
      .filter(f => !f.startsWith('node_modules/') && !f.includes('/node_modules/'));
    return { files, source: 'git' };
  } catch {
    // Fallback: recursive directory walk using stable readdirSync (Node 20.1+)
    const files = [];
    try {
      const entries = readdirSync(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const fullPath = join(entry.parentPath, entry.name);
        const relPath = relative(root, fullPath);
        const pathComponents = relPath.split(/[\\\/]/);

        // Skip if any directory component is excluded
        if (pathComponents.slice(0, -1).some(p => EXCLUDE_DIRS.has(p))) continue;

        // Convert to POSIX separators
        files.push(relPath.split('\\').join('/'));
      }
    } catch {
      // If walk fails, return empty list rather than throwing
      return { files: [], source: 'walk' };
    }
    return { files, source: 'walk' };
  }
}

export function readIfPresent(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

export function existsAny(root, rels) {
  for (const rel of rels) if (existsSync(join(root, rel))) return rel;
  return null;
}
