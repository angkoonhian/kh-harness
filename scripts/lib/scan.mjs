import { existsSync, readdirSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OVER_LIMIT, readBounded } from '../../assets/scripts/harness-log.mjs';
import { git } from './git-info.mjs';

// Listing a very large tree's untracked files can take git far longer than
// any other question the kit asks it.
const LISTING_TIMEOUT_MS = 60_000;

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);

/**
 * Run a path-listing git command with `-z` and return its NUL-terminated
 * records. Returns null — not [] — when git fails, so callers can tell
 * "nothing found" from "could not look".
 *
 * `-z` is not optional, and nothing in this file may ask git for a path
 * without it. With `core.quotePath` at its default (`true`) git applies
 * C-quoting to every path it prints, so a name holding any non-ASCII byte —
 * `src/café.ts`, a CJK filename, an emoji in a documentation tree — arrives
 * as the literal `"src/caf\303\251.ts"`, surrounding double quotes and octal
 * escapes included, and a path holding a literal newline is split across two
 * records. Every consumer in this tool would then treat that literal as a
 * path: the credential scanner would fail to open the file and skip it, with
 * `P0.security` reporting `verified` over a plaintext token, and
 * `languages()` would miss it too, because the quoted form ends in `.ts"`.
 *
 * It is prevented here, at the one place paths enter the tool, not
 * un-escaped at each consumer: un-escaping is a second answer to a question
 * `-z` removes outright. `-c core.quotePath=false` would also stop the
 * quoting but would still break on a path containing a newline, so it is
 * not used.
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
    return git(root, [...args, '-z'], { maxBuffer: 64 * 1024 * 1024, timeout: LISTING_TIMEOUT_MS }).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** True if any path component of an entry is a directory we never descend into. */
function isExcludedPath(entry) {
  return entry.split('/').filter(Boolean).some(part => EXCLUDE_DIRS.has(part));
}

// Known blind spot: a repository whose .git is a file (separate-git-dir, worktree layout)
// is not always detected — git does not enumerate it in ls-files output when the gitfile
// does not resolve. Submodules are detected via mode 160000. A directory whose .git file
// IS found is reported as `worktree` when `isOwnWorktree` proves it is a linked worktree
// of this repository (returned apart from `nested`, and not scanned), and as
// `nested-repo` otherwise, a worktree of some OTHER repository included.
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
// Not a blind spot, and named here because this list is where a reader
// looks for what the scan cannot see: a path whose name holds a non-ASCII
// byte. git quotes such a name unless asked not to, and `gitPaths` above,
// the only way this file asks git for a path, asks.
/**
 * True only when `rel` is a LINKED WORKTREE OF THIS REPOSITORY: a checkout
 * of the same repository, not a second one (found by the Vyugate trial,
 * which keeps `git worktree add` checkouts of itself under
 * `.claude/worktrees/<name>`; each was reported as a nested repository to be
 * "assessed separately"). Fails closed: anything not proven is false, and
 * the caller keeps calling it a nested repository. Proven when all hold:
 *   - `<rel>/.git` is a regular FILE, not a directory;
 *   - it reads `gitdir: <path>`, and `<path>` sits directly in THIS
 *     repository's `<common dir>/worktrees/` (`git rev-parse
 *     --git-common-dir`, so a run from inside another worktree works);
 *   - that admin directory's own `gitdir` file points back at `<rel>/.git`.
 * The back-pointer is what git itself writes for a worktree; a `.git` file
 * merely claiming a path in our worktrees folder does not have it.
 * Compared by real path, so case, short names and junctions agree.
 */
