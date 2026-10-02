import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);

/**
 * Run a path-listing git command with `-z` and return its NUL-terminated
 * records. Returns null — not [] — when git fails, so callers can tell
 * "nothing found" from "could not look".
 *
 * `-z` IS NOT OPTIONAL, and nothing in this file may ask git for a path
 * without it. With `core.quotePath` at its default (`true`) git applies
 * C-quoting to every path it prints, so a name holding any non-ASCII byte —
 * `src/café.ts`, a CJK filename, an emoji in a documentation tree — arrives
 * as the literal `"src/caf\303\251.ts"`, surrounding double quotes and octal
 * escapes included, and a path holding a literal newline is split across two
 * records. Every consumer in this tool then treats that literal as a path:
 * `detect-exposure.mjs`'s `statSync` threw ENOENT, the credential scanner
 * skipped the file with no record anywhere that it had, and `P0.security`
 * reported `verified / no credential patterns matched` over a plaintext
 * token (whole-branch review, F1). `languages()` missed it too, because the
 * quoted form ends in `.ts"`, so the profile silently fell back to
 * `generic`.
 *
 * That was the fourth, and by far the worst, of the blind spots enumerated
 * below: the only one that disarmed a security check rather than narrowing a
 * proposal. It is fixed here, at the one place paths enter the tool, rather
 * than un-escaped at each consumer — un-escaping is a second, driftable
 * answer to a question `-z` removes outright. `-c core.quotePath=false`
 * would also stop the quoting but would still break on a path containing a
 * newline, so it is not used.
 *
 * Note for anyone splitting these records: the NUL is a terminator, not a
 * separator, so the last element is always `''` and `filter(Boolean)` is what
 * drops it. The split character is written as the escape `'\0'`; a literal
 * 0x00 byte typed into a source file makes git treat the whole file as
 * binary (see glob.test.mjs's repository-wide guard, and glob.mjs's own
 * comment on `PLACEHOLDER` — this project has shipped that defect twice).
 */
