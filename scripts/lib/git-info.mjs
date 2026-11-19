// scripts/lib/git-info.mjs
//
// The kit's one way of asking git anything (`git`), and what `detect`
// records about the repository and `apply`'s two safety gates decide from
// (`gitInfo`, `defaultBranches`). Three facts are kept apart throughout: a
// repository, a non-repository, and "git could not answer". `apply` gates
// only on a repository, so a failure read as "not a repository" would waive
// both gates.
import { execFileSync } from 'node:child_process';

// How long one git call may take before the answer counts as one that could
// not be had.
const GIT_TIMEOUT_MS = 10_000;

// The variables that point git at a repository, work tree, index or object
// store other than the one found from `-C <root>`.
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];

/**
 * The environment every kit git call runs in: `base`, this process's unless
 * a caller says otherwise, with git's messages in the C locale, so the
 * wording they are matched on does not depend on the owner's language, and
 * without `REPOSITORY_VARIABLES`, so the repository read is the one at the
 * path asked about and not one a git hook's environment or a stray export
 * names.
 */
export function commitReadEnv(base = process.env) {
  const env = { ...base, LC_ALL: 'C' };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  return env;
}

/**
 * Runs git in `root` and returns what it printed; throws what
 * `execFileSync` throws. Every call the kit makes goes through here: with
 * its arguments as an array, never through a shell; in `commitReadEnv`;
 * under a timeout; and with `--no-replace-objects`, so no `refs/replace/`
 * object the repository holds changes what a commit is read as. `env` is
 * given whole and used as it is, which is how a test takes git away.
 */
export function git(root, args, { env = commitReadEnv(), timeout = GIT_TIMEOUT_MS, encoding = 'utf8', maxBuffer } = {}) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    encoding, stdio: ['ignore', 'pipe', 'pipe'], timeout, env, ...(maxBuffer === undefined ? {} : { maxBuffer }),
  });
}

/** Why a `git` call failed, as a sentence: the call timing out, git stopped
 * by a signal, git missing, or the first line git printed. Output past a
 * read's bound is the caller's to word (`ENOBUFS`). `timeout` is the one the
 * call was given. */
export function gitFailure(err, what, timeout = GIT_TIMEOUT_MS) {
  if (err?.code === 'ETIMEDOUT') return `git did not answer within ${timeout / 1000} seconds`;
  if ((err?.signal ?? null) !== null) return `git was stopped by ${err.signal}`;
  if (err?.code === 'ENOENT') return 'git is not installed or not on PATH';
  const stderr = String(err?.stderr ?? '').trim().split(/\r?\n/)[0];
  if (/not a git repository/i.test(stderr)) return 'it is not a git repository';
  return stderr || `git could not ${what}`;
}

/** True when `err`, thrown by `git`, is git saying the path is not a
 * repository. */
export const isNotRepository = err => /not a git repository/i.test(String(err?.stderr ?? ''));

/**
 * Runs one git query. Returns `{ out }` on success, `{ notRepo: true }` when
 * git itself says the path is not a repository, and `{ error }`, one line
 * that never includes the command, for anything else (git missing, "dubious
 * ownership", an unreadable `.git`, no answer in time).
 */
function ask(root, args, env) {
  try {
    return { out: git(root, args, env === undefined ? {} : { env }).trim() };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ETIMEDOUT' || (err?.signal ?? null) !== null) return { error: gitFailure(err, 'answer') };
    if (isNotRepository(err)) return { notRepo: true };
    const stderr = String(err?.stderr ?? '').trim().split(/\r?\n/)[0];
    // `symbolic-ref -q` exits 1 with no message for a detached HEAD or an
    // absent ref; that is an answer, not an error.
    if (err?.status === 1 && stderr === '') return { out: '' };
    return { error: stderr ? `git could not read ${root}: ${stderr}` : `git exited ${err?.status ?? 'abnormally'} for ${root}` };
  }
}

/**
 * `{ isRepo, branch, error }`.
 *   - `isRepo` from `rev-parse --is-inside-work-tree`, which is true on an
 *     unborn branch too.
 *   - `branch` from `symbolic-ref --short -q HEAD`: the branch name on an
 *     unborn branch as well as a committed one; `null` on a detached HEAD.
 *   - `error` is set when git could not answer. `isRepo` is then false, and
 *     a caller that gates on `isRepo` must treat `error` as "unknown", never
 *     as "not a repository" — `apply` refuses unless both gates are waived.
 *
 * A path that is not a repository while this process's environment carries
 * one of `REPOSITORY_VARIABLES` is an error too: git may find a repository
 * there through that variable, which the kit does not follow, and saying
 * "not a repository" would waive both gates over it. `env` is overridable
 * only so a test can take git away; production callers never pass it.
 */
export function gitInfo(root, { env } = {}) {
  const inside = ask(root, ['rev-parse', '--is-inside-work-tree'], env);
  if (inside.notRepo || (inside.out !== undefined && inside.out !== 'true')) {
    const followed = env === undefined ? REPOSITORY_VARIABLES.filter(name => process.env[name] !== undefined) : [];
    if (followed.length === 0) return { isRepo: false, branch: null, error: null };
    return {
      isRepo: false, branch: null,
      error: `${root} is not a git repository by its own .git, and ${followed.join(', ')} ${followed.length === 1 ? 'is' : 'are'} set, which kh-harness does not follow: unset ${followed.length === 1 ? 'it' : 'them'} to have this directory read as it is`,
    };
  }
  if (inside.error) return { isRepo: false, branch: null, error: inside.error };
  const head = ask(root, ['symbolic-ref', '--short', '-q', 'HEAD'], env);
  if (head.error) return { isRepo: false, branch: null, error: head.error };
  return { isRepo: true, branch: head.out || null, error: null };
}

/**
 * The branches `apply` refuses to write on without `--allow-default-branch`:
 * always `main` and `master`, plus whatever `init.defaultBranch` names and
 * the branch `refs/remotes/origin/HEAD` points at. Called by `apply` only —
 * `detect` has no gate and gains no spawns. A failure anywhere here leaves
 * the two fixed names, so the gate never widens or narrows on an error.
 */
export function defaultBranches(root, { env } = {}) {
  const names = ['main', 'master'];
  const configured = ask(root, ['config', '--get', 'init.defaultBranch'], env).out;
  if (configured) names.push(configured);
  const originHead = ask(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], env).out;
  if (originHead) names.push(originHead.replace(/^origin\//, ''));
  return [...new Set(names)];
}
