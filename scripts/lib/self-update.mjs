// scripts/lib/self-update.mjs
//
// Keeps the plugin's own checkout at its upstream, so every session runs
// the latest kit without anyone pulling it by hand. The session-start hook
// starts `scripts/self-update.mjs` in the background, which calls
// `selfUpdate`; the next session's hook reports what happened through
// `updateNotice`.
//
// It only ever fast-forwards. A checkout with tracked changes, with
// commits of its own that upstream lacks, on a detached HEAD or on a branch
// with no upstream is left exactly as it is, and the reason is recorded.
// That is what makes it safe to run in a folder someone may be working in:
// nothing the owner made can be lost, because nothing is merged, rebased,
// reset or stashed.
//
// The record lives in the checkout's git directory, never in a tracked
// file and never in a repository the kit is installed into.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { commitReadEnv, git, gitFailure } from './git-info.mjs';
import { readJsonFile } from './read-json.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { LOCKED, withFileLock } from './file-lock.mjs';

/** At most one attempt per this long, however many sessions start. */
export const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const STATE_FILE = 'kh-harness-self-update.json';
const FETCH_TIMEOUT_MS = 60_000;
const LOCAL_TIMEOUT_MS = 10_000;

/** Outcomes worth telling a session about; the rest are silent. */
const REPORTED = new Set(['updated', 'diverged', 'dirty', 'fetch-failed', 'merge-failed']);

/** The environment every update call runs in: the kit's usual one, and no
 * way for git to wait on a person — no terminal prompt, no credential
 * manager dialog, and ssh in batch mode unless the owner set their own ssh
 * command. */
function updateEnv() {
  const env = { ...commitReadEnv(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return env;
}

const run = (root, args, timeout = LOCAL_TIMEOUT_MS) => git(root, args, { env: updateEnv(), timeout }).trim();

/** The git directory of `root` when `root` is the top of its own work tree,
 * or null: a folder inside some other repository, or no repository, is not
 * a checkout of the plugin. */
function gitDirOf(root) {
  try {
    // Read untrimmed: at the top, `--show-prefix` prints an empty line.
    const out = git(root, ['rev-parse', '--show-prefix', '--absolute-git-dir'], { env: updateEnv(), timeout: LOCAL_TIMEOUT_MS });
    const [prefix, dir] = out.split(/\r?\n/);
    return prefix === '' && dir ? dir : null;
  } catch {
    return null;
  }
}

/** Where the record for the checkout at `root` lives, or null when `root`
 * is not one. */
export function updateStatePath(root) {
  const dir = gitDirOf(root);
  return dir ? join(dir, STATE_FILE) : null;
}

/** The last recorded attempt for `root`, or null. */
export function readUpdateState(root) {
  const path = updateStatePath(root);
  if (!path) return null;
  const read = readJsonFile(path);
  return read.state === 'ok' && read.value && typeof read.value === 'object' ? read.value : null;
}

/** The kit version the checkout at `root` holds, or null. */
function versionAt(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** One attempt, under no lock: what happened, as `{ outcome, detail, from?, to? }`. */
function attempt(root) {
  let branch;
  try {
    branch = run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch {
    return { outcome: 'skipped', detail: 'HEAD is detached' };
  }
  let upstream;
  try {
    upstream = run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    return { outcome: 'skipped', detail: `branch ${branch} has no upstream` };
  }
  if (run(root, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    return { outcome: 'dirty', detail: `${root} has uncommitted changes to tracked files` };
  }
  let remote;
  try {
    remote = run(root, ['config', '--get', `branch.${branch}.remote`]);
  } catch {
    remote = '';
  }
  if (remote && remote !== '.') {
    try {
      run(root, ['fetch', '--quiet', remote], FETCH_TIMEOUT_MS);
    } catch (err) {
      return { outcome: 'fetch-failed', detail: `fetching ${remote} failed: ${gitFailure(err, 'fetch', FETCH_TIMEOUT_MS)}` };
    }
  }
  const [ahead, behind] = run(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']).split(/\s+/).map(Number);
  if (behind === 0) return { outcome: 'current', detail: ahead ? `${ahead} local commit(s) not on ${upstream}` : '' };
  if (ahead > 0) {
    return {
      outcome: 'diverged',
      detail: `${branch} has ${ahead} commit${ahead === 1 ? '' : 's'} not on ${upstream}, and ${upstream} has ${behind} not on ${branch}`,
    };
  }
  const from = run(root, ['rev-parse', 'HEAD']);
  try {
    run(root, ['merge', '--ff-only', '--quiet', '@{u}']);
  } catch (err) {
    return { outcome: 'merge-failed', detail: `fast-forwarding to ${upstream} failed: ${gitFailure(err, 'merge')}` };
  }
  return { outcome: 'updated', detail: `${behind} commit${behind === 1 ? '' : 's'} from ${upstream}`, from, to: run(root, ['rev-parse', 'HEAD']) };
}

/**
 * Brings the checkout at `root` up to its upstream when that is a plain
 * fast-forward, at most once per `UPDATE_INTERVAL_MS`, and records the
 * outcome. Returns the outcome; `throttled`, `locked` and `not-a-checkout`
 * record nothing. `now` is for tests.
 */
export function selfUpdate(root, { now = Date.now } = {}) {
  const path = updateStatePath(root);
  if (!path) return { outcome: 'not-a-checkout', detail: `${root} is not the top of a git checkout` };
  try {
    return withFileLock(`${path}.lock`, { name: 'the self-update record' }, () => {
      const previous = readUpdateState(root);
      const at = now();
      if (previous && typeof previous.at === 'number' && at - previous.at < UPDATE_INTERVAL_MS) {
        return { outcome: 'throttled', detail: '' };
      }
      const result = attempt(root);
      writeFileAtomic(path, JSON.stringify({ at, ...result, version: versionAt(root), reportedKey: previous?.reportedKey ?? null }, null, 2) + '\n');
      return result;
    });
  } catch (err) {
    if (err?.code === LOCKED) return { outcome: 'locked', detail: 'another session is updating' };
    throw err;
  }
}

const keyOf = s => JSON.stringify([s.outcome, s.detail, s.to ?? null]);

/**
 * One line for the session about the last attempt, or null. Each update,
 * and each distinct failure, is reported once: the record remembers what
 * was last told.
 */
export function updateNotice(root) {
  const path = updateStatePath(root);
  const state = readUpdateState(root);
  if (!path || !state || !REPORTED.has(state.outcome)) return null;
  const key = keyOf(state);
  if (state.reportedKey === key) return null;
  try {
    withFileLock(`${path}.lock`, { name: 'the self-update record' }, () => {
      const latest = readUpdateState(root) ?? state;
      writeFileAtomic(path, JSON.stringify({ ...latest, reportedKey: key }, null, 2) + '\n');
    });
  } catch {
    return null; // told next time instead of twice
  }
  if (state.outcome === 'updated') {
    return `kh-harness: the plugin updated itself (${state.detail}, now kit ${state.version ?? 'version unknown'} at ${String(state.to).slice(0, 7)}). ` +
      `Mention it to the user in one line if it is relevant to their work.`;
  }
  return `kh-harness: the plugin at ${root} could not update itself: ${state.detail}. ` +
    `Tell the user once, in one line; it keeps running the version it has, and tries again within the hour.`;
}
