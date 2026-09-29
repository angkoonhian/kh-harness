import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);

function detectNestedRepositories(root) {
  const nested = [];
  try {
    // Detect submodules: entries with mode 160000 in git ls-files -s
    try {
      const lsOut = execFileSync('git', ['-C', root, 'ls-files', '-s'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of lsOut.split('\n')) {
        const parts = line.split(/\s+/);
        if (parts[0] === '160000' && parts[3]) {
          nested.push({ path: parts[3], kind: 'submodule' });
        }
      }
    } catch {
      // If git ls-files -s fails, continue without submodule detection
    }

    // Detect nested independent repositories: untracked directories containing .git
    try {
      const untrackedDirs = execFileSync('git', ['-C', root, 'ls-files', '-o', '--exclude-standard', '--directory'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of untrackedDirs.split('\n')) {
        const dir = line.trim();
        if (!dir || dir.endsWith('/node_modules/')) continue;
        const fullPath = join(root, dir);
        if (existsSync(join(fullPath, '.git'))) {
          nested.push({ path: dir.replace(/\/$/, ''), kind: 'nested-repo' });
        }
      }
    } catch {
      // If git ls-files -o fails, continue without nested-repo detection
    }
  } catch {
    // If any git operation fails entirely, return empty
    return [];
  }

  // Sort for stable output
  nested.sort((a, b) => a.path.localeCompare(b.path));
  return nested;
}

/**
 * Prefer `git ls-files`: it respects .gitignore and is dramatically faster than
 * a directory walk on NTFS repositories containing node_modules.
 */
export function listFiles(root) {
  const nested = detectNestedRepositories(root);
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out.split('\n').map(s => s.trim()).filter(Boolean)
      .filter(f => !f.startsWith('node_modules/') && !f.includes('/node_modules/'));
    return { files, source: 'git', nested };
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
      return { files: [], source: 'walk', nested };
    }
    return { files, source: 'walk', nested };
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