function isOwnWorktree(root, rel, commonDir) {
  if (!commonDir) return false;
  try {
    const dotGit = join(root, rel, '.git');
    if (!lstatSync(dotGit).isFile()) return false;
    const pointer = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!pointer) return false;
    const admin = realpathSync.native(resolve(join(root, rel), pointer[1]));
    if (realpathSync.native(dirname(admin)) !== realpathSync.native(join(commonDir, 'worktrees'))) return false;
    const back = readFileSync(join(admin, 'gitdir'), 'utf8').trim();
    return realpathSync.native(resolve(admin, back)) === realpathSync.native(dotGit);
  } catch {
    return false;
  }
}

/** This repository's common git directory, absolute, or null. */
function gitCommonDir(root) {
  try {
    const out = git(root, ['rev-parse', '--git-common-dir']).trim();
    return out ? resolve(root, out) : null;
  } catch {
    return null;
  }
}

function detectNestedRepositories(root) {
  const nested = [];
  let commonDir;
  // A directory holding a `.git`: a linked worktree of this repository, or
  // a nested repository. git is asked once, and only when there is one.
  const repoKind = path => {
    if (commonDir === undefined) commonDir = gitCommonDir(root);
    return isOwnWorktree(root, path, commonDir) ? 'worktree' : 'nested-repo';
  };
  // `ls-files -co --exclude-standard`, the list `listFiles` wants, is
  // exactly the paths of `-s` (fetched here for the gitlink scan) plus
  // `-o --exclude-standard` (fetched here for nested repositories). Both
  // answers are returned beside `nested` so `listFiles` derives the list
  // without a further spawn, which costs ~80 ms on Windows.
  let tracked = null;
  let untracked = null;
  try {
    // Untracked entries. Used twice below; git is asked once.
    untracked = gitPaths(root, ['ls-files', '-o', '--exclude-standard']);

    // Detect submodules: entries with mode 160000 in git ls-files -s. Each
    // record is `<mode> <object> <stage>\t<path>`; the path begins after
    // the first TAB and may itself hold spaces, so it is never found by
    // splitting on whitespace.
    const staged = gitPaths(root, ['ls-files', '-s']);
    if (staged !== null) tracked = [];
    for (const line of staged ?? []) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const mode = line.slice(0, tab).split(' ')[0];
      const path = line.slice(tab + 1);
      if (!path) continue;
      // Every stage of an unmerged path is one record; the path is listed once.
      if (tracked[tracked.length - 1] !== path) tracked.push(path);
      if (mode === '160000') nested.push({ path, kind: 'submodule' });
    }

    // Detect nested independent repositories: untracked directories containing .git
    for (const entry of untracked ?? []) {
      // Entries ending in / are nested repository boundaries
      if (entry.endsWith('/')) {
        const path = entry.slice(0, -1);
        // Confirm with .git child check (file or directory)
        if (existsSync(join(root, path, '.git'))) {
          nested.push({ path, kind: repoKind(path) });
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
              nested.push({ path, kind: repoKind(path) });
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
                    nested.push({ path: resultPath, kind: repoKind(resultPath) });
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
    // If any git operation fails entirely, return empty — and no file lists,
    // so listFiles falls back to the walk.
    return { nested: [], worktrees: [], tracked: null, untracked: null };
  }

  // Sort for stable output and deduplicate
  const uniqueNested = Array.from(new Map(nested.map(n => [n.path, n])).values());
  uniqueNested.sort((a, b) => a.path.localeCompare(b.path));
  // Linked worktrees of this repository are returned apart: they are not
  // scanned either (a checkout of another branch of the same repository),
  // but they are not a second repository to assess, so nothing that reads
  // `nested` may ask about them.
  return {
    nested: uniqueNested.filter(n => n.kind !== 'worktree'),
    worktrees: uniqueNested.filter(n => n.kind === 'worktree'),
    tracked, untracked,
  };
}

/**
 * Prefer `git ls-files`: it respects .gitignore and is dramatically faster than
 * a directory walk on NTFS repositories containing node_modules.
 *
 * Goes through `gitPaths`, like every other path question in this file, so
 * `-z` cannot be dropped from one call site and kept at the others.
 * `gitPaths` returning `null` is the one signal that distinguishes "git
 * could not look" from "git found nothing", and only the former may fall
 * through to the walk.
 */
export function listFiles(root) {
  const { nested, worktrees, tracked, untracked } = detectNestedRepositories(root);
  if (tracked !== null && untracked !== null) {
    // The union git's `ls-files -co --exclude-standard` would print — see
    // detectNestedRepositories. `-s` and `-o` are disjoint by definition,
    // so concatenation is the union.
    let files = [...tracked, ...untracked]
      .filter(f => !f.startsWith('node_modules/') && !f.includes('/node_modules/') && !f.endsWith('/'));

    // Filter out files beneath nested repositories and linked worktrees
    const skipped = [...nested, ...worktrees];
    if (skipped.length > 0) {
      files = files.filter(f => !skipped.some(n => f.startsWith(`${n.path}/`)));
    }

    return { files, source: 'git', nested, worktrees, unreadableDirs: [] };
  }

  // Fallback: a directory walk that prunes at the directory. A recursive
  // `readdirSync` would enumerate every entry under node_modules before
  // dropping them, seconds where skipping the directory takes milliseconds,
  // and would descend into a Windows junction. Regular files only, never
  // through a symlink or a junction, POSIX-relative paths.
  return { ...walkFiles(root), source: 'walk', nested, worktrees };
}

/**
 * The fallback file list for `root`, as `{ files, unreadableDirs }`.
 * A directory that cannot be listed is recorded in `unreadableDirs` (POSIX-
 * relative; the root itself is `'.'`) and the walk continues past it, so
 * every file it did read is kept and the sweep can report what it never
 * examined (audit 2026-11-18, C1). Exported so its test can time the walk
 * itself, apart from the git probes `listFiles` makes first; `readdir` is a
 * parameter so a test can make one directory fail on any platform.
 */
export function walkFiles(root, readdir = readdirSync) {
  const result = { files: [], unreadableDirs: [] };
  walk(root, '', readdir, result);
  return result;
}

function walk(root, rel, readdir, result) {
  let entries;
  try {
    entries = readdir(rel ? join(root, rel) : root, { withFileTypes: true });
  } catch {
    result.unreadableDirs.push(rel || '.');
    return;
  }
  for (const entry of entries) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) walk(root, entryRel, readdir, result);
    } else if (entry.isFile()) {
      result.files.push(entryRel);
    }
  }
}