function gitPaths(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args, '-z'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** True if any path component of an entry is a directory we never descend into. */
function isExcludedPath(entry) {
  return entry.split('/').filter(Boolean).some(part => EXCLUDE_DIRS.has(part));
}

// Known blind spot: a repository whose .git is a file (separate-git-dir, worktree layout)
// is not detected — git does not enumerate it in ls-files output. Submodules are detected
// via mode 160000; worktrees are views of the same repository, not separate projects.
// Note that the blind spot is not confined to worktrees: a project created with
// `git init --separate-git-dir` and then nested as a subfolder is a genuinely
// independent repository, and it sits on this same silent path.
//
// Second known blind spot, platform-dependent: a nested repository reachable only
// through a symlinked directory is not detected on POSIX, because git does not
// follow symlinks — `git ls-files -o` lists the symlink itself as a file, never
// descending into what it points at, so the repository behind it is invisible.
// On Windows the equivalent construct is a junction, which git cannot distinguish
// from an ordinary directory, so it is walked and the nested repository is found.
// The tool does not follow symlinks itself to close this gap — that would mean
// walking outside the index into cycle-prone territory on a hot path — so this
// is accepted as a rare, disclosed limitation rather than fixed.
//
// Third known blind spot, and a deliberate one: EXCLUDE_DIRS unconditionally
// excludes `dist`, `build` and `__pycache__` on the fallback (non-git) walk —
// there is no tracked/ignored distinction to read without git, so excluding
// likely build output by default is the better behaviour there. The git path
// has no such exclusion; it relies on `--exclude-standard` (.gitignore)
// instead, so a *tracked* dist/build/__pycache__ (unusual, but real — see
// propose.mjs's P2.protected comment) is visible to it and a gitignored one
// is not. The result: the same repository can yield a different
// `P2.protected` deny-rule proposal depending on whether git is available at
// all, or whether this scan can see it (per the first blind spot above). A
// missed proposal in that rare configuration is the acceptable direction for
// this to fail — it is not fixed here.
//
// There WAS a fourth, undisclosed blind spot, and unlike these three it was
// not a trade-off: git's C-quoting of non-ASCII path names made every file
// with such a name invisible to the credential scanner while `P0.security`
// still reported `verified`. It is gone — see `gitPaths` above, which is now
// the only way this file asks git for a path. It is named here, in the same
// list, because the list is where the next person will look to find out what
// this scan cannot see, and an enumeration that silently omits the one entry
// that mattered is how a reader concludes the list is exhaustive.
function detectNestedRepositories(root) {
  const nested = [];
  try {
    // Untracked entries. Used twice below; git is asked once.
    const untracked = gitPaths(root, ['ls-files', '-o', '--exclude-standard']);

    // Detect submodules: entries with mode 160000 in git ls-files -s
    for (const line of gitPaths(root, ['ls-files', '-s']) ?? []) {
      const parts = line.split(/\s+/);
      if (parts[0] === '160000' && parts[3]) {
        nested.push({ path: parts[3], kind: 'submodule' });
      }
    }

    // Detect nested independent repositories: untracked directories containing .git
    for (const entry of untracked ?? []) {
      // Entries ending in / are nested repository boundaries
      if (entry.endsWith('/')) {
        const path = entry.slice(0, -1);
        // Confirm with .git child check (file or directory)
        if (existsSync(join(root, path, '.git'))) {
          nested.push({ path, kind: 'nested-repo' });
        }
      }
    }

    // Detect nested repositories in gitignored directories
    try {
      for (const entry of gitPaths(root, ['ls-files', '-o', '-i', '--exclude-standard', '--directory']) ?? []) {
        // node_modules and friends are never nested projects: `npm install
        // git+https://…` leaves a real .git inside an installed package, and
        // reporting it is both wrong and one existsSync per installed package.
        if (isExcludedPath(entry)) continue;

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
      // If the gitignored sweep fails, continue without it
    }

    // Detect bare repositories (have HEAD file and objects directory)
    const topLevelDirs = new Set();
    for (const entry of untracked ?? []) {
      const topLevelDir = entry.split(/[/\\]/)[0];
      if (topLevelDir && !EXCLUDE_DIRS.has(topLevelDir)) topLevelDirs.add(topLevelDir);
    }
    for (const dir of topLevelDirs) {
      const fullPath = join(root, dir);
      // Bare repo: has HEAD file and objects directory
      if (existsSync(join(fullPath, 'HEAD')) && existsSync(join(fullPath, 'objects'))) {
        if (!nested.some(n => n.path === dir)) {
          nested.push({ path: dir, kind: 'nested-repo' });
        }
      }
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
 *
 * Goes through `gitPaths`, like every other path question in this file, so
 * `-z` cannot be dropped from one call site and kept at the others — which is
 * exactly how F1 happened (`apply.mjs`'s `hasTrackedChanges` half-knew about
 * git's quoting and stripped the surrounding quotes without un-escaping the
 * octal; this module did not know at all). `gitPaths` returning `null` is the
 * one signal that distinguishes "git could not look" from "git found
 * nothing", and only the former may fall through to the walk.
 */
export function listFiles(root) {
  const nested = detectNestedRepositories(root);
  const tracked = gitPaths(root, ['ls-files', '-co', '--exclude-standard']);
  if (tracked !== null) {
    let files = tracked
      .filter(f => !f.startsWith('node_modules/') && !f.includes('/node_modules/') && !f.endsWith('/'));

    // Filter out files beneath nested repositories
    if (nested.length > 0) {
      files = files.filter(f => !nested.some(n => f.startsWith(`${n.path}/`)));
    }

    return { files, source: 'git', nested };
  }

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

export function readIfPresent(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

export function existsAny(root, rels) {
  for (const rel of rels) if (existsSync(join(root, rel))) return rel;
  return null;
}
