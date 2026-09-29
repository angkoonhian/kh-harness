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
      const lsOut = execFileSync('git', ['-C', root, 'ls-files', '-o', '--exclude-standard'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of lsOut.split('\n')) {
        const entry = line.trim();
        if (!entry) continue;

        // Entries ending in / are nested repository boundaries
        if (entry.endsWith('/')) {
          const path = entry.slice(0, -1);
          // Confirm with .git child check (file or directory)
          if (existsSync(join(root, path, '.git'))) {
            nested.push({ path, kind: 'nested-repo' });
          }
        }
      }
    } catch {
      // If git ls-files fails, continue without nested-repo detection
    }

    // Detect nested repositories in gitignored directories
    try {
      const lsOut = execFileSync('git', ['-C', root, 'ls-files', '-o', '-i', '--exclude-standard', '--directory'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of lsOut.split('\n')) {
        const entry = line.trim();
        if (!entry || entry.endsWith('/node_modules/')) continue;

        // Entries ending in / are ignored directory boundaries
        if (entry.endsWith('/')) {
          const path = entry.slice(0, -1);
          const fullPath = join(root, path);

          // Check for .git in this directory
          if (existsSync(join(fullPath, '.git'))) {
            // Avoid duplicates
            if (!nested.some(n => n.path === path)) {
              nested.push({ path, kind: 'nested-repo' });
            }
          } else {
            // Check immediate children only (depth 1, no recursion)
            try {
              const entries = readdirSync(fullPath);
              for (const entry of entries) {
                if (entry === '.git') continue;
                const subPath = join(fullPath, entry);
                if (existsSync(join(subPath, '.git'))) {
                  const resultPath = `${path}/${entry}`;
                  if (!nested.some(n => n.path === resultPath)) {
                    nested.push({ path: resultPath, kind: 'nested-repo' });
                  }
                }
              }
            } catch {
              // Skip if readdirSync fails
            }
          }
        }
      }
    } catch {
      // If git ls-files fails, continue without gitignored nested-repo detection
    }

    // Detect bare repositories (have HEAD file and objects directory)
    try {
      const lsOut = execFileSync('git', ['-C', root, 'ls-files', '-o', '--exclude-standard'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const entries = new Set();
      for (const line of lsOut.split('\n')) {
        const entry = line.trim();
        if (!entry) continue;
        const topLevelDir = entry.split(/[/\\]/)[0];
        if (topLevelDir) entries.add(topLevelDir);
      }

      for (const dir of entries) {
        const fullPath = join(root, dir);
        // Bare repo: has HEAD file and objects directory
        if (existsSync(join(fullPath, 'HEAD')) && existsSync(join(fullPath, 'objects'))) {
          if (!nested.some(n => n.path === dir)) {
            nested.push({ path: dir, kind: 'nested-repo' });
          }
        }
      }
    } catch {
      // If detection fails, continue
    }
  } catch {
    // If any git operation fails entirely, return empty
    return [];
  }

  // Sort for stable output and deduplicate
  const uniqueNested = Array.from(new Map(nested.map(n => [n.path, n])).values());
  uniqueNested.sort((a, b) => a.path.localeCompare(b.path));
  return uniqueNested;
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
    let files = out.split('\n').map(s => s.trim()).filter(Boolean)
      .filter(f => !f.startsWith('node_modules/') && !f.includes('/node_modules/') && !f.endsWith('/'));

    // Filter out files beneath nested repositories
    if (nested.length > 0) {
      files = files.filter(f => !nested.some(n => f.startsWith(`${n.path}/`)));
    }

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