/** The most bytes read of one repository document or manifest; those the
 * kit reads whole are far smaller. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** Why a file `readDocument` gives as `over-limit` was not read, as a
 * clause after its path. */
export const OVER_DOCUMENT_LIMIT = `is larger than the ${MAX_DOCUMENT_BYTES} bytes kh-harness reads of a file`;

/**
 * The file at `rel` as it was read: `{ state: 'read', text }`; `{ state:
 * 'absent' }` when nothing is there; `{ state: 'over-limit' }` for a file
 * larger than `MAX_DOCUMENT_BYTES`; `{ state: 'unreadable' }` for a path
 * that is not a regular file or cannot be read. The size is checked first,
 * so a huge file, a pipe or a device costs a stat. Never throws.
 */
export function readDocument(root, rel) {
  try {
    return { state: 'read', text: readBounded(join(root, rel), MAX_DOCUMENT_BYTES).toString('utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { state: 'absent' };
    return { state: error?.code === OVER_LIMIT ? 'over-limit' : 'unreadable' };
  }
}

/** The text `readDocument` read, or null for every other state. A caller
 * to which null means "absent" or "empty" must not say so of a file that
 * exists: it uses `readDocument` and reports the file as not read. */
export function readIfPresent(root, rel) {
  const document = readDocument(root, rel);
  return document.state === 'read' ? document.text : null;
}

export function existsAny(root, rels) {
  for (const rel of rels) if (existsSync(join(root, rel))) return rel;
  return null;
}
