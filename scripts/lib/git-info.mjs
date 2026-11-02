// scripts/lib/git-info.mjs
//
// What `detect` records about the repository and what `apply`'s two safety
// gates decide from. Audit Tier 1, finding 3 (docs/2026-11-02-audit-
// findings.md): this used to ask `rev-parse --abbrev-ref HEAD`, which fails
// on a repository with no commits, and reported that failure — and every
// other failure, git not being installed included — as `isRepo: false`.
// `apply` gates only when `isRepo` is true, so an unborn `main` was written
// to with no refusal and a broken git waived both gates. Three facts are now
// kept apart: a repository, a non-repository, and "git could not answer".
import { execFileSync } from 'node:child_process';

/**
 * Runs one git query. Returns `{ out }` on success, `{ notRepo: true }` when
 * git itself says the path is not a repository, and `{ error }` — one line,
 * never including the command — for anything else (git missing, "dubious
 * ownership", an unreadable `.git`). `env` is overridable only so a test can
 * take git away; production callers never pass it.
 */
function ask(root, args, env) {
  try {
    return { out: execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim() };
  } catch (err) {
    if (err?.code === 'ENOENT') return { error: 'git is not installed or not on PATH' };
    const stderr = String(err?.stderr ?? '').trim().split(/\r?\n/)[0];
    if (/not a git repository/i.test(stderr)) return { notRepo: true };
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
 */
export function gitInfo(root, { env } = {}) {
  const inside = ask(root, ['rev-parse', '--is-inside-work-tree'], env);
  if (inside.notRepo || (inside.out !== undefined && inside.out !== 'true')) return { isRepo: false, branch: null, error: null };
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
